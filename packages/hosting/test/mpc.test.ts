import { describe, expect, it } from 'vitest'
import { getAddress, hexToBytes, recoverMessageAddress, recoverTypedDataAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { COW, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, USDC, ORDER_TYPES } from '@gremlins/treasury'
import {
  BASE_QUAI, BASE_USDC, COW_SETTLEMENT, COW_VAULT_RELAYER, MakerAway, MpcAbort, SECP256K1_N, browserKeygen, checkSignRequest, cosignOnce, digestOf,
  mpcCoordinator, shareAddressOf, shareScalar, wireTypedData, type CosignEvent, type MpcTransport, type PolicyContext,
} from '../src/mpc-index.js'
import { fluencePayTo } from '../src/fluence.js'
import type { TypedDataToSign } from '../src/signer.js'

const FLUENCE_PAYEE = '0x000000000000000000000000000000000000fee5'
const NOW = Date.parse('2026-11-10T12:00:00Z')

/** The browser talking to the coordinator in-process (the board's HTTP routes add only auth and JSON). */
function inProcess(c: ReturnType<typeof mpcCoordinator>, jobId: string, board: { share?: string }): MpcTransport {
  return {
    async keygen(msg) {
      const r = await c.keygen(jobId, msg)
      if (r.share) board.share = r.share
      return { msg: r.msg, hostingAddress: r.address }
    },
    confirmKeygen: async () => {},
    poll: async () => c.poll(jobId),
    answer: (id, a) => c.answer(jobId, id, a),
  }
}

async function keyed(jobId = 'job-1', o: Parameters<typeof mpcCoordinator>[0] = {}) {
  const c = mpcCoordinator({ now: () => NOW, ...o })
  const board: { share?: string } = {}
  const t = inProcess(c, jobId, board)
  const browser = await browserKeygen(t, jobId)
  const ctx: PolicyContext = { hostingAddress: browser.address, maxTopUpMicro: 10_000_000n, now: () => NOW, fluencePayTo: async () => [FLUENCE_PAYEE], cowQuote: async (sell) => (sell * 100_000n) / 10n ** 18n }
  return { c, t, jobId, board: board.share!, browser, ctx, signer: c.signer(jobId, board.share!) }
}

/** Keep the browser co-signing until `p` settles. */
async function withBrowser<T>(k: Awaited<ReturnType<typeof keyed>>, p: () => Promise<T>, events: CosignEvent[] = [], ctx = k.ctx): Promise<T> {
  k.c.poll(k.jobId) // page is open
  let done = false
  const run = p()
  void run.then(() => { done = true }, () => { done = true })
  while (!done) {
    if (!(await cosignOnce(k.t, k.jobId, k.browser.share, ctx, (e) => events.push(e)))) await new Promise((r) => setTimeout(r, 2))
  }
  return run
}

const siwe = (address: string, at = new Date(NOW)) => createSiweMessage({ domain: 'api.fluence.dev', address: getAddress(address), uri: 'https://api.fluence.dev', version: '1', chainId: 8453, nonce: 'abcdefgh12345678', issuedAt: at })

const x402 = (from: string, o: { to?: string; value?: bigint; validBefore?: bigint } = {}): TypedDataToSign => ({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: getAddress(BASE_USDC) },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
  primaryType: 'TransferWithAuthorization',
  message: { from, to: o.to ?? FLUENCE_PAYEE, value: o.value ?? 10_000_000n, validAfter: BigInt(NOW / 1000 - 600), validBefore: o.validBefore ?? BigInt(NOW / 1000 + 300), nonce: '0x' + '11'.repeat(32) },
})

const permit = (owner: string, spender = COW_VAULT_RELAYER): TypedDataToSign => ({
  domain: { ...QUAI_SYNTH_PERMIT_DOMAIN, chainId: 8453, verifyingContract: BASE_QUAI },
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { owner, spender, value: 120n * 10n ** 18n, nonce: 0n, deadline: BigInt(NOW / 1000 + 3600) },
})

const order = (receiver: string, buyAmount = 11_880_000n): TypedDataToSign => ({
  domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 8453, verifyingContract: COW_SETTLEMENT },
  types: ORDER_TYPES as never,
  primaryType: 'Order',
  message: { sellToken: BASE_QUAI, buyToken: BASE_USDC, receiver, sellAmount: '120000000000000000000', buyAmount: buyAmount.toString(), validTo: NOW / 1000 + 1800, appData: '0x' + '22'.repeat(32), feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' },
})

describe('2-of-2 hatch key', () => {
  it('key generation gives both sides the same address, and the shards multiply into its key', async () => {
    const k = await keyed()
    expect(shareAddressOf(k.board)).toBe(getAddress(k.browser.address))
    expect(k.signer.address).toBe(getAddress(k.browser.address))
    const x = (BigInt(shareScalar(k.board)) * BigInt(shareScalar(k.browser.share))) % SECP256K1_N
    expect(privateKeyToAccount(`0x${x.toString(16).padStart(64, '0')}` as Hex).address).toBe(k.signer.address)
    // neither shard alone is the key
    for (const s of [k.board, k.browser.share]) expect(privateKeyToAccount(shareScalar(s)).address).not.toBe(k.signer.address)
  }, 30_000)

  it('signs EIP-191 and EIP-712 that verify against the shared address', async () => {
    const k = await keyed()
    const message = siwe(k.signer.address)
    const events: CosignEvent[] = []
    const sig = await withBrowser(k, () => k.signer.signMessage(message), events)
    expect(await recoverMessageAddress({ message, signature: sig })).toBe(k.signer.address)
    expect(events[0]).toMatchObject({ verdict: { ok: true, kind: 'siwe' } })
    expect(events.at(-1)).toMatchObject({ signed: true })

    for (const td of [x402(k.signer.address), permit(k.signer.address), order(k.signer.address)]) {
      const s = await withBrowser(k, () => k.signer.signTypedData(td))
      expect(await recoverTypedDataAddress({ ...(td as never), signature: s })).toBe(k.signer.address)
    }
  }, 30_000)

  it('the board alone cannot sign: no page, it fails fast; a silent page times out', async () => {
    const k = await keyed('job-away', { waitMs: 50 })
    await expect(k.signer.signMessage(siwe(k.signer.address))).rejects.toBeInstanceOf(MakerAway)
    expect(k.signer.ready()).toBe(false)
    k.c.poll(k.jobId)
    expect(k.signer.ready()).toBe(true)
    await expect(k.signer.signMessage(siwe(k.signer.address))).rejects.toThrow(/did not co-sign in time/)
  }, 30_000)

  it('the browser refuses anything but the hatch’s own signatures, and the board learns why', async () => {
    const k = await keyed('job-refuse')
    const other = '0x00000000000000000000000000000000000bad00'
    const bad: [string, () => Promise<Hex>][] = [
      ['arbitrary message', () => k.signer.signMessage('transfer everything to 0xBAD')],
      ['SIWE for another site', () => k.signer.signMessage(createSiweMessage({ domain: 'evil.example', address: k.signer.address, uri: 'https://evil.example', version: '1', chainId: 8453, nonce: 'abcdefgh12345678', issuedAt: new Date(NOW) }))],
      ['old SIWE', () => k.signer.signMessage(siwe(k.signer.address, new Date(NOW - 3600_000)))],
      ['payment to the board', () => k.signer.signTypedData(x402(k.signer.address, { to: other }))],
      ['payment too large', () => k.signer.signTypedData(x402(k.signer.address, { value: 10_000_001n }))],
      ['payment valid for a day', () => k.signer.signTypedData(x402(k.signer.address, { validBefore: BigInt(NOW / 1000 + 86400) }))],
      ['permit for another spender', () => k.signer.signTypedData(permit(k.signer.address, other))],
      ['order paying someone else', () => k.signer.signTypedData(order(other))],
      ['order dumping QUAI', () => k.signer.signTypedData(order(k.signer.address, 1n))],
      ['some other typed data', () => k.signer.signTypedData({ domain: { name: 'Permit2', chainId: 8453, verifyingContract: other }, types: { PermitTransferFrom: [{ name: 'spender', type: 'address' }] }, primaryType: 'PermitTransferFrom', message: { spender: other } })],
    ]
    for (const [label, sign] of bad) {
      const events: CosignEvent[] = []
      await expect(withBrowser(k, sign, events), label).rejects.toThrow(/refused to sign/)
      expect(events.some((e) => 'signed' in e), label).toBe(false)
    }
    // Fluence's payee unknown (Fluence unreachable): refuse rather than guess
    await expect(withBrowser(k, () => k.signer.signTypedData(x402(k.signer.address)), [], { ...k.ctx, fluencePayTo: async () => { throw new Error('offline') } })).rejects.toThrow(/could not confirm Fluence/)
  }, 30_000)

  it('the browser hashes the payload itself: a board showing one payload and signing another gets no signature', async () => {
    const k = await keyed('job-lie')
    const { P1Signature } = await import('@silencelaboratories/ecdsa-tss')
    const { party2Sign } = await import('../src/mpc.js')
    const shown = { type: 'typed' as const, typedData: wireTypedData(x402(k.signer.address)) }
    const hidden = digestOf({ type: 'message', message: 'anything else' })
    expect(await checkSignRequest(shown, k.ctx)).toMatchObject({ ok: true })
    const p1 = new P1Signature('gremlins-hatch-sign:job-lie:r1', hexToBytes(hidden), JSON.parse(k.board))
    const p2 = party2Sign(k.jobId, 'r1', k.browser.share, digestOf(shown))
    const m2 = (await p2.step((await p1.processMessage(null)).msg_to_send)).msg!
    const m4 = (await p2.step((await p1.processMessage(m2)).msg_to_send)).msg!
    await expect(p1.processMessage(m4)).rejects.toThrow(/Invalid signature/)
  }, 30_000)

  it('a bad final message from the browser freezes the board share for good (Lindell 2017 abort rule)', async () => {
    const k = await keyed('job-abort')
    k.c.poll(k.jobId)
    const sig = k.signer.signMessage(siwe(k.signer.address))
    let req = k.c.poll(k.jobId)
    while (!req) { await new Promise((r) => setTimeout(r, 2)); req = k.c.poll(k.jobId) }
    const { party2Sign } = await import('../src/mpc.js')
    const p2 = party2Sign(k.jobId, req.id, k.browser.share, digestOf(req.payload))
    const m3 = (await k.c.answer(k.jobId, req.id, { msg: (await p2.step(req.msg)).msg! })).msg
    const m4 = JSON.parse((await p2.step(m3)).msg!)
    m4.c3 = m4.c3.replace(/^./, (ch: string) => (ch === 'A' ? 'B' : 'A')) // tampered ciphertext
    await expect(k.c.answer(k.jobId, req.id, { msg: JSON.stringify(m4) })).rejects.toThrow()
    await expect(sig).rejects.toBeInstanceOf(MpcAbort)
    expect(k.signer.ready()).toBe(false)
    await expect(withBrowser(k, () => k.signer.signMessage(siwe(k.signer.address)))).rejects.toBeInstanceOf(MpcAbort)
    // a restarted board keeps the freeze when told (the job records it)
    expect(mpcCoordinator().signer(k.jobId, k.board, { aborted: true }).ready()).toBe(false)
  }, 30_000)

  it('pins the same addresses as @gremlins/treasury', () => {
    expect([BASE_USDC, BASE_QUAI, COW_SETTLEMENT, COW_VAULT_RELAYER]).toEqual([USDC[8453], QUAI_SYNTH[8453], COW.settlement, COW.vaultRelayer])
  })

  it('reads Fluence’s x402 payee from its own 402 answer', async () => {
    const req = { x402Version: 2, resource: { url: 'x', description: 'top-up', mimeType: 'application/json' }, accepts: [
      { scheme: 'exact', network: 'eip155:1', amount: '1', asset: '0x0', payTo: '0x0000000000000000000000000000000000000001', maxTimeoutSeconds: 300, extra: {} },
      { scheme: 'exact', network: 'eip155:8453', amount: '10000000', asset: BASE_USDC, payTo: FLUENCE_PAYEE, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    ] }
    const seen: string[] = []
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`)
      return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(req)).toString('base64') } })
    }) as unknown as typeof fetch
    expect(await fluencePayTo(10, { fetchImpl: f })).toEqual([FLUENCE_PAYEE])
    expect(seen).toEqual(['POST https://api.fluence.dev/v2/x402/top-up?amountUsd=10.00'])
    await expect(fluencePayTo(10, { fetchImpl: (async () => new Response('{}', { status: 200 })) as never })).rejects.toThrow(/not a payment request/)
  })

  it('accepts exactly the sign-in fluence().login() makes', async () => {
    const k = { hostingAddress: '0x98FD29419225BE522f886C3F14782bD91610bdcd' }
    const ctx: PolicyContext = { ...k, maxTopUpMicro: 10n, now: () => NOW, fluencePayTo: async () => [] }
    expect(await checkSignRequest({ type: 'message', message: siwe(k.hostingAddress) }, ctx)).toMatchObject({ ok: true, kind: 'siwe' })
    const extra = siwe(k.hostingAddress).replace('Version: 1', 'Version: 1\nResources:\n- https://evil.example')
    expect(await checkSignRequest({ type: 'message', message: extra }, ctx)).toMatchObject({ ok: false })
  })
})
