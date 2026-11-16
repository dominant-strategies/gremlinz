/**
 * EIP-712 signing of a gremlin config by its maker (Pelagus on Quai, chainId 9). The signed message
 * commits to the config hash, so large text fields never go into the typed data itself.
 *
 * The maker signs *after* the egg has announced itself, and the message names the egg's Quai address
 * (`gremlin`). Without that binding, anyone who saw the signed config could register it on-chain from their
 * own address first. Only the config hash needs to exist before launch (it goes into cloud-init).
 *
 * Two ways to sign the same message:
 * - 'eip712' (default): typed data in the Gremlins domain on Quai (chainId 9). Pelagus signs it; GremlinRegistry
 *   verifies it on-chain, so these gremlins can register on Quai.
 * - 'personal': EIP-191 personal_sign over `hatchText(message)`, which names no chain. For EVM wallets (MetaMask,
 *   Phantom, WalletConnect): their keys are not Quai addresses, and switching them to Quai fails ("Address belongs
 *   to other zone"). Same binding (maker, egg, config hash), but GremlinRegistry cannot verify it, so these
 *   gremlins do not register on Quai.
 */
import { keccak256, toUtf8Bytes, verifyMessage, verifyTypedData, type Signer, type TypedDataDomain } from 'ethers'
import { GremlinConfig, canonicalJson } from './config.js'

export const QUAI_CHAIN_ID = 9

export const HATCH_DOMAIN: TypedDataDomain = { name: 'Gremlins', version: '1', chainId: QUAI_CHAIN_ID }

export const HATCH_TYPES = {
  Hatch: [
    { name: 'maker', type: 'address' },
    { name: 'gremlin', type: 'address' },
    { name: 'configHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
}

export interface HatchMessage {
  maker: string
  /** The egg's Quai address: the only account allowed to register this config. */
  gremlin: string
  configHash: string
  issuedAt: bigint
}

export type HatchScheme = 'eip712' | 'personal'

export interface SignedConfig {
  config: GremlinConfig
  message: HatchMessage
  signature: string
  /** How `signature` was made; absent means 'eip712'. */
  scheme?: HatchScheme
}

/** The text an EVM wallet signs (personal_sign) for the 'personal' scheme. Exact bytes matter: keep it stable. */
export function hatchText(m: HatchMessage): string {
  return [
    'gremlinz: hatch a gremlin',
    '',
    'I am this gremlin\'s maker and I approve its config for this egg.',
    '',
    `Maker: ${m.maker.toLowerCase()}`,
    `Gremlin: ${m.gremlin.toLowerCase()}`,
    `Config hash: ${m.configHash.toLowerCase()}`,
    `Issued at: ${BigInt(m.issuedAt).toString()}`,
    '',
    'Gremlins v1',
  ].join('\n')
}

/** Who signed a hatch message, by its scheme. Throws on a malformed signature. */
export function hatchSigner(signed: Pick<SignedConfig, 'message' | 'signature' | 'scheme'>): string {
  if (signed.scheme === 'personal') return verifyMessage(hatchText(signed.message), signed.signature)
  if (signed.scheme !== undefined && signed.scheme !== 'eip712') throw new Error('unknown signature scheme')
  return verifyTypedData(HATCH_DOMAIN, HATCH_TYPES, signed.message, signed.signature)
}

export function configHash(config: GremlinConfig): string {
  return keccak256(toUtf8Bytes(canonicalJson(GremlinConfig.parse(config))))
}

export async function signConfig(signer: Signer, config: GremlinConfig, gremlin: string, now = new Date()): Promise<SignedConfig> {
  const parsed = GremlinConfig.parse(config)
  const maker = await signer.getAddress()
  if (maker.toLowerCase() !== parsed.maker.toLowerCase()) throw new Error('signer is not the config maker')
  const message: HatchMessage = { maker, gremlin, configHash: configHash(parsed), issuedAt: BigInt(Math.floor(now.getTime() / 1000)) }
  const signature = await signer.signTypedData(HATCH_DOMAIN, HATCH_TYPES, message)
  return { config: parsed, message, signature }
}

export type VerifyResult = { ok: true; config: GremlinConfig } | { ok: false; reason: string }

/**
 * What the egg (and the board) run before accepting a config. `maker` and `configHash` come from the egg's
 * launch data (cloud-init), written before the egg existed; `gremlin` is the egg's own Quai address.
 */
export function verifySignedConfig(signed: SignedConfig, expected: { maker: string; configHash: string; gremlin: string }): VerifyResult {
  const parsed = GremlinConfig.safeParse(signed.config)
  if (!parsed.success) return { ok: false, reason: `invalid config: ${parsed.error.issues[0]?.message}` }
  const hash = configHash(parsed.data)
  if (hash !== expected.configHash) return { ok: false, reason: 'config hash does not match launch data' }
  if (signed.message.configHash !== hash) return { ok: false, reason: 'signed hash does not match config' }
  if (signed.message.maker.toLowerCase() !== expected.maker.toLowerCase()) return { ok: false, reason: 'maker does not match launch data' }
  if (signed.message.gremlin.toLowerCase() !== expected.gremlin.toLowerCase()) return { ok: false, reason: 'config was signed for a different gremlin' }
  if (parsed.data.maker.toLowerCase() !== expected.maker.toLowerCase()) return { ok: false, reason: 'config maker does not match launch data' }
  let recovered: string
  try {
    recovered = hatchSigner(signed)
  } catch {
    return { ok: false, reason: 'malformed signature' }
  }
  if (recovered.toLowerCase() !== expected.maker.toLowerCase()) return { ok: false, reason: 'signature is not from the maker' }
  return { ok: true, config: parsed.data }
}

/** GremlinRegistry on Quai mainnet (cyprus1), deployed 2026-09-29. See contracts/deployments/registry-9.json. */
export const GREMLIN_REGISTRY = '0x0023F20256Fd8014CB3fc1250d8Cf93E3e44d103'
