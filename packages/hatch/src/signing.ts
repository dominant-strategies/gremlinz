/**
 * EIP-712 signing of a gremlin config by its maker (Pelagus on Quai, chainId 9). The signed message
 * commits to the config hash, so large text fields never go into the typed data itself.
 *
 * The maker signs *after* the egg has announced itself, and the message names the egg's Quai address
 * (`gremlin`). Without that binding, anyone who saw the signed config could register it on-chain from their
 * own address first. Only the config hash needs to exist before launch (it goes into cloud-init).
 */
import { keccak256, toUtf8Bytes, verifyTypedData, type Signer, type TypedDataDomain } from 'ethers'
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

export interface SignedConfig {
  config: GremlinConfig
  message: HatchMessage
  signature: string
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
    recovered = verifyTypedData(HATCH_DOMAIN, HATCH_TYPES, signed.message, signed.signature)
  } catch {
    return { ok: false, reason: 'malformed signature' }
  }
  if (recovered.toLowerCase() !== expected.maker.toLowerCase()) return { ok: false, reason: 'signature is not from the maker' }
  return { ok: true, config: parsed.data }
}
