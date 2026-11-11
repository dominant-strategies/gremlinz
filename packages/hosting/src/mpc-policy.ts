/**
 * What the maker's browser agrees to co-sign for a hatch, and nothing else. The board asks; the browser decides from
 * the payload alone (it hashes it itself), so a compromised board can't slip in a transfer to itself, a permit for
 * someone else, or a dumping order. Four kinds:
 *
 *   siwe        exactly the Fluence sign-in `fluence().login()` builds, for the hosting address, issued just now
 *   x402        USDC on Base TransferWithAuthorization from the hosting address to an address Fluence's own 402
 *               answer names, at most the job's top-up, valid ≤ 1 h
 *   cow-permit  EIP-2612 on QUAI-on-Base, owner the hosting address, spender CoW's vault relayer, deadline ≤ 2 h
 *   cow-order   GPv2 on Base: sell QUAI for USDC to the hosting address, fill-or-kill, valid ≤ 1 h, at least 95% of
 *               what the browser's own CoW quote says
 *
 * Addresses are pinned here, not taken from any config the board could serve (same values as @gremlins/treasury).
 */
import { formatUnits, getAddress, isAddressEqual } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import type { SignPayload } from './mpc.js'

export const BASE_CHAIN_ID = 8453
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const BASE_QUAI = '0x5c97D726bf5130AE15408cE32bc764e458320D2f'
export const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
/** A hatch never tops up more than this, whatever the job says. */
export const MAX_HATCH_TOPUP_USD = 50

export type SignKind = 'siwe' | 'x402' | 'cow-permit' | 'cow-order'

export interface PolicyContext {
  hostingAddress: string
  /** The job's top-up in USDC micro-units (capped at MAX_HATCH_TOPUP_USD). */
  maxTopUpMicro: bigint
  /** ms */
  now: () => number
  /** Where Fluence says x402 payments go: asked of Fluence directly (`fluencePayTo`), never of the board. */
  fluencePayTo: () => Promise<string[]>
  /** USDC (micro) the browser's own CoW quote gives for `sellAmount` QUAI; without it orders are refused. */
  cowQuote?: (sellAmount: bigint) => Promise<bigint>
}

export type Verdict = { ok: true; kind: SignKind; summary: string } | { ok: false; reason: string }

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
  Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
  ],
} as const

const DOMAINS = {
  TransferWithAuthorization: { name: 'USD Coin', version: '2', chainId: BASE_CHAIN_ID, verifyingContract: BASE_USDC },
  Permit: { name: 'Symbiosis', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: BASE_QUAI },
  Order: { name: 'Gnosis Protocol', version: 'v2', chainId: BASE_CHAIN_ID, verifyingContract: COW_SETTLEMENT },
} as const

const no = (reason: string): Verdict => ({ ok: false, reason })
const same = (a: unknown, b: string) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && isAddressEqual(a as `0x${string}`, b as `0x${string}`)
const big = (v: unknown): bigint | undefined => {
  try {
    return typeof v === 'bigint' ? v : typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? BigInt(v) : undefined
  } catch {
    return undefined
  }
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Is `payload` one of the signatures this hatch needs? */
export async function checkSignRequest(payload: SignPayload, ctx: PolicyContext): Promise<Verdict> {
  const me = getAddress(ctx.hostingAddress)
  const nowS = Math.floor(ctx.now() / 1000)

  if (payload.type === 'message') {
    let p: ReturnType<typeof parseSiweMessage>
    try {
      p = parseSiweMessage(payload.message)
    } catch {
      return no('not a sign-in message')
    }
    if (!p.nonce || !p.issuedAt) return no('sign-in message without nonce or time')
    // Rebuild what fluence().login() makes from the nonce and time alone: any other line, field or value is refused.
    const expected = createSiweMessage({ domain: 'api.fluence.dev', address: me, uri: 'https://api.fluence.dev', version: '1', chainId: BASE_CHAIN_ID, nonce: p.nonce, issuedAt: p.issuedAt })
    if (expected !== payload.message) return no('not a Fluence sign-in for the hosting address')
    if (Math.abs(p.issuedAt.getTime() - ctx.now()) > 10 * 60_000) return no('sign-in message is not from just now')
    return { ok: true, kind: 'siwe', summary: `Sign in to Fluence as the egg's hosting account ${short(me)}` }
  }

  const td = payload.typedData
  const pt = td.primaryType as keyof typeof TYPES
  if (!(pt in TYPES)) return no(`unexpected typed data ${String(td.primaryType).slice(0, 40)}`)
  const types = td.types as Record<string, unknown>
  if (Object.keys(types).filter((k) => k !== 'EIP712Domain').join() !== pt || JSON.stringify(types[pt]) !== JSON.stringify(TYPES[pt])) return no(`unexpected ${pt} type definition`)
  const want = DOMAINS[pt]
  const d = td.domain
  if (d.name !== want.name || d.version !== want.version || Number(d.chainId) !== want.chainId || !same(d.verifyingContract, want.verifyingContract) || Object.keys(d).length !== 4)
    return no(`${pt} for an unexpected contract or chain`)
  const m = td.message

  if (pt === 'TransferWithAuthorization') {
    const value = big(m.value), validBefore = big(m.validBefore)
    if (!same(m.from, me)) return no('payment not from the hosting address')
    if (value === undefined || value <= 0n || value > ctx.maxTopUpMicro) return no(`payment of ${String(m.value)} is more than this hatch's top-up`)
    if (validBefore === undefined || validBefore > BigInt(nowS + 3600)) return no('payment authorization valid for too long')
    let payTo: string[]
    try {
      payTo = await ctx.fluencePayTo()
    } catch (e) {
      return no(`could not confirm Fluence's payment address: ${(e as Error).message}`)
    }
    if (!payTo.some((a) => same(m.to, a))) return no(`payment to ${String(m.to)}, which Fluence does not name`)
    return { ok: true, kind: 'x402', summary: `Pay Fluence $${Number(formatUnits(value, 6)).toFixed(2)} USDC from ${short(me)} (x402, valid until ${new Date(Number(validBefore) * 1000).toISOString().slice(11, 16)} UTC)` }
  }

  if (pt === 'Permit') {
    const deadline = big(m.deadline), value = big(m.value)
    if (!same(m.owner, me)) return no('permit not for the hosting address')
    if (!same(m.spender, COW_VAULT_RELAYER)) return no('permit for a spender other than CoW')
    if (value === undefined || big(m.nonce) === undefined || deadline === undefined || deadline > BigInt(nowS + 7200)) return no('permit valid for too long')
    return { ok: true, kind: 'cow-permit', summary: `Let CoW Protocol sell up to ${formatUnits(value, 18)} QUAI from ${short(me)} (for the USDC swap)` }
  }

  // Order
  const sell = big(m.sellAmount), buy = big(m.buyAmount), validTo = big(m.validTo)
  if (!same(m.sellToken, BASE_QUAI) || !same(m.buyToken, BASE_USDC)) return no('order is not QUAI → USDC')
  if (!same(m.receiver, me)) return no('order pays someone other than the hosting address')
  if (m.kind !== 'sell' || m.partiallyFillable !== false || m.sellTokenBalance !== 'erc20' || m.buyTokenBalance !== 'erc20') return no('unexpected order flags')
  if (sell === undefined || buy === undefined || big(m.feeAmount) !== 0n) return no('malformed order amounts')
  if (validTo === undefined || validTo > BigInt(nowS + 3600)) return no('order valid for too long')
  if (!ctx.cowQuote) return no('no CoW quote to check the price against')
  let quoted: bigint
  try {
    quoted = await ctx.cowQuote(sell)
  } catch (e) {
    return no(`could not check the price on CoW: ${(e as Error).message}`)
  }
  if (buy * 100n < quoted * 95n) return no(`order asks only ${formatUnits(buy, 6)} USDC; CoW quotes ${formatUnits(quoted, 6)}`)
  return { ok: true, kind: 'cow-order', summary: `Sell ${formatUnits(sell, 18)} QUAI for at least ${Number(formatUnits(buy, 6)).toFixed(2)} USDC to ${short(me)} on CoW` }
}
