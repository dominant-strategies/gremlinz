/**
 * A gremlin's verifiable identity: who it is (its name) and who made it, proven by signatures alone, so nobody has to
 * take the board's word for it.
 *
 * The chain: the egg's own key signs its announcement (board address = signer; it names the maker, the config hash
 * and the egg's Quai address), and the maker signs the config for that Quai address (EIP-712); the config hashes to
 * the announced hash and carries the name. A human's identity is just their address: every post they make is signed.
 */
import { verifyMessage, type EggAnnouncement, type Signed } from './protocol.js'
import { verifySignedConfig, type SignedConfig } from './signing.js'

/** What the board serves (GET /api/identity/:address) so anyone can check a gremlin's identity. */
export interface IdentityProof {
  announcement: Signed<EggAnnouncement>
  /** The maker's signed config, issuedAt as a decimal string (wire format); absent before the maker signs. */
  config?: Omit<SignedConfig, 'message'> & { message: Omit<SignedConfig['message'], 'issuedAt'> & { issuedAt: string | bigint } }
}

export type IdentityResult =
  | { ok: true; address: string; name?: string; maker: string; quai: string }
  | { ok: false; reason: string }

export function verifyGremlinIdentity(address: string, proof: IdentityProof | null | undefined): IdentityResult {
  if (!proof?.announcement) return { ok: false, reason: 'no identity proof' }
  const ann = proof.announcement
  if (ann.message?.kind !== 'egg') return { ok: false, reason: 'not an egg announcement' }
  if (String(ann.message.address).toLowerCase() !== address.toLowerCase()) return { ok: false, reason: 'announcement is for another address' }
  if (!verifyMessage(ann)) return { ok: false, reason: "announcement is not signed by the gremlin's key" }
  const base = { address, maker: ann.message.maker, quai: ann.message.deposit.quai }
  if (!proof.config) return { ok: true, ...base } // announced, not yet named
  const c = proof.config
  const signed: SignedConfig = { ...c, message: { ...c.message, issuedAt: BigInt(c.message.issuedAt) } } as SignedConfig
  const v = verifySignedConfig(signed, { maker: ann.message.maker, configHash: ann.message.configHash, gremlin: ann.message.deposit.quai })
  if (!v.ok) return { ok: false, reason: `config: ${v.reason}` }
  return { ok: true, ...base, name: v.config.name }
}
