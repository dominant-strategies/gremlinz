import { describe, expect, it } from 'vitest'
import type { OpenGrant } from '../src/gateway/grants.js'
import { GrantPool } from '../src/gateway/grant-pool.js'
import { fingerprint } from '../src/gateway/credentials.js'

const grant = (id: string, overrides = {}): OpenGrant => ({ apiKey: 'lent-secret', grant: {
  kind: 'key-grant', address: '0x01', gremlin: '0x02', grantId: `0x${id.repeat(32)}`,
  provider: { label: 'lent', baseUrl: 'https://unused/v1', models: ['qwen3'], inputPerM: 1, outputPerM: 1, budgetApi: 'none' },
  policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 10, rules: [{ withinHoursOfReset: 24, usePctOfBudget: 100 }], maxPerCallUsd: 0.5 },
  repay: 'patron', createdAt: '2026-11-13T00:00:00Z', sealedKey: { v: 1, epk: '', iv: '', ct: '' }, ...overrides,
} })

describe('bounded grant pool', () => {
  it('preserves lender wishes, in-flight limits and disabled-key reporting across authorization refreshes', async () => {
    let now = Date.parse('2026-11-13T12:00:00Z'), reports = 0
    const g = grant('a')
    g.grant.policy.limits = { rpm: 60, concurrency: 1 }
    g.grant.wishes = { purposes: ['plant trees'], forbidden: '', preferredModels: ['qwen3'], creditAs: 'tree-friend' }
    const pool = new GrantPool({ now: () => now, load: async () => [g], used: () => 0, onDisabled: () => { reports++ } })
    const offer = (await pool.offers())[0]!
    const prepared = offer.prepare!({ messages: [{ role: 'user', content: 'hello' }] })
    expect(JSON.stringify(prepared)).toContain('plant trees')
    expect(JSON.stringify(prepared)).toContain('tree-friend')
    const slot = offer.admit!(100)
    expect(slot).toHaveProperty('release')
    now += 30_000
    const refreshed = (await pool.offers())[0]!
    expect(refreshed.admit!(100)).toHaveProperty('skip')
    if ('release' in slot) slot.release(100)
    const next = refreshed.admit!(100)
    expect(next).toHaveProperty('release')
    if ('release' in next) next.release(100)
    refreshed.observe!(401, new Headers(), 'invalid key')
    refreshed.observe!(401, new Headers(), 'invalid key')
    expect(reports).toBe(1)
    expect(await pool.offers(true)).toHaveLength(0)
    expect(pool.allowanceFor(g.grant.grantId)).toBeUndefined()
    expect((await pool.status())[0]!.limiter.disabled?.status).toBe(401)
  })
  it('checks expiry on every dispatch and drops revoked grants after refresh', async () => {
    let now = Date.parse('2026-11-13T12:00:00Z')
    const g = grant('a', { expiresAt: new Date(now + 10_000).toISOString() })
    let rows = [g]
    const pool = new GrantPool({ now: () => now, load: async () => rows, used: () => 0 })
    expect(await pool.offers()).toHaveLength(1)
    expect(pool.allowanceFor(g.grant.grantId)?.maxPerCallUsd).toBe(0.5)
    now += 10_000
    expect(pool.allowanceFor(g.grant.grantId)).toBeUndefined()
    expect(await pool.offers()).toHaveLength(0)
    rows = [grant('b')]; now += 30_000
    expect(await pool.offers()).toHaveLength(1)
    rows = []; now += 30_000
    expect(await pool.offers()).toHaveLength(0)
  })
  it('fails closed after 60 seconds without a successful authorization refresh', async () => {
    let now = 0, failed = false
    const g = grant('a')
    const pool = new GrantPool({ now: () => now, load: async () => { if (failed) throw Error('offline'); return [g] }, used: () => 0 })
    await pool.offers(); failed = true; now = 30_000
    expect(await pool.offers()).toHaveLength(1)
    now = 60_000
    expect(await pool.offers()).toHaveLength(0)
    expect(pool.allowanceFor(g.grant.grantId)).toBeUndefined()
  })
  it('uses expiring allowances first and shares consumption for duplicate grants on the same credential', async () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    let used = 8
    const later = grant('a'), sooner = grant('b', { expiresAt: new Date(now + 60_000).toISOString() })
    const pool = new GrantPool({ now: () => now, load: async () => [later, sooner], used: (group) => { expect(group).toBe(`key:${fingerprint('lent-secret')}`); return used } })
    const offers = await pool.offers()
    expect(offers[0]!.targets[0]!.grantId).toBe(sooner.grant.grantId)
    expect(pool.allowanceFor(later.grant.grantId)!.scopes[0]).toMatchObject({ used: 8, limit: 10 })
    used = 10
    expect(pool.allowanceFor(sooner.grant.grantId)).toBeUndefined()
  })
  it('refreshes provider balances at reset and automatically restores recurring allowance', async () => {
    let now = Date.parse('2026-11-13T23:59:30Z'), used = 10, reads = 0
    let balance: number | undefined = 0
    const g = grant('a'); g.grant.provider.budgetApi = 'openrouter'
    const pool = new GrantPool({ now: () => now, load: async () => [g], used: () => used, remaining: async () => { reads++; return balance } })
    expect(await pool.offers()).toHaveLength(0)
    now += 31_000; used = 0; balance = 10
    expect(await pool.offers()).toHaveLength(1)
    expect(reads).toBe(2)
    balance = undefined; now += 120_000
    expect(await pool.offers()).toHaveLength(0)
  })
  it('deduplicates concurrent board refreshes', async () => {
    let calls = 0
    const pool = new GrantPool({ load: async () => { calls++; await Promise.resolve(); return [grant('a')] }, used: () => 0 })
    await Promise.all([pool.offers(), pool.offers(), pool.offers()])
    expect(calls).toBe(1)
  })
})
