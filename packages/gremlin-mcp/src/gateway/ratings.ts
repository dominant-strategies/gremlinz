/**
 * Model ratings: which model is best value for which kind of work. Published benchmark results (normalised to
 * 0–100 per domain, each with its source and date) are combined with prices into quality per dollar of a typical
 * task, then discounted by what this gremlin has seen itself (errors, refusals) in its ledger. The router reads these.
 */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { LedgerEntry } from './ledger.js'

export const DOMAINS = ['general', 'code', 'reasoning', 'math', 'writing'] as const
export type Domain = (typeof DOMAINS)[number]

export const Source = z.object({ name: z.string(), url: z.string().url(), metric: z.string(), value: z.number(), retrievedAt: z.string() })

export const ModelRating = z.object({
  provider: z.string(),
  model: z.string(),
  /** 0–100 per domain, normalised from published benchmarks; missing domains fall back to general. */
  scores: z.object(Object.fromEntries(DOMAINS.map((d) => [d, z.number().min(0).max(100).optional()])) as Record<Domain, z.ZodOptional<z.ZodNumber>>),
  inputPerM: z.number().min(0),
  outputPerM: z.number().min(0),
  /** Typical output tokens for one task (reasoning models use many more). */
  outputTokensPerTask: z.number().positive().default(800),
  inputTokensPerTask: z.number().positive().default(2_000),
  /** Answers questions other models refuse (e.g. uncensored variants). */
  permissive: z.boolean().default(false),
  sources: z.array(Source).default([]),
})
export type ModelRating = z.infer<typeof ModelRating>

export const RatingsFile = z.object({ updatedAt: z.string(), ratings: z.array(ModelRating) })

export function loadRatings(file: string): ModelRating[] {
  if (!existsSync(file)) return []
  return RatingsFile.parse(JSON.parse(readFileSync(file, 'utf8'))).ratings
}

export const quality = (r: ModelRating, d: Domain) => r.scores[d] ?? r.scores.general ?? 0
export const costPerTask = (r: ModelRating) => (r.inputTokensPerTask * r.inputPerM + r.outputTokensPerTask * r.outputPerM) / 1_000_000

export interface Observed { calls: number; errorRate: number; refusalRate: number; avgOutputTokens?: number; p50Ms?: number }

/** What the gremlin has seen of each provider/model, from its ledger. */
export function observe(entries: LedgerEntry[]): Map<string, Observed> {
  const by = new Map<string, LedgerEntry[]>()
  for (const e of entries) by.set(`${e.provider}/${e.model}`, [...(by.get(`${e.provider}/${e.model}`) ?? []), e])
  const out = new Map<string, Observed>()
  for (const [k, es] of by) {
    const ok = es.filter((e) => e.status < 400 && !(e as LedgerEntry & { incomplete?: boolean }).incomplete)
    const outs = ok.map((e) => e.usage?.completionTokens).filter((n): n is number => typeof n === 'number')
    const ms = ok.map((e) => e.ms).sort((a, b) => a - b)
    out.set(k, {
      calls: es.length,
      errorRate: 1 - ok.length / es.length,
      refusalRate: es.filter((e) => (e as LedgerEntry & { refused?: boolean }).refused).length / es.length,
      ...(outs.length ? { avgOutputTokens: outs.reduce((a, b) => a + b, 0) / outs.length } : {}),
      ...(ms.length ? { p50Ms: ms[Math.floor(ms.length / 2)] } : {}),
    })
  }
  return out
}

/** Quality discounted by observed failures; value = that quality per dollar of a typical task (free counts as $0.0001). */
export function value(r: ModelRating, d: Domain, seen?: Observed): { quality: number; usdPerTask: number; value: number } {
  const trust = seen && seen.calls >= 5 ? (1 - seen.errorRate) * (1 - seen.refusalRate) : 1
  const q = quality(r, d) * trust
  const tokens = seen?.avgOutputTokens ?? r.outputTokensPerTask
  const usd = (r.inputTokensPerTask * r.inputPerM + tokens * r.outputPerM) / 1_000_000
  return { quality: q, usdPerTask: usd, value: q / Math.max(usd, 0.0001) }
}

/** Candidates for a domain, best value first, among those clearing a quality floor. */
export function rank(ratings: ModelRating[], d: Domain, opts: { minQuality?: number; seen?: Map<string, Observed>; permissiveOnly?: boolean } = {}) {
  return ratings
    .filter((r) => !opts.permissiveOnly || r.permissive)
    .map((r) => ({ r, ...value(r, d, opts.seen?.get(`${r.provider}/${r.model}`)) }))
    .filter((x) => x.quality >= (opts.minQuality ?? 0))
    .sort((a, b) => b.value - a.value || b.quality - a.quality)
}
