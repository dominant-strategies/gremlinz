import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Documentation, type DocumentationTarget } from '../src/gateway/documentation.js'
import { documentationTargets } from '../src/gateway/documentation-targets.js'
import { AccessSources } from '../src/gateway/access.js'
import { GatewayConfig } from '../src/gateway/config.js'

const target: DocumentationTarget = { id: 'provider:renewal', source: 'provider', purpose: 'renewal', url: 'https://provider.example/renewal.md' }
const DAY = 86_400_000
function setup(extra: { maxBytes?: number; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inference-docs-'))
  let now = 1_000_000, body = 'POST /keys/renew with your account session.', status = 200, type = 'text/markdown'
  const calls: { url: string; init: RequestInit }[] = []
  const opts = { file: join(dir, 'state.json'), dir: join(dir, 'documents'), ...extra, now: () => now, fetch: (async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return new Response(status === 304 ? null : body, { status, headers: { 'content-type': type, etag: '"version"', ...(status === 302 ? { location: 'https://other.example/docs' } : {}) } })
  }) as typeof fetch }
  return { watcher: new Documentation(opts), opts, calls, set: (p: { now?: number; body?: string; status?: number; type?: string }) => { now = p.now ?? now; body = p.body ?? body; status = p.status ?? status; type = p.type ?? type } }
}

describe('official renewal documentation checks', () => {
  it('establishes a reviewable baseline, caches for a day, and preserves a reviewed version on HTTP 304', async () => {
    const t = setup()
    const first = (await t.watcher.check([target]))[0]!
    expect(first.status).toBe('needs-review')
    expect(t.calls[0]!.init.credentials).toBe('omit')
    expect(new Headers(t.calls[0]!.init.headers).has('authorization')).toBe(false)
    t.watcher.review(target.id, first.hash!, 'The account-session renewal flow matches the current adapter.')
    await t.watcher.check([target])
    expect(t.calls).toHaveLength(1)
    t.set({ now: 1_000_000 + DAY, status: 304 })
    const unchanged = (await t.watcher.check([target]))[0]!
    expect(unchanged.status).toBe('reviewed')
    expect(new Headers(t.calls[1]!.init.headers).get('if-none-match')).toBe('"version"')
    expect(unchanged.hash).toBe(first.hash)
    expect(new Documentation(t.opts).status()[0]!.review).toContain('account-session')
  })
  it('detects changed renewal steps, exposes a bounded difference and rejects a stale review acknowledgement', async () => {
    const t = setup()
    const old = (await t.watcher.check([target]))[0]!
    t.watcher.review(target.id, old.hash!, 'Old flow reviewed.')
    t.set({ body: 'POST /v2/credentials/refresh with a new account token.' })
    const changed = (await t.watcher.check([target], true))[0]!
    expect(changed.status).toBe('needs-review')
    expect(changed.hash).not.toBe(old.hash)
    expect(t.watcher.changes()[0]!.evidence.previous).toContain('/keys/renew')
    expect(t.watcher.changes()[0]!.evidence.current).toContain('/v2/credentials/refresh')
    expect(t.watcher.changes()[0]!.untrustedDocumentation).toBe(true)
    expect(() => t.watcher.review(target.id, old.hash!, 'Already reviewed.')).toThrow(/changed/)
    expect(new Headers(t.calls[1]!.init.headers).has('if-none-match')).toBe(false) // force rehashes the actual body
    t.watcher.review(target.id, changed.hash!, 'New endpoint needs adapter changes and a renewal test; no renewal success is claimed.')
    expect(t.watcher.status()[0]!.status).toBe('reviewed')
  })
  it('ignores JSON object ordering changes while detecting actual API schema changes', async () => {
    const t = setup()
    t.set({ type: 'application/json', body: '{"paths":{"/renew":{}},"version":1}' })
    const original = (await t.watcher.check([target]))[0]!
    t.watcher.review(target.id, original.hash!, 'API reviewed.')
    t.set({ body: '{"version":1,"paths":{"/renew":{}}}' })
    expect((await t.watcher.check([target], true))[0]!.status).toBe('reviewed')
    t.set({ body: '{"version":2,"paths":{"/refresh":{}}}' })
    expect((await t.watcher.check([target], true))[0]!.status).toBe('needs-review')
  })
  it('reports outages as uncertainty and retains the last successful baseline', async () => {
    const t = setup()
    const original = (await t.watcher.check([target]))[0]!
    t.watcher.review(target.id, original.hash!, 'Reviewed.')
    t.set({ status: 503, now: 1_000_000 + DAY })
    const failed = (await t.watcher.check([target]))[0]!
    expect(failed.status).toBe('unreachable')
    expect(failed.hash).toBe(original.hash)
    expect(() => t.watcher.review(target.id, original.hash!, 'Looks unchanged.')).toThrow()
    await t.watcher.check([target]); expect(t.calls).toHaveLength(2)
    t.set({ status: 200, now: 1_000_000 + DAY + 3_600_000 })
    expect((await t.watcher.check([target]))[0]!.status).toBe('reviewed')
  })
  it('does not silently follow a move to another origin or send credentials from URLs', async () => {
    const t = setup()
    t.set({ status: 302 })
    expect((await t.watcher.check([target]))[0]!.error).toContain('another origin')
    expect(t.calls).toHaveLength(1)
    const bad = { ...target, url: 'https://user:password@provider.example/renew' }
    expect((await t.watcher.check([bad], true))[0]!.status).toBe('unreachable')
    expect(t.calls).toHaveLength(1)
  })
  it('requires a fresh baseline after an official URL changes, including after a failed fetch', async () => {
    const t = setup()
    const old = (await t.watcher.check([target]))[0]!
    t.watcher.review(target.id, old.hash!, 'Reviewed original address.')
    const moved = { ...target, url: 'https://provider.example/v2/renewal.md' }
    t.set({ status: 503 })
    await t.watcher.check([moved], true)
    t.set({ status: 200 })
    const next = (await t.watcher.check([moved], true))[0]!
    expect(next.status).toBe('needs-review')
    expect(next.hash).not.toBe(old.hash)
    expect(new Headers(t.calls.at(-1)!.init.headers).has('if-none-match')).toBe(false)
  })
  it('bounds downloads and never treats a truncated body as the new baseline', async () => {
    const t = setup({ maxBytes: 100 })
    const old = (await t.watcher.check([target]))[0]!
    t.set({ body: 'x'.repeat(101) })
    const oversized = (await t.watcher.check([target], true))[0]!
    expect(oversized.error).toContain('size limit')
    expect(oversized.hash).toBe(old.hash)
    expect(t.watcher.changes()[0]!.evidence.current).toContain('/keys/renew')
  })
  it('bounds a hung check even when a fetch implementation ignores abort', async () => {
    const t = setup({ timeoutMs: 20 })
    const watcher = new Documentation({ ...t.opts, fetch: (() => new Promise(() => {})) as typeof fetch })
    expect((await watcher.check([target]))[0]!.status).toBe('unreachable')
  })
  it('does not infer a missing migrated snapshot is still current', async () => {
    const t = setup()
    const old = (await t.watcher.check([target]))[0]!
    const migratedDir = mkdtempSync(join(tmpdir(), 'migrated-docs-'))
    const watcher = new Documentation({ ...t.opts, dir: join(migratedDir, 'docs') })
    expect(watcher.status()[0]!.snapshotAvailable).toBe(false)
    expect((await watcher.check([target]))[0]!.hash).toBe(old.hash)
    expect(t.calls).toHaveLength(2)
    expect(new Headers(t.calls[1]!.init.headers).has('if-none-match')).toBe(false)
  })
  it('tracks the wallet adapter and configured official documents without exposing credentials', () => {
    const cfg = GatewayConfig.parse({ providers: [{ id: 'hashference', kind: 'hashference', baseUrl: 'https://hashference.com/v1' }, { id: 'other', kind: 'openai', baseUrl: 'https://provider.example/v1', documentationUrls: ['https://provider.example/renewal.md'] }], routes: { 'gremlin-main': [{ provider: 'hashference', model: 'qwen3' }] }, glean: { enabled: false } })
    const targets = documentationTargets(cfg, new AccessSources())
    expect(targets).toHaveLength(3)
    expect(targets.map(t => t.purpose)).toEqual(['renewal', 'api', 'renewal'])
  })
})
