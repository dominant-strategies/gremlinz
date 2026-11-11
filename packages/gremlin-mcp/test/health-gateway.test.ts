import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse, createServer, type Server } from 'node:http'
import { Socket } from 'node:net'
import { createGateway, isLocal, withDirective } from '../src/gateway/server.js'
import { GatewayConfig } from '../src/gateway/config.js'
import { classify, routeFor } from '../src/gateway/router.js'
import { ModelRating } from '../src/gateway/ratings.js'
import { healthReader } from '../src/health/gate.js'

const cfg = (u: string) => GatewayConfig.parse({
  providers: [{ id: 'paid', kind: 'openai', baseUrl: `${u}/paid/v1` }, { id: 'free', kind: 'openai', baseUrl: `${u}/free/v1`, free: true }],
  routes: { 'gremlin-main': [{ provider: 'paid', model: 'big' }], 'gremlin-glean': [{ provider: 'free', model: 'small' }] },
})

describe('admin endpoint', () => {
  it('refuses anyone but localhost', async () => {
    const gw = createGateway(cfg('http://127.0.0.1:9'))
    const call = (addr: string) => new Promise<{ status: number; body: string }>((resolve) => {
      const sock = new Socket()
      Object.defineProperty(sock, 'remoteAddress', { value: addr })
      const req = new IncomingMessage(sock)
      req.method = 'POST'
      req.url = '/admin/cooldown/reset'
      const res = new ServerResponse(req)
      let body = ''
      res.write = ((c: string) => { body += c; return true }) as never
      res.end = ((c?: string) => { body += c ?? ''; resolve({ status: res.statusCode, body }); return res }) as never
      gw.emit('request', req, res)
      req.push(null)
    })
    expect((await call('203.0.113.7')).status).toBe(403)
    expect((await call('::ffff:10.0.0.2')).status).toBe(403)
    expect((await call('127.0.0.1')).status).toBe(200)
    expect(isLocal('::1')).toBe(true)
    expect(isLocal(undefined)).toBe(false)
  })
})

describe('the health directive in every request', () => {
  let up: Server
  let base: string
  const seen: { provider: string; messages: { role: string; content: string }[] }[] = []
  let directive: string | undefined = 'Survival mode: money: runway 2.0 days. Until it\'s fixed, every action must serve fixing it; defer everything else.'
  beforeAll(async () => {
    up = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        seen.push({ provider: req.url!.split('/')[1]!, messages: JSON.parse(b).messages })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const gw = createGateway(cfg(`http://127.0.0.1:${(up.address() as { port: number }).port}`), { health: () => ({ directive }) })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
  })
  afterAll(() => up.close())
  const chat = (model: string, messages: unknown[]) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages }) })

  it('goes right after the system prompt, on every route, free endpoints included', async () => {
    await chat('gremlin-main', [{ role: 'system', content: 'You are Kip.' }, { role: 'user', content: 'plan my day' }, { role: 'assistant', content: 'sure' }, { role: 'user', content: 'go' }])
    expect(seen.at(-1)!.messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user'])
    expect(seen.at(-1)!.messages[0]!.content).toBe('You are Kip.')
    expect(seen.at(-1)!.messages[1]!.content).toBe(directive)
    await chat('gremlin-glean', [{ role: 'user', content: 'capital of France?' }])
    expect(seen.at(-1)).toEqual({ provider: 'free', messages: [{ role: 'system', content: directive }, { role: 'user', content: 'capital of France?' }] })
  })

  it('adds nothing when health is fine', async () => {
    directive = undefined
    await chat('gremlin-main', [{ role: 'user', content: 'hi' }])
    expect(seen.at(-1)!.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(withDirective({ model: 'x' }, 'd')).toEqual({ model: 'x' })
  })

  it('reads health.json at most every 30 seconds, and ignores a stale one', () => {
    const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
    process.env.GREMLIN_HOME = home
    let now = Date.parse('2026-11-10T12:00:00Z')
    const write = (at: number, d: string) => writeFileSync(join(home, 'health.json'), JSON.stringify({ at: new Date(at).toISOString(), directive: d, conserve: true }))
    write(now, 'first')
    const read = healthReader(30_000, () => now)
    expect(read()).toEqual({ directive: 'first', conserve: true })
    write(now, 'second')
    now += 10_000
    expect(read()?.directive).toBe('first') // cached
    now += 25_000
    expect(read()?.directive).toBe('second')
    write(now - 60 * 60_000, 'old')
    now += 31_000
    expect(read()).toBeUndefined() // the monitor stopped: no directive rather than an outdated one
  })
})

describe('conserving router', () => {
  const r = (model: string, q: number, inputPerM: number, outputPerM: number) => ModelRating.parse({ provider: 'p', model, scores: { general: q, code: q }, inputPerM, outputPerM })
  const ratings = [r('frontier', 95, 3, 15), r('solid', 82, 0.4, 1.6), r('cheap', 68, 0.05, 0.2)]
  const inp = { ratings, providers: new Set(['p']), fallback: [{ provider: 'p', model: 'frontier', inputPerM: 3, outputPerM: 15 }], glean: [{ provider: 'free', model: 'g', inputPerM: 0, outputPerM: 0 }] }
  const hard = classify({ messages: [{ role: 'user', content: 'Think carefully: design a migration plan for this architecture.' }], tools: [{}] })

  it('at bad or critical health, prefers the cheapest model one quality step down', () => {
    expect(hard.complexity).toBe('hard')
    const normal = routeFor(hard, inp).map((t) => t.model)
    const conserving = routeFor(hard, { ...inp, conserve: true }).map((t) => t.model)
    expect(normal).toEqual(['solid', 'frontier']) // the hard floor (80) excludes cheap
    expect(conserving).toEqual(['cheap', 'solid', 'frontier'])
    const small = classify({ messages: [{ role: 'user', content: 'a medium question about naming things in my notes?' }], tools: [] })
    expect(routeFor({ ...small, complexity: 'medium' }, { ...inp, conserve: true })[0]!.model).toBe('g') // free first when it can
  })
})
