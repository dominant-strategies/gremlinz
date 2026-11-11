/**
 * 2-of-2 ECDSA for hatch hosting accounts: neither the board nor the maker can sign alone, and the account key only
 * exists once the egg multiplies the two shards sealed to it (key = x1·x2 mod n).
 *
 * Lindell 2017 two-party ECDSA (@silencelaboratories/ecdsa-tss, Cure53-audited, plain JS: same code in Node and the
 * browser). The board is party 1: it holds the Paillier key, starts every session and checks the final signature. The
 * maker's browser is party 2. Protocol state stays in memory on both sides; a lost session is simply started again.
 *
 * Lindell 2017 leaks party 1's share bit by bit if party 1 keeps signing after a final signature fails its check, so
 * any failure at that step aborts for good (`MpcAbort`): the caller must freeze the job.
 *
 *   keygen:  board ─msg1─► browser ─msg2─► board ─msg3─► browser          (address = shared public key)
 *   sign:    board posts {payload, msg1}; browser checks the payload (mpc-policy.ts), then
 *            ─msg2─► board ─msg3─► browser ─msg4─► board ─msg5 + signature─► browser
 *
 * This module is the only place that knows the library; swapping it (e.g. for DKLs23) touches nothing else.
 */
import { P1KeyGen, P1Signature, P2KeyGen, P2Signature, type IP1KeyShare, type IP2KeyShare } from '@silencelaboratories/ecdsa-tss'
import { hashMessage, hashTypedData, hexToBytes, recoverAddress, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import type { HostingSigner, TypedDataToSign } from './signer.js'

/** secp256k1 group order. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Typed data as it travels: bigints as decimal strings. */
export type WireTypedData = TypedDataToSign
export type SignPayload = { type: 'message'; message: string } | { type: 'typed'; typedData: WireTypedData }

/** What the board asks the browser to co-sign: the payload itself (never just a digest) and party 1's first message. */
export interface MpcSignRequest {
  id: string
  /** The board's label, for display only; the browser classifies the payload itself. */
  purpose: string
  payload: SignPayload
  msg: string
}

export type MpcAnswer = { msg: string } | { refuse: string }

/** The final signature check failed: party 1 must never sign with this share again. */
export class MpcAbort extends Error {
  constructor(why: string) {
    super(`2-of-2 signing aborted for good: ${why}`)
  }
}

/** The maker's hatch page isn't there to co-sign. */
export class MakerAway extends Error {
  constructor(why = "the maker's hatch page is not open (it holds the second key share); waiting for it") {
    super(why)
  }
}

export const keygenSessionId = (jobId: string) => `gremlins-hatch-keygen:${jobId}`
export const signSessionId = (jobId: string, reqId: string) => `gremlins-hatch-sign:${jobId}:${reqId}`

const jsonSafe = (v: unknown): unknown =>
  typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(jsonSafe) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)])) : v

/** Typed data ready for the wire (bigints → strings, no EIP712Domain entry). */
export function wireTypedData(td: TypedDataToSign): WireTypedData {
  const { EIP712Domain: _d, ...types } = td.types as Record<string, unknown>
  return jsonSafe({ ...td, types }) as WireTypedData
}

type Field = { name: string; type: string }
/** Back to bigints for every (u)int field, so hashing doesn't depend on how numbers travelled. */
function withBigInts(types: Record<string, Field[]>, type: string, v: unknown): unknown {
  const arr = /^(.*)\[\d*\]$/.exec(type)
  if (arr) return (v as unknown[]).map((x) => withBigInts(types, arr[1]!, x))
  if (/^u?int\d*$/.test(type)) return BigInt(v as string)
  const fields = types[type]
  if (!fields) return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(fields.map((f) => [f.name, withBigInts(types, f.type, o[f.name])]))
}

export function digestOf(p: SignPayload): Hex {
  if (p.type === 'message') return hashMessage(p.message)
  const td = wireTypedData(p.typedData)
  const types = td.types as Record<string, Field[]>
  const domain = { ...td.domain } as Record<string, unknown>
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId)
  return hashTypedData({ domain, types, primaryType: td.primaryType, message: withBigInts(types, td.primaryType, td.message) as Record<string, unknown> } as never)
}

const sigHex = (rs: string, recid: number): Hex => `0x${rs}${(27 + recid).toString(16)}`
const shareAddress = (publicKeyHex: string): Hex => publicKeyToAddress(`0x04${publicKeyHex.replace(/^0x/, '').replace(/^04(?=[0-9a-f]{128}$)/i, '')}`)

/** The secret scalar of a serialized share (party 1's x1 or party 2's x2), for sealing to the egg. */
export function shareScalar(share: string): Hex {
  const s = JSON.parse(share) as Partial<IP1KeyShare & IP2KeyShare>
  const x = s.x1 ?? s.x2
  if (!x) throw new Error('not a key share')
  return `0x${x.padStart(64, '0')}`
}
export const shareAddressOf = (share: string): Hex => shareAddress((JSON.parse(share) as { public_key: string }).public_key)

// ---------------------------------------------------------------- party 2 (the maker's browser)

/** Party 2's key generation: answer msg1, then check msg3's proofs. Returns the serialized share and the address. */
export function party2Keygen(jobId: string) {
  const p2 = new P2KeyGen(keygenSessionId(jobId))
  return {
    first: async (msg1: string) => (await p2.processMessage(msg1)).msg_to_send!,
    async finish(msg3: string): Promise<{ share: string; address: Hex }> {
      const r = await p2.processMessage(msg3)
      if (!r.p2_key_share) throw new Error('key generation did not finish')
      return { share: JSON.stringify(r.p2_key_share), address: shareAddress(r.p2_key_share.public_key) }
    },
  }
}

/** Party 2's side of one signature over `digest` (computed by the caller from the payload it checked). */
export function party2Sign(jobId: string, reqId: string, share: string, digest: Hex) {
  const p2 = new P2Signature(signSessionId(jobId, reqId), hexToBytes(digest), JSON.parse(share) as IP2KeyShare)
  return {
    /** msg1 → msg2, msg3 → msg4, msg5 → done (party 2 checks the final signature itself). */
    step: async (msg: string): Promise<{ msg: string | null; done: boolean }> => {
      const r = await p2.processMessage(msg)
      return { msg: r.msg_to_send, done: !!r.signature }
    },
  }
}

// ---------------------------------------------------------------- party 1 (the board)

export interface MpcSigner extends HostingSigner {
  /** Is the maker's page there to co-sign? */
  ready(): boolean
}

/**
 * The board's side: key generation sessions, the signing queue the browser polls, and an `MpcSigner` per job. In
 * memory (one process): a restart drops sessions in flight, and they start again.
 */
export function mpcCoordinator(o: { waitMs?: number; presenceMs?: number; now?: () => number } = {}) {
  const waitMs = o.waitMs ?? 120_000
  const presenceMs = o.presenceMs ?? 30_000
  const now = o.now ?? Date.now
  const keygens = new Map<string, P1KeyGen>()
  const seen = new Map<string, number>()
  const aborted = new Set<string>()
  type Pending = { req: MpcSignRequest; p1: P1Signature; round: number; address: Hex; digest: Hex; resolve: (s: Hex) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  const pending = new Map<string, Pending>()

  const settle = (jobId: string, p: Pending, e: Error | null, sig?: Hex) => {
    clearTimeout(p.timer)
    if (pending.get(jobId) === p) pending.delete(jobId)
    if (e) p.reject(e)
    else p.resolve(sig!)
  }

  const present = (jobId: string) => now() - (seen.get(jobId) ?? -Infinity) <= presenceMs

  async function sign(jobId: string, address: Hex, share: string, purpose: string, payload: SignPayload): Promise<Hex> {
    if (aborted.has(jobId)) throw new MpcAbort('an earlier signature failed its check')
    if (!present(jobId)) throw new MakerAway()
    if (pending.has(jobId)) throw new Error('another signature is in progress for this hatch')
    const digest = digestOf(payload)
    const id = crypto.randomUUID()
    const p1 = new P1Signature(signSessionId(jobId, id), hexToBytes(digest), JSON.parse(share) as IP1KeyShare)
    const msg = (await p1.processMessage(null)).msg_to_send
    return new Promise<Hex>((resolve, reject) => {
      const p: Pending = { req: { id, purpose, payload, msg }, p1, round: 0, address, digest, resolve, reject, timer: setTimeout(() => settle(jobId, p, new MakerAway("the maker's hatch page did not co-sign in time")), waitMs) }
      pending.set(jobId, p)
    })
  }

  return {
    /** Party 1's key generation: `null` starts (or restarts) it and returns msg1; msg2 returns msg3 and the share. */
    async keygen(jobId: string, msg: string | null): Promise<{ msg: string; share?: string; address?: Hex }> {
      if (msg === null) {
        const p1 = new P1KeyGen(keygenSessionId(jobId))
        await p1.init() // Paillier key generation: about a second
        keygens.set(jobId, p1)
        return { msg: (await p1.processMessage(null)).msg_to_send }
      }
      const p1 = keygens.get(jobId)
      if (!p1) throw new Error('no key generation in progress; start again')
      keygens.delete(jobId)
      const r = await p1.processMessage(msg)
      if (!r.p1_key_share) throw new Error('key generation did not finish')
      return { msg: r.msg_to_send, share: JSON.stringify(r.p1_key_share), address: shareAddress(r.p1_key_share.public_key) }
    },

    /** The browser asks for work; this is also how we know its page is open. */
    poll(jobId: string): MpcSignRequest | null {
      seen.set(jobId, now())
      return pending.get(jobId)?.req ?? null
    },

    /** The browser's next message (or its refusal) for request `reqId`. */
    async answer(jobId: string, reqId: string, a: MpcAnswer): Promise<{ msg: string; done: boolean }> {
      seen.set(jobId, now())
      const p = pending.get(jobId)
      if (!p || p.req.id !== reqId) throw new Error('no such signing request (expired or done)')
      if ('refuse' in a) {
        settle(jobId, p, new Error(`the maker's hatch page refused to sign ${p.req.purpose}: ${String(a.refuse).slice(0, 200)}`))
        return { msg: '', done: true }
      }
      const round = ++p.round
      try {
        const r = await p.p1.processMessage(a.msg)
        if (round === 1) return { msg: r.msg_to_send, done: false }
        // Round 2 decrypted the browser's share of s and checked the signature: success or abort, nothing between.
        const sig = sigHex(r.signature!, r.recid!)
        if ((await recoverAddress({ hash: p.digest, signature: sig })).toLowerCase() !== p.address.toLowerCase()) throw new Error('signature does not recover to the hosting address')
        settle(jobId, p, null, sig)
        return { msg: r.msg_to_send, done: true }
      } catch (e) {
        if (round >= 2) {
          aborted.add(jobId)
          settle(jobId, p, new MpcAbort((e as Error).message))
        } else settle(jobId, p, e as Error)
        throw e
      }
    },

    present,

    /** A HostingSigner for a job whose board share is `share`. `aborted` restores a freeze recorded on the job. */
    signer(jobId: string, share: string, opts: { aborted?: boolean } = {}): MpcSigner {
      if (opts.aborted) aborted.add(jobId)
      const address = shareAddressOf(share)
      return {
        address,
        ready: () => present(jobId) && !aborted.has(jobId),
        signMessage: (message) => sign(jobId, address, share, 'a Fluence sign-in', { type: 'message', message }),
        signTypedData: (td) => sign(jobId, address, share, td.primaryType, { type: 'typed', typedData: wireTypedData(td) }),
      }
    },

    /** Drop everything held for a job (after hand-over). */
    forget(jobId: string) {
      keygens.delete(jobId)
      seen.delete(jobId)
      const p = pending.get(jobId)
      if (p) settle(jobId, p, new Error('hatch closed'))
    },
  }
}
export type MpcCoordinator = ReturnType<typeof mpcCoordinator>
