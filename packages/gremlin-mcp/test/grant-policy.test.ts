import { describe, expect, it } from 'vitest'
import type { GrantPolicy } from '@gremlins/hatch'
import { allowance, period } from '../src/gateway/grant-policy.js'

const at = (iso: string) => Date.parse(iso)

describe('grant policy', () => {
  it('finds the lender\'s period for daily, weekly and monthly resets', () => {
    expect(period({ every: 'day', resetAt: '00:00' }, at('2026-10-12T18:00:00Z'))).toEqual({ start: at('2026-10-12T00:00:00Z'), reset: at('2026-10-13T00:00:00Z') })
    expect(period({ every: 'day', resetAt: '20:30' }, at('2026-10-12T18:00:00Z')).reset).toBe(at('2026-10-12T20:30:00Z'))
    expect(period({ every: 'week', resetAt: '00:00', dayOfWeek: 1 }, at('2026-10-14T12:00:00Z')).reset).toBe(at('2026-10-19T00:00:00Z')) // Wed → next Mon
    expect(period({ every: 'month', resetAt: '00:00', dayOfMonth: 1 }, at('2026-10-12T00:00:00Z'))).toEqual({ start: at('2026-10-01T00:00:00Z'), reset: at('2026-11-01T00:00:00Z') })
  })

  // "If 30% of my budget is left within 12 hours of the reset, use up to 20%. Anything left in the last 6 hours, burn it."
  const policy: GrantPolicy = {
    period: { every: 'day', resetAt: '00:00' },
    budgetUsd: 50,
    rules: [{ withinHoursOfReset: 12, minRemainingPct: 30, usePctOfBudget: 20 }, { withinHoursOfReset: 6, usePctOfBudget: 100 }],
  }

  it('allows nothing outside the windows', () => {
    expect(allowance(policy, at('2026-10-12T09:00:00Z'), 0, 40).allowedUsd).toBe(0)
  })

  it('applies the 20% rule only when the provider confirms 30% is left', () => {
    expect(allowance(policy, at('2026-10-12T13:00:00Z'), 0, 20).allowedUsd).toBe(10) // 40% left → 20% of $50
    expect(allowance(policy, at('2026-10-12T13:00:00Z'), 4, 20).allowedUsd).toBe(6) // minus what it used
    expect(allowance(policy, at('2026-10-12T13:00:00Z'), 0, 10).allowedUsd).toBe(0) // only 20% left
    expect(allowance(policy, at('2026-10-12T13:00:00Z'), 0, undefined).allowedUsd).toBe(0) // unknown
  })

  it('burns whatever is left in the last 6 hours, never more than remains', () => {
    expect(allowance(policy, at('2026-10-12T19:00:00Z'), 0, 7.5).allowedUsd).toBe(7.5)
    expect(allowance(policy, at('2026-10-12T19:00:00Z'), 0, undefined).allowedUsd).toBe(50)
  })
})
