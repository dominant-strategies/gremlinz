/**
 * The inference gateway's configuration for a gremlin. Defaults: Venice over x402 (paid from the gremlin's own
 * USDC balance there) as gremlin-main, free gleaning, and a daily budget. Local development can add an Ollama
 * server (GREMLIN_OLLAMA_URL + GREMLIN_OLLAMA_MODEL), which then fronts every route.
 */
import type { GatewayConfig } from '../gateway/config.js'

export interface GatewayEnv {
  ollamaUrl?: string
  ollamaModel?: string
  veniceModel?: string
  dailyUsd?: number
  port?: number
}

export function gatewayConfig(e: GatewayEnv = {}): GatewayConfig {
  const venice = { id: 'venice', kind: 'venice-x402' as const, baseUrl: 'https://api.venice.ai/api/v1', timeoutMs: 180_000, free: false, minIntervalMs: 0 }
  const veniceMain = { provider: 'venice', model: e.veniceModel ?? 'qwen3-5-397b-a17b', inputPerM: 0.6, outputPerM: 2.4 }
  const providers: GatewayConfig['providers'] = [venice]
  const main: GatewayConfig['routes'][string] = [veniceMain]
  if (e.ollamaUrl && e.ollamaModel) {
    providers.unshift({ id: 'ollama', kind: 'openai', baseUrl: `${e.ollamaUrl.replace(/\/$/, '')}/v1`, timeoutMs: 600_000, free: false, minIntervalMs: 0 })
    main.unshift({ provider: 'ollama', model: e.ollamaModel, inputPerM: 0, outputPerM: 0 })
  }
  return {
    host: '127.0.0.1',
    port: e.port ?? 8711,
    providers,
    routes: { 'gremlin-main': main },
    budget: { dailyUsd: e.dailyUsd ?? 2 },
    glean: { enabled: true, models: {} },
  }
}
