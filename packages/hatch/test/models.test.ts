import { describe, expect, it } from 'vitest'
import { GremlinConfig, ModelPolicy, classifyModel, configHash, describePolicy, hashferenceCatalog, modelAllowed, namedModels, refAllowed, veniceCatalog } from '../src/index.js'

const c = (id: string, hints = {}) => classifyModel(id, hints)

describe('classifyModel', () => {
  it('reads families from ids and names', () => {
    expect(c('claude-opus-5-5').family).toBe('anthropic')
    expect(c('anthropic-claude-sonnet-5.5').family).toBe('anthropic')
    expect(c('openai-gpt-56-sol').family).toBe('openai')
    expect(c('gemini-3-6-flash').family).toBe('google')
    expect(c('google-gemma-4-31b-it').family).toBe('google')
    expect(c('qwen3-5-397b-a17b').family).toBe('qwen')
    expect(c('deepseek-v4-1-flash-1017-uncensored').family).toBe('deepseek')
    expect(c('z-ai-glm-5-3-flash').family).toBe('glm')
    expect(c('hashference-glm-5-3').family).toBe('glm')
    expect(c('kimi-k3').family).toBe('kimi')
    expect(c('grok-4-7').family).toBe('grok')
    expect(c('llama-3.3-70b').family).toBe('llama')
    expect(c('mistral-small-3-2-24b-instruct').family).toBe('mistral')
    expect(c('nvidia-nemotron-3-ultra-550b-a55b').family).toBe('nvidia')
    expect(c('muse-spark-open').family).toBe('other')
  })
  it('reads traits', () => {
    expect(c('e2ee-deepseek-v4-1-flash-1017-abliterated').traits).toEqual(expect.arrayContaining(['abliterated', 'uncensored', 'private', 'open-weights']))
    expect(c('abliteration-abliterated-model-large-v2').traits).toEqual(expect.arrayContaining(['abliterated', 'uncensored']))
    expect(c('venice-uncensored-1-2').traits).toContain('uncensored')
    expect(c('olafangensan-glm-4.7-flash-heretic').traits).toContain('uncensored')
    expect(c('qwen3-235b-a22b-thinking-2507').traits).toEqual(expect.arrayContaining(['reasoning', 'open-weights']))
    expect(c('qwen3-coder-480b-a35b-instruct-turbo').traits).toContain('code')
    expect(c('qwen3-vl-235b-a22b').traits).toContain('vision')
    expect(c('openai-gpt-oss-120b').traits).toContain('open-weights')
    expect(c('claude-opus-5-5').traits).not.toContain('open-weights')
    expect(c('qwen-3-8-max').traits).not.toContain('open-weights') // hosted-only Qwen
    expect(c('anything', { private: true, tags: ['most_uncensored'] }).traits).toEqual(expect.arrayContaining(['private', 'uncensored']))
  })
})

const policy = (p: Partial<ModelPolicy> & { primary: string }) => ModelPolicy.parse(p)

describe('model policy', () => {
  it('allows the named models and any model of an allowed kind, including ones that do not exist yet', () => {
    const p = policy({ primary: 'hashference/deepseek-v4-flash', approved: ['venice/claude-opus-5-5'], alternatives: [{ families: ['qwen'] }, { traits: ['uncensored'] }] })
    expect(refAllowed(p, 'hashference', 'deepseek-v4-flash')).toBe(true)
    expect(refAllowed(p, 'venice', 'claude-opus-5-5')).toBe(true)
    expect(refAllowed(p, 'hashference', 'claude-opus-5-5')).toBe(false) // named per provider
    expect(refAllowed(p, 'venice', 'qwen-9-ultra-2029')).toBe(true) // a Qwen released later
    expect(refAllowed(p, 'venice', 'gemma-6-uncensored')).toBe(true)
    expect(refAllowed(p, 'venice', 'openai-gpt-7')).toBe(false)
  })
  it('requires every trait in a kind', () => {
    const p = policy({ primary: 'venice/qwen3-5-397b-a17b', alternatives: [{ families: ['qwen', 'deepseek'], traits: ['private'] }] })
    expect(refAllowed(p, 'venice', 'e2ee-qwen3-8-27b')).toBe(true)
    expect(refAllowed(p, 'venice', 'qwen3-6-27b')).toBe(false)
    expect(refAllowed(p, 'venice', 'qwen3-6-27b', { private: true })).toBe(true)
  })
  it('an empty kind is any model; no policy is any model', () => {
    expect(refAllowed(policy({ primary: 'venice/x', alternatives: [{}] }), 'venice', 'whatever')).toBe(true)
    expect(modelAllowed(undefined, { ref: 'a/b', family: 'other', traits: [] })).toBe(true)
  })
  it('rejects bad refs and a primary listed twice', () => {
    expect(ModelPolicy.safeParse({ primary: 'claude-opus' }).success).toBe(false)
    expect(ModelPolicy.safeParse({ primary: 'venice/a', approved: ['venice/a'] }).success).toBe(false)
    expect(ModelPolicy.safeParse({ primary: 'venice/a', alternatives: [{ families: ['Not A Slug'] }] }).success).toBe(false)
  })
  it('names its models for older eggs and describes itself', () => {
    const p = policy({ primary: 'venice/a', approved: ['hashference/b'], alternatives: [{ families: ['qwen', 'anthropic'], traits: ['private'] }], freeModels: false })
    expect(namedModels(p)).toEqual(['venice/a', 'hashference/b'])
    expect(describePolicy(p)).toContain('Qwen or Anthropic models (private)')
    expect(describePolicy(p)).toContain('No free models')
  })
})

describe('config', () => {
  const base = {
    version: 1, name: 'Sprocket', persona: 'A tinkerer.', voice: '', goals: ['fix things'], maker: '0x' + '1'.repeat(40), parent: 'maker',
    revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: true, email: false, phone: false, money: false }, constitution: [], createdAt: '2026-11-11T00:00:00.000Z',
  } as const
  it('a config without a policy hashes as before', () => {
    const withEmpty = GremlinConfig.parse({ ...base, models: undefined })
    expect(configHash(withEmpty as GremlinConfig)).toBe(configHash(GremlinConfig.parse(base) as GremlinConfig))
  })
  it('carries a policy', () => {
    const cfg = GremlinConfig.parse({ ...base, models: { primary: 'venice/qwen3-5-397b-a17b', alternatives: [{ traits: ['open-weights'] }] } })
    expect(cfg.models?.freeModels).toBe(true)
    expect(configHash(cfg)).not.toBe(configHash(GremlinConfig.parse(base) as GremlinConfig))
  })
})

describe('catalogues', () => {
  it('normalises Venice', () => {
    const [m] = veniceCatalog({ data: [{ id: 'venice-uncensored-1-2', type: 'text', context_length: 32000, model_spec: { name: 'Venice Uncensored 1.2', privacy: 'private', traits: ['most_uncensored'], capabilities: { supportsFunctionCalling: true }, pricing: { input: { usd: 0.2 }, output: { usd: 0.9 } } } }, { id: 'flux', type: 'image' }] })
    expect(m).toMatchObject({ ref: 'venice/venice-uncensored-1-2', tools: true, inputPerM: 0.2, outputPerM: 0.9, context: 32000 })
    expect(m!.traits).toEqual(expect.arrayContaining(['uncensored', 'private']))
  })
  it('normalises Hashference (credits to dollars)', () => {
    const [m] = hashferenceCatalog({ data: [{ id: 'hashference-glm-5-3', name: 'GLM-5.3', hosting: 'hashference', supports_tools: true, credits_per_million_input_tokens: 441, credits_per_million_output_tokens: 1386, context_length: 131072 }] })
    expect(m).toMatchObject({ ref: 'hashference/hashference-glm-5-3', family: 'glm', tools: true, inputPerM: 0.441, outputPerM: 1.386 })
    expect(m!.traits).toEqual(expect.arrayContaining(['private', 'open-weights']))
  })
})
