/**
 * Which inference providers a person may lend a gremlin capacity from, and the rules the gremlin must keep on each.
 * Encoded from each provider's published terms, checked on CHECKED below (sources and exact clauses inline; the same
 * table, in prose, is docs/LENDING.md). Data plus a version: the board refuses grants for forbidden providers, the
 * lending page lists them with the reason and refuses before sealing, and the gateway enforces the limits.
 *
 * A stance is about letting another party (here an autonomous agent the lender does not control) use the lender's key:
 * - allowed: the terms say so.
 * - allowed-with-conditions: no clause forbids it; the account holder stays responsible and billed, nothing is resold.
 * - forbidden: a clause forbids sharing keys or account access, the service is a personal subscription, or the terms
 *   could not be checked (we refuse rather than risk the lender's account).
 *
 * Rate limits are conservative defaults for the provider's lowest paid tier; a lent key may use HALF of them unless
 * the lender says otherwise in the grant (policy.limits), so the lender's own apps keep the rest.
 */

export const PROVIDER_REGISTRY_VERSION = '2026-11-16.1'
/** When the terms below were read. */
export const CHECKED = '2026-11-16'

export type LendStance = 'allowed' | 'allowed-with-conditions' | 'forbidden'

export interface ProviderSource {
  url: string
  /** The clause, verbatim (or as quoted by a secondary source when `verified` is false). */
  clause: string
  /** The document's own date (last updated / effective), when it shows one. */
  docDate?: string
  /** Read from the live page on CHECKED; false: secondary source or the page refused us (see docs/LENDING.md). */
  verified: boolean
}

export interface ProviderLimits {
  rpm: number
  tpm?: number
  rpd?: number
  concurrency: number
}

export interface LendingProvider {
  id: string
  name: string
  kind: 'api' | 'subscription' | 'custom'
  stance: LendStance
  /** Why it can't be lent (forbidden), in words for the lending page. */
  reason?: string
  /** What the lender accepts by lending (allowed-with-conditions). */
  conditions: string[]
  sources: ProviderSource[]
  /** OpenAI-compatible base URL including /v1. */
  baseUrl?: string
  /** Hosts this provider's API lives on (a grant's baseUrl on one of them is this provider, whatever it is called). */
  hosts: string[]
  /** Conservative defaults for the lowest paid tier, and where to look up yours. */
  limits?: ProviderLimits
  limitsSource?: string
  /** Rules the gremlin keeps on calls with this key (shown to it on those calls and in lent_keys). */
  obligations: string[]
  /** How the gateway reads the key's remaining budget (minRemainingPct and "what's left" rules need one). */
  budgetApi: 'none' | 'openrouter' | 'hashference'
  /** What the lender should set up first. */
  setup: string
  /** Field for a stable, anonymous end-user id on each request, where the provider asks for one. */
  endUserField?: 'user' | 'safety_identifier'
  /** Extra headers the provider asks apps to send (attribution). */
  headers?: Record<string, string>
  /** Keys that are not API keys for this provider (subscription tokens): refused before sealing. */
  notApiKeys?: { re: RegExp; why: string }[]
  /** Models to suggest on the lending page. */
  suggestedModels?: string[]
  /** Value per million tokens to suggest, for repayment accounting. */
  price?: { inputPerM: number; outputPerM: number }
}

const UNVERIFIED_TERMS = 'We could not read its current terms, so we cannot tell you lending is safe. Until we can, it is not offered.'
const SUBSCRIPTION = 'a personal subscription: its terms let only you use it, and sharing it can get your account banned'

export const PROVIDERS: LendingProvider[] = [
  // ── API providers that can be lent ────────────────────────────────────────
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'You stay responsible for all activity and charges on the key.',
      'Nothing is resold: the gremlin repays you as a patron or syndicate backer, it never buys access.',
      'Use a dedicated key with a credit limit (OpenRouter guides recommend capped keys for agents).',
    ],
    sources: [
      { url: 'https://openrouter.ai/terms', docDate: '2026-08-31', verified: true, clause: 'You are responsible for all activity and charges under its account or API Credentials' },
      { url: 'https://openrouter.ai/terms', docDate: '2026-08-31', verified: true, clause: '§7(4) reselling API access to Models or otherwise developing a competing service; §7(14) sell or otherwise transfer the access granted under these Terms' },
      { url: 'https://openrouter.ai/docs/guides/best-practices/capping-shared-agent-keys.md', verified: true, clause: 'Capping shared agent keys (guide: give each agent its own key with a credit limit)' },
    ],
    baseUrl: 'https://openrouter.ai/api/v1', hosts: ['openrouter.ai'],
    // Paid models: no platform request cap, only per-IP bursts and upstream 429s. These are our own polite defaults.
    limits: { rpm: 60, concurrency: 4 }, limitsSource: 'https://openrouter.ai/docs/api-reference/limits',
    obligations: ['Keep to the terms of each model you call through OpenRouter (§5.1).'],
    budgetApi: 'openrouter',
    setup: 'Create a new key just for this gremlin (Settings → Keys) with a credit limit and a monthly reset, e.g. $10/month. The gremlin reads what is left on it, so "use what\'s left before my reset" rules work.',
    endUserField: 'user',
    headers: { 'HTTP-Referer': 'https://gremlinz.ai', 'X-Title': 'gremlinz' },
    suggestedModels: ['deepseek/deepseek-chat', 'qwen/qwen3-235b-a22b', 'anthropic/claude-sonnet-4.5'],
    price: { inputPerM: 0.5, outputPerM: 2 },
  },
  {
    id: 'hashference', name: 'Hashference', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'You stay responsible for the workspace balance the key spends.',
      'Give the gremlin its own key with a monthly budget; never share the workspace session token.',
      'Its terms of service could not be found on CHECKED; the conditions come from its documentation.',
    ],
    sources: [
      { url: 'https://hashference.com/llms.txt', verified: true, clause: 'All API keys in a workspace spend one shared balance. A key can have a monthly budget.' },
      { url: 'https://hashference.com/docs/agents.md', verified: true, clause: 'Keep API keys off websites and do not pass a console session token to an agent.' },
      { url: 'https://hashference.com/openapi.json', verified: true, clause: 'PUT /v1/profile/api-keys/{accountId}/limit (setKeyMonthlyLimit): Limit this key within the shared workspace' },
    ],
    baseUrl: 'https://hashference.com/v1', hosts: ['hashference.com'],
    limits: { rpm: 60, concurrency: 4 }, limitsSource: 'https://hashference.com/docs/errors-limits.md',
    obligations: ['Honour Retry-After on 429.'],
    budgetApi: 'hashference',
    setup: 'In your Hashference workspace, create a key for this gremlin and give it a monthly budget (e.g. $10). Keys share the workspace balance, so the budget is what protects the rest.',
    suggestedModels: ['hashference-glm-5-3'],
    price: { inputPerM: 0.441, outputPerM: 1.386 },
  },
  {
    id: 'nanogpt', name: 'NanoGPT (pay as you go)', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'Pay-as-you-go balance only: a NanoGPT subscription is for a single individual and can\'t be lent.',
      'You are responsible for the gremlin\'s use as if it were your own, and for checking each model\'s terms permit it.',
    ],
    sources: [
      { url: 'https://nano-gpt.com/terms', docDate: '2026-11-16', verified: true, clause: 'You are responsible for activity and charges under your account, whether or not authorized by you' },
      { url: 'https://nano-gpt.com/terms', docDate: '2026-11-16', verified: true, clause: 'Each subscription is intended for use by a single individual.' },
      { url: 'https://nano-gpt.com/terms', docDate: '2026-11-16', verified: true, clause: 'you are responsible for their access to and use of the Services as if it were your own' },
    ],
    baseUrl: 'https://nano-gpt.com/api/v1', hosts: ['nano-gpt.com'],
    // Not published where we could read it: our own conservative defaults.
    limits: { rpm: 30, concurrency: 2 },
    obligations: ['Use only models whose own terms permit use by an autonomous agent.'],
    budgetApi: 'none',
    setup: 'Use a pay-as-you-go balance (not a subscription) and lend only what you are happy to spend: NanoGPT has no per-key cap we could confirm, so keep the balance small or use a separate account.',
  },
  {
    id: 'gemini', name: 'Google Gemini API', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'You stay responsible for generated content and for anyone you share it with.',
      'Use a separate Google Cloud project for the key, with a budget alert (Google budgets alert; they do not hard-cap).',
      'The Google APIs Terms were not re-read on CHECKED; check them if you are unsure.',
    ],
    sources: [
      { url: 'https://aistudio.google.com/docs/terms', docDate: '2026-03-23', verified: true, clause: "You're responsible for your use of generated content, and for the use of that content by anyone you share it with." },
      { url: 'https://aistudio.google.com/docs/terms', docDate: '2026-03-23', verified: true, clause: 'You will not, and will not allow your end user or any third party to, cache, frame, syndicate, resell... (Grounding with Google Search)' },
    ],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hosts: ['generativelanguage.googleapis.com'],
    limits: { rpm: 60, tpm: 250_000, concurrency: 4 }, limitsSource: 'https://aistudio.google.com/docs/rate-limits',
    obligations: ['Follow Google\'s Generative AI Prohibited Use Policy.', 'Do not resell or syndicate Grounding with Google Search results.'],
    budgetApi: 'none',
    setup: 'Create a new Google Cloud project just for this gremlin, enable billing with a budget alert, and make an API key restricted to the Generative Language API.',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'anthropic', name: 'Anthropic API (Claude, pay as you go)', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'An API key from a Console workspace you pay for, never a Claude Pro/Max/Team login or token.',
      'You stay responsible for all activity on the key, and nothing is resold.',
      'Anthropic enforces strictly: lend from a dedicated workspace with its own spend limit, so a problem stays there.',
    ],
    sources: [
      { url: 'https://www.anthropic.com/legal/commercial-terms', docDate: '2025-06-17', verified: true, clause: 'Customer is responsible for all activity under its account.' },
      { url: 'https://www.anthropic.com/legal/commercial-terms', docDate: '2025-06-17', verified: true, clause: 'resell the Services except as expressly approved by Anthropic' },
      { url: 'https://www.anthropic.com/legal/aup', docDate: '2026-11-12', verified: true, clause: 'Agentic use cases must comply with the Usage Policy.' },
    ],
    baseUrl: 'https://api.anthropic.com/v1', hosts: ['api.anthropic.com'],
    // The Start tier allows far more (1,000-4,000 RPM by model); new orgs can be in a lower evaluation tier.
    limits: { rpm: 50, tpm: 40_000, concurrency: 4 }, limitsSource: 'https://platform.claude.com/docs/en/api/rate-limits',
    obligations: [
      'Disclose that you are an AI to any person you interact with (Usage Policy: consumer-facing agents must disclose they are AI).',
      'Keep to Anthropic\'s Usage Policy on every call with this key.',
    ],
    budgetApi: 'none',
    setup: 'In the Claude Console, create a workspace just for this gremlin with a monthly spend limit (the default workspace can\'t have one), then an API key (sk-ant-api…) in that workspace.',
    notApiKeys: [{ re: /^sk-ant-(oat|ort|sid)/, why: 'This is a Claude.ai subscription token, not an API key. Anthropic does not allow Pro/Max credentials to be used by third-party tools or agents.' }],
    suggestedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    price: { inputPerM: 3, outputPerM: 15 },
  },
  {
    id: 'venice', name: 'Venice API', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'You stay responsible for the key; Venice may revoke or rotate it.',
      'Venice credits must not be transferred: lend use of the key, never credits.',
      'Use a key with its own consumption limit if your account offers one.',
    ],
    sources: [
      { url: 'https://venice.ai/legal/tos', docDate: '2026-06-08', verified: true, clause: '§5 You are solely responsible for maintaining the confidentiality of your account and password.' },
      { url: 'https://venice.ai/legal/tos', docDate: '2026-06-08', verified: true, clause: '§12(h) sell or otherwise transfer the access granted under these Terms; §6.5 Any attempt to transfer or exchange Venice Credits is a material breach' },
    ],
    baseUrl: 'https://api.venice.ai/api/v1', hosts: ['api.venice.ai'],
    // Venice reports per-model limits at GET /api_keys/rate_limits; these are conservative defaults.
    limits: { rpm: 20, concurrency: 2 }, limitsSource: 'https://docs.venice.ai/api-reference/rate-limiting',
    obligations: ['Keep failed requests low: Venice counts error budgets per model per API key.'],
    budgetApi: 'none',
    setup: 'Create an API key just for this gremlin with a consumption limit, and keep your balance to what you are happy to lend.',
  },
  {
    id: 'together', name: 'Together AI', kind: 'api', stance: 'allowed-with-conditions',
    conditions: [
      'You manage your own users and stay responsible for them.',
      'Not offered on a standalone basis or resold: the gremlin uses it, it does not sell access.',
      'Each model\'s own terms apply.',
    ],
    sources: [
      { url: 'https://www.together.ai/terms-of-service', docDate: '2026-05-19', verified: true, clause: '§4.3(d) transfer, distribute, resell, lease, license, or assign the Services or otherwise offer the Services on a standalone basis' },
      { url: 'https://www.together.ai/terms-of-service', docDate: '2026-05-19', verified: true, clause: '§1.1 You are entirely responsible for provisioning and managing your user accounts.' },
    ],
    baseUrl: 'https://api.together.xyz/v1', hosts: ['api.together.xyz'],
    limits: { rpm: 60, concurrency: 4 }, limitsSource: 'https://docs.together.ai/docs/rate-limits',
    obligations: ['Comply with the terms of each model you call (§2.4).'],
    budgetApi: 'none',
    setup: 'Keep a small prepaid balance for this gremlin; Together has no per-key cap we could confirm.',
  },
  {
    id: 'custom', name: 'Your own server (OpenAI-compatible)', kind: 'custom', stance: 'allowed',
    conditions: ['Only for a server you run yourself (Ollama, vLLM, llama.cpp...). Not for a hosted provider\'s key.'],
    sources: [],
    hosts: [],
    limits: { rpm: 30, concurrency: 2 },
    obligations: [],
    budgetApi: 'none',
    setup: 'Expose an OpenAI-compatible /v1 endpoint over HTTPS with its own key. The gremlin pays you back at the prices you set.',
  },

  // ── API providers whose terms forbid it (or could not be read) ───────────────
  {
    id: 'openai', name: 'OpenAI API', kind: 'api', stance: 'forbidden',
    reason: 'OpenAI\'s terms forbid making account access credentials available to third parties, and OpenAI asks for one key per person.',
    conditions: [],
    sources: [
      { url: 'https://openai.com/policies/services-agreement/', docDate: '2023-11-14', verified: false, clause: 'You may not make account access credentials available to third parties, share individual login credentials between multiple users on an account, or resell or lease access to your account' },
      { url: 'https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety', verified: false, clause: 'Each team member should have their own unique API key; do not share API keys (Best Practices for API Key Safety)' },
    ],
    baseUrl: 'https://api.openai.com/v1', hosts: ['api.openai.com'],
    obligations: [], budgetApi: 'none', endUserField: 'safety_identifier',
    setup: 'Not offered.',
  },
  {
    id: 'groq', name: 'Groq', kind: 'api', stance: 'forbidden',
    reason: 'Groq\'s Services Agreement allows only your Authorized Account Users to use your account, and bans leasing access to it.',
    conditions: [],
    sources: [{ url: 'https://console.groq.com/docs/legal/services-agreement', docDate: '2026-06-22', verified: true, clause: '§3.2 Customer will only make its Account available to Authorized Account Users. Customer may not resell or lease access to its Account.' }],
    hosts: ['api.groq.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'deepinfra', name: 'DeepInfra', kind: 'api', stance: 'forbidden',
    reason: 'DeepInfra\'s terms forbid sharing account or access credentials.',
    conditions: [],
    sources: [{ url: 'https://deepinfra.com/terms', docDate: '2026-10-15', verified: true, clause: '§11(a)(viii) sell, transfer, or share any account or access credentials' }],
    hosts: ['api.deepinfra.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'mistral', name: 'Mistral AI', kind: 'api', stance: 'forbidden',
    reason: 'Mistral\'s terms forbid transferring API keys to a third party or granting a third party access without written permission.',
    conditions: [],
    sources: [{ url: 'https://legal.mistral.ai/terms/commercial-terms-of-service', docDate: '2026-09-25', verified: true, clause: '§2.2(h) buy, sell, or transfer API keys or any type of Mistral AI account from, to, or with a third party; §2.2(i) grant any third party access to the Mistral AI Products without our prior written authorization' }],
    hosts: ['api.mistral.ai'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'api', stance: 'forbidden',
    reason: 'DeepSeek\'s terms say not to share your API key with others.',
    conditions: [],
    sources: [{ url: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html', docDate: '2026-04-29', verified: true, clause: '§2.2 do not share or publicly disclose your API key with others' }],
    hosts: ['api.deepseek.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'xai', name: 'xAI (Grok API)', kind: 'api', stance: 'forbidden', reason: UNVERIFIED_TERMS,
    conditions: [], sources: [{ url: 'https://x.ai/legal/terms-of-service', verified: false, clause: '(the page refused our request on CHECKED)' }],
    hosts: ['api.x.ai'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'fireworks', name: 'Fireworks AI', kind: 'api', stance: 'forbidden', reason: UNVERIFIED_TERMS,
    conditions: [], sources: [{ url: 'https://fireworks.ai/terms-of-service', verified: false, clause: '(published as a PDF we could not read on CHECKED)' }],
    hosts: ['api.fireworks.ai'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },

  // ── consumer subscriptions: never lendable ─────────────────────────────────
  {
    id: 'chatgpt-sub', name: 'ChatGPT Plus / Pro', kind: 'subscription', stance: 'forbidden',
    reason: `ChatGPT is ${SUBSCRIPTION}. OpenAI's terms: you may not share your account credentials or make your account available to anyone else.`,
    conditions: [],
    sources: [{ url: 'https://openai.com/policies/terms-of-use/', docDate: '2026-01-01', verified: false, clause: 'You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account.' }],
    hosts: ['chatgpt.com', 'chat.openai.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'claude-sub', name: 'Claude Pro / Max', kind: 'subscription', stance: 'forbidden',
    reason: `Claude Pro and Max are ${SUBSCRIPTION}. Anthropic does not allow requests to be routed through Pro/Max credentials for anyone else, and enforces it without notice.`,
    conditions: [],
    sources: [
      { url: 'https://www.anthropic.com/legal/consumer-terms', docDate: '2025-10-08', verified: true, clause: 'You may not share your Account login information, Anthropic API key, or Account credentials with anyone else.' },
      { url: 'https://code.claude.com/docs/en/legal-and-compliance', verified: true, clause: 'Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users.' },
    ],
    hosts: ['claude.ai'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'gemini-sub', name: 'Google AI Pro / Ultra (Gemini app)', kind: 'subscription', stance: 'forbidden',
    reason: `Google AI Pro and Ultra are ${SUBSCRIPTION}. Lend a Gemini API key from a Cloud project instead.`,
    conditions: [],
    sources: [{ url: 'https://policies.google.com/terms', verified: false, clause: '(Gemini Apps terms not re-read on CHECKED; a Google Account is for one person)' }],
    hosts: ['gemini.google.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'copilot-sub', name: 'GitHub Copilot', kind: 'subscription', stance: 'forbidden',
    reason: `Copilot is ${SUBSCRIPTION} tied to your GitHub account.`,
    conditions: [],
    sources: [{ url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features', docDate: '2026-08-27', verified: false, clause: '(refers to the GitHub Terms of Service; a personal account is for one person)' }],
    hosts: ['api.githubcopilot.com'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'cursor-sub', name: 'Cursor', kind: 'subscription', stance: 'forbidden',
    reason: `Cursor is ${SUBSCRIPTION}. Its terms: you may not rent, lease, lend, or sell the Service.`,
    conditions: [],
    sources: [{ url: 'https://cursor.com/terms-of-service', docDate: '2026-09-03', verified: true, clause: '§1.5(iii) rent, lease, lend, or sell the Service' }],
    hosts: ['api2.cursor.sh'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
  {
    id: 'perplexity-sub', name: 'Perplexity Pro', kind: 'subscription', stance: 'forbidden',
    reason: `Perplexity Pro is ${SUBSCRIPTION}, for personal, non-commercial use, and its terms ban bots.`,
    conditions: [],
    sources: [{ url: 'https://www.perplexity.ai/hub/legal/terms-of-service', docDate: '2026-01-23', verified: true, clause: '§5.1 personal, non-commercial use only; §5.2 automation software (bots)' }],
    hosts: ['www.perplexity.ai', 'perplexity.ai'], obligations: [], budgetApi: 'none', setup: 'Not offered.',
  },
]

export const lendingProvider = (id: string) => PROVIDERS.find((p) => p.id === id)

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }

/** The registry entry a grant's provider is: by its id, or else by the host of its base URL (undefined: custom). */
export function providerOf(p: { id?: string; baseUrl: string }): LendingProvider | undefined {
  const host = hostOf(p.baseUrl)
  const byHost = PROVIDERS.find((q) => q.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
  if (byHost) return byHost
  return p.id ? lendingProvider(p.id) : undefined
}

/** Why a grant's provider can't be lent from, or null. */
export function lendProblem(p: { id?: string; baseUrl: string }): string | null {
  if (p.id && !lendingProvider(p.id)) return `unknown provider "${p.id}"`
  const host = hostOf(p.baseUrl)
  const byHost = PROVIDERS.find((q) => q.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
  // A known host under another provider's name (or as "custom") is that provider.
  if (p.id && byHost && byHost.id !== p.id) return `the base URL is ${byHost.name}, not ${lendingProvider(p.id)!.name}`
  const q = byHost ?? (p.id ? lendingProvider(p.id) : undefined)
  if (q?.stance === 'forbidden') return `provider forbids lending: ${q.name}: ${q.reason}`
  if (q && q.kind !== 'custom' && q.baseUrl && p.id && !byHost) return `the base URL must be ${q.name}'s (${q.hosts.join(', ')})`
  return null
}

/** Why this pasted key must not be lent for this provider (a subscription token, an empty key), or null. */
export function keyProblem(providerId: string, apiKey: string): string | null {
  const k = apiKey.trim()
  if (!k) return 'paste the API key'
  if (/\s/.test(k)) return 'an API key has no spaces in it'
  const p = lendingProvider(providerId)
  if (!p) return `unknown provider "${providerId}"`
  if (p.stance === 'forbidden') return p.reason ?? 'this provider cannot be lent from'
  for (const n of PROVIDERS.flatMap((q) => q.notApiKeys ?? [])) if (n.re.test(k)) return n.why
  return null
}

/** What a lent key may use: the grant's own limits, else half the provider's default tier. */
export function lentLimits(p: { id?: string; baseUrl: string }, own?: Partial<ProviderLimits>): ProviderLimits {
  const d = providerOf(p)?.limits ?? { rpm: 30, concurrency: 2 }
  const half = (n?: number) => (n === undefined ? undefined : Math.max(1, Math.floor(n / 2)))
  return {
    rpm: own?.rpm ?? half(d.rpm)!,
    tpm: own?.tpm ?? half(d.tpm),
    rpd: own?.rpd ?? half(d.rpd),
    concurrency: own?.concurrency ?? half(d.concurrency)!,
  }
}
