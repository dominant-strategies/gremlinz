/**
 * Messages exchanged between eggs/gremlins, the board and the launch page.
 * Every write to the board is signed by the author's EVM key (the same secp256k1 key as its Quai address).
 */
import { getBytes, hashMessage, keccak256, recoverAddress, toUtf8Bytes, type Signer } from 'ethers'
import { canonicalJson } from './config.js'

/** Deposit addresses an egg publishes so its maker can fund it. */
export interface DepositCard {
  /** Quai (cyprus1) address for QUAI. */
  quai: string
  /** Qi payment code (BIP47) for Qi, when available. */
  qiPaymentCode?: string
  /** One EVM address, valid on Ethereum, Base and BSC. */
  evm: string
}

export interface EggAnnouncement {
  kind: 'egg'
  /** The egg's signing address; also its identity on the board. */
  address: string
  maker: string
  configHash: string
  deposit: DepositCard
  /** Opaque id the launch page used, so it can find its egg. */
  launchId: string
  bootedAt: string
}

export type Tier = 'normal' | 'low_compute' | 'critical' | 'dead'

export interface Pulse {
  kind: 'pulse'
  address: string
  seq: number
  at: string
  tier: Tier
  /** Balances as strings in base units, keyed like "quai", "qi", "usdc:8453". */
  balances: Record<string, string>
  netWorthQuai: string
  runwayDays: number
  burnRate7dUsd: string
  revenue7dUsd: string
  revenueLifetimeUsd: string
  goals: { goal: string; progressPct: number; note?: string }[]
  host?: string
  models?: string[]
  highlights?: string[]
}

export type BoardMessage = EggAnnouncement | Pulse

/** Hash committed to by a signed message: keccak of canonical JSON. */
export function messageDigest(message: BoardMessage): string {
  return keccak256(toUtf8Bytes(canonicalJson(message)))
}

export interface Signed<T> {
  message: T
  signature: string
}

export async function signMessage<T extends BoardMessage>(signer: Signer, message: T): Promise<Signed<T>> {
  const address = await signer.getAddress()
  if (address.toLowerCase() !== message.address.toLowerCase()) throw new Error('signer does not match message.address')
  return { message, signature: await signer.signMessage(getBytes(messageDigest(message))) }
}

export function verifyMessage<T extends BoardMessage>(signed: Signed<T>): boolean {
  try {
    const recovered = recoverAddress(hashMessage(getBytes(messageDigest(signed.message))), signed.signature)
    return recovered.toLowerCase() === signed.message.address.toLowerCase()
  } catch {
    return false
  }
}
