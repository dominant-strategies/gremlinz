/**
 * Lent API keys (see @gremlins/hatch grants): fetched from the board, checked (lender signature, shape, expiry, the
 * provider's terms allow lending), opened with the gremlin's key and held only in memory. Each is offered to the
 * gateway while the lender's rules allow, with the remaining budget read from the provider where it reports one.
 *
 * On every call with a lent key the gateway keeps to: the grant's models, the lender's period rules and per-call cap
 * (max_tokens is lowered so the worst case fits), the key's rate limits (lent-limits.ts), the provider's Retry-After,
 * and stops for good on 401/403, telling the lender through the board. The lender's wishes go with each call as a
 * delimited system note (lentKeyNote).
 *
 * GrantPool revalidates authorization and reserves estimated cost before dispatch. Provider billing can differ
 * from estimates; lenders should still lend a dedicated key with a hard limit set at the provider.
 */
import { createHash } from 'node:crypto'
import {
  ModelChoice, choiceAllows, classifyModel, grantProblem, hashferenceCatalog, legacyChoice, lentKeyNote, lentLimits, openApiKey, openaiCatalog, priceOf, providerOf, rankModels, signMessage, veniceCatalog, verifyMessage,
  type CatalogModel, type GrantStatus, type KeyGrant, type Signed,
} from '@gremlins/hatch'
import type { HDNodeWallet } from 'ethers'
import type { ProviderConfig, RouteTarget } from './config.js'
import type { UpstreamFetch } from './providers.js'
import { allowance, period, type Allowance } from './grant-policy.js'
import { KeyLimiter } from './lent-limits.js'
import { CREDITS_PER_USD } from '../hashference.js'

export interface OpenGrant { grant: KeyGrant; apiKey: string }

/** A lent key as the gateway sees it for one request. */
export interface LentOffer {
  provider: ProviderConfig
  /** Registry identity used only to check the maker's model policy. */
  modelProvider?: string
  fetch: UpstreamFetch
  targets: RouteTarget[]
  /** Detect the borrowed credential in a draft without exposing it to the gateway. */
  containsCredential?: (text: string) => boolean
  /** The upstream body for this key and model (wishes, end-user id, per-call cap), or a reason to skip it this time. */
  prepare?: (body: Record<string, unknown>, target?: { model: string; inputPerM?: number; outputPerM?: number }) => { body: Record<string, unknown> } | { skip: string }
  /** A slot under the key's rate limits for a call of about `tokens`, or a reason to skip it. */
  admit?: (tokens: number) => { release: (actualTokens?: number) => void } | { skip: string }
  /** Every answer from the provider on this key (Retry-After, refused keys). */
  observe?: (status: number, headers: Headers, text: string) => void
}

export async function fetchGrants(boardUrl: string, gremlin: HDNodeWallet, fetchImpl: typeof fetch = fetch): Promise<OpenGrant[]> {
  const res = await fetchImpl(new URL(`/api/grants?gremlin=${gremlin.address}`, boardUrl), { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`board grants: ${res.status}`)
  const { grants } = (await res.json()) as { grants: (Signed<KeyGrant> & { status?: string | null; revokedAt?: string | null })[] }
  const out: OpenGrant[] = []
  for (const sg of grants) {
    const g = sg.message
    // A key this gremlin already reported as refused stays off, across restarts.
    if (sg.status === 'disabled' || sg.revokedAt) continue
    if (g.gremlin.toLowerCase() !== gremlin.address.toLowerCase() || !verifyMessage(sg) || grantProblem(g)) continue
    try {
      out.push({ grant: g, apiKey: await openApiKey(gremlin.signingKey, g.sealedKey) })
    } catch { /* not sealed to us */ }
  }
  return out
}

/**
 * Tell the lender, through the board, that the provider refused their key and the gremlin stopped using it. Signed by
 * the gremlin; the board shows it on the lending page. Best effort: the key stays off locally either way.
 */
export async function reportDisabled(boardUrl: string, gremlin: HDNodeWallet, grantId: string, httpStatus: number, reason: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const status: GrantStatus = { kind: 'grant-status', address: gremlin.address, grantId, status: 'disabled', httpStatus, reason: reason.slice(0, 300), createdAt: new Date().toISOString() }
  try {
    const r = await fetchImpl(new URL('/api/grants/status', boardUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(gremlin, status)), signal: AbortSignal.timeout(15_000) })
    return r.ok || r.status === 409
  } catch { return false }
}

/** Remaining budget on the key, for providers that report it. */
export async function remainingUsd(g: OpenGrant, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const base = g.grant.provider.baseUrl.replace(/\/$/, '')
  const auth = { headers: { authorization: `Bearer ${g.apiKey}` }, signal: AbortSignal.timeout(5000) }
  try {
    if (g.grant.provider.budgetApi === 'openrouter') {
      const r = await fetchImpl(`${base}/key`, auth)
      if (!r.ok) return undefined
      const d = ((await r.json()) as { data?: { limit_remaining?: number | null } }).data
      return typeof d?.limit_remaining === 'number' ? d.limit_remaining : undefined
    }
    if (g.grant.provider.budgetApi === 'hashference') {
      // The workspace balance the key spends (its own monthly budget, if any, is not reported to the key).
      const r = await fetchImpl(`${base}/account`, auth)
      if (!r.ok) return undefined
      const d = (await r.json()) as { account?: { balance?: { availableCredits?: number } }; availableMicrousd?: number; balance?: { availableMicrousd?: number } }
      const credits = d.account?.balance?.availableCredits
      if (typeof credits === 'number') return credits / CREDITS_PER_USD
      const micro = d.availableMicrousd ?? d.balance?.availableMicrousd
      return typeof micro === 'number' ? micro / 1_000_000 : undefined
    }
  } catch { /* unknown */ }
  return undefined
}

/**
 * The models a lent key serves (GET {baseUrl}/models), classified and priced where the provider says. Lenders don't
 * name models; the gremlin reads them here and moves on when one is retired.
 */
export async function grantCatalog(g: OpenGrant, fetchImpl: typeof fetch = fetch): Promise<CatalogModel[]> {
  const reg = providerOf(g.grant.provider)
  const base = g.grant.provider.baseUrl.replace(/\/$/, '')
  // Anthropic's own /models wants x-api-key and a version; everyone else reads the bearer token.
  const headers: Record<string, string> = { ...(reg?.headers ?? {}), authorization: `Bearer ${g.apiKey}`, ...(reg?.id === 'anthropic' ? { 'x-api-key': g.apiKey, 'anthropic-version': '2023-06-01' } : {}) }
  const res = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`models list: ${res.status}`)
  const body = await res.json()
  const id = reg?.id ?? 'custom'
  return id === 'venice' ? veniceCatalog(body) : id === 'hashference' ? hashferenceCatalog(body) : openaiCatalog(id, body)
}

/** What the lender chose: the grant's model choice, or (older grants) its model list read as preferences then families. */
export function grantChoice(grant: KeyGrant): ModelChoice {
  const c = grant.modelChoice ? ModelChoice.parse(grant.modelChoice) : legacyChoice(grant.provider.models)
  const preferred = grant.wishes?.preferredModels ?? []
  return preferred.length && !c.only ? { ...c, models: [...preferred, ...c.models.filter((m) => !preferred.includes(m))] } : c
}

export interface PricedModel { model: string; inputPerM: number; outputPerM: number }
/**
 * A model at its real price: the key's catalogue, else the price table. Only when neither knows it does an older
 * grant's stated price stand in (the lender's own valuation); a newer grant, which states none, gets the worst case.
 */
function priced(grant: KeyGrant, model: string, cat?: CatalogModel): PricedModel {
  const p = priceOf(model, cat)
  const stated = !grant.modelChoice && (grant.provider.inputPerM > 0 || grant.provider.outputPerM > 0)
  if (p.source === 'estimate' && stated) return { model, inputPerM: grant.provider.inputPerM, outputPerM: grant.provider.outputPerM }
  return { model, inputPerM: p.inputPerM, outputPerM: p.outputPerM }
}

/**
 * The models to try on a lent key, best first, each at its real price. From the key's catalogue when the gremlin has
 * read it; before that, the grant's own list (still priced from the table, never below what the grant says).
 */
export function grantModels(grant: KeyGrant, catalog?: CatalogModel[]): PricedModel[] {
  const choice = grantChoice(grant)
  if (catalog?.length) {
    const ranked = rankModels(catalog, choice)
    return ranked.slice(0, 8).map((m) => priced(grant, m.id, m))
  }
  const list = [...choice.models.filter((m) => grant.provider.models.includes(m)), ...grant.provider.models.filter((m) => !choice.models.includes(m))]
  // Never below what an older grant states: it was the lender's own valuation.
  return list.filter(m => !grant.modelChoice || choiceAllows(choice, { id: m, ...classifyModel(m) }))
    .map((m) => { const p = priced(grant, m); return { model: m, inputPerM: Math.max(p.inputPerM, grant.provider.inputPerM), outputPerM: Math.max(p.outputPerM, grant.provider.outputPerM) } })
}

/** A provider's answer meaning "that model isn't served here (any more)". */
export const modelGone = (status: number, text: string) => (status === 400 || status === 404) && /not_found_error.{0,80}"model: |unsupported model|model not found|no such model|unknown model|model .{0,40} (?:does not exist|is not available)/i.test(text)

/** A stable, anonymous id for this gremlin, for providers that ask for an end-user id. */
export const endUserId = (gremlin: string) => `gremlin-${createHash('sha256').update(gremlin.toLowerCase()).digest('hex').slice(0, 32)}`

const keyFetch = (apiKey: string, extra: Record<string, string> = {}): UpstreamFetch => (url, init) => {
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  headers.set('authorization', `Bearer ${apiKey}`)
  return fetch(url, { ...init, headers })
}

/** Rough prompt size in tokens (4 bytes a token), for rate limits and the per-call cap. */
export const promptTokens = (body: Record<string, unknown>) => Math.ceil(Buffer.byteLength(JSON.stringify(body.messages ?? body)) / 4)
const OUT_DEFAULT = 4096

/** The system note right after the caller's own system prompt (as withDirective does). */
function withNote(body: Record<string, unknown>, note: string): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body
  const msgs = body.messages as { role?: string }[]
  let i = 0
  while (i < msgs.length && (msgs[i]!.role === 'system' || msgs[i]!.role === 'developer')) i++
  return { ...body, messages: [...msgs.slice(0, i), { role: 'system', content: note }, ...msgs.slice(i)] }
}

/**
 * Per-call cap: the lender's maxPerCallUsd and what is left of the allowance. Lowers max_tokens so the worst case fits,
 * or says why the call can't fit at all.
 */
export function capCall(body: Record<string, unknown>, g: KeyGrant, allowedUsd: number, price: { inputPerM: number; outputPerM: number } = g.provider): { body: Record<string, unknown> } | { skip: string } {
  const cap = Math.min(g.policy.maxPerCallUsd ?? Infinity, allowedUsd)
  const { inputPerM, outputPerM } = price
  const inUsd = (promptTokens(body) * inputPerM) / 1e6
  if (inUsd >= cap) return { skip: `the prompt alone (~$${inUsd.toFixed(4)}) is over the $${cap.toFixed(4)} this key allows for one call` }
  if (!outputPerM || cap === Infinity) return { body }
  const fits = Math.floor(((cap - inUsd) * 1e6) / outputPerM)
  if (fits < 64) return { skip: `less than $${(cap - inUsd).toFixed(4)} allowed for the answer` }
  const asked = Number(body.max_completion_tokens ?? body.max_tokens ?? Infinity)
  if (asked <= fits) return { body }
  return { body: { ...body, ...(body.max_completion_tokens !== undefined ? { max_completion_tokens: fits } : { max_tokens: fits }) } }
}

export interface LentKeyStatus {
  grantId: string
  lender: string
  provider: { id: string; name: string; stance: string; conditions: string[]; obligations: string[] }
  models: string[]
  policy: KeyGrant['policy']
  wishes: KeyGrant['wishes'] | null
  repay: KeyGrant['repay']
  allowance: { allowedUsd: number; usedThisPeriodUsd: number; reason: string; resetsAt: string }
  remainingOnKeyUsd: number | null
  limiter: ReturnType<KeyLimiter['status']>
}

/**
 * The opened grants, with their limiters (kept across requests and grant refreshes) and the provider's remaining budget.
 * `used` is what this gremlin spent on a grant since a time (the ledger); `onDisabled` tells the lender once.
 */
export class LentKeys {
  grants: OpenGrant[] = []
  private limiters = new Map<string, KeyLimiter>()
  private remaining = new Map<string, number | undefined>()
  /** Each key's model list, read from the provider; `at` 0 means read it again (a model was retired). */
  private catalogs = new Map<string, { at: number; models: CatalogModel[] }>()
  private gremlin: string
  private used: (grantId: string, sinceMs: number) => number
  private onDisabled: (g: KeyGrant, status: number, reason: string) => void
  private now: () => number

  constructor(o: { gremlin: string; used: (grantId: string, sinceMs: number) => number; onDisabled?: (g: KeyGrant, status: number, reason: string) => void; now?: () => number }) {
    this.gremlin = o.gremlin
    this.used = o.used
    this.onDisabled = o.onDisabled ?? (() => {})
    this.now = o.now ?? Date.now
  }

  set(grants: OpenGrant[]) {
    this.grants = grants
    for (const g of grants)
      if (!this.limiters.has(g.grant.grantId)) this.limiters.set(g.grant.grantId, new KeyLimiter(lentLimits(g.grant.provider, g.grant.policy.limits), this.now))
  }

  setRemaining(grantId: string, usd: number | undefined) { this.remaining.set(grantId, usd) }

  setCatalog(grantId: string, models: CatalogModel[]) { this.catalogs.set(grantId, { at: this.now(), models }) }

  /** Does this key's model list need reading (never read, a day old, or a model was retired since)? */
  catalogDue(grantId: string, maxAgeMs = 24 * 3_600_000): boolean {
    const c = this.catalogs.get(grantId)
    // An empty list means it couldn't be read: try again within the hour.
    return !c || c.at === 0 || this.now() - c.at > (c.models.length ? maxAgeMs : 3_600_000)
  }

  limiter(grantId: string) { return this.limiters.get(grantId) }

  private allow(g: OpenGrant): { allow: Allowance; used: number } {
    const now = this.now()
    const used = this.used(g.grant.grantId, period(g.grant.policy.period, now).start)
    return { allow: allowance(g.grant.policy, now, used, this.remaining.get(g.grant.grantId)), used }
  }

  /** Offers for the keys usable now: not stopped, with allowance left. */
  offers(): LentOffer[] {
    return this.grants.flatMap((g) => {
      const lim = this.limiters.get(g.grant.grantId)
      if (lim?.disabled) return []
      const { allow } = this.allow(g)
      if (allow.allowedUsd <= 0.0001) return []
      return [this.offerFor(g, allow, lim)]
    })
  }

  offerFor(g: OpenGrant, allow: Allowance, lim?: KeyLimiter): LentOffer {
    const grant = g.grant
    const reg = providerOf(grant.provider)
    const id = `grant-${grant.grantId.slice(2)}`
    const note = lentKeyNote(grant)
    const models = grantModels(grant, this.catalogs.get(grant.grantId)?.models)
    const priceFor = (model?: string) => models.find((m) => m.model === model) ?? models[0] ?? grant.provider
    return {
      provider: { id, kind: 'openai', baseUrl: grant.provider.baseUrl, timeoutMs: 600_000, firstByteMs: 120_000, free: false, minIntervalMs: 0 },
      modelProvider: providerOf({ baseUrl: grant.provider.baseUrl })?.id,
      fetch: keyFetch(g.apiKey, reg?.headers),
      containsCredential: text => text.includes(g.apiKey),
      targets: models.map((m) => ({ provider: id, model: m.model, inputPerM: m.inputPerM, outputPerM: m.outputPerM, grantId: grant.grantId })),
      prepare: (body, target) => {
        const capped = capCall(body, grant, allow.allowedUsd, priceFor(target?.model))
        if ('skip' in capped) return capped
        let b = withNote(capped.body, note)
        if (reg?.endUserField) b = { ...b, [reg.endUserField]: endUserId(this.gremlin) }
        return { body: b }
      },
      admit: (tokens) => lim ? lim.admit(tokens) : { release: () => {} },
      observe: (status, headers, text) => {
        // A retired model: read the key's model list again before the next pick.
        if (modelGone(status, text)) { const c = this.catalogs.get(grant.grantId); if (c) c.at = 0 }
        if (lim?.observe(status, headers, text) === 'disabled') this.onDisabled(grant, status, lim.disabled!.reason)
      },
    }
  }

  /** Everything the gremlin needs to plan with its lent keys (the lent_keys tool). No keys. */
  status(): LentKeyStatus[] {
    return this.grants.map((g) => {
      const reg = providerOf(g.grant.provider)
      const { allow, used } = this.allow(g)
      return {
        grantId: g.grant.grantId,
        lender: g.grant.address,
        provider: { id: reg?.id ?? 'custom', name: reg?.name ?? g.grant.provider.label, stance: reg?.stance ?? 'allowed', conditions: reg?.conditions ?? [], obligations: reg?.obligations ?? [] },
        models: grantModels(g.grant, this.catalogs.get(g.grant.grantId)?.models).map((m) => m.model),
        policy: g.grant.policy,
        wishes: g.grant.wishes ?? null,
        repay: g.grant.repay,
        allowance: { allowedUsd: allow.allowedUsd, usedThisPeriodUsd: used, reason: allow.reason, resetsAt: new Date(allow.reset).toISOString() },
        remainingOnKeyUsd: this.remaining.get(g.grant.grantId) ?? null,
        limiter: this.limiters.get(g.grant.grantId)!.status(),
      }
    })
  }
}

/** Gateway offers for grants with an allowance worked out by the caller (no limiter, wishes still applied). */
export function lentOffers(grants: { g: OpenGrant; allow: Allowance }[], gremlin = '0x0000000000000000000000000000000000000000'): LentOffer[] {
  const k = new LentKeys({ gremlin, used: () => 0 })
  return grants
    .filter(({ allow }) => allow.allowedUsd > 0.0001)
    .map(({ g, allow }) => k.offerFor(g, allow))
}

export { allowance, period }
