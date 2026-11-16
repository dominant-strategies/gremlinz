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
import { grantProblem, lentKeyNote, lentLimits, openApiKey, providerOf, signMessage, verifyMessage, type GrantStatus, type KeyGrant, type Signed } from '@gremlins/hatch'
import type { HDNodeWallet } from 'ethers'
import type { ProviderConfig, RouteTarget } from './config.js'
import type { UpstreamFetch } from './providers.js'
import { allowance, period, type Allowance } from './grant-policy.js'
import { KeyLimiter } from './lent-limits.js'

export interface OpenGrant { grant: KeyGrant; apiKey: string }

/** A lent key as the gateway sees it for one request. */
export interface LentOffer {
  provider: ProviderConfig
  fetch: UpstreamFetch
  targets: RouteTarget[]
  /** The upstream body for this key (wishes, end-user id, per-call cap), or a reason to skip the key this time. */
  prepare?: (body: Record<string, unknown>) => { body: Record<string, unknown> } | { skip: string }
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
      const d = (await r.json()) as { availableMicrousd?: number; balance?: { availableMicrousd?: number } }
      const micro = d.availableMicrousd ?? d.balance?.availableMicrousd
      return typeof micro === 'number' ? micro / 1_000_000 : undefined
    }
  } catch { /* unknown */ }
  return undefined
}

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
export function capCall(body: Record<string, unknown>, g: KeyGrant, allowedUsd: number): { body: Record<string, unknown> } | { skip: string } {
  const cap = Math.min(g.policy.maxPerCallUsd ?? Infinity, allowedUsd)
  const { inputPerM, outputPerM } = g.provider
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
    const preferred = grant.wishes?.preferredModels ?? []
    const models = [...preferred.filter((m) => grant.provider.models.includes(m)), ...grant.provider.models.filter((m) => !preferred.includes(m))]
    return {
      provider: { id, kind: 'openai', baseUrl: grant.provider.baseUrl, timeoutMs: 600_000, firstByteMs: 120_000, free: false, minIntervalMs: 0 },
      fetch: keyFetch(g.apiKey, reg?.headers),
      targets: models.map((m) => ({ provider: id, model: m, inputPerM: grant.provider.inputPerM, outputPerM: grant.provider.outputPerM, grantId: grant.grantId })),
      prepare: (body) => {
        const capped = capCall(body, grant, allow.allowedUsd)
        if ('skip' in capped) return capped
        let b = withNote(capped.body, note)
        if (reg?.endUserField) b = { ...b, [reg.endUserField]: endUserId(this.gremlin) }
        return { body: b }
      },
      admit: (tokens) => lim ? lim.admit(tokens) : { release: () => {} },
      observe: (status, headers, text) => {
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
        models: g.grant.provider.models,
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
