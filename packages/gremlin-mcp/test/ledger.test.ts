import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, costUsd } from '../src/gateway/ledger.js'

const target = { provider: 'p', model: 'm', inputPerM: 2, outputPerM: 8 }
const rec = (at: string, promptTokens = 1_000_000, completionTokens = 0) => ({ at, alias: 'gremlin-main', provider: 'p', model: 'm', status: 200, ms: 5, usage: { promptTokens, completionTokens } })

describe('inference ledger', () => {
  it('prices calls from token usage', () => {
    expect(costUsd(rec('2026-10-12T00:00:00Z', 500_000, 250_000), target)).toBeCloseTo(1 + 2)
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
})

describe('budget enforcement in the gateway', () => {
  it('refuses with budget_exhausted before calling any provider', async () => {
    const { createServer } = await import('node:http')
    const { createGateway } = await import('../src/gateway/server.js')
    const { GatewayConfig } = await import('../src/gateway/config.js')
    let upstreamHits = 0
    const up = createServer((_q, s) => { upstreamHits++; s.end('{}') })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${(up.address() as { port: number }).port}/v1` }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }] } })
    const gw = createGateway(cfg, { refuse: () => 'inference budget for today is spent' })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${(gw.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [] }) })
    expect(r.status).toBe(429)
    expect((await r.json()).error.type).toBe('budget_exhausted')
    expect(upstreamHits).toBe(0)
    gw.close(); up.close()
  })
})
