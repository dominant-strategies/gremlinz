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
 */
import { dirname, join } from 'node:path'
import { JsonRpcProvider, Wallet } from 'ethers'
import { FLUENCE_MIN_TOPUP_USD, fluence, localSigner } from '@gremlins/hosting'
import { quaiOnBase, sellQuaiOnBaseForUsdc, usdcAuthorizationUsed, usdcOnBase } from '@gremlins/treasury/base'
import type { BoardStore } from './store.ts'
import type { HatchConfig, HatchDeps } from './hatch.ts'
import { HatchStore } from './hatch-store.ts'

export function hatchFromEnv(env: NodeJS.ProcessEnv, boardDbPath: string): { cfg: HatchConfig; store: HatchStore } | undefined {
  const secret = env.BOARD_HATCH_SECRET
  const image = env.BOARD_EGG_IMAGE
  const publicUrl = env.BOARD_PUBLIC_URL
  if (!secret || !image || !publicUrl) return undefined
  const devSshKeys = String(env.BOARD_EGG_DEV_SSH_KEYS ?? '').split(/[\n,]+/).map((k) => k.trim()).filter(Boolean)
  const artifact = env.BOARD_EGG_ARTIFACT_URL && env.BOARD_EGG_ARTIFACT_SHA256 ? { url: env.BOARD_EGG_ARTIFACT_URL, sha256: env.BOARD_EGG_ARTIFACT_SHA256 } : undefined
  const topUpUsd = Number(env.BOARD_HATCH_TOPUP_USD || FLUENCE_MIN_TOPUP_USD)
  if (!(topUpUsd >= FLUENCE_MIN_TOPUP_USD)) throw new Error(`BOARD_HATCH_TOPUP_USD must be at least ${FLUENCE_MIN_TOPUP_USD}`)
  const dbPath = env.BOARD_HATCH_DB ?? (boardDbPath === ':memory:' ? ':memory:' : join(dirname(boardDbPath), 'hatch.db'))
  return { cfg: { image, artifact, devSshKeys, publicUrl: new URL(publicUrl).origin, topUpUsd }, store: new HatchStore(dbPath, secret) }
}

export function liveHatchDeps(env: NodeJS.ProcessEnv, board: BoardStore): HatchDeps {
  const base = new JsonRpcProvider(env.BOARD_BASE_RPC || 'https://mainnet.base.org', 8453, { staticNetwork: true })
  return {
    now: () => Date.now(),
    fluence: (key) => fluence({ signer: localSigner(key as `0x${string}`) }),
    base: {
      usdc: (a) => usdcOnBase(base, a),
      quai: (a) => quaiOnBase(base, a),
      authorizationUsed: (a, nonce) => usdcAuthorizationUsed(base, a, nonce),
      // CoW signing still takes the raw key; the 2-of-2 signer will need a typed-data path here too.
      sellQuai: (key, amount) => sellQuaiOnBaseForUsdc({ signer: new Wallet(key, base), provider: base, amount }),
    },
    findEgg: async (launchId) => board.getEggByLaunchId(launchId),
  }
}
