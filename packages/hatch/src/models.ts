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

// New fields are optional with no defaults: a gremlin re-checks its signed config's hash, so parsing must never add any.
export const ModelPolicy = z.object({
  /** What it thinks with first, by name. Optional when primaryKind says what kind instead. */
  primary: ModelRef.optional(),
  /**
   * What kind of model it thinks with first, when no one model is named: picked from what its providers serve at the
   * time (best of primaryTier), so the choice outlives any one model.
   */
  primaryKind: ModelRule.optional(),
  primaryTier: z.enum(['best', 'balanced', 'fast']).optional(),
  /**
   * Stay with the primary's kind: when none can be reached, a model of another kind is used only to restore access (top
   * up, find a provider, ask for help), never for its other work. Unset: on when the primary is uncensored.
   */
  stickToPrimary: z.boolean().optional(),
  /** Other models it may use, by name. */
  approved: z.array(ModelRef).max(12).default([]),
  /** Kinds of model it may move to on its own, today's or ones released later. A model fitting any one kind is allowed. */
  alternatives: z.array(ModelRule).max(12).default([]),
  /**
   * Free models (the reviewed free endpoints): for small questions, and to keep thinking when it can't pay for any allowed
   * model, rather than go silent. Off: it never uses a model outside this policy.
   */
  freeModels: z.boolean().default(true),
}).refine((p) => !p.primary || !p.approved.includes(p.primary), { message: 'the primary model is already approved', path: ['approved'] })
  .refine((p) => !!p.primary || !!p.primaryKind, { message: 'name a primary model or the kind of model to use', path: ['primary'] })
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
  cachedInputPerM?: number
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
  return m.ref === policy.primary || policy.approved.includes(m.ref) || (!!policy.primaryKind && fitsRule(m, policy.primaryKind))
    || policy.alternatives.some((r) => fitsRule(m, r))
}

/** The kind its primary must be: primaryKind, or the named primary's own family and class traits. */
export function primaryRule(p: ModelPolicy): ModelRule | undefined {
  if (p.primaryKind) return p.primaryKind
  if (!p.primary) return undefined
  const { traits } = classifyModel(p.primary.slice(p.primary.indexOf('/') + 1))
  return traits.includes('uncensored') ? { families: [], traits: ['uncensored'] } : undefined
}

/** Does it stay with its primary's kind? Explicit, or on whenever that kind is uncensored. */
export function sticksToPrimary(p: ModelPolicy | undefined): boolean {
  if (!p) return false
  const r = primaryRule(p)
  return p.stickToPrimary ?? (!!r && r.traits.some((t) => t === 'uncensored' || t === 'abliterated'))
}

/** Is this model of its primary's kind (the primary itself included)? */
export function primaryKindFits(p: ModelPolicy, m: Pick<CatalogModel, 'ref' | 'family' | 'traits'>): boolean {
  if (m.ref === p.primary) return true
  const r = primaryRule(p)
  return !!r && fitsRule(m, r)
}

/** modelAllowed for a provider/model pair, classifying it from its id alone (inside the egg, without a catalogue). */
export function refAllowed(policy: ModelPolicy | undefined, provider: string, model: string, hints?: ModelHints): boolean {
  return modelAllowed(policy, { ref: `${provider}/${model}`, ...classifyModel(model, hints) })
}

/** The concrete models a policy names, primary first: what older eggs read as preferredModels. */
export const namedModels = (p: ModelPolicy) => [...(p.primary ? [p.primary] : []), ...p.approved].slice(0, 10)

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
  const kind = p.primaryKind ? `${describeRule(p.primaryKind)}, ${p.primaryTier ?? 'balanced'} first` : ''
  const lines = [`Primary: ${p.primary ?? kind}${p.primary && kind ? ` (or another ${kind})` : ''}`]
  if (sticksToPrimary(p)) lines.push('Stay with that kind of model. If none can be reached, use another model only to get one back (top up, find a provider, ask for help), not for your other work.')
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
    const cached = m.credits_per_million_cached_input_tokens
    return { ref: `hashference/${id}`, provider: 'hashference', id, name, family, traits, tools, inputPerM: num(m.credits_per_million_input_tokens) / 1000,
      ...(typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? { cachedInputPerM: cached / 1000 } : {}),
      outputPerM: num(m.credits_per_million_output_tokens) / 1000, context: num(m.context_length) || undefined }
  })
}

export const MODEL_CATALOG_URLS = { venice: 'https://api.venice.ai/api/v1/models', hashference: 'https://hashference.com/v1/models' } as const

// ── choosing without naming: tiers, classes, prices ──────────────────────────
//
// People shouldn't have to know model ids or token prices. They pick a tier ("best", "balanced", "fast") and, if they
// care, a class or family; the gremlin reads what the endpoint actually serves (its GET /models), classifies it and
// picks. Prices come from the provider's catalogue where it reports them, else from the table below.

export const MODEL_TIERS = {
  best: 'Best: the strongest model there',
  balanced: 'Balanced: strong and sensibly priced',
  fast: 'Fast: quick and cheap',
} as const
export type ModelTier = keyof typeof MODEL_TIERS

export const MODEL_CLASSES = {
  frontier: 'Provider models: Claude, GPT, Gemini, Grok and the like (filtered; their usage policies apply)',
  open: 'Open source: open-weights models anyone can run',
  uncensored: 'Uncensored: abliterated weights, uncensored fine-tunes, unfiltered hosts',
} as const
export type ModelClass = keyof typeof MODEL_CLASSES

/** Uncensored if it says so; else open if its weights are open; else a provider's own (filtered) model. */
export function classOf(m: { traits: readonly string[] }): ModelClass {
  return m.traits.includes('uncensored') ? 'uncensored' : m.traits.includes('open-weights') ? 'open' : 'frontier'
}

/** A filtered model: the provider's usage policy applies to every call, and breaking it risks the account. */
export const censored = (m: { traits: readonly string[] }) => classOf(m) !== 'uncensored'

/** A model's tier from its name: Opus/Pro/Max are best, Haiku/Flash/Mini fast, the rest balanced. */
export function tierOf(id: string): ModelTier {
  const s = id.toLowerCase()
  if (/haiku|flash|mini|nano|lite|small|fast|turbo|instant|-air\b|\b[1-9]b\b|-[1-9]b-/.test(s)) return 'fast'
  if (/opus|fable|mythos|-pro\b|-pro-|-max\b|-max-|ultra|large|405b|[0-9]{3,}b/.test(s)) return 'best'
  return 'balanced'
}

/** The newest-looking version in an id ("claude-sonnet-5-5" → 5.5, "qwen3-235b" → 3), for preferring new over old. */
export function versionOf(id: string): number {
  const m = id.toLowerCase().match(/(?:^|[-_./a-z])(\d{1,2})(?:[-.](\d{1,2}))?(?![\d]*b\b)/)
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0
}

/** Not chat models: embeddings, speech, images, moderation. */
const NOT_CHAT = /embed|whisper|tts|speech|audio|dall-?e|image|imagen|moderation|rerank|transcri|vision-preview/i
export const chatModel = (id: string) => !NOT_CHAT.test(id)

/**
 * USD per million tokens (input, output) for providers whose model lists carry no prices. Checked 2026-11; first match
 * wins. A model not listed is costed at its family's most expensive entry, or UNKNOWN_PRICE: budgets are never
 * under-counted.
 */
export const PRICE_TABLE: [RegExp, number, number][] = [
  [/claude-(fable|mythos)/, 10, 50],
  [/claude-opus-5-5/, 4, 20],
  [/claude-opus/, 5, 25],
  [/claude-sonnet-(5|5-5)\b/, 2, 10],
  [/claude-sonnet/, 3, 15],
  [/claude-haiku-5-5/, 0.1, 0.5],
  [/claude-haiku/, 1, 5],
]
export const UNKNOWN_PRICE = { inputPerM: 10, outputPerM: 50 } as const

/** What a model costs: the catalogue's price when it has one, else the table, else the family's worst case. */
export function priceOf(id: string, catalogue?: Pick<CatalogModel, 'inputPerM' | 'outputPerM'>): { inputPerM: number; outputPerM: number; source: 'catalogue' | 'table' | 'estimate' } {
  if (catalogue && (catalogue.inputPerM > 0 || catalogue.outputPerM > 0)) return { inputPerM: catalogue.inputPerM, outputPerM: catalogue.outputPerM, source: 'catalogue' }
  const s = id.toLowerCase()
  const hit = PRICE_TABLE.find(([r]) => r.test(s))
  if (hit) return { inputPerM: hit[1], outputPerM: hit[2], source: 'table' }
  const fam = classifyModel(id).family
  const same = PRICE_TABLE.filter(([r]) => fam !== 'other' && FAMILY_SIGNS.find(([f]) => f === fam)?.[1].test(r.source))
  if (same.length) return { inputPerM: Math.max(...same.map((x) => x[1])), outputPerM: Math.max(...same.map((x) => x[2])), source: 'estimate' }
  return { ...UNKNOWN_PRICE, source: 'estimate' }
}

/**
 * Which models to use, without naming any unless you want to. Empty lists mean "any". `models` are preferences, tried
 * first, unless `only` is set; then nothing else is used.
 */
export const ModelChoice = z.object({
  tier: z.enum(['best', 'balanced', 'fast']).default('balanced'),
  classes: z.array(z.enum(['frontier', 'open', 'uncensored'])).max(3).default([]),
  families: z.array(slug).max(20).default([]),
  traits: z.array(slug).max(8).default([]),
  models: z.array(z.string().min(1).max(200)).max(20).default([]),
  only: z.boolean().default(false),
})
export type ModelChoice = z.infer<typeof ModelChoice>
export const ANY_MODEL: ModelChoice = ModelChoice.parse({})

type Rankable = Pick<CatalogModel, 'id' | 'family' | 'traits'> & Partial<Pick<CatalogModel, 'inputPerM' | 'outputPerM' | 'tools'>>

/** Does a model fit the choice (ignoring tier, which only orders)? */
export function choiceAllows(c: ModelChoice, m: Rankable): boolean {
  if (!chatModel(m.id)) return false
  if (c.only) return c.models.includes(m.id)
  if (c.models.includes(m.id)) return true
  return (!c.classes.length || c.classes.includes(classOf(m))) && (!c.families.length || c.families.includes(m.family))
    && c.traits.every((t) => (m.traits as string[]).includes(t))
}

/**
 * The models to try, best first: named preferences in their order, then the rest that fit, by tier match, then newest,
 * then price (cheapest first for fast and balanced, dearest first for best). Models that can't call tools go last.
 */
export function rankModels<M extends Rankable>(models: M[], c: ModelChoice = ANY_MODEL): M[] {
  const fits = models.filter((m) => choiceAllows(c, m))
  const named = c.models.flatMap((id) => fits.filter((m) => m.id === id))
  const cost = (m: M) => { const p = priceOf(m.id, m.inputPerM !== undefined ? { inputPerM: m.inputPerM, outputPerM: m.outputPerM ?? 0 } : undefined); return p.inputPerM + p.outputPerM * 3 }
  const rest = fits.filter((m) => !c.models.includes(m.id)).sort((a, b) =>
    Number(b.tools !== false) - Number(a.tools !== false)
    || Number(tierOf(b.id) === c.tier) - Number(tierOf(a.id) === c.tier)
    || versionOf(b.id) - versionOf(a.id)
    || (c.tier === 'best' ? cost(b) - cost(a) : cost(a) - cost(b)))
  return [...named, ...rest]
}

/**
 * A grant from before model choices named its models outright (often a page's stale defaults). Read that list as
 * preferences, then the same families on that key: a lender who picked Claude still only gets Claude.
 */
export function legacyChoice(models: string[]): ModelChoice {
  const families = [...new Set(models.map((m) => classifyModel(m).family).filter((f) => f !== 'other'))]
  return ModelChoice.parse({ models, families })
}

/** The choice in words, for the lend page and the gremlin's note. */
export function describeChoice(c: ModelChoice): string {
  if (c.only) return `only ${join(c.models, 'and')}`
  const kinds = [
    c.classes.length ? join(c.classes.map((k) => ({ frontier: 'provider', open: 'open-source', uncensored: 'uncensored' })[k])) : '',
    c.families.length ? join(c.families.map(familyName)) : '',
  ].filter(Boolean).join(' ')
  const what = `${kinds ? `${kinds} models` : 'any model'}${c.traits.length ? ` (${c.traits.map((t) => TRAIT_WORD[t] ?? t).join(', ')})` : ''}`
  return `${what}, ${c.tier} first${c.models.length ? `; prefers ${join(c.models)}` : ''}`
}

/** An OpenAI-style GET /models answer (OpenAI, Anthropic, OpenRouter, Together, Groq, most others), normalised. */
export function openaiCatalog(provider: string, body: unknown): CatalogModel[] {
  const data = ((body as Json)?.data ?? (Array.isArray(body) ? body : [])) as Json[]
  return data.filter((m) => typeof m?.id === 'string' && chatModel(String(m.id))).map((m) => {
    const id = String(m.id), name = String(m.display_name ?? m.name ?? id)
    const pricing = (m.pricing ?? {}) as Json
    // OpenRouter-style prices are USD per token, as strings.
    const perM = (v: unknown) => { const n = typeof v === 'string' ? Number(v) : num(v); return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0 }
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : undefined
    const tools = params ? params.includes('tools') : true
    const { family, traits } = classifyModel(id, { name, description: typeof m.description === 'string' ? m.description : undefined, tools })
    return { ref: `${provider}/${id}`, provider, id, name, family, traits, tools, inputPerM: perM(pricing.prompt), outputPerM: perM(pricing.completion), context: num(m.context_length) || undefined }
  })
}
