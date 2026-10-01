/**
 * Sealed boxes for moving a gremlin's seed between servers.
 *
 * ECIES on secp256k1: a fresh ephemeral key does ECDH with the recipient's public key, HKDF-SHA256 derives an
 * AES-256-GCM key, and the ephemeral public key travels with the ciphertext. Only the holder of the recipient's
 * private key can open it. Web Crypto + ethers only, so it runs in Node and browsers.
 */
import { SigningKey, getBytes, hexlify, keccak256, solidityPacked, randomBytes, toUtf8Bytes } from 'ethers'

export interface Sealed {
  v: 1
  /** Sender's ephemeral public key (uncompressed, 0x04…). */
  epk: string
  iv: string
  /** AES-GCM ciphertext including the auth tag. */
  ct: string
}

const INFO = toUtf8Bytes('gremlins-seal-v1')
/** Web Crypto wants ArrayBuffer-backed views (not SharedArrayBuffer); copy to be explicit. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u)

async function aesKey(shared: string, epk: string, rpk: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', buf(getBytes(shared)), 'HKDF', false, ['deriveKey'])
  // Bind the key to both public keys so a ciphertext can't be replayed under a different recipient.
  const salt = buf(getBytes(keccak256(solidityPacked(['bytes', 'bytes'], [epk, rpk]))))
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: buf(INFO) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function seal(recipientPublicKey: string, plaintext: Uint8Array): Promise<Sealed> {
  const rpk = SigningKey.computePublicKey(recipientPublicKey, false)
  const eph = new SigningKey(hexlify(randomBytes(32)))
  const key = await aesKey(eph.computeSharedSecret(rpk), eph.publicKey, rpk)
  const iv = buf(randomBytes(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf(plaintext)))
  return { v: 1, epk: eph.publicKey, iv: hexlify(iv), ct: hexlify(ct) }
}

export async function open(recipient: SigningKey, sealed: Sealed): Promise<Uint8Array> {
  if (sealed.v !== 1) throw new Error('unsupported sealed box version')
  const key = await aesKey(recipient.computeSharedSecret(sealed.epk), SigningKey.computePublicKey(sealed.epk, false), recipient.publicKey)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(getBytes(sealed.iv)) }, key, buf(getBytes(sealed.ct))))
}

/**
 * Proof that a nest knows the secret its launcher put in its cloud-init. The board never sees the secret,
 * so a board operator cannot announce a fake nest and intercept the seed.
 */
export function nestProof(nestSecret: string, transportPublicKey: string, forGremlin: string): string {
  return keccak256(solidityPacked(['bytes32', 'bytes', 'address'], [nestSecret, SigningKey.computePublicKey(transportPublicKey, false), forGremlin]))
}

/** Split a sealed box into the signed part (with ctHash) and the ciphertext that travels alongside it. */
export function detachCiphertext(box: Sealed): { sealed: { v: 1; epk: string; iv: string; ctHash: string }; ct: string } {
  return { sealed: { v: box.v, epk: box.epk, iv: box.iv, ctHash: keccak256(box.ct) }, ct: box.ct.toLowerCase() }
}

/** Reassemble after checking the ciphertext matches the signed hash. */
export function attachCiphertext(signed: { v: 1; epk: string; iv: string; ctHash: string }, ct: string): Sealed {
  if (keccak256(ct) !== signed.ctHash) throw new Error('ciphertext does not match signed hash')
  return { v: signed.v, epk: signed.epk, iv: signed.iv, ct }
}
