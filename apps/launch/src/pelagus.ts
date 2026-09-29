/** Minimal Pelagus (Quai wallet) adapter: connect and sign EIP-712 typed data. */
import { HATCH_DOMAIN, HATCH_TYPES, configHash, type GremlinConfig, type SignedConfig } from '@gremlins/hatch'

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

declare global {
  interface Window { pelagus?: Eip1193 }
}

export function pelagus(): Eip1193 {
  if (!window.pelagus) throw new Error('Pelagus wallet not found. Install it from pelaguswallet.io and reload.')
  return window.pelagus
}

export async function connect(): Promise<string> {
  const accounts = (await pelagus().request({ method: 'quai_requestAccounts' })) as string[]
  if (!accounts?.length) throw new Error('No Quai account available in Pelagus')
  return accounts[0]
}

/**
 * Maker signs the config hash for one specific egg (its Quai address). Matches signConfig() in
 * @gremlins/hatch; verified by the egg, the board and GremlinRegistry.
 */
export async function signConfigWithPelagus(maker: string, config: GremlinConfig, gremlin: string): Promise<SignedConfig> {
  const message = { maker, gremlin, configHash: configHash(config), issuedAt: BigInt(Math.floor(Date.now() / 1000)) }
  const typedData = {
    domain: HATCH_DOMAIN,
    types: HATCH_TYPES,
    primaryType: 'Hatch',
    message: { ...message, issuedAt: message.issuedAt.toString() },
  }
  const signature = (await pelagus().request({ method: 'quai_signTypedData_v4', params: [maker, JSON.stringify(typedData)] })) as string
  return { config, message, signature }
}
