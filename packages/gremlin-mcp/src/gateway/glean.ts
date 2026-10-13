/**
 * Gleaning: free inference endpoints for small questions and short tasks that don't need paying for.
 *
 * Only endpoints in this reviewed list are used (a free endpoint may log or alter what it is sent). Keyless
 * endpoints are on by default; free tiers that need an account are on only when the maker supplied a key at hatch
 * (gremlins don't farm accounts). Requests that look like they contain secrets are never sent to a free endpoint.
 */
import type { ProviderConfig, RouteTarget } from './config.js'

export interface GleanEndpoint {
  id: string
  baseUrl: string
  /** Environment variable with the maker-supplied key; absent for keyless endpoints. */
  apiKeyEnv?: string
  /** Models to try, best first. For keyed tiers these are suggestions; the maker's config can override. */
  models: string[]
  /** Minimum gap between calls, to stay well inside the free tier. */
  minIntervalMs: number
  terms: string
  privacy: string
  reviewed: { by: string; at: string; note: string }
}

export const GLEAN_ENDPOINTS: GleanEndpoint[] = [
  {
    id: 'pollinations',
    baseUrl: 'https://text.pollinations.ai/openai/v1',
    models: ['openai'],
    minIntervalMs: 15_000,
    terms: 'https://pollinations.ai/terms',
    privacy: 'Anonymous tier; assume prompts may be logged.',
    reviewed: { by: 'gremlinz', at: '2026-10-12', note: 'Keyless OpenAI-compatible; anonymous tier served GPT-OSS 20B with tool support (verified live).' },
  },
  {
    id: 'groq-free',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GLEAN_GROQ_KEY',
    models: [],
    minIntervalMs: 3_000,
    terms: 'https://groq.com/terms-of-use',
    privacy: 'Account-based free tier.',
    reviewed: { by: 'gremlinz', at: '2026-10-12', note: 'Free tier with rate limits; maker supplies key and model.' },
  },
  {
    id: 'google-free',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GLEAN_GOOGLE_KEY',
    models: [],
    minIntervalMs: 5_000,
    terms: 'https://ai.google.dev/gemini-api/terms',
    privacy: 'Free-tier prompts may be used to improve Google products.',
    reviewed: { by: 'gremlinz', at: '2026-10-12', note: 'OpenAI-compatible endpoint; maker supplies key and model.' },
  },
  {
    id: 'openrouter-free',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'GLEAN_OPENROUTER_KEY',
    models: [],
    minIntervalMs: 4_000,
    terms: 'https://openrouter.ai/terms',
    privacy: 'Free models are often served by providers that log prompts.',
    reviewed: { by: 'gremlinz', at: '2026-10-12', note: 'Use only ":free" model ids; maker supplies key and models.' },
  },
]

/** Patterns that look like secrets. Never sent to free endpoints. */
const SECRET_PATTERNS = [
  /\b0x[0-9a-fA-F]{64}\b/, // private key
  /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/, // 12–24 lowercase words in a row (seed phrase)
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/, // API keys
  /\bss_t_[0-9a-z]{27}\b/, // SporeStack token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function looksSensitive(body: unknown): boolean {
  const text = JSON.stringify(body)
  return SECRET_PATTERNS.some((r) => r.test(text))
}

/** Providers and the gremlin-glean route for the endpoints available to this gremlin (keyless, or keyed and configured). */
export function gleanRoute(env: NodeJS.ProcessEnv = process.env, models: Record<string, string[]> = {}): { providers: ProviderConfig[]; route: RouteTarget[] } {
  const providers: ProviderConfig[] = []
  const route: RouteTarget[] = []
  for (const e of GLEAN_ENDPOINTS) {
    if (e.apiKeyEnv && !env[e.apiKeyEnv]) continue
    const ms = models[e.id] ?? e.models
    if (!ms.length) continue
    providers.push({ id: `glean-${e.id}`, kind: 'openai', baseUrl: e.baseUrl, apiKeyEnv: e.apiKeyEnv, timeoutMs: 60_000, firstByteMs: 30_000, free: true, minIntervalMs: e.minIntervalMs })
    for (const m of ms) route.push({ provider: `glean-${e.id}`, model: m, inputPerM: 0, outputPerM: 0 })
  }
  return { providers, route }
}
