import { describe, expect, it } from 'vitest'
import { ModelRating, observe, rank, value } from '../src/gateway/ratings.js'

const r = (model: string, general: number, inputPerM: number, outputPerM: number, extra: object = {}) =>
  ModelRating.parse({ provider: 'p', model, scores: { general }, inputPerM, outputPerM, ...extra })

describe('model ratings', () => {
  const big = r('big', 90, 3, 15)
  const mid = r('mid', 75, 0.3, 1.2)
  const tiny = r('tiny', 40, 0.05, 0.1)

  it('ranks by quality per dollar of a typical task', () => {
    expect(value(big, 'general').usdPerTask).toBeCloseTo((2000 * 3 + 800 * 15) / 1e6)
    expect(rank([big, mid, tiny], 'general').map((x) => x.r.model)).toEqual(['tiny', 'mid', 'big'])
  })

  it('respects a quality floor for hard work', () => {
    expect(rank([big, mid, tiny], 'general', { minQuality: 80 }).map((x) => x.r.model)).toEqual(['big'])
    expect(rank([big, mid, tiny], 'general', { minQuality: 60 })[0]!.r.model).toBe('mid')
  })

  it('falls back to the general score for unrated domains, and uses domain scores when published', () => {
    const coder = r('coder', 60, 0.5, 2, { scores: { general: 60, code: 92 } })
    expect(rank([big, coder], 'code', { minQuality: 85 })[0]!.r.model).toBe('coder')
  })

  it('discounts models that fail or refuse in practice', () => {
    const at = '2026-10-12T00:00:00Z'
    const entries = Array.from({ length: 10 }, (_, i) => ({ at, alias: 'a', provider: 'p', model: 'mid', status: i < 5 ? 503 : 200, ms: 100, usd: 0, priced: true }))
    const seen = observe(entries)
    expect(seen.get('p/mid')).toMatchObject({ calls: 10, errorRate: 0.5 })
    expect(value(mid, 'general', seen.get('p/mid')).quality).toBeCloseTo(37.5)
  })
})
