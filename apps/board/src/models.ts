/**
 * The models a gremlin can be given at hatch: Venice's and Hashference's public catalogues, normalised (models.ts in
 * @gremlins/hatch), cached for an hour. A provider that is down keeps its last good list, so the hatch page always has
 * something to offer.
 */
import { MODEL_CATALOG_URLS, hashferenceCatalog, veniceCatalog, type CatalogModel } from '@gremlins/hatch'

const TTL_MS = 60 * 60_000
const RETRY_MS = 5 * 60_000

export interface ModelCatalog {
  updatedAt: string | null
  models: CatalogModel[]
  sources: Record<string, { ok: boolean; at: string | null; count: number; error?: string }>
}

export function modelCatalog(opts: { fetch?: typeof fetch; now?: () => number } = {}) {
  const get = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const parsers = { venice: veniceCatalog, hashference: hashferenceCatalog } as const
  const last: Record<string, { models: CatalogModel[]; at: number; ok: boolean; error?: string; tried: number }> = {}
  let pending: Promise<void> | null = null

  async function refresh(id: keyof typeof parsers) {
    const prev = last[id]
    try {
      const res = await get(MODEL_CATALOG_URLS[id], { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const models = parsers[id](await res.json()).filter((m) => m.tools) // a gremlin needs tool calls
      if (!models.length) throw new Error('empty catalogue')
      last[id] = { models, at: now(), ok: true, tried: now() }
    } catch (e) {
      last[id] = { models: prev?.models ?? [], at: prev?.at ?? 0, ok: false, error: (e as Error).message, tried: now() }
    }
  }

  return async function catalog(): Promise<ModelCatalog> {
    const stale = (Object.keys(parsers) as (keyof typeof parsers)[]).filter((id) => {
      const l = last[id]
      return !l || now() - (l.ok ? l.at : l.tried) > (l.ok ? TTL_MS : RETRY_MS)
    })
    if (stale.length) {
      pending ??= Promise.all(stale.map(refresh)).then(() => { pending = null })
      await pending
    }
    const at = Math.max(0, ...Object.values(last).map((l) => l.at))
    return {
      updatedAt: at ? new Date(at).toISOString() : null,
      models: Object.values(last).flatMap((l) => l.models),
      sources: Object.fromEntries(Object.entries(last).map(([id, l]) => [id, { ok: l.ok, at: l.at ? new Date(l.at).toISOString() : null, count: l.models.length, ...(l.error ? { error: l.error } : {}) }])),
    }
  }
}
