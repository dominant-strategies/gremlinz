/**
 * Hatch custody: the hatch backend creates the egg's hosting account, launches the egg on it, then seals the account
 * key to the egg and forgets it. The gremlin owns (and pays for) its own hosting from then on.
 *
 * Which egg? Anyone can announce an egg with a given launchId (the maker knows it), so the backend puts a random hatch
 * secret in the egg's cloud-init, which only it and the server see. The egg claims its hand-over with
 * hatchProof(secret, its public key, its address); the backend seals only to a key that proves the secret.
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

export const sealHostingHandover = (eggPublicKey: string, h: HostingHandover): Promise<Sealed> => seal(eggPublicKey, toUtf8Bytes(JSON.stringify(h)))

/** Open and sanity-check a hand-over: the key must be the account it names. */
export async function openHostingHandover(eggKey: SigningKey, sealed: Sealed): Promise<HostingHandover> {
  const h = JSON.parse(toUtf8String(await open(eggKey, sealed))) as HostingHandover
  if (h.v !== 1 || h.provider !== 'fluence' || typeof h.vmId !== 'string' || !h.vmId) throw new Error('malformed hosting hand-over')
  if (computeAddress(h.hostingKey).toLowerCase() !== String(h.hostingAddress).toLowerCase()) throw new Error('hosting key does not match its address')
  if (Number.isNaN(Date.parse(h.launchedAt)) || Number.isNaN(Date.parse(h.lastSessionAt))) throw new Error('malformed hosting hand-over times')
  return h
}
