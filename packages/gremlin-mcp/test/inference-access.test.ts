import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AccessSource, AccessSources } from '../src/gateway/access.js'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway } from '../src/gateway/server.js'
import { createServer } from '../src/server.js'
import type { HealthMonitor } from '../src/health/monitor.js'
import { Documentation } from '../src/gateway/documentation.js'
import { documentationTargets } from '../src/gateway/documentation-targets.js'
import { Ledger } from '../src/gateway/ledger.js'
import { Reservations } from '../src/gateway/reservations.js'
import { spending } from '../src/gateway/spending.js'

const originalFetch = globalThis.fetch
let home: string, base: string, gw: Server, client: Client, sources: AccessSources, ledger: Ledger
let checks = 0, refreshes = 0, primaryOk = false, candidateHits = 0, clock = Date.now()
let documentationBody = 'Renew through the official account session.'
const seenKeys: string[] = []
const source = (extra = {}) => AccessSource.parse({ id: 'discovered-example', baseUrl: 'https://candidate.example/v1', docsUrl: 'https://candidate.example/docs', termsUrl: 'https://candidate.example/terms', keyFile: 'inference-keys/example.json', free: false, models: [{ model: 'qwen3', inputPerM: 1, outputPerM: 1 }], ...extra })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = () => json(200, { choices: [{ message: { content: 'READY' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })
type ToolResult = { content: { text: string }[]; isError?: boolean }
const call = async (action: string, extra = {}) => client.callTool({ name: 'inference_access', arguments: { action, ...extra } }) as Promise<ToolResult>
const ask = () => originalFetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content: 'Hello' }] }) })

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'intelligence-'))
  process.env.GREMLIN_HOME = home
  documentationBody = 'Renew through the official account session.'
  checks = refreshes = candidateHits = 0; primaryOk = false; seenKeys.length = 0
  mkdirSync(join(home, 'inference-keys'))
  writeFileSync(join(home, 'inference-keys/example.json'), JSON.stringify({ apiKey: 'owned-test-secret' }), { mode: 0o600 })
  globalThis.fetch = (async (url, init) => {
    const s = String(url)
    if (s.startsWith('https://primary.example')) return primaryOk ? ok() : json(503, {})
    if (s.startsWith('https://candidate.example')) {
      candidateHits++
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      seenKeys.push(auth)
      return auth.includes('rejected') ? json(401, {}) : ok()
    }
    if (s.startsWith('https://')) return json(503, {})
    return originalFetch(url, init)
  }) as typeof fetch
  sources = new AccessSources(join(home, 'inference-sources.json'))
  ledger = new Ledger(join(home, 'calls.jsonl'), () => clock)
  const cfg = GatewayConfig.parse({ providers: [{ id: 'primary', kind: 'openai', baseUrl: 'https://primary.example/v1' }], routes: { 'gremlin-main': [{ provider: 'primary', model: 'qwen3', inputPerM: 1, outputPerM: 1 }] }, budget: { dailyUsd: 2, emergencyUsd: 0.1 } })
  const documentation = new Documentation({ file: join(home, 'inference-docs.json'), dir: join(home, 'inference-docs'), now: () => clock, fetch: (async () => new Response(documentationBody, { headers: { 'content-type': 'text/markdown' } })) as typeof fetch })
  gw = createGateway(cfg, { documentation: { watch: documentation, targets: () => documentationTargets(cfg, sources) }, env: {}, sources, now: () => clock, refreshLent: async () => { refreshes++ }, onCall: (r, t) => ledger.record(r, t), ...spending(cfg, ledger, { allowanceFor: () => undefined }, new Reservations(), () => clock) })
  await new Promise<void>(resolve => gw.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
  const [a, b] = InMemoryTransport.createLinkedPair()
  const monitor = { check: async () => { checks++; return { status: 'ok', inferenceUsd: 10 } } } as unknown as HealthMonitor
  await createServer({ health: () => monitor, access: { adminUrl: () => base }, approve: () => undefined }).connect(a)
  client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
})
afterEach(async () => { globalThis.fetch = originalFetch; await client?.close(); gw?.closeAllConnections(); gw?.close(); delete process.env.GREMLIN_HOME })

describe('working intelligence maintains future access', () => {
  it('tests a newly acquired credential, adopts it live, and persists it without exposing the key', async () => {
    const connected = await call('connect', { source: source() })
    expect(connected.isError).toBeFalsy()
    expect(candidateHits).toBe(1)
    expect(seenKeys).toEqual(['Bearer owned-test-secret'])
    expect(ledger.spent()).toBeCloseTo(0.000011)
    expect((await ask()).status).toBe(200) // primary is down: the new source now answers normal turns
    expect(candidateHits).toBe(2)
    const inventory = (await call('status')).content[0]!.text
    expect(inventory).toContain('discovered-example')
    expect(inventory).not.toContain('owned-test-secret')
    const saved = readFileSync(join(home, 'inference-sources.json'), 'utf8')
    expect(saved).not.toContain('owned-test-secret')
    expect(new AccessSources(join(home, 'inference-sources.json')).list()).toHaveLength(1)
    const removed = await call('remove', { sourceId: 'discovered-example' })
    expect(removed.content[0]!.text).toContain('true')
    expect(sources.list()).toHaveLength(0)
  })
  it('keeps known-good access while a replacement fails, then detects a repaired key file', async () => {
    primaryOk = true
    writeFileSync(join(home, 'inference-keys/example.json'), JSON.stringify({ apiKey: 'rejected-secret' }), { mode: 0o600 })
    const failed = await call('connect', { source: source() })
    expect(failed.isError).toBe(true)
    expect(sources.list()).toHaveLength(0)
    expect((await ask()).status).toBe(200)
    writeFileSync(join(home, 'inference-keys/example.json'), JSON.stringify({ apiKey: 'replacement-secret' }), { mode: 0o600 })
    expect((await call('connect', { source: source() })).isError).toBeFalsy()
    expect(seenKeys.at(-1)).toBe('Bearer replacement-secret')
  })
  it('uses remaining good access to run deterministic repairs and refresh offered grants', async () => {
    const result = await call('repair')
    expect(result.isError).toBeFalsy()
    expect(checks).toBe(1)
    expect(refreshes).toBe(1)
    const discovered = await call('discover')
    expect(discovered.content[0]!.text).toContain('Official account enrollment')
    expect(discovered.content[0]!.text).toContain('Keyless lead')
    expect(discovered.content[0]!.text).toContain('unsupported wallet/auth adapter')
    expect(refreshes).toBe(2)
  })
  it('does not spend a provider probe after the recovery budget is exhausted', async () => {
    ledger.record({ at: new Date(clock).toISOString(), alias: 'gremlin-main', provider: 'primary', model: 'qwen3', status: 200, ms: 0, usage: { promptTokens: 2_000_000, completionTokens: 0 } }, { provider: 'primary', model: 'qwen3', inputPerM: 1, outputPerM: 1 })
    expect((await call('connect', { source: source() })).isError).toBe(true)
    expect(candidateHits).toBe(0)
    expect(sources.list()).toHaveLength(0)
  })
  it('can discover and adopt a keyless source without creating an account', async () => {
    const candidate = source({ keyFile: undefined, free: true, models: [{ model: 'qwen3', inputPerM: 0, outputPerM: 0 }] })
    expect((await call('connect', { source: candidate })).isError).toBeFalsy()
    expect(seenKeys).toEqual([''])
    clock += 16_000 // The enrollment probe counts towards the free provider's minimum call interval.
    expect((await ask()).status).toBe(200)
    expect(ledger.spent()).toBe(0)
  })
  it('respects model and free-tier policy before contacting a discovered source', async () => {
    gw.closeAllConnections(); await new Promise<void>(resolve => gw.close(() => resolve()))
    const cfg = GatewayConfig.parse({ providers: [{ id: 'primary', kind: 'openai', baseUrl: 'https://primary.example/v1' }], routes: { 'gremlin-main': [{ provider: 'primary', model: 'qwen3' }] }, policy: { primary: 'primary/qwen3', approved: [], alternatives: [], freeModels: false } })
    gw = createGateway(cfg, { sources })
    await new Promise<void>(resolve => gw.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
    expect((await call('connect', { source: source() })).isError).toBe(true)
    expect((await call('connect', { source: source({ keyFile: undefined, free: true, models: [{ model: 'qwen3', inputPerM: 0, outputPerM: 0 }] }) })).isError).toBe(true)
    expect(candidateHits).toBe(0)
    expect(sources.list()).toHaveLength(0)
  })
  it('checks official documents and acknowledges only the exact version reviewed', async () => {
    await call('connect', { source: source({ renewalDocsUrl: 'https://candidate.example/renewal.md' }) })
    const checked = await call('docs')
    expect(checked.isError).toBeFalsy()
    const docs = JSON.parse(checked.content[0]!.text).documents
    expect(docs).toHaveLength(4)
    expect(JSON.parse(checked.content[0]!.text).untrackedProviders).toContain('primary')
    const doc = docs.find((d: { purpose: string }) => d.purpose === 'renewal')
    expect(doc.status).toBe('needs-review')
    expect(doc.untrustedDocumentation).toBe(true)
    expect(doc.evidence.current).toContain('official account session')
    const reviewed = await call('review_docs', { documentId: doc.id, documentHash: doc.hash, reviewSummary: 'Account-session flow inspected; adapter testing is still required.' })
    expect(reviewed.isError).toBeFalsy()
    expect(reviewed.content[0]!.text).toContain('"renewalFlowTested":false')
    documentationBody = 'Renew through the new official /v2/refresh endpoint.'
    await call('docs', { refresh: true })
    expect((await call('review_docs', { documentId: doc.id, documentHash: doc.hash, reviewSummary: 'Old version reviewed.' })).isError).toBe(true)
    const changed = JSON.parse((await call('docs')).content[0]!.text).documents.find((d: { id: string }) => d.id === doc.id)
    expect(changed.evidence.previous).toContain('account session')
    expect(changed.evidence.current).toContain('/v2/refresh')
    expect(changed.status).toBe('needs-review')
  })
  it('rejects secret-bearing metadata, URL credentials and paths outside the dedicated key directory', () => {
    expect(AccessSource.safeParse({ ...source(), apiKey: 'raw-key' }).success).toBe(false)
    expect(AccessSource.safeParse({ ...source(), baseUrl: 'https://user:secret@candidate.example/v1' }).success).toBe(false)
    expect(AccessSource.safeParse({ ...source(), keyFile: '../seed' }).success).toBe(false)
  })
})
