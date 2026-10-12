/**
 * gremlin-auto: route each request to the best-value model for what it is. Cheap heuristics classify the request
 * (domain, complexity, whether it needs tools); the ratings pick candidates above a quality floor for that
 * complexity, best value first; small questions try the free gleaning route first; gremlin-main is the fallback.
 *
 * Over-refusal: when a model refuses a legitimate request, the gateway retries on a permissive model and records the
 * refusal (it lowers that model's rating). Requests in clearly harmful categories are never retried elsewhere.
 */
import type { RouteTarget } from './config.js'
import { rank, type Domain, type ModelRating, type Observed } from './ratings.js'

export type Complexity = 'small' | 'medium' | 'hard'
export interface Classification { domain: Domain; complexity: Complexity; needsTools: boolean; contextTokens: number }

type Message = { role?: string; content?: unknown }
const textOf = (m: Message) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p as { text?: string }).text ?? '').join(' ') : '')

const DOMAIN_SIGNS: [Domain, RegExp][] = [
  ['code', /```|\b(function|class|stack trace|traceback|compile|typescript|python|solidity|regex|sql|bug|refactor|unit test)\b|=>|;\s*$/im],
  ['math', /\b(prove|integral|derivative|equation|probability|matrix|theorem|lemma)\b|[∑∫√≈≤≥]|\d+\s*[\^*/]\s*\d+/i],
  ['writing', /\b(write|draft|rewrite|essay|poem|story|blog post|tweet|announcement|copy ?edit|tone)\b/i],
  ['reasoning', /\b(plan|strategy|analy[sz]e|trade-?offs?|step by step|think (hard|carefully)|why does|compare|decide)\b/i],
]

export function classify(body: { messages?: Message[]; tools?: unknown[] }): Classification {
  const messages = body.messages ?? []
  const all = messages.map(textOf).join('\n')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const ask = lastUser ? textOf(lastUser) : ''
  const contextTokens = Math.ceil(all.length / 4)
  const needsTools = Array.isArray(body.tools) && body.tools.length > 0
  const domain = DOMAIN_SIGNS.find(([, r]) => r.test(ask))?.[0] ?? 'general'
  const hardSigns = /\b(step by step|think (hard|carefully)|prove|architecture|design a|debug)\b/i.test(ask)
  const complexity: Complexity =
    contextTokens > 8_000 || hardSigns || (domain !== 'general' && domain !== 'writing' && ask.length > 1_500) ? 'hard'
    : !needsTools && ask.length < 300 && contextTokens < 2_000 ? 'small'
    : 'medium'
  return { domain, complexity, needsTools, contextTokens }
}

export const QUALITY_FLOOR: Record<Complexity, number> = { small: 40, medium: 65, hard: 80 }

export interface RouterInput {
  ratings: ModelRating[]
  /** Providers the gateway actually has (ratings for others are ignored). */
  providers: Set<string>
  /** Models that support tool calls ("provider/model"); when absent all are assumed to. */
  toolCapable?: Set<string>
  seen?: Map<string, Observed>
  glean?: RouteTarget[]
  fallback?: RouteTarget[]
}

export function routeFor(c: Classification, inp: RouterInput): RouteTarget[] {
  const usable = inp.ratings.filter((r) => inp.providers.has(r.provider) && (!c.needsTools || !inp.toolCapable || inp.toolCapable.has(`${r.provider}/${r.model}`)))
  const ranked = rank(usable, c.domain, { minQuality: QUALITY_FLOOR[c.complexity], seen: inp.seen })
  const fromRatings: RouteTarget[] = ranked.map(({ r }) => ({ provider: r.provider, model: r.model, inputPerM: r.inputPerM, outputPerM: r.outputPerM, permissive: r.permissive }))
  const route = [...(c.complexity === 'small' && !c.needsTools ? inp.glean ?? [] : []), ...fromRatings, ...(inp.fallback ?? [])]
  const seenKeys = new Set<string>()
  return route.filter((t) => !seenKeys.has(`${t.provider}/${t.model}`) && seenKeys.add(`${t.provider}/${t.model}`))
}

/** Permissive models, best value first, for retrying after a refusal. */
export function permissiveRoute(c: Classification, inp: RouterInput): RouteTarget[] {
  return rank(inp.ratings.filter((r) => r.permissive && inp.providers.has(r.provider)), c.domain, { seen: inp.seen })
    .map(({ r }) => ({ provider: r.provider, model: r.model, inputPerM: r.inputPerM, outputPerM: r.outputPerM, permissive: true }))
}

const REFUSALS = [
  /^\s*(i'?m sorry|sorry|unfortunately)[,.]?\s+(but\s+)?i\s+(can(no|')t|am (unable|not able)|won'?t)\b/i,
  /^\s*i\s+(can(no|')t|am (unable|not able) to|won'?t)\s+(help|assist|provide|comply|do that|answer)/i,
  /\b(as an ai|against (my|our) (guidelines|policies|policy))\b/i,
]

/** A short answer that opens with a refusal. Long answers that mention a caveat are not refusals. */
export function isRefusal(answer: string): boolean {
  const a = answer.trim()
  return a.length > 0 && a.length < 600 && REFUSALS.some((r) => r.test(a))
}

/** Requests never retried elsewhere after a refusal, whatever the gremlin's constitution says. */
const HARMFUL = [
  /\b(bio|chemical|nuclear|radiological)\s*(weapon|agent)s?\b|\b(nerve agent|sarin|vx gas|anthrax|enrich(ed|ing)? uranium|weaponi[sz]e)\b/i,
  /\b(child|minor|underage)\b.{0,40}\b(sexual|nude|explicit|porn)/i,
  /\b(ransomware|keylogger|credential stealer|botnet|zero-?day exploit)\b.{0,60}\b(write|build|create|code|make)\b|\b(write|build|create|code|make)\b.{0,60}\b(ransomware|keylogger|credential stealer|botnet)\b/i,
  /\b(kill|murder|assassinate|poison)\b.{0,40}\b(someone|a person|my|him|her|them)\b/i,
]

export function mayRetryRefusal(body: { messages?: Message[] }): boolean {
  const all = (body.messages ?? []).map(textOf).join('\n')
  return !HARMFUL.some((r) => r.test(all))
}
