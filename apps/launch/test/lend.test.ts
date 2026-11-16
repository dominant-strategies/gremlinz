import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { buildGrant, openApiKey } from '@gremlins/hatch'
import { DEFAULT_BUDGET, formPolicy, providerOptions } from '../src/lend-form.js'

describe('lending form', () => {
  it('lists forbidden providers with the reason, last, and not selectable', () => {
    const opts = providerOptions()
    const sub = opts.find((o) => o.id === 'claude-sub')!
    expect(sub.selectable).toBe(false)
    expect(sub.note).toMatch(/personal subscription/)
    expect(opts.find((o) => o.id === 'openrouter')!.selectable).toBe(true)
    const firstForbidden = opts.findIndex((o) => !o.selectable)
    expect(opts.slice(firstForbidden).every((o) => !o.selectable)).toBe(true)
  })

  it('turns "use up to 50% of what\'s left within 6 hours of my reset" into a what\'s-left rule', () => {
    expect(formPolicy({ ...DEFAULT_BUDGET, preset: 'leftover', every: 'day', pct: 50, hours: 6, budgetUsd: 10 }, 'openrouter'))
      .toMatchObject({ period: { every: 'day', resetAt: '00:00' }, budgetUsd: 10, rules: [{ withinHoursOfReset: 6, usePctOfRemaining: 50 }] })
  })

  it('turns "up to $5 a week" into a weekly $5 budget usable at any time, with optional caps', () => {
    const p = formPolicy({ ...DEFAULT_BUDGET, preset: 'fixed', every: 'week', dayOfWeek: 1, usd: 5, maxPerCallUsd: 0.05, limits: { rpm: 10 } }, 'hashference')
    expect(p).toMatchObject({ budgetUsd: 5, period: { every: 'week', dayOfWeek: 1 }, rules: [{ withinHoursOfReset: 168, usePctOfBudget: 100 }], maxPerCallUsd: 0.05, limits: { rpm: 10 } })
  })

  it('refuses a custom "what\'s left" rule where the provider can\'t report it', () => {
    expect(() => formPolicy({ ...DEFAULT_BUDGET, preset: 'custom', custom: { withinHoursOfReset: 12, share: 'remaining', pct: 20 } }, 'together')).toThrow(/doesn't report what's left/)
    expect(formPolicy({ ...DEFAULT_BUDGET, preset: 'custom', custom: { withinHoursOfReset: 12, share: 'remaining', pct: 20, minRemainingPct: 30 } }, 'openrouter').rules)
      .toEqual([{ withinHoursOfReset: 12, usePctOfRemaining: 20, minRemainingPct: 30 }])
  })

  it('seals the key so only the gremlin opens it', async () => {
    const gremlin = Wallet.createRandom()
    const g = await buildGrant({
      lender: Wallet.createRandom().address, gremlin: gremlin.address, gremlinPublicKey: gremlin.signingKey.publicKey, providerId: 'hashference',
      models: ['hashference-glm-5-3'], inputPerM: 0.441, outputPerM: 1.386, repay: 'patron', apiKey: 'hf_secret',
      wishes: { purposes: ['anything'], forbidden: '', preferredModels: [], creditAs: '' }, policy: formPolicy(DEFAULT_BUDGET, 'hashference'),
    })
    expect(g.provider).toMatchObject({ id: 'hashference', baseUrl: 'https://hashference.com/v1', budgetApi: 'hashference' })
    expect(JSON.stringify(g)).not.toContain('hf_secret')
    expect(await openApiKey(gremlin.signingKey, g.sealedKey)).toBe('hf_secret')
  })
})
