import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, costUsd } from '../src/gateway/ledger.js'
import { GatewayConfig } from '../src/gateway/config.js'
import { Reservations } from '../src/gateway/reservations.js'
import { MAINTENANCE_DAILY_USD, spending } from '../src/gateway/spending.js'
import { settledHashferenceUsage } from '../src/hashference.js'
import { burnFromLedger } from '../src/health/measure.js'

const providerReservationId = 'rxs_47cf7775-4bd8-4a99-9e10-7639b336644a'

const target = { provider: 'p', model: 'm', inputPerM: 2, outputPerM: 8 }
const rec = (at: string, promptTokens = 1_000_000, completionTokens = 0) => ({ at, alias: 'gremlin-main', provider: 'p', model: 'm', status: 200, ms: 5, usage: { promptTokens, completionTokens } })

describe('inference ledger', () => {
  it('prices calls from token usage', () => {
    expect(costUsd(rec('2026-10-12T00:00:00Z', 500_000, 250_000), target)).toBeCloseTo(1 + 2)
  })

  it('prices cached inputs as a subset of total input, retaining full price when metadata is unusable', () => {
    const call = rec('2026-10-12T00:00:00Z', 500_000, 250_000)
    const cached = { ...call, usage: { ...call.usage, cachedPromptTokens: 400_000 } }
    expect(costUsd(cached, { ...target, cachedInputPerM: 0.5 })).toBeCloseTo(2.4)
    expect(costUsd(cached, target)).toBeCloseTo(3)
    expect(costUsd({ ...cached, usage: { ...cached.usage, cachedPromptTokens: 600_000 } }, { ...target, cachedInputPerM: 0.5 })).toBeCloseTo(3)
  })

  it('applies confirmed charges once, preserves reservations without receipts and replays corrections after restart', () => {
    let clock = Date.parse('2026-10-12T10:00:00Z')
    const now = () => clock
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'x.jsonl')
    const l = new Ledger(file, now)
    const at = new Date(clock).toISOString()
    l.record({ ...rec(at, 10_000), incomplete: true, estimatedUsd: 0.2, providerReservationId, accountId: 'own', alias: 'gremlin-maintenance' }, target)
    l.record({ ...rec(at, 25_000), accountId: 'own' }, target) // existing ledger format, unmatched
    expect(l.spent()).toBeCloseTo(0.25)
    appendFileSync(file, '{"kind":"settlem')
    const beforeReceipt = new Ledger(file, now)
    expect(beforeReceipt.settle('other', providerReservationId, 0)).toBe(false)
    expect(beforeReceipt.settle('p', providerReservationId, -1)).toBe(false)
    expect(beforeReceipt.settle('p', providerReservationId, 65_000)).toBe(true)
    expect(beforeReceipt.settle('p', providerReservationId, 65_000)).toBe(false)
    const restored = new Ledger(file, now)
    expect(restored.spent()).toBeCloseTo(0.115)
    expect(restored.spent(true)).toBeCloseTo(0.065)
    expect(restored.accountUsed('own')).toBeCloseTo(0.115)
    expect(restored.dailyAccounting().settledUsd).toBeCloseTo(0.065)
    expect(restored.dailyAccounting().estimatedUsd).toBeCloseTo(0.05)
    expect(restored.settle('p', providerReservationId, 65_000)).toBe(false)
    clock += 86_400_000
    expect(restored.settle('p', providerReservationId, 80_000)).toBe(true)
    expect(restored.spent()).toBe(0)
    const burn = burnFromLedger(file, clock - 1)
    expect(burn.usdPerDay).toBeCloseTo(0.13)
    expect(burn.providers).toEqual([{ provider: 'p', calls: 2, errorRate: 0 }])
  })

  it('refuses once the day is spent, resets the next UTC day, and survives restarts', () => {
    let clock = Date.parse('2026-10-12T10:00:00Z')
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'inference-ledger.jsonl')
    const l = new Ledger(file, () => clock)
    l.record(rec('2026-10-12T10:00:00Z'), target) // $2
    expect(l.refuse(5)).toBeUndefined()
    l.record(rec('2026-10-12T11:00:00Z', 1_500_000), target) // $3 → $5
    expect(l.refuse(5)).toMatch(/budget for today is spent/)
    appendFileSync(file, '{"torn') // a crash mid-write
    expect(new Ledger(file, () => clock).spent()).toBeCloseTo(5) // restart re-reads today
    clock = Date.parse('2026-10-13T00:00:01Z')
    expect(l.refuse(5)).toBeUndefined()
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('has no cap when no budget is configured', () => {
    const l = new Ledger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'x.jsonl'))
    expect(l.refuse(undefined)).toBeUndefined()
  })

  it('retains the separate maintenance cap after restart and preserves normal inference room', () => {
    let clock = Date.parse('2026-10-12T10:00:00Z')
    const now = () => clock
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'x.jsonl')
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://provider.example/v1' }], routes: { 'gremlin-main': [target] }, budget: { dailyUsd: 2 } })
    const original = new Ledger(file, now)
    original.record({ ...rec(new Date(clock).toISOString(), 125_000), alias: 'gremlin-maintenance' }, target)
    const restarted = new Ledger(file, now)
    expect(restarted.spent(true)).toBeCloseTo(MAINTENANCE_DAILY_USD)
    const policy = spending(cfg, restarted, { allowanceFor: () => undefined }, new Reservations({ now }), now)
    const attempt = (maintenance: boolean) => policy.reserve!({ messages: [], max_tokens: 30 }, target, cfg.providers[0]!, false, maintenance)
    expect(attempt(true)).toBeUndefined()
    expect(attempt(false)).toBeDefined()
    clock += 86_400_000
    expect(attempt(true)).toBeDefined()
  })
})

describe('budget enforcement in the gateway', () => {
  it('reopens room under the same cap after a matching Hashference receipt arrives', async () => {
    const { createGateway } = await import('../src/gateway/server.js')
    const cfg = GatewayConfig.parse({ providers: [{ id: 'hashference', kind: 'hashference', baseUrl: 'https://hashference.com/v1' }], routes: { 'gremlin-main': [{ ...target, provider: 'hashference', cachedInputPerM: 0.5 }] }, budget: { dailyUsd: 1, emergencyUsd: 0.1 }, glean: { enabled: false } })
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'x.jsonl'))
    ledger.record(rec(new Date().toISOString(), 420_000), target)
    const reservations = new Reservations()
    const policy = spending(cfg, ledger, { allowanceFor: () => undefined }, reservations)
    const messages = [{ role: 'user', content: 'x'.repeat(25_000) }]
    const reply = 'data: '+JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 20_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 18_000 } } })+'\n\ndata: [DONE]\n\n'
    const gw = createGateway(cfg, { ...policy, onCall: (call, route) => ledger.record(call, route), fetchers: {
      hashference: async () => new Response(reply, { headers: { 'x-hashference-reservation': providerReservationId, 'content-type': 'text/event-stream' } }),
    } })
    await new Promise<void>(resolve => gw.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
      const body = { model: 'gremlin-main', messages, max_tokens: 32, stream: true }
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) })
      expect(response.status).toBe(200)
      await response.text()
      const reserveAgain = () => policy.reserve!(body, cfg.routes['gremlin-main']![0]!, cfg.providers[0]!, false)
      expect(reserveAgain()).toBeUndefined()
      const get = (async () => Response.json({ recent: [
        { id: providerReservationId, status: 'open', costMicrousd: 0 },
        { id: providerReservationId, status: 'settled', costMicrousd: 4_500 },
        { id: providerReservationId, status: 'settled', costMicrousd: '0' },
      ] })) as typeof fetch
      const receipts = await settledHashferenceUsage({ apiKey: 'hf_mock', address: '', createdAt: '' }, get)
      expect(receipts).toEqual([{ id: providerReservationId, costMicrousd: 4_500 }])
      for (const receipt of receipts) expect(ledger.settle('hashference', receipt.id, receipt.costMicrousd)).toBe(true)
      const status = await (await fetch(`${base}/admin/access`)).json()
      expect(status.dailyAccounting.settledUsd).toBeCloseTo(0.0045)
      expect(status.dailyAccounting.pendingUsd).toBe(0)
      expect(status.dailyAccounting.normalRemainingUsd).toBeCloseTo(0.0555)
      expect(reserveAgain()).toBeDefined()
    } finally { gw.closeAllConnections(); gw.close() }
  })

  it('refuses with budget_exhausted before calling any provider', async () => {
    const { createServer } = await import('node:http')
    const { createGateway } = await import('../src/gateway/server.js')
    const { GatewayConfig } = await import('../src/gateway/config.js')
    let upstreamHits = 0
    const up = createServer((_q, s) => { upstreamHits++; s.end('{}') })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${(up.address() as { port: number }).port}/v1` }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }] }, glean: { enabled: false } })
    const gw = createGateway(cfg, { refuse: () => 'inference budget for today is spent' })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${(gw.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [] }) })
    expect(r.status).toBe(429)
    expect((await r.json()).error.type).toBe('budget_exhausted')
    expect(upstreamHits).toBe(0)
    gw.close(); up.close()
  })
})
