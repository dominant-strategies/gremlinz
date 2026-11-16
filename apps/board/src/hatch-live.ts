/**
 * Production wiring for hatch custody: Fluence through @gremlins/hosting, Base through @gremlins/treasury/base.
 *
 * Env (all of BOARD_HATCH_SECRET, BOARD_EGG_IMAGE and BOARD_PUBLIC_URL, or hatching stays off):
 *   BOARD_HATCH_SECRET      ≥32 chars; encrypts hosting keys at rest. Losing it strands keys not yet handed off.
 *   BOARD_EGG_IMAGE         egg image pinned by digest
 *   BOARD_PUBLIC_URL        this board's public origin, e.g. https://gremlinz.ai (eggs talk to it)
 *   BOARD_EGG_DEV_SSH_KEYS  dev phase: team SSH keys, newline- or comma-separated
 *   BOARD_EGG_ARTIFACT_URL, BOARD_EGG_ARTIFACT_SHA256  release bundle of the same build
 *   BOARD_HATCH_DB          default: hatch.db next to BOARD_DB
 *   BOARD_HATCH_TOPUP_USD   default 10 (Fluence's minimum)
 *   BOARD_BASE_RPC          default https://mainnet.base.org
 *   BOARD_HATCH_CUSTODY     mpc (default: 2-of-2 with the maker's page) or local (the board holds the key; dev only)
 */
import { dirname, join } from 'node:path'
import { AbstractSigner, JsonRpcProvider, TypedDataEncoder, type Provider, type TypedDataDomain, type TypedDataField } from 'ethers'
import { FLUENCE_MIN_TOPUP_USD, fluence, type HostingSigner } from '@gremlins/hosting'
import { mpcCoordinator, type MpcCoordinator } from '@gremlins/hosting/mpc'
import { quaiOnBase, sellQuaiOnBaseForUsdc, usdcAuthorizationUsed, usdcOnBase } from '@gremlins/treasury/base'
import type { BoardStore } from './store.ts'
import type { HatchConfig, HatchDeps } from './hatch.ts'
import { HatchStore } from './hatch-store.ts'

export function hatchFromEnv(env: NodeJS.ProcessEnv, boardDbPath: string): { cfg: HatchConfig; store: HatchStore; mpc: MpcCoordinator } | undefined {
  const secret = env.BOARD_HATCH_SECRET
  const image = env.BOARD_EGG_IMAGE
  const publicUrl = env.BOARD_PUBLIC_URL
  if (!secret || !image || !publicUrl) return undefined
  const devSshKeys = String(env.BOARD_EGG_DEV_SSH_KEYS ?? '').split(/[\n,]+/).map((k) => k.trim()).filter(Boolean)
  const artifact = env.BOARD_EGG_ARTIFACT_URL && env.BOARD_EGG_ARTIFACT_SHA256 ? { url: env.BOARD_EGG_ARTIFACT_URL, sha256: env.BOARD_EGG_ARTIFACT_SHA256 } : undefined
  const topUpUsd = Number(env.BOARD_HATCH_TOPUP_USD || FLUENCE_MIN_TOPUP_USD)
  if (!(topUpUsd >= FLUENCE_MIN_TOPUP_USD)) throw new Error(`BOARD_HATCH_TOPUP_USD must be at least ${FLUENCE_MIN_TOPUP_USD}`)
  const custody = (env.BOARD_HATCH_CUSTODY || 'mpc') as HatchConfig['custody']
  if (custody !== 'mpc' && custody !== 'local') throw new Error('BOARD_HATCH_CUSTODY must be mpc or local')
  let canary: HatchConfig['canary']
  const canaryKeys = String(env.BOARD_CANARY_DEV_SSH_KEYS || env.BOARD_EGG_DEV_SSH_KEYS || '').split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
  if (env.BOARD_CANARY_EGG_IMAGE) {
    const makers = String(env.BOARD_CANARY_MAKERS ?? '').split(/[\n,]+/).map(a => a.trim().toLowerCase()).filter(Boolean)
    if (!makers.length || makers.some(a => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error('canary needs BOARD_CANARY_MAKERS with approved wallet addresses')
    if (!canaryKeys.length || canaryKeys.some(k => !/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\n']*)?$/.test(k))) throw new Error('canary needs valid dev SSH public keys for monitoring')
    if (!/^[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(env.BOARD_CANARY_EGG_IMAGE)) throw new Error('canary egg image must be pinned by digest')
    const url = env.BOARD_CANARY_ARTIFACT_URL, sum = env.BOARD_CANARY_ARTIFACT_SHA256
    if (!!url !== !!sum || (sum && !/^[a-f0-9]{64}$/.test(sum))) throw new Error('canary bundle needs a matching URL and SHA256')
    if (url && new URL(url).protocol !== 'https:') throw new Error('canary bundle needs HTTPS')
    canary = { image: env.BOARD_CANARY_EGG_IMAGE, makers: [...new Set(makers)], devSshKeys: canaryKeys, ...(url && sum ? { artifact: { url, sha256: sum } } : {}) }
  } else if (env.BOARD_CANARY_MAKERS || env.BOARD_CANARY_ARTIFACT_URL || env.BOARD_CANARY_ARTIFACT_SHA256) throw new Error('canary settings require BOARD_CANARY_EGG_IMAGE')
  const dbPath = env.BOARD_HATCH_DB ?? (boardDbPath === ':memory:' ? ':memory:' : join(dirname(boardDbPath), 'hatch.db'))
  return { cfg: { image, artifact, devSshKeys, publicUrl: new URL(publicUrl).origin, topUpUsd, custody, ...(canary ? { canary } : {}) }, store: new HatchStore(dbPath, secret), mpc: mpcCoordinator() }
}

/**
 * A HostingSigner as an ethers Signer, for the CoW swap code (permit + order typed data). Signs typed data and
 * messages only: there is no gas on a hosting account, so no transactions.
 */
class HostingEthersSigner extends AbstractSigner {
  private s: HostingSigner
  constructor(s: HostingSigner, provider: Provider) {
    super(provider)
    this.s = s
  }
  getAddress = async () => this.s.address
  connect = (provider: Provider | null) => new HostingEthersSigner(this.s, provider ?? this.provider!)
  signMessage = async (m: string | Uint8Array) => {
    if (typeof m !== 'string') throw new Error('hosting signer signs text messages only')
    return this.s.signMessage(m)
  }
  signTypedData = async (domain: TypedDataDomain, types: Record<string, TypedDataField[]>, message: Record<string, unknown>) =>
    this.s.signTypedData({ domain: domain as Record<string, unknown>, types, primaryType: TypedDataEncoder.getPrimaryType(types), message })
  signTransaction = async (): Promise<string> => {
    throw new Error('hosting accounts hold no gas: no transactions')
  }
}

export function liveHatchDeps(env: NodeJS.ProcessEnv, board: BoardStore, mpc?: MpcCoordinator): HatchDeps {
  const base = new JsonRpcProvider(env.BOARD_BASE_RPC || 'https://mainnet.base.org', 8453, { staticNetwork: true })
  return {
    now: () => Date.now(),
    fluence: (signer) => fluence({ signer }),
    base: {
      usdc: (a) => usdcOnBase(base, a),
      quai: (a) => quaiOnBase(base, a),
      authorizationUsed: (a, nonce) => usdcAuthorizationUsed(base, a, nonce),
      // Permit and order are typed data: co-signed by the maker's page under 2-of-2 (and checked by it first).
      sellQuai: (signer, amount) => sellQuaiOnBaseForUsdc({ signer: new HostingEthersSigner(signer, base), provider: base, amount }),
    },
    findEgg: async (launchId) => board.getEggByLaunchId(launchId),
    mpc,
  }
}
