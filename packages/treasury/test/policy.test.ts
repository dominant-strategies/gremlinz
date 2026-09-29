import { describe, expect, it } from 'vitest'
import { USD, billsInCycle, checkConversion, nonCoreCeiling, shortfallByAsset, sweepPlan, type Bill } from '../src/policy.js'

const d = (s: string) => new Date(s)
const bills: Bill[] = [
  { id: 'server', asset: 'usdt:sporestack', valueUsd: 10n * USD, dueAt: d('2026-10-05') },
  { id: 'inference', asset: 'usdc:8453', valueUsd: 20n * USD, dueAt: d('2026-10-20') },
  { id: 'next-month', asset: 'usdc:8453', valueUsd: 30n * USD, dueAt: d('2026-11-20') },
]

describe('treasury rule', () => {
  it('only counts bills in the current cycle', () => {
    expect(billsInCycle(bills, d('2026-10-31')).map((b) => b.id)).toEqual(['server', 'inference'])
  })

  it('ceiling is 1.2x current-cycle needs', () => {
    expect(nonCoreCeiling(30n * USD)).toBe(36n * USD)
  })

  it('allows converting exactly what is needed', () => {
    const r = checkConversion({ amountUsd: 20n * USD, cycleBills: billsInCycle(bills, d('2026-10-31')), nonCoreHoldings: [{ asset: 'usdt:sporestack', valueUsd: 10n * USD }] })
    expect(r.ok).toBe(true)
  })

  it('refuses conversions that push holdings past the ceiling', () => {
    const r = checkConversion({ amountUsd: 27n * USD, cycleBills: billsInCycle(bills, d('2026-10-31')), nonCoreHoldings: [{ asset: 'usdt:sporestack', valueUsd: 10n * USD }] })
    expect(r.ok).toBe(false)
    expect(r.afterUsd).toBe(37n * USD)
  })

  it('refuses any conversion when nothing is due', () => {
    expect(checkConversion({ amountUsd: 1n, cycleBills: [], nonCoreHoldings: [] }).ok).toBe(false)
  })

  it('computes shortfall per asset with no buffer', () => {
    const s = shortfallByAsset(billsInCycle(bills, d('2026-10-31')), [{ asset: 'usdc:8453', valueUsd: 5n * USD }])
    expect(s.get('usdc:8453')).toBe(15n * USD)
    expect(s.get('usdt:sporestack')).toBe(10n * USD)
  })

  it('sweeps everything not earmarked for a current bill', () => {
    const plan = sweepPlan(billsInCycle(bills, d('2026-10-31')), [
      { asset: 'usdc:8453', valueUsd: 50n * USD },
      { asset: 'btc', valueUsd: 7n * USD },
    ])
    expect(plan).toEqual([
      { asset: 'usdc:8453', valueUsd: 30n * USD },
      { asset: 'btc', valueUsd: 7n * USD },
    ])
  })
})
