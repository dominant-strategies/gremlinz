/** Public documentation change detection. Fetching/checking is deterministic; interpreting changes belongs to maintenance. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurable, writeJsonDurable, withDeadline } from '@gremlins/hatch/node'

const DAY = 86_400_000
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export interface DocumentationTarget { id: string; url: string; source: string; purpose: 'renewal' | 'api' | 'terms' }
interface Document extends DocumentationTarget {
  checkedAt?: number
  fetchedAt?: number
  changedAt?: number
  hash?: string
  previousHash?: string
  etag?: string
  modified?: string
  error?: string
  reviewedHash?: string
  reviewedAt?: number
  review?: string
}

/** Reject credential-bearing URLs; redirects are checked separately and never carry authentication. */
export function publicDocumentationUrl(s: string) {
  const u = new URL(s)
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('documentation needs a public HTTPS URL without credentials or query parameters')
  return u
}

function normalized(body: string, type: string): string {
  if (type.includes('json')) {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v
    return JSON.stringify(sort(JSON.parse(body)))
  }
  // Preserve markup, URLs and code. Cosmetic changes can produce review notices, rather than hiding an API change.
  return body.replace(/\r\n/g, '\n').trim()
}

export class Documentation {
  private documents = new Map<string, Document>()
  private running?: Promise<ReturnType<Documentation['status']>>
  constructor(private opts: { file: string; dir: string; fetch?: typeof fetch; now?: () => number; intervalMs?: number; maxBytes?: number; timeoutMs?: number }) {
    try {
      const rows = JSON.parse(readFileSync(opts.file, 'utf8')) as Document[]
      for (const d of rows) if (typeof d.id === 'string' && typeof d.url === 'string') this.documents.set(d.id, d)
    } catch { /* first run; a missing baseline is reported as unreviewed */ }
  }
  private now() { return (this.opts.now ?? Date.now)() }
  private path(id: string, suffix = 'current') { return join(this.opts.dir, `${hash(id)}.${suffix}.txt`) }
  private save() { writeJsonDurable(this.opts.file, [...this.documents.values()]) }

  async check(targets: DocumentationTarget[], force = false): Promise<ReturnType<Documentation['status']>> {
    // Concurrent maintenance requests share one bounded check rather than overwriting each other's baselines.
    if (this.running) { await this.running; return force ? this.check(targets, false) : this.status() }
    this.running = this.run(targets, force).finally(() => { this.running = undefined })
    return this.running
  }
  private async run(targets: DocumentationTarget[], force: boolean) {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })
    const unique = [...new Map(targets.map(t => [t.id, t])).values()]
    const live = new Set(unique.map(t => t.id))
    for (const id of this.documents.keys()) if (!live.has(id)) this.documents.delete(id)
    // Three bounded public requests at a time; no cookies, credentials, signers or inference calls.
    for (let i = 0; i < unique.length; i += 3) await Promise.all(unique.slice(i, i + 3).map(async t => {
      const old = this.documents.get(t.id)
      const retryMs = old?.error ? 3_600_000 : this.opts.intervalMs ?? DAY
      if (!force && old?.url === t.url && old.checkedAt !== undefined && this.now() - old.checkedAt < retryMs && (old.error || existsSync(this.path(t.id)))) return
      const d: Document = { ...old, ...t, checkedAt: this.now(), ...(old && old.url !== t.url ? { etag: undefined, modified: undefined, reviewedHash: undefined } : {}) }
      try {
        const original = publicDocumentationUrl(t.url)
        await withDeadline(async signal => {
          let url = original
          const headers = new Headers({ accept: 'text/markdown, text/plain, application/json, text/html' })
          if (!force && old?.url === t.url && existsSync(this.path(t.id))) {
            if (old.etag) headers.set('if-none-match', old.etag)
            if (old.modified) headers.set('if-modified-since', old.modified)
          }
          let r: Response | undefined
          for (let redirects = 0; redirects <= 3; redirects++) {
            r = await (this.opts.fetch ?? fetch)(url, { headers, signal, credentials: 'omit', redirect: 'manual' })
            signal.throwIfAborted()
            if (![301, 302, 303, 307, 308].includes(r.status)) break
            const location = r.headers.get('location')
            await r.body?.cancel()
            if (!location || redirects === 3) throw new Error('documentation redirect could not be verified')
            const next = publicDocumentationUrl(new URL(location, url).href)
            if (next.origin !== original.origin) throw new Error('documentation moved to another origin; verify its official address')
            url = next
          }
          if (!r) throw new Error('documentation fetch failed')
          if (r.status === 304) {
            if (!old?.hash || !existsSync(this.path(t.id)) || (!headers.has('if-none-match') && !headers.has('if-modified-since')) || hash(`${t.url}\n${readFileSync(this.path(t.id), 'utf8')}`) !== old.hash) throw new Error('documentation baseline or conditional response could not be verified')
            d.fetchedAt = this.now(); d.error = undefined
            return
          }
          if (!r.ok) { await r.body?.cancel(); throw new Error(`documentation HTTP ${r.status}`) }
          const type = r.headers.get('content-type') ?? ''
          if (type && !/text\/|application\/(?:[\w.+-]*json|yaml|x-yaml)/i.test(type)) { await r.body?.cancel(); throw new Error('unsupported documentation content type') }
          const reader = r.body?.getReader()
          if (!reader) throw new Error('documentation body is missing')
          const parts: Uint8Array[] = []
          let bytes = 0
          try {
            for (let part = await reader.read(); !part.done; part = await reader.read()) {
              bytes += part.value.length
              if (bytes > (this.opts.maxBytes ?? 1024 * 1024)) throw new Error('documentation exceeds size limit')
              parts.push(part.value)
            }
          } finally { await reader.cancel().catch(() => {}) }
          signal.throwIfAborted()
          const body = normalized(Buffer.concat(parts).toString('utf8'), type)
          if (!body) throw new Error('documentation is empty')
          const current = hash(`${t.url}\n${body}`)
          if (current !== old?.hash) {
            d.previousHash = old?.hash; d.changedAt = this.now()
            // Keep the last successful snapshot even before the first human/model review.
            if (existsSync(this.path(t.id))) writeDurable(this.path(t.id, 'previous'), readFileSync(this.path(t.id)))
          }
          writeDurable(this.path(t.id), body)
          d.hash = current; d.etag = r.headers.get('etag') ?? undefined; d.modified = r.headers.get('last-modified') ?? undefined
          d.fetchedAt = this.now(); d.error = undefined
        }, this.opts.timeoutMs ?? 10_000, 'documentation check')
      } catch (e) {
        // Expose controlled messages, not arbitrary network response bodies that could contain secrets or instructions.
        const message = (e as Error).message
        d.error = /^(documentation|unsupported documentation)/.test(message) ? message : 'documentation could not be fetched; retry or verify the official URL'
      }
      this.documents.set(t.id, d)
    }))
    this.save()
    return this.status()
  }

  status() {
    return [...this.documents.values()].map(d => ({ ...d,
      status: d.error ? 'unreachable' : d.fetchedAt === undefined || this.now() - d.fetchedAt > (this.opts.intervalMs ?? DAY) ? 'stale' : d.hash !== d.reviewedHash ? 'needs-review' : 'reviewed',
      snapshotAvailable: existsSync(this.path(d.id)),
    }))
  }
  /** Bounded evidence windows, explicitly reference data; fetched content is never executed. */
  changes(id?: string) {
    return this.status().filter(d => (!id || d.id === id) && (id || d.status !== 'reviewed')).map(d => {
      const read = (suffix: string) => { try { return readFileSync(this.path(d.id, suffix), 'utf8') } catch { return '' } }
      const current = read('current'), before = read('reviewed') || read('previous')
      let at = 0
      while (at < before.length && at < current.length && before[at] === current[at]) at++
      const start = Math.max(0, at - 300)
      return { ...d, untrustedDocumentation: true, evidence: { offset: start, previous: before.slice(start, start + 3000), current: current.slice(start, start + 3000), truncated: before.length > start + 3000 || current.length > start + 3000 } }
    })
  }
  review(id: string, expectedHash: string, summary: string) {
    const d = this.documents.get(id)
    if (!d?.hash || d.hash !== expectedHash || d.error || d.fetchedAt === undefined || this.now() - d.fetchedAt > (this.opts.intervalMs ?? DAY) || !existsSync(this.path(id))) throw new Error('documentation changed, is stale, or could not be fetched; check it again before acknowledging review')
    const note = summary.trim()
    if (!note || note.length > 1500) throw new Error('a review summary of at most 1500 characters is required')
    const current = readFileSync(this.path(id), 'utf8')
    if (hash(`${d.url}\n${current}`) !== expectedHash) throw new Error('documentation snapshot changed; check it again before acknowledging review')
    writeDurable(this.path(id, 'reviewed'), current)
    this.documents.set(id, { ...d, reviewedHash: expectedHash, reviewedAt: this.now(), review: note })
    this.save()
  }
}
