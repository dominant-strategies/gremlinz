/**
 * Lent API keys (see @gremlins/hatch grants): fetched from the board, checked (lender signature, shape, expiry),
 * opened with the gremlin's key and held only in memory. Each is offered to the gateway while the lender's rules
 * allow, with the remaining budget read from the provider where it reports one.
 *
 * The allowance is checked before each call and a call's cost is known only after it, so use can overshoot by at
 * most one call. Lenders should lend a dedicated sub-key with a hard limit set at the provider.
 */
import { grantProblem, openApiKey, verifyMessage, type KeyGrant, type Signed } from '@gremlins/hatch'
import type { HDNodeWallet } from 'ethers'
import type { ProviderConfig, RouteTarget } from './config.js'
import type { UpstreamFetch } from './providers.js'
import { allowance, period, type Allowance } from './grant-policy.js'

export interface OpenGrant { grant: KeyGrant; apiKey: string }

export async function fetchGrants(boardUrl: string, gremlin: HDNodeWallet, fetchImpl: typeof fetch = fetch): Promise<OpenGrant[]> {
  const res = await fetchImpl(new URL(`/api/grants?gremlin=${gremlin.address}`, boardUrl))
  if (!res.ok) throw new Error(`board grants: ${res.status}`)
  const { grants } = (await res.json()) as { grants: Signed<KeyGrant>[] }
  const out: OpenGrant[] = []
  for (const sg of grants) {
    const g = sg.message
    if (g.gremlin.toLowerCase() !== gremlin.address.toLowerCase() || !verifyMessage(sg) || grantProblem(g)) continue
    try {
      out.push({ grant: g, apiKey: await openApiKey(gremlin.signingKey, g.sealedKey) })
    } catch { /* not sealed to us */ }
  }
  return out
}

/** Remaining budget on the key, for providers that report it. */
export async function remainingUsd(g: OpenGrant, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  if (g.grant.provider.budgetApi !== 'openrouter') return undefined
  try {
    const r = await fetchImpl(`${g.grant.provider.baseUrl.replace(/\/$/, '')}/key`, { headers: { authorization: `Bearer ${g.apiKey}` } })
    if (!r.ok) return undefined
    const d = ((await r.json()) as { data?: { limit_remaining?: number | null } }).data
    return typeof d?.limit_remaining === 'number' ? d.limit_remaining : undefined
  } catch {
    return undefined
  }
}

const keyFetch = (apiKey: string): UpstreamFetch => (url, init) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${apiKey}`)
  return fetch(url, { ...init, headers })
}

/** Gateway offers for the grants whose allowance is open now. */
export function lentOffers(grants: { g: OpenGrant; allow: Allowance }[]): { provider: ProviderConfig; fetch: UpstreamFetch; targets: RouteTarget[] }[] {
  return grants
    .filter(({ allow }) => allow.allowedUsd > 0.0001)
    .map(({ g }) => {
      const id = `grant-${g.grant.grantId.slice(2, 10)}`
      return {
        provider: { id, kind: 'openai' as const, baseUrl: g.grant.provider.baseUrl, timeoutMs: 600_000, firstByteMs: 120_000, free: false, minIntervalMs: 0 },
        fetch: keyFetch(g.apiKey),
        targets: g.grant.provider.models.map((m) => ({ provider: id, model: m, inputPerM: g.grant.provider.inputPerM, outputPerM: g.grant.provider.outputPerM, grantId: g.grant.grantId })),
      }
    })
}

export { allowance, period }
