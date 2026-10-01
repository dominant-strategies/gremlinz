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
 */
import { keccak256, toUtf8Bytes, verifyMessage, type Signer } from 'ethers'

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

/** Client helper: headers for a signed board request. */
export async function signRequest(signer: Signer, method: string, path: string, body: string, nowSec = Math.floor(Date.now() / 1000)) {
  const signature = await signer.signMessage(requestSigningPayload(method, path, nowSec, body))
  return {
    [AUTH_HEADERS.address]: await signer.getAddress(),
    [AUTH_HEADERS.timestamp]: String(nowSec),
    [AUTH_HEADERS.signature]: signature,
  }
}
