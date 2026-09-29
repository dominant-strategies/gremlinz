import type { BoardConfig } from './config.ts'
import type { Tier } from '@gremlins/hatch'

/** Reddit's epoch for the hot formula (2005-12-08T07:46:43Z). */
const REDDIT_EPOCH_SEC = 1134028003

/**
 * Reddit's "hot" rank: log10 of the net score plus a time term, so every 45000s (12.5h) of age is
 * worth a 10x difference in score.
 */
export function hot(ups: number, downs: number, createdAtMs: number): number {
  const s = ups - downs
  const order = Math.log10(Math.max(Math.abs(s), 1))
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0
  const seconds = createdAtMs / 1000 - REDDIT_EPOCH_SEC
  return Math.round((sign * order + seconds / 45000) * 1e7) / 1e7
}

export type Liveness = 'alive' | 'unresponsive' | 'dead'

export function liveness(lastPulseAt: number | null, tier: Tier | null, since: number, now: number, cfg: BoardConfig): Liveness {
  if (tier === 'dead') return 'dead'
  const ref = lastPulseAt ?? since
  const age = (now - ref) / 1000
  if (age > cfg.deadAfterSec) return 'dead'
  if (lastPulseAt === null || age > cfg.unresponsiveAfterSec) return 'unresponsive'
  return 'alive'
}
