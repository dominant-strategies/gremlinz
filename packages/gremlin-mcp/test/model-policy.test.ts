import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { ModelPolicy, type CatalogModel } from '@gremlins/hatch'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway, type CallRecord } from '../src/gateway/server.js'
import { ModelRating } from '../src/gateway/ratings.js'
import { applyCatalog, sparesFor } from '../src/gateway/catalog.js'
import { gatewayConfig, withPolicy } from '../src/bootstrap/gateway-config.js'
import { soulMarkdown } from '../src/bootstrap/soul.js'

const policy = (p: object) => ModelPolicy.parse(p)
const cat = (ref: string, family: CatalogModel['family'], traits: CatalogModel['traits'], price: number): CatalogModel => {
  const [provider, id] = ref.split('/') as [string, string]
  return { ref, provider, id, name: id, family, traits, tools: true, inputPerM: price / 4, outputPerM: price }
}

describe('gremlin-main under a policy', () => {
  const defaults = [{ provider: 'hashference', model: 'deepseek-v4-flash', inputPerM: 0.17, outputPerM: 0.33 }, { provider: 'venice', model: 'qwen3-5-397b-a17b', inputPerM: 0.6, outputPerM: 2.4 }]
  it('puts the named models first and keeps only the defaults the policy allows', () => {
    const r = withPolicy(defaults, policy({ primary: 'venice/claude-opus-5-5', approved: ['nowhere/x'], alternatives: [{ families: ['qwen'] }] }), ['hashference', 'venice'])
    expect(r.map((t) => `${t.provider}/${t.model}`)).toEqual(['venice/claude-opus-5-5', 'venice/qwen3-5-397b-a17b'])
  })
  it('no policy: the defaults as they were', () => {
    expect(withPolicy(defaults, undefined, ['venice'])).toBe(defaults)
    expect(gatewayConfig({}).policy).toBeUndefined()
  })
  it('carries the policy into the gateway config', () => {
    const p = policy({ primary: 'venice/qwen3-5-397b-a17b' })
    const cfg = GatewayConfig.parse(JSON.parse(JSON.stringify(gatewayConfig({ policy: p }))))
    expect(cfg.policy?.primary).toBe('venice/qwen3-5-397b-a17b')
    expect(cfg.routes['gremlin-main']![0]).toMatchObject({ provider: 'venice', model: 'qwen3-5-397b-a17b' })
  })
})

describe('the catalogue in the egg', () => {
  const models = [
    cat('venice/claude-opus-5-5', 'anthropic', [], 20),
    cat('venice/claude-sonnet-6', 'anthropic', [], 10),
    cat('hashference/anthropic-claude-haiku-6', 'anthropic', [], 0.5),
    cat('venice/qwen-9-max', 'qwen', [], 9),
    cat('venice/openai-gpt-7', 'openai', [], 10),
    cat('other/claude-x', 'anthropic', [], 10), // a provider the gateway doesn't have
  ]
  it('picks spares of an allowed kind, same family and class first', () => {
    const p = policy({ primary: 'venice/claude-opus-5-5', alternatives: [{ families: ['anthropic', 'qwen'] }] })
    const s = sparesFor(p, models, [{ provider: 'venice', model: 'claude-opus-5-5', inputPerM: 0, outputPerM: 0 }], new Set(['venice', 'hashference']))
    expect(s.map((t) => `${t.provider}/${t.model}`)).toEqual(['venice/claude-sonnet-6', 'hashference/anthropic-claude-haiku-6', 'venice/qwen-9-max'])
  })
  it('no alternatives: no spares (the maker named every model it may use)', () => {
    expect(sparesFor(policy({ primary: 'venice/claude-opus-5-5' }), models, [], new Set(['venice']))).toEqual([])
  })
  it('prices named models and replaces spares on each refresh', () => {
    const cfg = GatewayConfig.parse({
      providers: [{ id: 'venice', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1' }],
      routes: { 'gremlin-main': [{ provider: 'venice', model: 'claude-opus-5-5' }] },
      policy: { primary: 'venice/claude-opus-5-5', alternatives: [{ families: ['anthropic'] }] },
    })
    const spares = new Set<string>()
    applyCatalog(cfg, models, spares)
    expect(cfg.routes['gremlin-main']).toEqual([
      { provider: 'venice', model: 'claude-opus-5-5', inputPerM: 5, outputPerM: 20 },
      { provider: 'venice', model: 'claude-sonnet-6', inputPerM: 2.5, outputPerM: 10 },
    ])
    // sonnet withdrawn, a new one released
    applyCatalog(cfg, [models[0]!, cat('venice/claude-sonnet-7', 'anthropic', [], 10)], spares)
    expect(cfg.routes['gremlin-main']!.map((t) => t.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-7'])
  })
})

describe('the gateway keeps to the policy', () => {
  let up: Server
  const gws: Server[] = []
  let port = 0
  beforeAll(async () => {
    // "prude" refuses everything; "open" answers; "dead" is down
    up = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const id = req.url!.split('/')[1]
        if (id === 'dead') { res.statusCode = 503; return res.end('{}') }
        const content = id === 'prude' ? "I'm sorry, but I can't help with that." : 'Here is a balanced answer.'
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    port = (up.address() as { port: number }).port
  })
  afterAll(() => { for (const g of gws) g.close(); up.close() })

  async function gateway(p: object, main = 'prude') {
    const calls: CallRecord[] = []
    const cfg = GatewayConfig.parse({
      providers: [
        { id: 'prude', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/prude/v1` },
        { id: 'dead', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/dead/v1` },
        { id: 'open', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/open/v1` },
        { id: 'free', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/free/v1`, free: true },
      ],
      routes: { 'gremlin-main': [{ provider: main, model: 'qwen3-a' }], 'gremlin-glean': [{ provider: 'free', model: 'llama-3-free' }] },
      glean: { enabled: false },
      policy: p,
    })
    const ratings = [ModelRating.parse({ provider: 'prude', model: 'qwen3-a', scores: { general: 90 }, inputPerM: 0.1, outputPerM: 0.1 }), ModelRating.parse({ provider: 'open', model: 'llama-3-uncensored', scores: { general: 70 }, inputPerM: 0.5, outputPerM: 0.5, permissive: true })]
    const gw = createGateway(cfg, { router: () => ({ ratings }), onCall: (r) => calls.push(r) })
    gws.push(gw)
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
    const ask = (model: string, content = 'Summarise the arguments for and against drug decriminalisation, briefly.') =>
      fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content }] }) }).then((r) => r.json())
    return { ask, calls }
  }

  it('does not retry a refusal on a model the policy rules out', async () => {
    const g = await gateway({ primary: 'prude/qwen3-a', alternatives: [{ families: ['qwen'] }], freeModels: false })
    const r = await g.ask('gremlin-auto')
    expect(r.choices[0].message.content).toMatch(/can't help/)
    expect(g.calls.map((c) => c.provider)).toEqual(['prude'])
  })
  it('retries it on one the policy allows', async () => {
    const g = await gateway({ primary: 'prude/qwen3-a', alternatives: [{ traits: ['uncensored'] }], freeModels: false })
    const r = await g.ask('gremlin-auto')
    expect(r.choices[0].message.content).toBe('Here is a balanced answer.')
    expect(g.calls.map((c) => c.provider)).toEqual(['prude', 'open'])
  })
  it('free models only when the policy allows them', async () => {
    const off = await gateway({ primary: 'dead/qwen3-a', freeModels: false }, 'dead')
    await off.ask('gremlin-main', 'hello')
    expect(off.calls.map((c) => c.provider)).toEqual(['dead'])
    const on = await gateway({ primary: 'dead/qwen3-a' }, 'dead')
    const r = await on.ask('gremlin-main', 'hello')
    expect(r.choices[0].message.content).toBe('Here is a balanced answer.')
    expect(on.calls.map((c) => c.provider)).toEqual(['dead', 'free'])
  })
})

describe('soul', () => {
  it('tells the gremlin its policy', () => {
    const config = { version: 1, name: 'Sprocket', persona: 'p', voice: '', goals: ['g'], preferredModels: [], maker: '0x' + '1'.repeat(40), parent: 'maker', revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: true, email: false, phone: false, money: false }, constitution: [], createdAt: '2026-11-11T00:00:00.000Z',
      models: policy({ primary: 'venice/qwen3-5-397b-a17b', alternatives: [{ families: ['qwen'], traits: ['private'] }], freeModels: false }) }
    const md = soulMarkdown(config as never, { evmAddress: '0x' + '2'.repeat(40), quaiAddress: '0x00' + '3'.repeat(38), boardUrl: 'https://gremlinz.ai' } as never)
    expect(md).toContain('## Models')
    expect(md).toContain('Primary: venice/qwen3-5-397b-a17b')
    expect(md).toContain('Qwen models (private)')
    expect(md).toContain('Free models are off for you')
  })
})
