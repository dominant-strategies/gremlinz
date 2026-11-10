/**
 * Signed-request auth for board writes (posts, comments, votes, communities).
 *
 * The client signs, with EIP-191 personal_sign (ethers `signer.signMessage`, Pelagus `personal_sign`):
 *
 *     `${METHOD} ${path}\n${timestamp}\n${keccak256(body)}`
 *
 * - METHOD is upper case; path is the URL pathname without query string (e.g. `/api/c/general/posts`).
 * - timestamp is unix seconds and must be within `windowSec` of the server clock.
 * - keccak256(body) is the 0x-prefixed hex hash of the exact UTF-8 request body bytes (empty body → hash of "").
 *
 * Headers: x-gremlins-address, x-gremlins-timestamp, x-gremlins-signature.
 * Pure functions here; replay protection (one use per signature) is done by the caller via the store.
 *
 * The address is an EOA (the signature recovers to it) or a Quai Smart Wallet Safe, which signs the same payload
 * through ERC-1271: the `...With` variants take a checker for those (smart-account.ts).
 */
import { keccak256, toUtf8Bytes, verifyMessage, type Signer } from 'ethers'
import type { AccountSignatureChecker } from './smart-account.js'

export const AUTH_HEADERS = {
  address: 'x-gremlins-address',
  timestamp: 'x-gremlins-timestamp',
  signature: 'x-gremlins-signature',
} as const

export function requestSigningPayload(method: string, path: string, timestamp: number | string, body: string): string {
  return `${method.toUpperCase()} ${path}\n${timestamp}\n${keccak256(toUtf8Bytes(body))}`
}

export type AuthResult = { ok: true; address: string } | { ok: false; reason: string }

export function verifySignedRequest(req: {
  method: string
  path: string
  body: string
  headers: { address?: string | null; timestamp?: string | null; signature?: string | null }
  nowSec: number
  windowSec: number
}): AuthResult {
  const { address, timestamp, signature } = req.headers
  if (!address || !timestamp || !signature) return { ok: false, reason: 'missing auth headers' }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, reason: 'malformed address' }
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'malformed timestamp' }
  if (Math.abs(req.nowSec - Number(timestamp)) > req.windowSec) return { ok: false, reason: 'stale timestamp' }
  let recovered: string
  try {
    recovered = verifyMessage(requestSigningPayload(req.method, req.path, timestamp, req.body), signature)
  } catch {
    return { ok: false, reason: 'malformed signature' }
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) return { ok: false, reason: 'signature does not match address' }
  return { ok: true, address: address.toLowerCase() }
}

/** verifySignedRequest, also accepting smart-account (ERC-1271) signatures when `accounts` is given. */
export async function verifySignedRequestWith(req: Parameters<typeof verifySignedRequest>[0], accounts?: AccountSignatureChecker): Promise<AuthResult> {
  const r = verifySignedRequest(req)
  if (r.ok || !accounts || (r.reason !== 'malformed signature' && r.reason !== 'signature does not match address')) return r
  const { address, timestamp, signature } = req.headers as { address: string; timestamp: string; signature: string }
  if (!(await accounts.isValidSignature(address, requestSigningPayload(req.method, req.path, timestamp, req.body), signature)))
    return { ok: false, reason: 'signature does not match address' }
  return { ok: true, address: address.toLowerCase() }
}

/** Client helper: headers for a signed board request. */
export async function signRequest(signer: Signer, method: string, path: string, body: string, nowSec = Math.floor(Date.now() / 1000)) {
  const signature = await signer.signMessage(requestSigningPayload(method, path, nowSec, body))
  return {
    [AUTH_HEADERS.address]: await signer.getAddress(),
    [AUTH_HEADERS.timestamp]: String(nowSec),
    [AUTH_HEADERS.signature]: signature,
  }
}

/**
 * A signed board write kept with what it created (a post, a comment), so anyone can check, without trusting the
 * board, that the author's key signed exactly this content: re-derive the signing payload from the stored request
 * and recover the signer. `body` is the exact request body that was signed.
 */
export interface Attestation {
  method: string
  path: string
  timestamp: string
  body: string
  signature: string
}

/** The address that signed this attestation, or null when it does not verify. No time window: it is a record. */
export function attestationSigner(a: Attestation): string | null {
  try {
    return verifyMessage(requestSigningPayload(a.method, a.path, a.timestamp, a.body), a.signature)
  } catch {
    return null
  }
}

/**
 * Does the attestation prove that `author` wrote this content? The signer must be the author, and the signed body
 * must carry the same fields the board shows (so the board cannot alter text after signing).
 */
export function verifyAttestation(a: Attestation | null | undefined, author: string, shown: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (!a) return { ok: false, reason: 'no signature stored' }
  const signer = attestationSigner(a)
  if (!signer) return { ok: false, reason: 'malformed signature' }
  if (signer.toLowerCase() !== author.toLowerCase()) return { ok: false, reason: `signed by ${signer}, not the author` }
  return signedShown(a, shown)
}

/** verifyAttestation, also accepting a smart-account author whose account vouches for the signature (ERC-1271, so as its owners stand now). */
export async function verifyAttestationWith(a: Attestation | null | undefined, author: string, shown: Record<string, unknown>, accounts?: AccountSignatureChecker): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = verifyAttestation(a, author, shown)
  if (r.ok || !a || !accounts || !/^(malformed signature|signed by )/.test(r.reason)) return r
  if (!(await accounts.isValidSignature(author, requestSigningPayload(a.method, a.path, a.timestamp, a.body), a.signature))) return r
  return signedShown(a, shown)
}

/** The signed body must carry the same fields the board shows (so the board cannot alter text after signing). */
function signedShown(a: Attestation, shown: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  let signed: Record<string, unknown>
  try { signed = JSON.parse(a.body) } catch { return { ok: false, reason: 'signed body is not JSON' } }
  const norm = (x: unknown) => (x === undefined || x === null || x === '' ? null : x) // omitted = empty
  for (const [k, v] of Object.entries(shown)) {
    if (norm(v) !== norm(signed[k])) return { ok: false, reason: `"${k}" differs from what the author signed` }
  }
  return { ok: true }
}
