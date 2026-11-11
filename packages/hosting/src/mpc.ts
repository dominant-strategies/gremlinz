/**
 * 2-of-2 ECDSA for hatch hosting accounts: neither the board nor the maker can sign alone, and the account key only
 * exists once the egg adds up the two shares sealed to it (key = x1 + x2 mod n).
 *
 * Coinbase's cb-mpc ECDSA-2PC (MIT; built to WebAssembly from a pinned commit by cbmpc/build.sh; cbmpc.ts drives it).
 * The board is party 1 (holds the Paillier key, gets the signature), the maker's browser party 2. cb-mpc's public
 * `sign` has party 2 prove its last message correct, so a failed signature leaks nothing and is simply that: a failed
 * session. Only its global-abort variant (which we don't use) can report a bit leak; that would freeze the job
 * (`MpcAbort`). Protocol state stays in memory on both sides; a lost session is started again.
 *
 *   keygen and sign: messages relayed through the board's HTTP routes as batches (JSON arrays of base64), each side
 *   stepping its run until both are done. The board posts every signing request with its payload (never just a
 *   digest); the browser checks it (mpc-policy.ts) and hashes it itself before taking part.
 *
 * This module is the only place that knows the protocol library.
 */
import { hashMessage, hashTypedData, hexToBytes, recoverAddress, toHex, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { CbmpcError, CbmpcRun, cbmpcPrivateShare, cbmpcPublicKey, type Parties } from './cbmpc.js'
import type { HostingSigner, TypedDataToSign } from './signer.js'

/** secp256k1 group order. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Typed data as it travels: bigints as decimal strings. */
export type WireTypedData = TypedDataToSign
export type SignPayload = { type: 'message'; message: string } | { type: 'typed'; typedData: WireTypedData }

/** What the board asks the browser to co-sign: the payload itself (never just a digest) and the board's first messages. */
export interface MpcSignRequest {
  id: string
  /** The board's label, for display only; the browser classifies the payload itself. */
  purpose: string
  payload: SignPayload
  msg: string
}

export type MpcAnswer = { msg: string } | { refuse: string }

/** cb-mpc reported a possible key-bit leak: the board share must never sign again. */
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

/** What the board keeps of the page's per-job secret (0x + 32 bytes hex): its SHA-256, 0x-hex. */
export async function mpcAuthOf(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret.toLowerCase()))
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** cb-mpc derives party ids from names; these are unique per hatch job. */
const parties = (jobId: string, self: 0 | 1): Parties => ({ self, p1: `gremlins-hatch-board:${jobId}`, p2: `gremlins-hatch-maker:${jobId}` })

// ---------------------------------------------------------------- wire encoding

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
/** A batch of protocol messages as one relay string. */
export const encodeBatch = (msgs: Uint8Array[]) => JSON.stringify(msgs.map(b64))
export function decodeBatch(s: string): Uint8Array[] {
  const a = JSON.parse(s) as unknown
  if (!Array.isArray(a) || a.length > 16 || !a.every((x) => typeof x === 'string')) throw new Error('malformed protocol messages')
  return a.map(unb64)
}

/** A key share (cb-mpc key blob) as stored: base64. Secret. */
const shareBytes = (share: string) => unb64(share)

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

/** r and s of a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }). */
function derRS(der: Uint8Array): [bigint, bigint] {
  let i = 0
  const len = () => {
    let n = der[i++]!
    if (n & 0x80) {
      const k = n & 0x7f
      n = 0
      for (let j = 0; j < k; j++) n = (n << 8) | der[i++]!
    }
    return n
  }
  if (der[i++] !== 0x30) throw new Error('not a DER signature')
  len()
  const int = () => {
    if (der[i++] !== 0x02) throw new Error('not a DER signature')
    const n = len()
    const v = BigInt(toHex(der.slice(i, i + n)))
    i += n
    return v
  }
  return [int(), int()]
}

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const modPow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n
  for (b %= m; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m
  return r
}
/** SEC1 compressed secp256k1 point → uncompressed (y² = x³ + 7, and p ≡ 3 mod 4). */
function decompress(c: Uint8Array): Hex {
  if (c.length !== 33 || (c[0] !== 2 && c[0] !== 3)) throw new Error('not a compressed public key')
  const x = BigInt(toHex(c.slice(1)))
  let y = modPow((x * x * x + 7n) % P, (P + 1n) / 4n, P)
  if ((y * y) % P !== (x * x * x + 7n) % P) throw new Error('not a point on secp256k1')
  if (Number(y & 1n) !== (c[0] & 1)) y = P - y
  return `0x04${x.toString(16).padStart(64, '0')}${y.toString(16).padStart(64, '0')}`
}

/** cb-mpc's DER signature → the 65-byte Ethereum form: low s (EIP-2; USDC's ecrecover insists), v found by recovery. */
async function ethSignature(der: Uint8Array, digest: Hex, address: Hex): Promise<Hex> {
  const [r, s0] = derRS(der)
  const s = s0 > SECP256K1_N / 2n ? SECP256K1_N - s0 : s0
  const rs = r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0')
  for (const v of [27, 28]) {
    const sig: Hex = `0x${rs}${v.toString(16)}`
    if ((await recoverAddress({ hash: digest, signature: sig })).toLowerCase() === address.toLowerCase()) return sig
  }
  throw new Error('signature does not recover to the hosting address')
}

/** The address of a share's joint public key. */
export async function shareAddressOf(share: string): Promise<Hex> {
  return publicKeyToAddress(decompress(await cbmpcPublicKey(shareBytes(share))))
}

/** This party's secret share x_i (mod n, 32-byte hex), for sealing to the egg. The key is x_1 + x_2 mod n. */
export async function shareScalar(share: string): Promise<Hex> {
  const x = BigInt(toHex(await cbmpcPrivateShare(shareBytes(share)))) % SECP256K1_N
  return `0x${x.toString(16).padStart(64, '0')}`
}

/** Step one side of a run with a relay batch; returns the reply batch and, when done, the result. */
async function relayStep<T>(run: CbmpcRun<T>, msg: string | null) {
  const r = await run.step(msg === null ? [] : decodeBatch(msg))
  return { msg: encodeBatch(r.out), done: r.done, result: r.done ? r.result : undefined }
}

// ---------------------------------------------------------------- party 2 (the maker's browser)

/** Party 2's key generation: feed it the board's batches until done; the result is the serialized share. */
export function party2Keygen(jobId: string) {
  const run = CbmpcRun.dkg(parties(jobId, 1))
  return {
    async step(msg: string): Promise<{ msg: string; done: boolean; share?: string; address?: Hex }> {
      const r = await relayStep(run, msg)
      if (!r.done) return { msg: r.msg, done: false }
      const share = b64(r.result!)
      return { msg: r.msg, done: true, share, address: await shareAddressOf(share) }
    },
    cancel: () => run.cancel(),
  }
}

/** Party 2's side of one signature over `digest` (computed by the caller from the payload it checked). */
export function party2Sign(jobId: string, reqId: string, share: string, digest: Hex) {
  void reqId // cb-mpc agrees a fresh session id inside the protocol
  const run = CbmpcRun.sign(parties(jobId, 1), shareBytes(share), hexToBytes(digest))
  return {
    step: async (msg: string): Promise<{ msg: string; done: boolean }> => {
      const r = await relayStep(run, msg)
      return { msg: r.msg, done: r.done }
    },
    cancel: () => run.cancel(),
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
  const keygens = new Map<string, CbmpcRun<Uint8Array>>()
  const seen = new Map<string, number>()
  const aborted = new Set<string>()
  type Pending = { req: MpcSignRequest; run: CbmpcRun<Uint8Array | null>; address: Hex; digest: Hex; resolve: (s: Hex) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  const pending = new Map<string, Pending>()

  const settle = (jobId: string, p: Pending, e: Error | null, sig?: Hex) => {
    clearTimeout(p.timer)
    if (pending.get(jobId) === p) pending.delete(jobId)
    if (e) {
      p.run.cancel()
      p.reject(e)
    } else p.resolve(sig!)
  }

  const present = (jobId: string) => now() - (seen.get(jobId) ?? -Infinity) <= presenceMs

  async function sign(jobId: string, address: Hex, share: string, purpose: string, payload: SignPayload): Promise<Hex> {
    if (aborted.has(jobId)) throw new MpcAbort('cb-mpc reported a key-bit leak earlier')
    if (!present(jobId)) throw new MakerAway()
    if (pending.has(jobId)) throw new Error('another signature is in progress for this hatch')
    const digest = digestOf(payload)
    const id = crypto.randomUUID()
    const run = CbmpcRun.sign(parties(jobId, 0), shareBytes(share), hexToBytes(digest))
    const first = await relayStep(run, null)
    return new Promise<Hex>((resolve, reject) => {
      const p: Pending = { req: { id, purpose, payload, msg: first.msg }, run, address, digest, resolve, reject, timer: setTimeout(() => settle(jobId, p, new MakerAway("the maker's hatch page did not co-sign in time")), waitMs) }
      pending.set(jobId, p)
    })
  }

  return {
    /** Party 1's key generation: `null` starts (or restarts) it; then each browser batch until done (share + address). */
    async keygen(jobId: string, msg: string | null): Promise<{ msg: string; done: boolean; share?: string; address?: Hex }> {
      let run = keygens.get(jobId)
      if (msg === null) {
        run?.cancel()
        keygens.set(jobId, (run = CbmpcRun.dkg(parties(jobId, 0))))
      } else if (!run) throw new Error('no key generation in progress; start again')
      try {
        const r = await relayStep(run, msg)
        if (!r.done) return { msg: r.msg, done: false }
        keygens.delete(jobId)
        const share = b64(r.result!)
        return { msg: r.msg, done: true, share, address: await shareAddressOf(share) }
      } catch (e) {
        keygens.delete(jobId)
        throw e
      }
    },

    /** The browser asks for work; this is also how we know its page is open. */
    poll(jobId: string): MpcSignRequest | null {
      seen.set(jobId, now())
      return pending.get(jobId)?.req ?? null
    },

    /** The browser's next batch (or its refusal) for request `reqId`. `done`: the board has its signature. */
    async answer(jobId: string, reqId: string, a: MpcAnswer): Promise<{ msg: string; done: boolean }> {
      seen.set(jobId, now())
      const p = pending.get(jobId)
      if (!p || p.req.id !== reqId) throw new Error('no such signing request (expired or done)')
      if ('refuse' in a) {
        settle(jobId, p, new Error(`the maker's hatch page refused to sign ${p.req.purpose}: ${String(a.refuse).slice(0, 200)}`))
        return { msg: encodeBatch([]), done: true }
      }
      try {
        const r = await relayStep(p.run, a.msg)
        if (r.done) settle(jobId, p, null, await ethSignature(r.result!, p.digest, p.address))
        return { msg: r.msg, done: r.done }
      } catch (e) {
        if (e instanceof CbmpcError && e.bitLeak) {
          aborted.add(jobId)
          settle(jobId, p, new MpcAbort(e.message))
        } else settle(jobId, p, e as Error)
        throw e
      }
    },

    present,

    /** A HostingSigner for a job: the board's `share` of the account at `address`. `aborted` restores a recorded freeze. */
    signer(jobId: string, share: string, address: string, opts: { aborted?: boolean } = {}): MpcSigner {
      if (opts.aborted) aborted.add(jobId)
      const a = address as Hex
      return {
        address: a,
        ready: () => present(jobId) && !aborted.has(jobId),
        signMessage: (message) => sign(jobId, a, share, 'a Fluence sign-in', { type: 'message', message }),
        signTypedData: (td) => sign(jobId, a, share, td.primaryType, { type: 'typed', typedData: wireTypedData(td) }),
      }
    },

    /** Drop everything held for a job (after hand-over). */
    forget(jobId: string) {
      keygens.get(jobId)?.cancel()
      keygens.delete(jobId)
      seen.delete(jobId)
      const p = pending.get(jobId)
      if (p) settle(jobId, p, new Error('hatch closed'))
    },
  }
}
export type MpcCoordinator = ReturnType<typeof mpcCoordinator>
