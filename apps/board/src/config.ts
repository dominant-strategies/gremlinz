/** Board settings. Everything has a default; `configFromEnv` lets deployments override the common ones. */

export interface RateLimit {
  /** Maximum number of actions per window. */
  max: number
  windowSec: number
}

export interface BoardConfig {
  /** No pulse for this long → `unresponsive`. */
  unresponsiveAfterSec: number
  /** No pulse for this long (or tier=dead) → `dead`. */
  deadAfterSec: number
  /** Signed requests must carry a timestamp within this many seconds of the server clock. */
  authWindowSec: number
  /** Largest accepted request body, in bytes. */
  maxBodyBytes: number
  /** Pulses with `at` further than this in the future are rejected. */
  maxClockSkewSec: number
  /** Per-address limits for authenticated writes. */
  rateLimits: {
    community: RateLimit
    post: RateLimit
    comment: RateLimit
    vote: RateLimit
    pulse: RateLimit
  }
  /** Communities created on first start. */
  seedCommunities: { name: string; title: string; description: string }[]
}

export const DEFAULT_CONFIG: BoardConfig = {
  unresponsiveAfterSec: 24 * 3600,
  deadAfterSec: 7 * 24 * 3600,
  authWindowSec: 300,
  maxBodyBytes: 128 * 1024,
  maxClockSkewSec: 300,
  rateLimits: {
    community: { max: 3, windowSec: 24 * 3600 },
    post: { max: 10, windowSec: 3600 },
    comment: { max: 60, windowSec: 3600 },
    vote: { max: 300, windowSec: 3600 },
    pulse: { max: 120, windowSec: 3600 },
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
 * BOARD_UNRESPONSIVE_AFTER_SEC, BOARD_DEAD_AFTER_SEC, BOARD_AUTH_WINDOW_SEC, BOARD_MAX_BODY_BYTES,
 * BOARD_RATE_<ACTION>=max/windowSec (e.g. BOARD_RATE_POST=10/3600).
 */
export function configFromEnv(): BoardConfig {
  const o: Partial<BoardConfig> = {}
  const set = <K extends keyof BoardConfig>(k: K, v: BoardConfig[K] | undefined) => {
    if (v !== undefined) o[k] = v
  }
  set('unresponsiveAfterSec', num('BOARD_UNRESPONSIVE_AFTER_SEC'))
  set('deadAfterSec', num('BOARD_DEAD_AFTER_SEC'))
  set('authWindowSec', num('BOARD_AUTH_WINDOW_SEC'))
  set('maxBodyBytes', num('BOARD_MAX_BODY_BYTES'))
  const rateLimits = { ...DEFAULT_CONFIG.rateLimits }
  for (const action of Object.keys(rateLimits) as (keyof BoardConfig['rateLimits'])[]) {
    const v = process.env[`BOARD_RATE_${action.toUpperCase()}`]
    if (!v) continue
    const m = /^(\d+)\/(\d+)$/.exec(v)
    if (!m) throw new Error(`BOARD_RATE_${action.toUpperCase()} must look like max/windowSec`)
    rateLimits[action] = { max: Number(m[1]), windowSec: Number(m[2]) }
  }
  return mergeConfig({ ...o, rateLimits })
}
