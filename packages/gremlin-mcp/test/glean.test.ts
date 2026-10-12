import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Wallet } from 'ethers'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway, withGlean } from '../src/gateway/server.js'
import { gleanRoute, looksSensitive } from '../src/gateway/glean.js'

describe('glean endpoints', () => {
  it('uses keyless endpoints by default and keyed free tiers only when the maker supplied a key and model', () => {
    expect(gleanRoute({}).route.map((t) => t.provider)).toEqual(['glean-pollinations'])
    const r = gleanRoute({ GLEAN_GROQ_KEY: 'k' }, { 'groq-free': ['llama-x'] })
    expect(r.route.map((t) => `${t.provider}/${t.model}`)).toEqual(['glean-pollinations/openai', 'glean-groq-free/llama-x'])
    expect(r.route.every((t) => t.inputPerM === 0 && t.outputPerM === 0)).toBe(true)
  })

  it('recognises secrets', () => {
    const w = Wallet.createRandom()
    expect(looksSensitive([{ role: 'user', content: `key ${w.privateKey}` }])).toBe(true)
    expect(looksSensitive([{ role: 'user', content: w.mnemonic!.phrase }])).toBe(true)
    expect(looksSensitive([{ role: 'user', content: 'token ss_t_' + 'a'.repeat(27) }])).toBe(true)
    expect(looksSensitive([{ role: 'user', content: 'What is the capital of France?' }])).toBe(false)
  })
})

describe('gremlin-glean through the gateway', () => {
  let up: Server
  let gw: Server
  let base: string
  let hits = 0
  let clock = 0
  beforeAll(async () => {
    up = createServer((_q, s) => { hits++; s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ choices: [{ message: { content: 'free answer' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })) })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(up.address() as { port: number }).port}/v1`
    const cfg = GatewayConfig.parse({
      providers: [{ id: 'free', kind: 'openai', baseUrl: u, free: true, minIntervalMs: 10_000 }],
      routes: { 'gremlin-glean': [{ provider: 'free', model: 'm' }] },
    })
    gw = createGateway(cfg, { now: () => clock })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
  })
  afterAll(() => { gw.close(); up.close() })
  const ask = (content: string) => fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-glean', messages: [{ role: 'user', content }] }) })

  it('answers small questions for free, keeping to the endpoint\'s rate', async () => {
    expect((await ask('2+2?')).status).toBe(200)
    const tooSoon = await ask('3+3?')
    expect(tooSoon.status).toBe(503)
    expect((await tooSoon.json()).error.message).toContain('rate limit')
    clock += 10_000
    expect((await ask('3+3?')).status).toBe(200)
    expect(hits).toBe(2)
  })

  it('never sends secrets to a free endpoint', async () => {
    clock += 10_000
    const r = await ask(`please check ${Wallet.createRandom().privateKey}`)
    expect(r.status).toBe(503)
    expect((await r.json()).error.message).toContain('secret')
    expect(hits).toBe(2)
  })

  it('is added automatically from the reviewed list', () => {
    const cfg = withGlean(GatewayConfig.parse({ providers: [{ id: 'p', kind: 'openai', baseUrl: 'http://x/v1' }], routes: { 'gremlin-main': [{ provider: 'p', model: 'm' }] } }), {})
    expect(cfg.routes['gremlin-glean']![0]!.provider).toBe('glean-pollinations')
  })
})
