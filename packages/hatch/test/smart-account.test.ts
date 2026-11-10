import { describe, expect, it } from 'vitest'
import { AbiCoder, Signature, TypedDataEncoder, Wallet, getBytes, hashMessage, keccak256, verifyMessage } from 'ethers'
import { QUAI_SMART_WALLET_CODE_HASHES, SmartAccountVerifier, requestSigningPayload, verifyAttestationWith, verifySignedRequestWith } from '../src/index.js'

// Runtime code of a live Quai Smart Wallet proxy (0x006Da621…5166 on cyprus1, read with quai_getCode).
const PROXY_CODE = '0x6080604052366058573373ffffffffffffffffffffffffffffffffffffffff167f3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d346040518082815260200191505060405180910390a2005b73ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000000000000000000000000000000000000000000000000000600035141560a4578060005260206000f35b3660008037600080366000845af43d6000803e600081141560c4573d6000fd5b3d6000f3fea2646970667358221220004d49b5736bb9d97107ba3e0d838ea7d6bb44f4eaecbf4c704f383fa34b9bfb64736f6c63430007060033'
const SAFE = '0x006Da62157f676fc2aFa09A21AF7B6ABC68a5166'
const owner = Wallet.createRandom()
const SAFE_MESSAGE = { SafeMessage: [{ name: 'message', type: 'bytes' }] }
const safeMessageHash = (safe: string, dataHash: string) => TypedDataEncoder.hash({ chainId: 9, verifyingContract: safe }, SAFE_MESSAGE, { message: dataHash })

/** What the wallet host returns for signMessage: the owner's personal_sign over the SafeMessage digest, v + 4. */
async function safeSign(message: string, safe = SAFE, signer = owner) {
  const sig = Signature.from(await signer.signMessage(getBytes(safeMessageHash(safe, hashMessage(message)))))
  return sig.r + sig.s.slice(2) + (sig.v + 4).toString(16)
}

/** A cyprus1 RPC: quai_getCode from `codes`; quai_call runs the CompatibilityFallbackHandler's check for `owners`. */
function chain(opts: { codes?: Record<string, string>; owners?: Record<string, string>; answer?: string; fail?: boolean } = {}) {
  const calls: { method: string; params: any[] }[] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body))
    calls.push({ method, params })
    if (opts.fail) return new Response('bad gateway', { status: 502 })
    const reply = (x: object) => Response.json({ jsonrpc: '2.0', id, ...x })
    if (method === 'quai_getCode') {
      // Quai rejects addresses without a valid checksum.
      if (params[0] === params[0].toLowerCase()) return reply({ error: { code: -32000, message: 'address has invalid checksum' } })
      return reply({ result: opts.codes?.[params[0].toLowerCase()] ?? '0x' })
    }
    if (method === 'quai_call') {
      if (opts.answer) return reply({ result: opts.answer })
      const data: string = params[0].data
      expect(data.slice(0, 10)).toBe('0x1626ba7e')
      const [dataHash, sig] = AbiCoder.defaultAbiCoder().decode(['bytes32', 'bytes'], '0x' + data.slice(10))
      // Safe's checkSignatures: v > 30 means eth_sign over the SafeMessage hash, recovered with v - 4.
      const v = parseInt(sig.slice(130, 132), 16)
      if (v <= 30) return reply({ error: { code: 3, message: 'execution reverted: GS026' } })
      const signer = verifyMessage(getBytes(safeMessageHash(params[0].to, dataHash)), Signature.from({ r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130), v: v - 4 }))
      if (signer.toLowerCase() !== opts.owners?.[params[0].to.toLowerCase()]?.toLowerCase())
        return reply({ error: { code: 3, message: 'execution reverted: GS026' } })
      return reply({ result: '0x1626ba7e' + '0'.repeat(56) })
    }
    return reply({ error: { code: -32601, message: 'no such method' } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const safeChain = () => chain({ codes: { [SAFE.toLowerCase()]: PROXY_CODE }, owners: { [SAFE.toLowerCase()]: owner.address } })

describe('Quai Smart Wallet signatures (ERC-1271)', () => {
  it('pins the live proxy runtime', () => {
    expect(QUAI_SMART_WALLET_CODE_HASHES).toContain(keccak256(PROXY_CODE))
  })

  it('accepts a Safe signature the Safe vouches for, over the EIP-191 hash of the payload', async () => {
    const { fetch, calls } = safeChain()
    const v = new SmartAccountVerifier({ fetch })
    const sig = await safeSign('hello')
    expect(await v.isValidSignature(SAFE.toLowerCase(), 'hello', sig)).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['quai_getCode', 'quai_call'])
    expect(calls[0].params[0]).toBe(SAFE) // checksummed for Quai's RPC
    expect(calls[1].params[0].data.slice(10, 74)).toBe(hashMessage('hello').slice(2))
    // the code hash is cached
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(true)
    expect(calls.filter((c) => c.method === 'quai_getCode')).toHaveLength(1)
  })

  it('rejects a signature the Safe does not accept (other message, other signer)', async () => {
    const v = new SmartAccountVerifier(safeChain())
    expect(await v.isValidSignature(SAFE, 'other', await safeSign('hello'))).toBe(false)
    expect(await v.isValidSignature(SAFE, 'hello', await safeSign('hello', SAFE, Wallet.createRandom()))).toBe(false)
  })

  it('rejects contracts with another code hash, and EOAs, without asking them', async () => {
    const { fetch, calls } = chain({ codes: { [SAFE.toLowerCase()]: PROXY_CODE + '00' }, answer: '0x1626ba7e' + '0'.repeat(56) })
    const v = new SmartAccountVerifier({ fetch })
    expect(await v.isValidSignature(SAFE, 'hello', await safeSign('hello'))).toBe(false)
    expect(await v.isValidSignature(owner.address, 'hello', await safeSign('hello'))).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['quai_getCode', 'quai_getCode'])
  })

  it('accepts only the exact magic value', async () => {
    for (const answer of ['0x' + '0'.repeat(64), '0x1626ba7f' + '0'.repeat(56), '0x1626ba7e', '0x1626ba7e' + '0'.repeat(55) + '1']) {
      const { fetch } = chain({ codes: { [SAFE.toLowerCase()]: PROXY_CODE }, answer })
      expect(await new SmartAccountVerifier({ fetch }).isValidSignature(SAFE, 'hello', await safeSign('hello'))).toBe(false)
    }
  })

  it('fails closed when the RPC fails, and does not cache the failure', async () => {
    let down = true
    const up = safeChain()
    const fetch = ((...a: Parameters<typeof globalThis.fetch>) => (down ? chain({ fail: true }).fetch(...a) : up.fetch(...a))) as typeof globalThis.fetch
    const v = new SmartAccountVerifier({ fetch })
    const sig = await safeSign('hello')
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(false)
    const thrown = new SmartAccountVerifier({ fetch: (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch })
    expect(await thrown.isValidSignature(SAFE, 'hello', sig)).toBe(false)
    down = false
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(true)
  })

  it('keeps "not a smart account" only briefly (a Safe may be deployed there later)', async () => {
    const codes: Record<string, string> = {}
    const { fetch } = chain({ codes, owners: { [SAFE.toLowerCase()]: owner.address } })
    let now = 0
    const v = new SmartAccountVerifier({ fetch, now: () => now, negativeTtlMs: 60_000 })
    const sig = await safeSign('hello')
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(false)
    codes[SAFE.toLowerCase()] = PROXY_CODE
    now = 30_000
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(false)
    now = 61_000
    expect(await v.isValidSignature(SAFE, 'hello', sig)).toBe(true)
  })

  it('takes only one canonical owner signature (no replayable twins)', async () => {
    const { fetch, calls } = safeChain()
    const v = new SmartAccountVerifier({ fetch })
    const sig = await safeSign('hello')
    const s = BigInt('0x' + sig.slice(66, 130))
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const v8 = parseInt(sig.slice(130), 16)
    const highS = sig.slice(0, 66) + (N - s).toString(16).padStart(64, '0') + (v8 === 31 ? 32 : 31).toString(16)
    expect(await v.isValidSignature(SAFE, 'hello', highS)).toBe(false)
    expect(await v.isValidSignature(SAFE, 'hello', sig + '00'.repeat(65))).toBe(false)
    expect(await v.isValidSignature(SAFE, 'hello', '0x')).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('signed requests and attestations from either kind of account', () => {
  const req = (address: string, signature: string, ts = '1000') => ({
    method: 'POST', path: '/api/c/general/posts', body: '{"title":"hi","body":"there"}', nowSec: 1000, windowSec: 300,
    headers: { address, timestamp: ts, signature },
  })
  const payload = requestSigningPayload('POST', '/api/c/general/posts', '1000', '{"title":"hi","body":"there"}')

  it('an EOA signature verifies without the chain', async () => {
    const { fetch, calls } = safeChain()
    const r = await verifySignedRequestWith(req(owner.address, await owner.signMessage(payload)), new SmartAccountVerifier({ fetch }))
    expect(r).toEqual({ ok: true, address: owner.address.toLowerCase() })
    expect(calls).toHaveLength(0)
  })

  it('a Safe signature verifies through the Safe; without a checker it does not', async () => {
    const sig = await safeSign(payload)
    expect(await verifySignedRequestWith(req(SAFE, sig), new SmartAccountVerifier(safeChain()))).toEqual({ ok: true, address: SAFE.toLowerCase() })
    expect(await verifySignedRequestWith(req(SAFE, sig))).toMatchObject({ ok: false })
    expect(await verifySignedRequestWith(req(SAFE, sig, '1'), new SmartAccountVerifier(safeChain()))).toEqual({ ok: false, reason: 'stale timestamp' })
    expect(await verifySignedRequestWith(req(SAFE, await safeSign(payload + 'x')), new SmartAccountVerifier(safeChain()))).toEqual({ ok: false, reason: 'signature does not match address' })
  })

  it('a Safe author\'s attestation verifies, and still binds the shown content', async () => {
    const a = { method: 'POST', path: '/api/c/general/posts', timestamp: '1000', body: '{"title":"hi","body":"there"}', signature: await safeSign(payload) }
    const accounts = new SmartAccountVerifier(safeChain())
    expect(await verifyAttestationWith(a, SAFE, { title: 'hi', body: 'there' }, accounts)).toEqual({ ok: true })
    expect(await verifyAttestationWith(a, SAFE, { title: 'hi', body: 'edited' }, accounts)).toMatchObject({ ok: false, reason: '"body" differs from what the author signed' })
    expect(await verifyAttestationWith(a, owner.address, { title: 'hi', body: 'there' }, accounts)).toMatchObject({ ok: false })
  })
})
