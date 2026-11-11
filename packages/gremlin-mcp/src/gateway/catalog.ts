/**
 * The providers' model catalogues, inside the egg. Two jobs:
 *  - price the maker's named models (the budget needs real prices; the signed config only names them);
 *  - keep a gremlin with a model policy from being locked to models that go away: gremlin-main gets a few current
 *    models of the kinds its maker allowed, after the named ones, so when a named model is withdrawn the next one is a
 *    model the maker would have accepted, not whatever the defaults happen to be.
 */
import { MODEL_CATALOG_URLS, hashferenceCatalog, modelAllowed, veniceCatalog, type CatalogModel, type ModelPolicy } from '@gremlins/hatch'
import type { GatewayConfig, RouteTarget } from './config.js'

/** How many policy-matching models to add behind the named ones. */
export const SPARES = 3

export async function fetchCatalog(get: typeof fetch = fetch): Promise<CatalogModel[]> {
  const one = async (url: string, parse: (b: unknown) => CatalogModel[]) => {
    try {
      const res = await get(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      return res.ok ? parse(await res.json()) : []
    } catch { return [] }
  }
  return (await Promise.all([one(MODEL_CATALOG_URLS.venice, veniceCatalog), one(MODEL_CATALOG_URLS.hashference, hashferenceCatalog)])).flat()
}

/**
 * Spares for a policy: allowed, tool-capable models on providers the gateway has, not already routed. The primary's own
 * family first, then priced closest to the primary (a stand-in for "the same class of model"), cheaper on ties.
 */
export function sparesFor(policy: ModelPolicy, models: CatalogModel[], route: RouteTarget[], providerIds: Set<string>, n = SPARES): RouteTarget[] {
  const primary = models.find((m) => m.ref === policy.primary)
  const price = (m: { inputPerM: number; outputPerM: number }) => m.inputPerM + m.outputPerM
  const target = primary ? price(primary) : Math.max(0, ...route.map(price))
  const routed = new Set(route.map((t) => `${t.provider}/${t.model}`))
  return models
    .filter((m) => m.tools && providerIds.has(m.provider) && !routed.has(m.ref) && policy.alternatives.length > 0 && modelAllowed(policy, m))
    .sort((a, b) => Number(b.family === primary?.family) - Number(a.family === primary?.family) || Math.abs(price(a) - target) - Math.abs(price(b) - target) || price(a) - price(b))
    .slice(0, n)
    .map((m) => ({ provider: m.provider, model: m.id, inputPerM: m.inputPerM, outputPerM: m.outputPerM }))
}

/** Prices unknown targets and (under a policy) refreshes the spares at the end of gremlin-main. Mutates `cfg.routes`. */
export function applyCatalog(cfg: GatewayConfig, models: CatalogModel[], spares: Set<string>): string[] {
  if (!models.length) return []
  const byRef = new Map(models.map((m) => [m.ref, m]))
  const notes: string[] = []
  for (const route of Object.values(cfg.routes)) for (const t of route) {
    const m = byRef.get(`${t.provider}/${t.model}`)
    if (m && !t.inputPerM && !t.outputPerM && (m.inputPerM || m.outputPerM)) { t.inputPerM = m.inputPerM; t.outputPerM = m.outputPerM; notes.push(`priced ${m.ref}`) }
  }
  const main = cfg.routes['gremlin-main']
  if (cfg.policy && main) {
    const kept = main.filter((t) => !spares.has(`${t.provider}/${t.model}`))
    const fresh = sparesFor(cfg.policy, models, kept, new Set(cfg.providers.map((p) => p.id)))
    spares.clear()
    for (const t of fresh) spares.add(`${t.provider}/${t.model}`)
    main.splice(0, main.length, ...kept, ...fresh)
    if (fresh.length) notes.push(`spares: ${fresh.map((t) => `${t.provider}/${t.model}`).join(', ')}`)
  }
  return notes
}
