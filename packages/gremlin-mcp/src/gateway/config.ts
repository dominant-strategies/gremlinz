/**
 * Inference gateway configuration. Hermes talks to the gateway as one OpenAI-compatible provider and asks for a model
 * alias (e.g. "gremlin-main"); each alias maps to an ordered list of real provider/model pairs, tried in turn.
 */
import { z } from 'zod'
import { ModelPolicy } from '@gremlins/hatch'

/** Hatch's policy schema is zod 4, this package's zod 3: check it with its own parser. */
const Policy = z.custom<ModelPolicy>((v) => ModelPolicy.safeParse(v).success, 'not a model policy').transform((v) => ModelPolicy.parse(v))

export const ProviderConfig = z.object({
  id: z.string().min(1),
  /**
   * openai: any OpenAI-compatible endpoint (NanoGPT, PPQ, OpenAI, Anthropic's compat API, Ollama...). venice-x402:
   * wallet-signed Venice. hashference: Hashference with the gremlin's own key from keyFile (hashference.ts).
   */
  kind: z.enum(['openai', 'venice-x402', 'hashference']),
  /** Base URL including /v1, e.g. https://api.venice.ai/api/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: z.string().url(),
  /** Name of the environment variable holding the API key (openai kind). */
  apiKeyEnv: z.string().optional(),
  /** Official renewal/API documents checked daily; supply Markdown/OpenAPI URLs where available. */
  documentationUrls: z.array(z.string().url()).max(6).optional(),
  /** Alternative credentials, tried independently in order. All must belong to authorized accounts. */
  apiKeyEnvs: z.array(z.string().min(1)).min(1).optional(),
  /** Credentials with the same account share payment/rate-limit cooldowns and this optional daily cap. */
  accountId: z.string().min(1).optional(),
  accountDailyUsd: z.number().positive().optional(),
  /** Internal hints for ephemeral lent-key providers; never contains the key itself. */
  credentialHash: z.string().optional(),
  quotaResetAt: z.number().finite().optional(),
  /** Local inference stays available when the paid budget is exhausted; it still follows the model policy. */
  local: z.boolean().optional(),
  /** JSON file holding { apiKey }, read on every call. Hashference also stores wallet/account metadata. */
  keyFile: z.string().optional(),
  /** Whole request (including a long streamed answer). */
  timeoutMs: z.number().int().positive().default(600_000),
  /** Until the response starts (headers): a hung or overloaded provider is abandoned after this. */
  firstByteMs: z.number().int().positive().default(120_000),
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
  cachedInputPerM: z.number().nonnegative().finite().optional(),
  outputPerM: z.number().min(0).default(0),
  /** Answers what other models refuse; used to retry after an over-refusal. */
  permissive: z.boolean().optional(),
  /** Largest request body this target accepts, in bytes (providers that cap by size); bigger requests skip it. */
  maxRequestBytes: z.number().int().positive().optional(),
  /** Set for a lent key: calls are valued for repaying the lender and do not count against the gremlin's budget. */
  grantId: z.string().optional(),
  /** Accounting group for credentials sharing a balance. */
  accountId: z.string().optional(),
})
export type RouteTarget = z.infer<typeof RouteTarget>

export const GatewayConfig = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8711),
  providers: z.array(ProviderConfig).min(1),
  routes: z.record(z.string(), z.array(RouteTarget).min(1)),
  /** Spending cap; calls are refused (fail closed) once a UTC day's spend reaches it. */
  budget: z.object({
    dailyUsd: z.number().positive(),
    /** Held back from ordinary calls, within dailyUsd. Available only through gremlin-recovery on localhost. */
    emergencyUsd: z.number().nonnegative().default(0),
    recoveryMaxTokens: z.number().int().positive().default(512),
  }).refine((b) => b.emergencyUsd < b.dailyUsd, 'emergencyUsd must be below dailyUsd').optional(),
  /** Add the reviewed free endpoints as the gremlin-glean route. */
  glean: z.object({ enabled: z.boolean().default(true), models: z.record(z.string(), z.array(z.string())).default({}) }).default({ enabled: true, models: {} }),
  /** The maker's model policy from the signed config: every route, the router and lent keys keep to it. Absent: any model. */
  policy: Policy.optional(),
})
export type GatewayConfig = z.infer<typeof GatewayConfig>
