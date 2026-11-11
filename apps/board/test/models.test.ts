import { describe, expect, it } from 'vitest'
import { modelCatalog } from '../src/models.ts'
import { makeBoard } from './helpers.ts'

const venice = { data: [
  { id: 'qwen3-5-397b-a17b', type: 'text', model_spec: { name: 'Qwen 3.5 397B', privacy: 'anonymized', capabilities: { supportsFunctionCalling: true, supportsReasoning: true }, pricing: { input: { usd: 0.75 }, output: { usd: 4.5 } } } },
  { id: 'no-tools', type: 'text', model_spec: { capabilities: {}, pricing: {} } },
] }
const hashference = { data: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supports_tools: true, credits_per_million_input_tokens: 165.6, credits_per_million_output_tokens: 330 }] }

function stub(fail = new Set<string>()) {
  const calls: string[] = []
  const fetch = (async (url: string) => {
    calls.push(url)
    const id = url.includes('venice') ? 'venice' : 'hashference'
    if (fail.has(id)) return new Response('down', { status: 503 })
    return Response.json(id === 'venice' ? venice : hashference)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('model catalogue', () => {
  it('merges both providers, keeps only tool-capable models, and caches for an hour', async () => {
    let t = 1_000_000
    const s = stub()
    const cat = modelCatalog({ fetch: s.fetch, now: () => t })
    const a = await cat()
    expect(a.models.map((m) => m.ref).sort()).toEqual(['hashference/deepseek-v4-flash', 'venice/qwen3-5-397b-a17b'])
    expect(a.sources.venice).toMatchObject({ ok: true, count: 1 })
    await cat()
    expect(s.calls).toHaveLength(2)
    t += 61 * 60_000
    await cat()
    expect(s.calls).toHaveLength(4)
  })
  it('a provider that is down keeps its last good list', async () => {
    let t = 0
    const fail = new Set<string>()
    const s = stub(fail)
    const cat = modelCatalog({ fetch: s.fetch, now: () => t })
    await cat()
    fail.add('venice')
    t += 61 * 60_000
    const b = await cat()
    expect(b.sources.venice).toMatchObject({ ok: false, count: 1, error: 'HTTP 503' })
    expect(b.models).toHaveLength(2)
  })
  it('is served at /api/models', async () => {
    const b = await makeBoard({}, { models: modelCatalog({ fetch: stub().fetch }) })
    const res = await b.app.request('/api/models')
    expect(res.status).toBe(200)
    const body = await res.json() as { models: { ref: string; family: string }[] }
    expect(body.models.find((m) => m.ref === 'venice/qwen3-5-397b-a17b')?.family).toBe('qwen')
  })
})
