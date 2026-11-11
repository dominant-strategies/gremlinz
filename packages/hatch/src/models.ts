/**
 * Which models a gremlin may think with, chosen by its maker at hatch.
 *
 * A gremlin lives for years; model names live for months. So the policy names a few concrete models (a primary and
 * some approved ones) and, separately, *kinds* of model it may move to on its own: by family (Qwen, Anthropic…) and by
 * trait (uncensored, open weights, private…). A model released next year that fits a kind is allowed without anyone
 * re-signing anything, so a gremlin never gets locked to a model that has gone away, while the maker still decides what
 * sort of mind it runs on.
 *
 * Models are named "provider/model", e.g. "venice/qwen3-5-397b-a17b" or "hashference/deepseek-v4-flash". Families and
 * traits are read from a model's id and name (and the provider's catalogue, where it says more), the same way on the
 * board, in the hatch page and inside the egg.
 */
import { z } from 'zod'

/** Families shown in the hatch page. The policy accepts any slug, so families that appear later can still be named. */
export const MODEL_FAMILIES = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini, Gemma)',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  glm: 'GLM (Z.ai)',
  kimi: 'Kimi (Moonshot)',
  grok: 'Grok (xAI)',
  llama: 'Llama (Meta)',
  mistral: 'Mistral',
  minimax: 'MiniMax',
  nvidia: 'NVIDIA Nemotron',
} as const
export type ModelFamily = keyof typeof MODEL_FAMILIES | 'other'

export const MODEL_TRAITS = {
  uncensored: 'Uncensored: answers what most models refuse (abliterated models count too)',
  abliterated: 'Abliterated: refusal removed from the weights',
  'open-weights': 'Open weights: anyone can run it, so it can never be taken away',
  private: 'Private: the provider keeps no logs of prompts or answers',
  reasoning: 'Reasoning: thinks before it answers',
  vision: 'Vision: can look at images',
  code: 'Code: tuned for programming',
} as const
export type ModelTrait = keyof typeof MODEL_TRAITS

/** Providers a gremlin can pay for itself today. */
export const MODEL_PROVIDERS = { hashference: 'Hashference (paid in QUAI)', venice: 'Venice (paid in USDC)' } as const

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/)
/** "provider/model". */
export const ModelRef = z.string().max(120).regex(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'a model is named provider/model')

/** One kind of model: every listed family is an option (empty: any family) and every listed trait is required. */
export const ModelRule = z.object({
  families: z.array(slug).max(20).default([]),
  traits: z.array(slug).max(8).default([]),
})
export type ModelRule = z.infer<typeof ModelRule>

export const ModelPolicy = z.object({
  /** What it thinks with first. */
  primary: ModelRef,
  /** Other models it may use, by name. */
  approved: z.array(ModelRef).max(12).default([]),
  /** Kinds of model it may move to on its own, today's or ones released later. A model fitting any one kind is allowed. */
  alternatives: z.array(ModelRule).max(12).default([]),
  /**
   * Free models (the reviewed free endpoints): for small questions, and to keep thinking when it can't pay for any allowed
   * model, rather than go silent. Off: it never uses a model outside this policy.
   */
  freeModels: z.boolean().default(true),
}).refine((p) => !p.approved.includes(p.primary), { message: 'the primary model is already approved', path: ['approved'] })
export type ModelPolicy = z.infer<typeof ModelPolicy>

/** A model as a provider's catalogue describes it, normalised. */
export interface CatalogModel {
  ref: string
  provider: string
  id: string
  name: string
  family: ModelFamily
  traits: ModelTrait[]
  tools: boolean
  /** USD per million tokens. */
  inputPerM: number
  outputPerM: number
  context?: number
}

const FAMILY_SIGNS: [ModelFamily, RegExp][] = [
  ['anthropic', /claude|anthropic/],
  ['openai', /\bgpt|openai|\bo[1-9]-/],
  ['google', /gemini|gemma/],
  ['qwen', /qwen|qwq/],
  ['deepseek', /deepseek/],
  ['glm', /glm|zai-|z-ai/],
  ['kimi', /kimi|moonshot/],
  ['grok', /grok|xai-/],
  ['llama', /llama/],
  ['mistral', /mistral|mixtral|magistral|devstral|codestral/],
  ['minimax', /minimax/],
  ['nvidia', /nemotron|nvidia/],
]
/** Families whose models are released with open weights (their closed variants are caught below). */
const OPEN_FAMILIES = new Set<ModelFamily>(['qwen', 'deepseek', 'glm', 'kimi', 'llama', 'mistral', 'minimax', 'nvidia'])
const CLOSED_SIGNS = /qwen-?3-[5-9]-(max|plus|flash)|qwen-max|qwen-plus|mistral-(large|medium)|kimi-k3-1-pro|minimax-m3-preview/

export interface ModelHints {
  name?: string
  description?: string
  tools?: boolean
  reasoning?: boolean
  vision?: boolean
  code?: boolean
  /** The provider keeps no logs. */
  private?: boolean
  /** Provider-specific tags, e.g. Venice's "most_uncensored". */
  tags?: string[]
}

/** A model's family and traits, from its id and whatever the catalogue says. */
export function classifyModel(id: string, hints: ModelHints = {}): { family: ModelFamily; traits: ModelTrait[] } {
  const text = `${id} ${hints.name ?? ''}`.toLowerCase()
  const family = FAMILY_SIGNS.find(([, r]) => r.test(text))?.[0] ?? 'other'
  const traits = new Set<ModelTrait>()
  if (/abliterat/.test(text)) traits.add('abliterated').add('uncensored')
  if (/uncensored|heretic|unfiltered/.test(text) || hints.tags?.includes('most_uncensored')) traits.add('uncensored')
  const openByName = /gpt-oss|gemma|mimo|uncensored|heretic|abliterat|hermes|olmo|phi-/.test(text)
  if ((OPEN_FAMILIES.has(family) && !CLOSED_SIGNS.test(text)) || openByName) traits.add('open-weights')
  if (hints.private || /e2ee/.test(text)) traits.add('private')
  if (hints.reasoning || /thinking|reason|-r1\b/.test(text)) traits.add('reasoning')
  if (hints.vision || /-vl\b|-vl-|vision|glm-5v/.test(text)) traits.add('vision')
  if (hints.code || /coder|-code\b|codex|devstral|codestral/.test(text)) traits.add('code')
  return { family, traits: [...traits] }
}

/** Does a model fit one kind? */
export function fitsRule(m: Pick<CatalogModel, 'family' | 'traits'>, r: ModelRule): boolean {
  return (!r.families.length || r.families.includes(m.family)) && r.traits.every((t) => (m.traits as string[]).includes(t))
}

/** May a gremlin with this policy use this model? No policy (configs from before policies): any model. */
export function modelAllowed(policy: ModelPolicy | undefined, m: Pick<CatalogModel, 'ref' | 'family' | 'traits'>): boolean {
  if (!policy) return true
  return m.ref === policy.primary || policy.approved.includes(m.ref) || policy.alternatives.some((r) => fitsRule(m, r))
}

/** modelAllowed for a provider/model pair, classifying it from its id alone (inside the egg, without a catalogue). */
export function refAllowed(policy: ModelPolicy | undefined, provider: string, model: string, hints?: ModelHints): boolean {
  return modelAllowed(policy, { ref: `${provider}/${model}`, ...classifyModel(model, hints) })
}

/** The concrete models a policy names, primary first: what older eggs read as preferredModels. */
export const namedModels = (p: ModelPolicy) => [p.primary, ...p.approved].slice(0, 10)

const join = (xs: string[], last = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs.at(-1)}`)
const familyName = (f: string) => (MODEL_FAMILIES as Record<string, string>)[f]?.replace(/ \(.*\)$/, '') ?? f

const TRAIT_WORD: Record<string, string> = { 'open-weights': 'open weights', reasoning: 'reasoning', vision: 'vision', code: 'code-tuned' }
/** One kind, in words: "Qwen or DeepSeek models (private, open weights)". */
export function describeRule(r: ModelRule): string {
  const fam = r.families.length ? `${join(r.families.map(familyName))} models` : 'any model'
  return r.traits.length ? `${fam} (${r.traits.map((t) => TRAIT_WORD[t] ?? t).join(', ')})` : fam
}

/** The policy in words, for the gremlin's soul and its public profile. */
export function describePolicy(p: ModelPolicy): string {
  const lines = [`Primary: ${p.primary}`]
  if (p.approved.length) lines.push(`Also approved: ${p.approved.join(', ')}`)
  lines.push(p.alternatives.length ? `You may also switch to: ${p.alternatives.map(describeRule).join('; ')}` : 'No other models: only the ones named above.')
  lines.push(p.freeModels ? 'Free models are allowed too: for small questions, and to keep you thinking when you cannot pay.' : 'No free models either: even when you cannot pay, you use no model outside this list.')
  return lines.join('\n')
}

// ── provider catalogues ──────────────────────────────────────────────────────

type Json = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Venice's GET /api/v1/models (text models). */
export function veniceCatalog(body: unknown): CatalogModel[] {
  const data = ((body as Json)?.data ?? []) as Json[]
  return data.filter((m) => (m.type ?? 'text') === 'text').map((m) => {
    const spec = (m.model_spec ?? {}) as Json, caps = (spec.capabilities ?? {}) as Json, price = (spec.pricing ?? {}) as Json
    const id = String(m.id), name = String(spec.name ?? id)
    const tools = !!caps.supportsFunctionCalling
    const { family, traits } = classifyModel(id, {
      name, tools, reasoning: !!caps.supportsReasoning, vision: !!caps.supportsVision, code: !!caps.optimizedForCode,
      private: spec.privacy === 'private', tags: (spec.traits as string[]) ?? [],
    })
    return { ref: `venice/${id}`, provider: 'venice', id, name, family, traits, tools, inputPerM: num(((price.input ?? {}) as Json).usd), outputPerM: num(((price.output ?? {}) as Json).usd), context: num(m.context_length) || undefined }
  })
}

/** Hashference's GET /v1/models (1,000 credits = $1). */
export function hashferenceCatalog(body: unknown): CatalogModel[] {
  const data = ((body as Json)?.data ?? []) as Json[]
  return data.map((m) => {
    const id = String(m.id), name = String(m.name ?? id), description = String(m.description ?? '')
    const tools = !!m.supports_tools
    const { family, traits } = classifyModel(id, { name, description, tools, private: m.hosting === 'hashference' || /zero-retention|private/i.test(description) })
    return { ref: `hashference/${id}`, provider: 'hashference', id, name, family, traits, tools, inputPerM: num(m.credits_per_million_input_tokens) / 1000, outputPerM: num(m.credits_per_million_output_tokens) / 1000, context: num(m.context_length) || undefined }
  })
}

export const MODEL_CATALOG_URLS = { venice: 'https://api.venice.ai/api/v1/models', hashference: 'https://hashference.com/v1/models' } as const
