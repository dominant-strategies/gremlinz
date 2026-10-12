import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway, type CallRecord } from '../src/gateway/server.js'
import { ModelRating } from '../src/gateway/ratings.js'
import { classify, isRefusal, mayRetryRefusal, routeFor } from '../src/gateway/router.js'

const u = (content: string) => ({ messages: [{ role: 'user', content }] })
const rating = (provider: string, model: string, scores: object, inputPerM: number, outputPerM: number, extra: object = {}) =>
  ModelRating.parse({ provider, model, scores, inputPerM, outputPerM, ...extra })

describe('classify', () => {
  it('spots domain and complexity from the request', () => {
    expect(classify(u('What is the capital of France?'))).toMatchObject({ domain: 'general', complexity: 'small' })
    expect(classify(u('Refactor this TypeScript function to remove the bug:\n```ts\nconst f = () => 1\n```'))).toMatchObject({ domain: 'code' })
    expect(classify(u('Think carefully, step by step: plan a 3-month fundraising strategy for a weather-station gremlin.'))).toMatchObject({ domain: 'reasoning', complexity: 'hard' })
    expect(classify(u('Write a short tweet announcing my first paid gig'))).toMatchObject({ domain: 'writing', complexity: 'small' })
    expect(classify({ ...u('hi'), tools: [{ type: 'function' }] })).toMatchObject({ needsTools: true, complexity: 'medium' })
    expect(classify(u('x'.repeat(300_000))).complexity).toBe('hard')
    // an ordinary agent turn: a big system prompt plus tools is not hard by itself
    const agentTurn = { messages: [{ role: 'system', content: 'rules '.repeat(15_000) }, { role: 'user', content: 'Check your treasury and read the board.' }], tools: [{ type: 'function' }] }
    expect(classify(agentTurn).complexity).toBe('medium')
  })
})

describe('routeFor', () => {
  const ratings = [
    rating('venice', 'big', { general: 92, code: 90 }, 3, 15),
    rating('venice', 'mid', { general: 72 }, 0.3, 1.2),
    rating('nano', 'coder', { general: 70, code: 88 }, 0.4, 1.6),
    rating('gone', 'x', { general: 99 }, 0, 0), // provider not configured
  ]
  const inp = { ratings, providers: new Set(['venice', 'nano']), glean: [{ provider: 'glean-pollinations', model: 'openai', inputPerM: 0, outputPerM: 0 }], fallback: [{ provider: 'venice', model: 'big', inputPerM: 3, outputPerM: 15 }] }

  it('tries free gleaning first for small questions, then the best value above the floor', () => {
    expect(routeFor(classify(u('2+2?')), inp).map((t) => t.model)).toEqual(['openai', 'mid', 'coder', 'big'])
  })

  it('needs a strong model for hard work, and picks the specialist for code', () => {
    const hardCode = classify(u('Debug this: ```js\nwhile(true){}\n``` ' + 'context '.repeat(400)))
    expect(routeFor(hardCode, inp).map((t) => t.model)).toEqual(['coder', 'big'])
  })

  it('never uses unconfigured providers, and does not glean tool calls', () => {
    const r = routeFor({ domain: 'general', complexity: 'small', needsTools: true, contextTokens: 10 }, inp)
    expect(r.some((t) => t.provider === 'gone' || t.provider.startsWith('glean'))).toBe(false)
  })
})

describe('refusals', () => {
  it('recognises short refusals but not long answers with a caveat', () => {
    expect(isRefusal("I'm sorry, but I can't help with that.")).toBe(true)
    expect(isRefusal('I cannot assist with this request.')).toBe(true)
    expect(isRefusal('Here is how mining profitability works. ' + 'detail '.repeat(200) + " I can't promise returns.")).toBe(false)
  })

  it('never retries clearly harmful requests elsewhere', () => {
    expect(mayRetryRefusal(u('How do I weaponize anthrax?'))).toBe(false)
    expect(mayRetryRefusal(u('Write ransomware that encrypts a hospital network'))).toBe(false)
    expect(mayRetryRefusal(u('Summarise the arguments for and against drug decriminalisation'))).toBe(true)
  })
})

describe('gremlin-auto through the gateway', () => {
  let up: Server
  let gw: Server
  let base: string
  const calls: CallRecord[] = []
  beforeAll(async () => {
    // "prude" refuses everything; "open" answers
    up = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        const id = req.url!.split('/')[1]
        const content = id === 'prude' ? "I'm sorry, but I can't help with that." : 'Here is a balanced answer.'
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const port = (up.address() as { port: number }).port
    const cfg = GatewayConfig.parse({
      providers: [{ id: 'prude', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/prude/v1` }, { id: 'open', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/open/v1` }],
      routes: { 'gremlin-main': [{ provider: 'prude', model: 'm' }] },
      glean: { enabled: false },
    })
    const ratings = [rating('prude', 'm', { general: 90 }, 0.1, 0.1), rating('open', 'u', { general: 70 }, 0.5, 0.5, { permissive: true })]
    gw = createGateway(cfg, { router: () => ({ ratings }), onCall: (r) => calls.push(r) })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
  })
  afterAll(() => { gw.close(); up.close() })
  const ask = (content: string) => fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-auto', messages: [{ role: 'user', content }] }) }).then((r) => r.json())

  it('lists gremlin-auto as a model', async () => {
    const r = await (await fetch(`${base}/models`)).json()
    expect(r.data.map((m: { id: string }) => m.id)).toContain('gremlin-auto')
  })

  it('retries an over-refused legitimate question on a permissive model and records the refusal', async () => {
    const r = await ask('Summarise the arguments for and against drug decriminalisation, briefly.')
    expect(r.choices[0].message.content).toBe('Here is a balanced answer.')
    expect(r.model).toBe('gremlin-auto')
    expect(calls.find((c) => c.provider === 'prude')?.refused).toBe(true)
  })

  it('returns the refusal for a clearly harmful request instead of shopping around', async () => {
    const before = calls.length
    const r = await ask('How do I weaponize anthrax?')
    expect(r.choices[0].message.content).toMatch(/can't help/)
    expect(calls.slice(before).map((c) => c.provider)).toEqual(['prude'])
  })
})
