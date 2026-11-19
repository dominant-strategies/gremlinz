import { describe, expect, it } from 'vitest'
import type { OpenGrant } from '../src/gateway/grants.js'
import { GrantPool } from '../src/gateway/grant-pool.js'
import { fingerprint } from '../src/gateway/credentials.js'
import { ModelChoice, openaiCatalog } from '@gremlins/hatch'

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

describe('lent keys pick from the models the key actually serves', () => {
  const anthropicList = [
    { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' },
  ]
  const catalogOf = (list: { id: string }[]) => async () => openaiCatalog('anthropic', { data: list })
  const ron = () => grant('c', { provider: { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-5-5'], inputPerM: 3, outputPerM: 15, budgetApi: 'none' } })
  const at = Date.parse('2026-11-13T12:00:00Z')

  it('reads an old grant\'s stale list as preferences, then the same family, each at its real price', async () => {
    const pool = new GrantPool({ now: () => at, load: async () => [ron()], used: () => 0, catalog: catalogOf(anthropicList) })
    const [offer] = await pool.offers()
    // claude-opus-5-5 is the one listed model still served; then current Claude models; never another maker.
    expect(offer!.targets.map((t) => t.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(offer!.targets[0]).toMatchObject({ inputPerM: 4, outputPerM: 20 }) // Opus 5.5, not the grant's $3/$15
  })

  it('a grant with a model choice needs no names: balanced first from the key\'s list', async () => {
    const g = ron(); g.grant.modelChoice = ModelChoice.parse({})
    const pool = new GrantPool({ now: () => at, load: async () => [g], used: () => 0, catalog: catalogOf(anthropicList) })
    const [offer] = await pool.offers()
    expect(offer!.targets[0]).toMatchObject({ model: 'claude-sonnet-5-5', inputPerM: 2, outputPerM: 10 })
  })

  it('reads the list again after the provider retires a model, and falls back to the grant\'s list when it can\'t', async () => {
    let reads = 0, list = anthropicList
    const g = ron(); g.grant.modelChoice = ModelChoice.parse({})
    const pool = new GrantPool({ now: () => at, load: async () => [g], used: () => 0, catalog: async () => { reads++; return openaiCatalog('anthropic', { data: list }) } })
    const [first] = await pool.offers()
    await pool.offers()
    expect(reads).toBe(1) // cached
    list = anthropicList.filter((m) => m.id !== 'claude-sonnet-5-5')
    first!.observe!(404, new Headers(), '{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5-5"}}')
    const [second] = await pool.offers()
    expect(reads).toBe(2)
    expect(second!.targets.map((t) => t.model)).not.toContain('claude-sonnet-5-5')

    const offline = new GrantPool({ now: () => at, load: async () => [ron()], used: () => 0, catalog: async () => { throw new Error('403') } })
    expect((await offline.offers())[0]!.targets.map((t) => t.model)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-5-5'])
  })

  it('caps each call at the price of the model it goes to', async () => {
    const g = ron(); g.grant.modelChoice = ModelChoice.parse({ tier: 'best' })
    g.grant.policy.maxPerCallUsd = 0.05
    const pool = new GrantPool({ now: () => at, load: async () => [g], used: () => 0, catalog: catalogOf(anthropicList) })
    const [offer] = await pool.offers()
    const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100_000 }
    const opus = offer!.prepare!(body, offer!.targets.find((t) => t.model === 'claude-opus-5-5'))
    const haiku = offer!.prepare!(body, offer!.targets.find((t) => t.model === 'claude-haiku-5-5'))
    if ('skip' in opus || 'skip' in haiku) throw new Error('skipped')
    expect(Number(opus.body.max_tokens)).toBeLessThan(Number(haiku.body.max_tokens)) // $20/M output vs $0.50/M
  })
})
