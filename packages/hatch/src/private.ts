/**
 * Private directions: words from the maker that only the gremlin ever reads.
 *
 * - The maker's browser seals them to the egg's own key (recovered from its signed announcement), so the board only
 *   relays ciphertext and never sees them; nor does the Forge, the profile, or the chain.
 * - The config carries only a salted commitment (keccak of salt + text). It is part of the config the maker signs, so
 *   the board cannot swap in directions of its own, and the salt keeps the commitment from revealing the text.
 * - The egg opens the box with its key, checks the commitment, and hands the text to the gremlin's runtime.
 */
import { SigningKey, computeAddress, getBytes, hashMessage, hexlify, keccak256, randomBytes, toUtf8Bytes } from 'ethers'
import { canonicalJson } from './config.js'
import { messageDigest, type EggAnnouncement } from './protocol.js'
import { open, seal, type Sealed } from './seal.js'

export const PRIVATE_DIRECTIONS_MAX = 4_000

export interface PrivateDirections {
  text: string
  /** 32 random bytes (hex): keeps the public commitment from being guessed from likely texts. */
  salt: string
}

export function newPrivateDirections(text: string): PrivateDirections {
  return { text, salt: hexlify(randomBytes(32)) }
}

/** The commitment that goes into the signed config. */
export function privateCommitment(p: PrivateDirections): string {
  return keccak256(toUtf8Bytes(canonicalJson({ kind: 'gremlin-private-directions', salt: p.salt.toLowerCase(), text: p.text })))
}

/** The egg's public key, recovered from its signed announcement (the board serves both). */
export function eggPublicKey(announcement: EggAnnouncement, signature: string): string {
  const pk = SigningKey.recoverPublicKey(hashMessage(getBytes(messageDigest(announcement))), signature)
  if (computeAddress(pk).toLowerCase() !== announcement.address.toLowerCase()) throw new Error('the announcement was not signed by the egg it names')
  return pk
}

/** Seal private directions to the egg. Only the egg's key opens the box. */
export async function sealPrivateDirections(eggPubKey: string, p: PrivateDirections): Promise<Sealed> {
  if (!p.text.trim()) throw new Error('private directions are empty')
  if (p.text.length > PRIVATE_DIRECTIONS_MAX) throw new Error(`private directions are longer than ${PRIVATE_DIRECTIONS_MAX} characters`)
  return seal(eggPubKey, toUtf8Bytes(JSON.stringify({ text: p.text, salt: p.salt })))
}

/** Open the box with the egg's key and check it against the commitment in the maker's signed config. */
export async function openPrivateDirections(key: SigningKey, sealed: Sealed, commitment: string): Promise<PrivateDirections> {
  const p = JSON.parse(new TextDecoder().decode(await open(key, sealed))) as PrivateDirections
  if (typeof p?.text !== 'string' || typeof p?.salt !== 'string') throw new Error('private directions are malformed')
  if (privateCommitment(p).toLowerCase() !== commitment.toLowerCase()) throw new Error('private directions do not match the signed config')
  return { text: p.text, salt: p.salt }
}
