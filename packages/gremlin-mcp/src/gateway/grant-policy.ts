/**
 * How much of a lent key the gremlin may spend right now, under the lender's rules. Pure, so it is easy to audit.
 */
import type { GrantPolicy } from '@gremlins/hatch'

const H = 3_600_000

/** The lender's current period: [start, next reset). */
export function period(p: GrantPolicy['period'], nowMs: number): { start: number; reset: number } {
  const [hh, mm] = (p.resetAt ?? '00:00').split(':').map(Number) as [number, number]
  const d = new Date(nowMs)
  const at = (y: number, mo: number, day: number) => Date.UTC(y, mo, day, hh, mm)
  if (p.every === 'day') {
    let reset = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    if (reset <= nowMs) reset += 24 * H
    return { start: reset - 24 * H, reset }
  }
  if (p.every === 'week') {
    const dow = p.dayOfWeek ?? 1
    let reset = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7))
    if (reset <= nowMs) reset += 7 * 24 * H
    return { start: reset - 7 * 24 * H, reset }
  }
  const dom = p.dayOfMonth ?? 1
  let reset = at(d.getUTCFullYear(), d.getUTCMonth(), dom)
  if (reset <= nowMs) reset = at(d.getUTCFullYear(), d.getUTCMonth() + 1, dom)
  const prev = new Date(reset)
  return { start: at(prev.getUTCFullYear(), prev.getUTCMonth() - 1, dom), reset }
}

export interface Allowance {
  allowedUsd: number
  reason: string
  reset: number
}

/**
 * @param usedUsd what this gremlin has spent on the key in the current period
 * @param remainingUsd the lender's unused budget, if the provider reports it (rules with minRemainingPct need it)
 */
export function allowance(policy: GrantPolicy, nowMs: number, usedUsd: number, remainingUsd?: number): Allowance {
  const { reset } = period(policy.period, nowMs)
  const hoursLeft = (reset - nowMs) / H
  const remainingPct = remainingUsd === undefined ? undefined : (remainingUsd / policy.budgetUsd) * 100
  const applicable = policy.rules.filter((r) =>
    hoursLeft <= r.withinHoursOfReset && (r.minRemainingPct === undefined || (remainingPct !== undefined && remainingPct >= r.minRemainingPct)))
  if (!applicable.length) return { allowedUsd: 0, reason: `no rule applies ${hoursLeft.toFixed(1)}h before the reset`, reset }
  const capUsd = Math.max(...applicable.map((r) => (r.usePctOfBudget / 100) * policy.budgetUsd))
  let allowed = capUsd - usedUsd
  if (remainingUsd !== undefined) allowed = Math.min(allowed, remainingUsd)
  allowed = Math.max(0, allowed)
  return { allowedUsd: allowed, reason: allowed > 0 ? `may use $${allowed.toFixed(4)} (cap $${capUsd.toFixed(2)}, used $${usedUsd.toFixed(4)})` : 'allowance for this period is used up', reset }
}
