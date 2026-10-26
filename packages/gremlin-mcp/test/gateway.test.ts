import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway, type CallRecord } from '../src/gateway/server.js'

// Fake upstreams: "down" always 503, "busy" 429 once, "ok" answers (and streams), "bad" rejects the request (400).
const hits: Record<string, number> = {}
let up: Server
let gw: Server
let base: string
const calls: CallRecord[] = []
let clock = 1_000_000

function upstream() {
  return createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const id = req.url!.split('/')[1]!
      hits[id] = (hits[id] ?? 0) + 1
      const b = JSON.parse(body)
      if (id === 'down') { res.statusCode = 503; return res.end('{"error":"down"}') }
      if (id === 'bad') { res.statusCode = 400; return res.end('{"error":{"message":"bad request"}}') }
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'x', model: b.model, choices: [{ message: { role: 'assistant', content: `from ${id} as ${b.model}` } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }))
    })
  })
}

beforeAll(async () => {
  up = upstream()
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
  const u = `http://127.0.0.1:${(up.address() as { port: number }).port}`
  const cfg = GatewayConfig.parse({
    providers: ['down', 'ok', 'bad'].map((id) => ({ id, kind: 'openai', baseUrl: `${u}/${id}/v1` })),
    routes: {
      'gremlin-main': [{ provider: 'down', model: 'big' }, { provider: 'ok', model: 'big-ok', inputPerM: 1, outputPerM: 2 }],
      'gremlin-bad': [{ provider: 'bad', model: 'x' }, { provider: 'ok', model: 'y' }],
    },
    glean: { enabled: false },
  })
  gw = createGateway(cfg, { onCall: (r) => calls.push(r), now: () => clock })
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
})
afterAll(() => { gw.close(); up.close() })

const chat = (model: string, extra: object = {}) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }) })

describe('inference gateway', () => {
  it('lists aliases as models', async () => {
    const r = await (await fetch(`${base}/models`)).json()
    expect(r.data.map((m: { id: string }) => m.id)).toEqual(['gremlin-main', 'gremlin-bad'])
  })

  it('fails over to the next provider and reports the alias as the model', async () => {
    const r = await (await chat('gremlin-main')).json()
    expect(r.choices[0].message.content).toBe('from ok as big-ok')
    expect(r.model).toBe('gremlin-main')
    expect(calls.at(-1)).toMatchObject({ provider: 'ok', usage: { promptTokens: 100, completionTokens: 50 } })
  })

  it('skips a provider in cooldown, then retries it after the cooldown', async () => {
    const before = hits.down
    await chat('gremlin-main')
    expect(hits.down).toBe(before) // still cooling down
    clock += 31_000
    await chat('gremlin-main')
    expect(hits.down).toBe(before! + 1)
  })

  it('does not fail over on a bad request', async () => {
    const r = await chat('gremlin-bad')
    expect(r.status).toBe(400)
    expect(hits.ok).toBe(3)
  })

  it('passes streams through and captures usage from the last chunk', async () => {
    const r = await chat('gremlin-main', { stream: true })
    const text = await r.text()
    expect(text).toContain('"hel"')
    expect(text).toContain('[DONE]')
    expect(calls.at(-1)!.usage).toEqual({ promptTokens: 11, completionTokens: 2 })
  })

  it('names the valid aliases for an unknown model', async () => {
    const r = await chat('gpt-9')
    expect(r.status).toBe(404)
    expect((await r.json()).error.message).toContain('gremlin-main')
  })
})

describe('incomplete streams', () => {
  it('records a stream that ends without a finish_reason as incomplete', async () => {
    const { createServer } = await import('node:http')
    const up2 = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/event-stream' }); s.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`) })
    await new Promise<void>((r) => up2.listen(0, '127.0.0.1', r))
    const recs: CallRecord[] = []
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${(up2.address() as { port: number }).port}/v1` }], routes: { m: [{ provider: 'p', model: 'x' }] }, glean: { enabled: false } })
    const g = createGateway(cfg, { onCall: (r) => recs.push(r) })
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${(g.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) })
    expect(await r.text()).toContain('partial')
    expect(recs[0]!.incomplete).toBe(true)
    g.close(); up2.close()
  })
})

describe('hung and unpaid providers', () => {
  it('abandons a provider that never answers after firstByteMs, and benches a 402 for 30 minutes', async () => {
    const { createServer } = await import('node:http')
    let paidHits = 0
    const up3 = createServer((req, res) => {
      if (req.url!.startsWith('/hang')) return // never answers
      if (req.url!.startsWith('/unpaid')) { paidHits++; res.statusCode = 402; return res.end('{"error":"insufficient_balance"}') }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    await new Promise<void>((r) => up3.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(up3.address() as { port: number }).port}`
    let clock = 0
    const cfg = GatewayConfig.parse({
      providers: [
        { id: 'hang', kind: 'openai', baseUrl: `${u}/hang/v1`, firstByteMs: 300 },
        { id: 'unpaid', kind: 'openai', baseUrl: `${u}/unpaid/v1` },
        { id: 'ok', kind: 'openai', baseUrl: `${u}/ok/v1` },
      ],
      routes: { m: [{ provider: 'hang', model: 'x' }, { provider: 'unpaid', model: 'x' }, { provider: 'ok', model: 'x' }] },
      glean: { enabled: false },
    })
    const g = createGateway(cfg, { now: () => clock })
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r))
    const ask = () => fetch(`http://127.0.0.1:${(g.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    const t0 = Date.now()
    expect((await (await ask()).json()).choices[0].message.content).toBe('ok')
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(paidHits).toBe(1)
    clock += 5 * 60_000 // the hung provider is back after its cooldown; the unpaid one is not
    await ask()
    expect(paidHits).toBe(1)
    clock += 30 * 60_000
    await ask()
    expect(paidHits).toBe(2)
    g.close(); up3.closeAllConnections(); up3.close()
  })
})

describe('stalled streams', () => {
  it('cuts a stream that goes silent and benches the provider', async () => {
    const { createServer } = await import('node:http')
    const up4 = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/event-stream' }); s.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'start' } }] })}\n\n`) /* then silence */ })
    await new Promise<void>((r) => up4.listen(0, '127.0.0.1', r))
    const recs: CallRecord[] = []
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${(up4.address() as { port: number }).port}/v1`, firstByteMs: 300 }], routes: { m: [{ provider: 'p', model: 'x' }] }, glean: { enabled: false } })
    const g = createGateway(cfg, { onCall: (r) => recs.push(r) })
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(g.address() as { port: number }).port}`
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) })
    await expect(r.text()).rejects.toThrow() // the client sees a broken stream, not a clean end
    expect(recs[0]!.incomplete).toBe(true)
    expect(Object.keys((await (await fetch(`${base}/health`)).json()).cooling)).toEqual(['p'])
    g.close(); up4.closeAllConnections(); up4.close()
  })
})

describe('long healthy streams', () => {
  it('are not cut by the first-response limit once data is flowing', async () => {
    const { createServer } = await import('node:http')
    const up5 = createServer((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/event-stream' })
      let n = 0
      const t = setInterval(() => {
        s.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${n}` }, finish_reason: n === 5 ? 'stop' : null }] })}\n\n`)
        if (++n > 5) { clearInterval(t); s.end('data: [DONE]\n\n') }
      }, 150) // 900 ms in total, well past firstByteMs, but never silent for long
    })
    await new Promise<void>((r) => up5.listen(0, '127.0.0.1', r))
    const recs: CallRecord[] = []
    const cfg = GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${(up5.address() as { port: number }).port}/v1`, firstByteMs: 400 }], routes: { m: [{ provider: 'p', model: 'x' }] }, glean: { enabled: false } })
    const g = createGateway(cfg, { onCall: (r) => recs.push(r) })
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${(g.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [] }) })
    expect(await r.text()).toContain('[DONE]')
    expect(recs[0]!.incomplete).toBeFalsy()
    g.close(); up5.close()
  })
})
