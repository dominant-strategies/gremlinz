/**
 * Inference gateway configuration. Hermes talks to the gateway as one OpenAI-compatible provider and asks for a model
 * alias (e.g. "gremlin-main"); each alias maps to an ordered list of real provider/model pairs, tried in turn.
 */
import { z } from 'zod'

export const ProviderConfig = z.object({
  id: z.string().min(1),
  /** openai: any OpenAI-compatible endpoint (NanoGPT, PPQ, OpenAI, Anthropic's compat API, Ollama...). venice-x402: wallet-signed Venice. */
  kind: z.enum(['openai', 'venice-x402']),
  /** Base URL including /v1, e.g. https://api.venice.ai/api/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: z.string().url(),
  /** Name of the environment variable holding the API key (openai kind). */
  apiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().default(120_000),
  /** Free endpoint (gleaning): requests that look like they contain secrets are never sent here. */
  free: z.boolean().default(false),
  /** Minimum gap between calls to this provider (free tiers). */
  minIntervalMs: z.number().int().min(0).default(0),
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

export const RouteTarget = z.object({
  provider: z.string(),
  model: z.string(),
  /** USD per million tokens, for the budget. Unknown prices count as zero (and are reported as such). */
  inputPerM: z.number().min(0).default(0),
  outputPerM: z.number().min(0).default(0),
})
export type RouteTarget = z.infer<typeof RouteTarget>

export const GatewayConfig = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8711),
  providers: z.array(ProviderConfig).min(1),
  routes: z.record(z.string(), z.array(RouteTarget).min(1)),
  /** Spending cap; calls are refused (fail closed) once a UTC day's spend reaches it. */
  budget: z.object({ dailyUsd: z.number().positive() }).optional(),
  /** Add the reviewed free endpoints as the gremlin-glean route. */
  glean: z.object({ enabled: z.boolean().default(true), models: z.record(z.string(), z.array(z.string())).default({}) }).default({ enabled: true, models: {} }),
})
export type GatewayConfig = z.infer<typeof GatewayConfig>
