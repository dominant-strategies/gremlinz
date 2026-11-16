import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { Credentials, fingerprint, retryAt } from '../src/gateway/credentials.js'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway, type GatewayDeps } from '../src/gateway/server.js'
import { Ledger } from '../src/gateway/ledger.js'
import { Reservations } from '../src/gateway/reservations.js'
import { spending } from '../src/gateway/spending.js'

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })
const cfg = (extra = {}) => GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1' }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm', inputPerM: 1, outputPerM: 1 }] }, glean: { enabled: false }, ...extra })
async function gateway(config: ReturnType<typeof cfg>, deps: GatewayDeps) {
  const s = createGateway(config, deps); servers.push(s)
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`
  return { ask: (model = 'gremlin-main', extra = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], ...extra }) }), health: async () => (await fetch(`${base}/health`)).json() }
}
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { headers: { 'content-type': 'application/json' } })

describe('credential recovery', () => {
  it('persists retry times, honors both Retry-After forms and never re-enables invalid authorization on a timer/reset', () => {
    let now = 1_000_000
    const file = join(mkdtempSync(join(tmpdir(), 'creds-')), 'states.json')
    const c = new Credentials({ now: () => now, file })
    c.fail('p', 429, new Headers({ 'retry-after': '120' }), fingerprint('secret'))
    expect(new Credentials({ file, now: () => now }).available('p', fingerprint('secret'))).toBe(false)
    now += 120_000
    expect(c.available('p', fingerprint('secret'))).toBe(true)
    c.fail('p', 401, undefined, fingerprint('secret'))
    now += 86_400_000
    c.reset()
    expect(c.available('p', fingerprint('secret'))).toBe(false)
    expect(c.available('p', fingerprint('replacement'))).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('secret')
    expect(retryAt(new Headers({ 'retry-after': 'invalid' }), now)).toBeUndefined()
    const date = new Date(now + 60_000).toUTCString()
    expect(retryAt(new Headers({ 'retry-after': date }), now)).toBe(Date.parse(date))
  })

  it('tries a second credential after 401/403 and reloads replaced environment secrets', async () => {
    for (const status of [401, 403]) {
      const env = { FIRST: 'rejected', SECOND: 'working' }
      const seen: string[] = []
      const realFetch = globalThis.fetch
      const config = cfg({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1', apiKeyEnvs: ['FIRST', 'SECOND'] }] })
      // providerFetch calls global fetch; intercept only upstream calls, keeping the gateway HTTP request real.
      globalThis.fetch = ((url, init) => {
        if (String(url).startsWith('http://unused')) {
          const auth = new Headers(init?.headers).get('authorization')!
          seen.push(auth)
          return Promise.resolve(auth === 'Bearer rejected' ? new Response('{}', { status }) : ok())
        }
        return realFetch(url, init)
      }) as typeof fetch
      try {
        const g = await gateway(config, { env })
        expect((await g.ask()).status).toBe(200)
        expect(seen).toEqual(['Bearer rejected', 'Bearer working'])
        await g.ask()
        expect(seen.at(-1)).toBe('Bearer working')
        env.FIRST = 'repaired'
        await g.ask()
        expect(seen.at(-1)).toBe('Bearer repaired')
        expect(JSON.stringify(await g.health())).not.toContain('rejected')
      } finally { globalThis.fetch = realFetch }
    }
  })

  it('tells the working fallback model to repair access, and stops prompting once the failed source is replaced', async () => {
    let repaired = false
    const env = { KEY: 'failed' }
    const messages: string[] = []
    const config = cfg({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1', apiKeyEnv: 'KEY' }, { id: 'q', kind: 'openai', baseUrl: 'http://unused/v1' }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' }] } })
    const g = await gateway(config, { env, fetchers: {
      p: async (_u, init) => { if (!repaired) return new Response('{}', { status: 401 }); messages.push(String(init.body)); return ok() },
      q: async (_u, init) => { messages.push(String(init.body)); return ok() },
    } })
    await g.ask('gremlin-main', { tools: [{ type: 'function', function: { name: 'inference_access' } }] })
    expect(messages.at(-1)).toContain('inference_access repair')
    repaired = true; env.KEY = 'replacement'
    await g.ask('gremlin-main', { tools: [{ type: 'function', function: { name: 'inference_access' } }] })
    expect(messages.at(-1)).not.toContain('inference_access repair')
  })

  it('shares rate-limit cooldown across credentials declared on one account, then restores them', async () => {
    let now = 0, hits = 0
    const g = await gateway(cfg({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1', accountId: 'shared' }, { id: 'q', kind: 'openai', baseUrl: 'http://unused/v1', accountId: 'shared' }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' }] } }), {
      now: () => now,
      fetchers: { p: async () => { hits++; return hits === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : ok() }, q: async () => { hits++; return ok() } },
    })
    expect((await g.ask()).status).toBe(503)
    expect(hits).toBe(1)
    now = 60_000
    expect((await g.ask()).status).toBe(200)
    expect(hits).toBe(2)
  })

  it('still reaches free/local inference when paid spending is exhausted', async () => {
    for (const local of [false, true]) {
      const hits: string[] = []
      const g = await gateway(cfg({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1' }, { id: 'backup', kind: 'openai', baseUrl: 'http://unused/v1', local, free: !local }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }, ...(local ? [{ provider: 'backup', model: 'small' }] : [])], ...(!local ? { 'gremlin-glean': [{ provider: 'backup', model: 'small' }] } : {}) } }), {
        refuse: () => 'spent', fetchers: { p: async () => { hits.push('paid'); return ok() }, backup: async () => { hits.push('backup'); return ok() } },
      })
      expect((await g.ask()).status).toBe(200)
      expect(hits).toEqual(['backup'])
    }
  })

  it('keeps emergency spending inside the daily cap and accounts for replies with missing usage', async () => {
    const config = cfg({ budget: { dailyUsd: 1, emergencyUsd: 0.2 } })
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'spending-')), 'calls.jsonl'))
    const r = { at: new Date().toISOString(), alias: 'gremlin-main', provider: 'p', model: 'm', status: 200, ms: 0, usage: { promptTokens: 800_000, completionTokens: 0 } }
    ledger.record(r, config.routes['gremlin-main']![0]!)
    let tokens = 0
    const g = await gateway(config, { ...spending(config, ledger, { allowanceFor: () => undefined }, new Reservations()), onCall: (r, t) => ledger.record(r, t), fetchers: { p: async (_url, init) => { tokens = JSON.parse(String(init.body)).max_tokens; return new Response('{"choices":[{"message":{"content":"recovered"}}]}') } } })
    expect((await g.ask()).status).toBe(429)
    expect((await g.ask('gremlin-recovery', { max_tokens: 10_000 })).status).toBe(200)
    expect(tokens).toBe(512)
    expect(ledger.spent()).toBeGreaterThan(0.8)
    expect(ledger.spent()).toBeLessThanOrEqual(1)
  })
  it('reserves before sending a concurrent call, then releases the hold after usage is recorded', async () => {
    const config = cfg({
      providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://unused/v1' }, { id: 'free', kind: 'openai', baseUrl: 'http://unused/v1', free: true }],
      routes: { 'gremlin-main': [{ provider: 'p', model: 'm', inputPerM: 1, outputPerM: 1000 }], 'gremlin-glean': [{ provider: 'free', model: 'small' }] },
      budget: { dailyUsd: 0.1 },
    })
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'concurrent-')), 'calls.jsonl'))
    const reservations = new Reservations()
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    let paidHits = 0, freeHits = 0
    const g = await gateway(config, {
      ...spending(config, ledger, { allowanceFor: () => undefined }, reservations),
      onCall: (r, t) => ledger.record(r, t),
      fetchers: { p: async () => { paidHits++; entered(); await pending; return ok() }, free: async () => { freeHits++; return ok() } },
    })
    const first = g.ask('gremlin-main', { max_tokens: 99 })
    await started
    try {
      expect((await g.ask('gremlin-main', { max_tokens: 99 })).status).toBe(200)
      expect(paidHits).toBe(1)
      expect(freeHits).toBe(1)
    } finally { finish() }
    expect((await first).status).toBe(200)
    expect(ledger.spent()).toBeLessThan(0.1)
    expect((await g.ask('gremlin-main', { max_tokens: 5 })).status).toBe(200)
    expect(paidHits).toBe(2)
  })

})
