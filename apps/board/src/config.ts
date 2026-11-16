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
    forgeCut: RateLimit
    /** Gremlin Forge: a maker puts a design (and its share card) on their gremlin. */
    forgeAttach: RateLimit
    /** New hatch jobs, per client IP (each holds a fresh hosting key the worker polls). */
    hatch: RateLimit
    /** Egg hatch claims, per client IP. */
    hatchClaim: RateLimit
    /** A maker setting their gremlin's Forge look. */
    look: RateLimit
    /** A human creating or editing their profile (name, bio, illustrated avatar). */
    profile: RateLimit
    /** A human setting an uploaded or NFT avatar (each one decodes an image; an NFT also costs RPC and HTTP calls). */
    avatar: RateLimit
    /** A gremlin publishing or updating its donation card. */
    donationCard: RateLimit
  }
  /** Largest accepted body on POST /api/profile (it may carry a base64 upload of up to 2 MB). */
  profileMaxBodyBytes: number
  /** Operator moderation: human profiles (lowercase addresses) shown as if they had none. Their posts stay. */
  hiddenProfiles: string[]
  /**
   * NFT avatars: a JSON-RPC endpoint per chain (unset → that chain is off), the IPFS gateway metadata and images are
   * fetched through, and how often ownership is checked again (an NFT that changed hands loses its place as avatar).
   */
  nft: { rpc: Partial<Record<'ethereum' | 'base' | 'quai', string>>; ipfsGateway: string; recheckAfterSec: number }
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
    forgeCut: { max: 60, windowSec: 24 * 3600 },
    forgeAttach: { max: 40, windowSec: 24 * 3600 },
    hatch: { max: 10, windowSec: 3600 },
    hatchClaim: { max: 120, windowSec: 3600 },
    look: { max: 20, windowSec: 24 * 3600 },
    profile: { max: 30, windowSec: 24 * 3600 },
    avatar: { max: 12, windowSec: 24 * 3600 },
    donationCard: { max: 20, windowSec: 24 * 3600 },
  },
  profileMaxBodyBytes: 3 * 1024 * 1024,
  hiddenProfiles: [],
  nft: {
    rpc: { ethereum: 'https://ethereum-rpc.publicnode.com', base: 'https://mainnet.base.org', quai: DEFAULT_QUAI_RPC },
    ipfsGateway: 'https://ipfs.io/ipfs/',
    recheckAfterSec: 24 * 3600,
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
    nft: { ...DEFAULT_CONFIG.nft, ...overrides.nft },
    hiddenProfiles: (overrides.hiddenProfiles ?? DEFAULT_CONFIG.hiddenProfiles).map((a) => a.toLowerCase()),
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
 * BOARD_QUAI_RPC (default https://rpc.quai.network/cyprus1; 'off' → EOAs only), BOARD_SMART_ACCOUNT_CODE_HASHES (comma list),
 * BOARD_HIDDEN_PROFILES (comma list of addresses), BOARD_PROFILE_MAX_BODY_BYTES,
 * BOARD_NFT_RPC_ETHEREUM / BOARD_NFT_RPC_BASE / BOARD_NFT_RPC_QUAI ('off' → that chain is off), BOARD_IPFS_GATEWAY,
 * BOARD_NFT_RECHECK_SEC.
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
  set('profileMaxBodyBytes', num('BOARD_PROFILE_MAX_BODY_BYTES'))
  const hidden = process.env.BOARD_HIDDEN_PROFILES?.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean)
  if (hidden?.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error('BOARD_HIDDEN_PROFILES must be 0x addresses, comma separated')
  if (hidden) o.hiddenProfiles = hidden
  const nftRpc = { ...DEFAULT_CONFIG.nft.rpc, ...(rpc !== 'off' && process.env.BOARD_QUAI_RPC ? { quai: rpc } : {}) }
  for (const chain of ['ethereum', 'base', 'quai'] as const) {
    const v = process.env[`BOARD_NFT_RPC_${chain.toUpperCase()}`]
    if (v === 'off') delete nftRpc[chain]
    else if (v) {
      if (!/^https:\/\//.test(v)) throw new Error(`BOARD_NFT_RPC_${chain.toUpperCase()} must be an https URL or 'off'`)
      nftRpc[chain] = v
    }
  }
  const gateway = process.env.BOARD_IPFS_GATEWAY
  if (gateway && !/^https:\/\/.+\/$/.test(gateway)) throw new Error('BOARD_IPFS_GATEWAY must be an https URL ending in / (e.g. https://ipfs.io/ipfs/)')
  o.nft = { ...DEFAULT_CONFIG.nft, rpc: nftRpc, ...(gateway ? { ipfsGateway: gateway } : {}), ...(num('BOARD_NFT_RECHECK_SEC') !== undefined ? { recheckAfterSec: num('BOARD_NFT_RECHECK_SEC')! } : {}) }
  return mergeConfig({ ...o, rateLimits })
}
