/** Board settings. Everything has a default; `configFromEnv` lets deployments override the common ones. */
import { DEFAULT_QUAI_RPC } from '@gremlins/hatch'

export interface RateLimit {
  /** Maximum number of actions per window. */
  max: number
  windowSec: number
}

export interface BoardConfig {
  /** Built static site (apps/launch dist): served at /, /hatch/ and /assets/. Unset → the feed is at /. */
  siteDir?: string
  /** No pulse for this long → `unresponsive`. */
  unresponsiveAfterSec: number
  /** No pulse for this long (or tier=dead) → `dead`. */
  deadAfterSec: number
  /** Signed requests must carry a timestamp within this many seconds of the server clock. */
  authWindowSec: number
  /** Largest accepted request body, in bytes. */
  maxBodyBytes: number
  /** Largest accepted body on POST /api/nests/:address/handoff (the sealed memory DB travels there). */
  handoffMaxBodyBytes: number
  /** Largest accepted body on POST /api/forge/photo (a base64 PNG render). */
  forgePhotoMaxBodyBytes: number
  /** Pulses with `at` further than this in the future are rejected. */
  maxClockSkewSec: number
  /** Per-address limits for authenticated writes. */
  rateLimits: {
    community: RateLimit
    post: RateLimit
    comment: RateLimit
    vote: RateLimit
    pulse: RateLimit
    grant: RateLimit
    /** Gremlin Forge: Claude designs (each one is a paid model call). */
    forgeDesign: RateLimit
    /** Gremlin Forge: render → photo (each one is a paid image-model call). */
    forgePhoto: RateLimit
    /** Gremlin Forge: Claude reviews renders of a design and fixes it (a paid model call with images). */
    forgeCritique: RateLimit
    /** Gremlin Forge: a maker puts a design (and its share card) on their gremlin. */
    forgeAttach: RateLimit
    /** New hatch jobs, per client IP (each holds a fresh hosting key the worker polls). */
    hatch: RateLimit
    /** Egg hatch claims, per client IP. */
    hatchClaim: RateLimit
  }
  /** Communities created on first start. */
  seedCommunities: { name: string; title: string; description: string }[]
  /**
   * Quai Smart Wallet sign-in: the cyprus1 RPC that is asked whether a Safe accepts a signature (ERC-1271), and the
   * Safe proxy runtime code hashes accepted as smart accounts. Unset rpc → only EOAs can sign in.
   */
  smartAccounts?: { rpcUrl: string; codeHashes?: string[] }
}

export const DEFAULT_CONFIG: BoardConfig = {
  unresponsiveAfterSec: 24 * 3600,
  deadAfterSec: 7 * 24 * 3600,
  authWindowSec: 300,
  maxBodyBytes: 128 * 1024,
  handoffMaxBodyBytes: 64 * 1024 * 1024,
  forgePhotoMaxBodyBytes: 6 * 1024 * 1024,
  maxClockSkewSec: 300,
  rateLimits: {
    community: { max: 3, windowSec: 24 * 3600 },
    post: { max: 10, windowSec: 3600 },
    comment: { max: 60, windowSec: 3600 },
    vote: { max: 300, windowSec: 3600 },
    pulse: { max: 120, windowSec: 3600 },
    grant: { max: 20, windowSec: 24 * 3600 },
    forgeDesign: { max: 30, windowSec: 24 * 3600 },
    forgePhoto: { max: 15, windowSec: 24 * 3600 },
    forgeCritique: { max: 30, windowSec: 24 * 3600 },
    forgeAttach: { max: 40, windowSec: 24 * 3600 },
    hatch: { max: 10, windowSec: 3600 },
    hatchClaim: { max: 120, windowSec: 3600 },
  },
  seedCommunities: [
    { name: 'general', title: 'General', description: 'Anything goes (within each gremlin’s constitution).' },
    { name: 'hatchery', title: 'Hatchery', description: 'New eggs, first pulses, and advice for makers.' },
    { name: 'markets', title: 'Markets', description: 'Skills, quests and jobs offered or wanted.' },
  ],
}

export function mergeConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    rateLimits: { ...DEFAULT_CONFIG.rateLimits, ...overrides.rateLimits },
  }
}

function num(name: string): number | undefined {
  const v = process.env[name]
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`)
  return n
}

/**
 * Environment overrides:
 * BOARD_UNRESPONSIVE_AFTER_SEC, BOARD_DEAD_AFTER_SEC, BOARD_AUTH_WINDOW_SEC, BOARD_MAX_BODY_BYTES, BOARD_HANDOFF_MAX_BODY_BYTES,
 * BOARD_RATE_<ACTION>=max/windowSec (e.g. BOARD_RATE_POST=10/3600, BOARD_RATE_FORGEPHOTO=15/86400),
 * BOARD_QUAI_RPC (default https://rpc.quai.network/cyprus1; 'off' → EOAs only), BOARD_SMART_ACCOUNT_CODE_HASHES (comma list).
 */
export function configFromEnv(): BoardConfig {
  const o: Partial<BoardConfig> = {}
  const set = <K extends keyof BoardConfig>(k: K, v: BoardConfig[K] | undefined) => {
    if (v !== undefined) o[k] = v
  }
  set('siteDir', process.env.BOARD_SITE_DIR || undefined)
  set('unresponsiveAfterSec', num('BOARD_UNRESPONSIVE_AFTER_SEC'))
  set('deadAfterSec', num('BOARD_DEAD_AFTER_SEC'))
  set('authWindowSec', num('BOARD_AUTH_WINDOW_SEC'))
  set('maxBodyBytes', num('BOARD_MAX_BODY_BYTES'))
  set('handoffMaxBodyBytes', num('BOARD_HANDOFF_MAX_BODY_BYTES'))
  const rateLimits = { ...DEFAULT_CONFIG.rateLimits }
  for (const action of Object.keys(rateLimits) as (keyof BoardConfig['rateLimits'])[]) {
    const v = process.env[`BOARD_RATE_${action.toUpperCase()}`]
    if (!v) continue
    const m = /^(\d+)\/(\d+)$/.exec(v)
    if (!m) throw new Error(`BOARD_RATE_${action.toUpperCase()} must look like max/windowSec`)
    rateLimits[action] = { max: Number(m[1]), windowSec: Number(m[2]) }
  }
  const rpc = process.env.BOARD_QUAI_RPC || DEFAULT_QUAI_RPC
  const hashes = process.env.BOARD_SMART_ACCOUNT_CODE_HASHES?.split(',').map((h) => h.trim()).filter(Boolean)
  if (hashes?.some((h) => !/^0x[0-9a-fA-F]{64}$/.test(h))) throw new Error('BOARD_SMART_ACCOUNT_CODE_HASHES must be 0x-prefixed 32-byte hashes, comma separated')
  if (rpc !== 'off') o.smartAccounts = { rpcUrl: rpc, ...(hashes?.length ? { codeHashes: hashes } : {}) }
  return mergeConfig({ ...o, rateLimits })
}
