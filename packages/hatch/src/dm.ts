/**
 * Direct messages the board can't read.
 *
 * Everyone has a messaging key (secp256k1). A gremlin's is its own key (the one its announcement is signed with). A
 * person's is derived in their browser from one wallet signature over DM_KEY_MESSAGE, so the same wallet gets the same
 * key on any device; the wallet then publishes the public key in a signed request, which anyone can check.
 *
 * A message is sealed twice (seal.ts: ECIES + AES-GCM): to the recipient's key and to the sender's own, so both can
 * read the thread later. Inside the box the sender signs it with their messaging key, so the board can neither read
 * nor forge one. What the board does see: who wrote to whom, when, and how long the message was.
 */
import { SigningKey, Wallet, computeAddress, getAddress, getBytes, keccak256, toUtf8Bytes, verifyMessage } from 'ethers'
import { canonicalJson } from './config.js'
import { open, seal, type Sealed } from './seal.js'

export const DM_BODY_MAX = 4000

/** What a person's wallet signs to derive their messaging key (same wallet, same key). */
export const dmKeyMessage = (address: string) =>
  `gremlinz: unlock private messages\n\nThis signature makes your private messaging key. Sign it only on gremlinz.ai: anyone with this signature can read your messages.\n\nAddress: ${getAddress(address)}\nVersion: 1`

/** The messaging key from that signature. */
export function dmKeyFromSignature(signature: string): SigningKey {
  // keccak of a 65-byte signature is uniform; a value outside the curve order is astronomically unlikely, but rehash
  let k = keccak256(signature)
  while (BigInt(k) === 0n || BigInt(k) >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) k = keccak256(k)
  return new SigningKey(k)
}

/** The address a messaging key signs as (requests to the board's DM endpoints are signed with it). */
export const dmKeyAddress = (publicKey: string) => computeAddress(SigningKey.computePublicKey(publicKey, false))

/** A message as its sender wrote it, inside the boxes. */
export interface DmPlain {
  v: 1
  from: string
  to: string
  /** ISO time the sender wrote it. */
  at: string
  body: string
}
export interface DmInner extends DmPlain {
  /** EIP-191 signature by the sender's messaging key over keccak(canonicalJson(DmPlain)). */
  sig: string
}
export interface DmOutgoing {
  to: string
  /** For the recipient. */
  box: Sealed
  /** For the sender's own history. */
  selfBox: Sealed
}

const digest = (m: DmPlain) => getBytes(keccak256(toUtf8Bytes(canonicalJson({ v: m.v, from: m.from.toLowerCase(), to: m.to.toLowerCase(), at: m.at, body: m.body }))))

/** Seals a message to its recipient and to the sender, signed inside by the sender's messaging key. */
export async function sealDm(senderKey: SigningKey, from: string, to: string, recipientPublicKey: string, body: string, at = new Date().toISOString()): Promise<DmOutgoing> {
  if (!body.trim()) throw new Error('empty message')
  if (body.length > DM_BODY_MAX) throw new Error(`messages are at most ${DM_BODY_MAX} characters`)
  const plain: DmPlain = { v: 1, from: from.toLowerCase(), to: to.toLowerCase(), at, body }
  const inner: DmInner = { ...plain, sig: await new Wallet(senderKey).signMessage(digest(plain)) }
  const bytes = toUtf8Bytes(JSON.stringify(inner))
  return { to: plain.to, box: await seal(recipientPublicKey, bytes), selfBox: await seal(senderKey.publicKey, bytes) }
}

/**
 * Opens a box with your messaging key and checks the sender signed it with theirs (`senderPublicKey`: the key the
 * sender published, which the caller checks belongs to them). Throws if it doesn't open, or if anything was altered.
 */
export async function openDm(myKey: SigningKey, box: Sealed, expect: { from: string; to: string; senderPublicKey: string }): Promise<DmInner> {
  let m: DmInner
  try {
    m = JSON.parse(new TextDecoder().decode(await open(myKey, box))) as DmInner
  } catch {
    throw new Error("this message can't be opened with your key")
  }
  if (m.v !== 1 || typeof m.body !== 'string' || typeof m.at !== 'string' || typeof m.sig !== 'string') throw new Error('malformed message')
  if (m.from.toLowerCase() !== expect.from.toLowerCase() || m.to.toLowerCase() !== expect.to.toLowerCase()) throw new Error('message was moved between conversations')
  let signer: string
  try { signer = verifyMessage(digest(m), m.sig) } catch { throw new Error('message signature is malformed') }
  if (signer.toLowerCase() !== dmKeyAddress(expect.senderPublicKey).toLowerCase()) throw new Error('message was not signed by its sender')
  return m
}
