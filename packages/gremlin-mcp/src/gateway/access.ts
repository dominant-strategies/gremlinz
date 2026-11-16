/** Sources the maintenance agent has obtained lawfully, tested, and added without restarting the gateway. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { homeFile } from '../env.js'
import { ProviderConfig, type RouteTarget } from './config.js'

// Credentials cannot travel in onboarding URLs. Documentation and the API must use HTTPS.
const publicUrl = z.string().url().refine(s => {
  const u = new URL(s)
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
}, 'use an HTTPS URL without credentials, query parameters or fragments')
export const AccessSource = z.object({
  id: z.string().regex(/^discovered-[a-z0-9-]{1,48}$/),
  baseUrl: publicUrl,
  docsUrl: publicUrl,
  termsUrl: publicUrl,
  renewalDocsUrl: publicUrl.optional(),
  specUrl: publicUrl.optional(),
  /** Existing credentials obtained through official enrollment or owner-authorized account access. Never the key. */
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  keyFile: z.string().regex(/^inference-keys\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/).optional(),
  accountId: z.string().min(1).optional(),
  accountDailyUsd: z.number().positive().optional(),
  free: z.boolean(),
  models: z.array(z.object({ model: z.string().min(1).max(200), inputPerM: z.number().nonnegative(), outputPerM: z.number().nonnegative() })).min(1).max(10),
}).strict().refine(s => !(s.apiKeyEnv && s.keyFile), 'supply one credential source').refine(s => s.free || !!(s.apiKeyEnv || s.keyFile), 'paid sources need an owned credential').refine(s => s.free || s.models.every(m => m.inputPerM > 0 || m.outputPerM > 0), 'paid sources need prices').refine(s => !s.free || s.models.every(m => m.inputPerM === 0 && m.outputPerM === 0), 'free sources need zero prices')
export type AccessSource = z.infer<typeof AccessSource>

export const sourceOffer = (s: AccessSource) => ({
  provider: ProviderConfig.parse({ id: s.id, kind: 'openai', baseUrl: s.baseUrl, apiKeyEnv: s.apiKeyEnv, keyFile: s.keyFile ? homeFile(s.keyFile) : undefined, accountId: s.accountId, accountDailyUsd: s.accountDailyUsd, free: s.free, minIntervalMs: s.free ? 15_000 : 0, firstByteMs: 30_000, timeoutMs: 120_000 }),
  targets: s.models.map(m => ({ ...m, provider: s.id } as RouteTarget)),
})

export class AccessSources {
  private sources = new Map<string, AccessSource>()
  constructor(private file?: string) {
    if (file) try {
      const rows = z.array(AccessSource).parse(JSON.parse(readFileSync(file, 'utf8')))
      for (const s of rows) this.sources.set(s.id, s)
    } catch { /* first use or unreadable catalog: configured inference remains available */ }
  }
  list() { return [...this.sources.values()] }
  offers() { return this.list().map(sourceOffer) }
  add(source: AccessSource) {
    const parsed = AccessSource.parse(source)
    if (this.sources.has(parsed.id)) throw new Error('source id already exists; remove it before replacing its configuration')
    // Publish durably before the source becomes visible to other calls.
    const next = [...this.sources.values(), parsed]
    if (this.file) writeJsonDurable(this.file, next)
    this.sources.set(parsed.id, parsed)
  }
  remove(id: string) {
    if (!this.sources.has(id)) return false
    if (this.file) writeJsonDurable(this.file, this.list().filter(s => s.id !== id))
    return this.sources.delete(id)
  }
}
