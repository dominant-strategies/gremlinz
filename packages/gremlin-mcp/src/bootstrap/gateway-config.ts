/**
 * The inference gateway's configuration for a gremlin. Defaults: gremlin-main is Hashference (the gremlin's own key,
 * credit bought with QUAI), then Venice over x402 (paid from its USDC balance there), then the free gleaning endpoints
 * as a last resort; plus a daily budget. Local development can add an Ollama
 * server (GREMLIN_OLLAMA_URL + GREMLIN_OLLAMA_MODEL), which then fronts every route.
 */
import type { GatewayConfig } from '../gateway/config.js'
import { homeFile } from '../env.js'
import { HASHFERENCE_MAIN_MODEL } from '../hashference.js'
import { refAllowed, type ModelPolicy } from '@gremlins/hatch'

export interface GatewayEnv {
  ollamaUrl?: string
  ollamaModel?: string
  veniceModel?: string
  hashferenceModel?: string
  /** Defaults to GREMLIN_HOME/hashference.json. */
  hashferenceKeyFile?: string
  dailyUsd?: number
  port?: number
  /** The maker's model policy (signed config). */
  policy?: ModelPolicy
}

export function gatewayConfig(e: GatewayEnv = {}): GatewayConfig {
  const venice = { id: 'venice', kind: 'venice-x402' as const, baseUrl: 'https://api.venice.ai/api/v1', timeoutMs: 600_000, firstByteMs: 120_000, free: false, minIntervalMs: 0 }
  const veniceMain = { provider: 'venice', model: e.veniceModel ?? 'qwen3-5-397b-a17b', inputPerM: 0.6, outputPerM: 2.4 }
  // Hashference first: cheaper per token than Venice, and paid in QUAI from the gremlin's own wallet. Until the gremlin
  // has made a key and bought credit it answers 402 locally and the route moves on to Venice, then the free endpoints.
  const hashference = { id: 'hashference', kind: 'hashference' as const, baseUrl: 'https://hashference.com/v1', keyFile: e.hashferenceKeyFile ?? homeFile('hashference.json'), timeoutMs: 600_000, firstByteMs: 180_000, free: false, minIntervalMs: 0 }
  // Several Hashference models, because its catalog changes (its featured GLM-5.3 was withdrawn within an hour in the
  // rehearsal); a model it stops offering is skipped by the gateway and the next one used. Tool-capable, cheapest first
  // among good ones (USD per million tokens, 2026-11). Its own featured routes cap requests at ~240 KB of JSON.
  const hashferenceRoute = e.hashferenceModel
    ? [{ provider: 'hashference', model: e.hashferenceModel, inputPerM: 0, outputPerM: 0 }]
    : [
        { provider: 'hashference', model: 'z-ai-glm-5-3-flash', inputPerM: 0.18, outputPerM: 0.6 },
        { provider: 'hashference', model: 'deepseek-v4-flash', inputPerM: 0.17, outputPerM: 0.33 },
        { provider: 'hashference', model: HASHFERENCE_MAIN_MODEL, inputPerM: 0.441, outputPerM: 1.386, maxRequestBytes: 235_000 },
      ]
  const providers: GatewayConfig['providers'] = [hashference, venice]
  const main: GatewayConfig['routes'][string] = withPolicy([...hashferenceRoute, veniceMain], e.policy, providers.map((p) => p.id))
  if (e.ollamaUrl && e.ollamaModel) {
    // A local model may need minutes to load into memory on its first call.
    providers.unshift({ id: 'ollama', kind: 'openai', baseUrl: `${e.ollamaUrl.replace(/\/$/, '')}/v1`, timeoutMs: 900_000, firstByteMs: 180_000, free: false, minIntervalMs: 0 })
    main.unshift({ provider: 'ollama', model: e.ollamaModel, inputPerM: 0, outputPerM: 0 })
  }
  return {
    host: '127.0.0.1',
    port: e.port ?? 8711,
    providers,
    routes: { 'gremlin-main': main },
    budget: { dailyUsd: e.dailyUsd ?? 2 },
    glean: { enabled: true, models: {} },
    ...(e.policy ? { policy: e.policy } : {}),
  }
}

type Target = GatewayConfig['routes'][string][number]
/**
 * gremlin-main under a model policy: the maker's primary and approved models first (on providers this gateway has),
 * then whichever defaults the policy allows. Their prices are filled in from the providers' catalogues once fetched
 * (gateway/catalog.ts). If nothing is left (a policy naming only providers it can't reach), the defaults stay, so the
 * gremlin can still think and fix it.
 */
export function withPolicy(defaults: Target[], policy: ModelPolicy | undefined, providerIds: string[]): Target[] {
  if (!policy) return defaults
  const named = [policy.primary, ...policy.approved].flatMap((ref) => {
    const i = ref.indexOf('/'), provider = ref.slice(0, i), model = ref.slice(i + 1)
    if (!providerIds.includes(provider)) return []
    return [defaults.find((d) => d.provider === provider && d.model === model) ?? { provider, model, inputPerM: 0, outputPerM: 0 }]
  })
  const allowed = defaults.filter((d) => refAllowed(policy, d.provider, d.model) && !named.some((n) => n.provider === d.provider && n.model === d.model))
  const route = [...named, ...allowed]
  return route.length ? route : defaults
}
