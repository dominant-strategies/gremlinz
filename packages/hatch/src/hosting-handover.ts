/**
 * Hatch custody: the hatch backend creates the egg's hosting account, launches the egg on it, then seals the account
 * key to the egg and forgets it. The gremlin owns (and pays for) its own hosting from then on.
 *
 * Which egg? Anyone can announce an egg with a given launchId (the maker knows it), so the backend puts a random hatch
 * secret in the egg's cloud-init, which only it and the server see. The egg claims its hand-over with
 * hatchProof(secret, its public key, its address); the backend seals only to a key that proves the secret.
 *
 * 2-of-2 custody (@gremlins/hosting/mpc): the key never exists as one before this. The backend seals its shard (v2),
 * the maker's hatch page seals its own to the same egg, and the egg adds them up (key = x1 + x2 mod n).
 */
import { SigningKey, computeAddress, keccak256, solidityPacked, toUtf8Bytes, toUtf8String } from 'ethers'
import { open, seal, type Sealed } from './seal.js'

export function hatchProof(hatchSecret: string, publicKey: string, address: string): string {
  return keccak256(solidityPacked(['string', 'bytes32', 'bytes', 'address'], ['gremlins-hatch-v1', hatchSecret, SigningKey.computePublicKey(publicKey, false), address]))
}

/** What an egg posts to claim its hosting account: its board identity key and the proof. */
export interface HatchClaim {
  launchId: string
  /** Uncompressed secp256k1 public key of the egg's EVM (board) key. */
  publicKey: string
  proof: string
}

export interface HostingHandover {
  v: 1
  provider: 'fluence'
  /** The account key: on Fluence the paying wallet is the account. */
  hostingKey: string
  hostingAddress: string
  vmId: string
  launchedAt: string
  /** The backend's last sign-in: its access token (2 h, not revocable) runs out from here. */
  lastSessionAt: string
}

/** The backend's half of a 2-of-2 account: its key shard instead of the key. */
export interface HostingShardHandover extends Omit<HostingHandover, 'v' | 'hostingKey'> {
  v: 2
  custody: 'mpc'
  /** The backend's (party 1's) secret share, 32-byte hex. */
  shard: string
}

/** The maker's half, sealed to the egg by the hatch page. */
export interface BrowserShard {
  v: 2
  custody: 'mpc'
  launchId: string
  hostingAddress: string
  /** The browser's (party 2's) secret share, 32-byte hex. */
  shard: string
}

/** A 2-of-2 hand-over whose browser half hasn't arrived yet. */
export class HandoverIncomplete extends Error {
  constructor() {
    super("waiting for the maker's half of the hosting key")
  }
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const scalar = (h: unknown) => {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error('malformed key shard')
  const x = BigInt(h)
  if (x === 0n || x >= N) throw new Error('malformed key shard')
  return x
}
/** Additive 2-of-2 shares (cb-mpc ECDSA-2PC): the key is x1 + x2 mod n. */
export const combineShards = (x1: string, x2: string): string => `0x${((scalar(x1) + scalar(x2)) % N).toString(16).padStart(64, '0')}`

export const sealHostingHandover = (eggPublicKey: string, h: HostingHandover | HostingShardHandover): Promise<Sealed> => seal(eggPublicKey, toUtf8Bytes(JSON.stringify(h)))
export const sealBrowserShard = (eggPublicKey: string, s: BrowserShard): Promise<Sealed> => seal(eggPublicKey, toUtf8Bytes(JSON.stringify(s)))

/**
 * Open and sanity-check a hand-over: the key must be the account it names. A 2-of-2 hand-over needs the browser's
 * sealed shard too (HandoverIncomplete until then); either way the result is the account key.
 */
export async function openHostingHandover(eggKey: SigningKey, sealed: Sealed, browserSealed?: Sealed): Promise<HostingHandover> {
  const raw = JSON.parse(toUtf8String(await open(eggKey, sealed))) as HostingHandover | HostingShardHandover
  let h: HostingHandover
  if (raw.v === 2) {
    if (raw.custody !== 'mpc') throw new Error('malformed hosting hand-over')
    if (!browserSealed) throw new HandoverIncomplete()
    const b = JSON.parse(toUtf8String(await open(eggKey, browserSealed))) as BrowserShard
    if (b.v !== 2 || b.custody !== 'mpc' || String(b.hostingAddress).toLowerCase() !== String(raw.hostingAddress).toLowerCase()) throw new Error("the maker's key shard is for another account")
    const { shard, custody: _c, ...rest } = raw
    h = { ...rest, v: 1, hostingKey: combineShards(shard, b.shard) }
  } else h = raw
  if (h.v !== 1 || h.provider !== 'fluence' || typeof h.vmId !== 'string' || !h.vmId) throw new Error('malformed hosting hand-over')
  if (computeAddress(h.hostingKey).toLowerCase() !== String(h.hostingAddress).toLowerCase()) throw new Error('hosting key does not match its address')
  if (Number.isNaN(Date.parse(h.launchedAt)) || Number.isNaN(Date.parse(h.lastSessionAt))) throw new Error('malformed hosting hand-over times')
  return h
}
