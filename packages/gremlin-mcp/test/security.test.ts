import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import { ReleaseFeed, judgeImage } from '../src/tools/security.js'
import type { SecurityDeps } from '../src/tools/security.js'

const REPO = 'ghcr.io/dominant-strategies/gremlinz-egg'
const img = (c: string) => `${REPO}@sha256:${c.repeat(64)}`
const FEED = {
  repository: REPO,
  releases: [
    { tag: 'egg-v0.1.2', date: '2026-12-01', image: img('c'), fixes: [{ id: 'CVE-X', severity: 'medium', summary: 'x' }] },
    { tag: 'egg-v0.1.1', date: '2026-11-04', image: img('b'), fixes: [{ id: 'CVE-2026-111497', severity: 'high', summary: 'brotli' }] },
    { tag: 'egg-v0.1.0', date: '2026-10-08', image: img('a'), fixes: [] },
  ],
}

let home: string
let clock = Date.parse('2026-11-05T00:00:00Z')
let applied = 0

async function connect(security: SecurityDeps, image?: string) {
  home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  process.env.GREMLIN_HOME = home
  process.env.GREMLIN_LAUNCH = join(home, 'cloud-launch.json')
  if (image) writeFileSync(process.env.GREMLIN_LAUNCH, JSON.stringify({ mode: 'egg', image }))
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) }, now: () => clock, security }).connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { text: r.content[0]!.text, isError: !!r.isError }
  }
}

const deps = (over: Partial<SecurityDeps> = {}): SecurityDeps => ({
  fetchFeed: async () => FEED,
  osUpdates: async () => ({ security: [], other: 2 }),
  patchOs: async () => { applied++; return '3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' },
  runtimeChecks: [{ id: 'CVE-2026-111497', fixedIn: 'Node 24.22.1', present: () => true }],
  ...over,
})

beforeEach(() => { clock += 24 * 60 * 60_000 })

describe('judgeImage', () => {
  it('lists every fix shipped after the running release and names the newest release to move to', () => {
    const v = judgeImage(ReleaseFeed.parse(FEED), img('a'))
    expect(v.release).toBe('egg-v0.1.0')
    expect(v.missing.map((f) => [f.id, f.fixedIn])).toEqual([['CVE-X', 'egg-v0.1.2'], ['CVE-2026-111497', 'egg-v0.1.1']])
    expect(v.moveTo?.tag).toBe('egg-v0.1.2')
  })
  it('treats the latest release as clean and unknown digests as unofficial', () => {
    expect(judgeImage(ReleaseFeed.parse(FEED), img('c')).missing).toEqual([])
    expect(judgeImage(ReleaseFeed.parse(FEED), img('d')).official).toBe(false)
  })
})

describe('the published release feed', () => {
  it('parses, lists newest first, and names the CVE-2026-111497 fix', () => {
    const feed = ReleaseFeed.parse(JSON.parse(readFileSync(join(__dirname, '../../../docs/releases.json'), 'utf8')))
    const dates = feed.releases.map((r) => r.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    expect(judgeImage(feed, feed.releases.at(-1)!.image).missing.map((f) => f.id)).toContain('CVE-2026-111497')
  })
})

describe('security_check', () => {
  it('flags an old image as urgent and says which image to move to', async () => {
    const call = await connect(deps(), img('a'))
    const r = await call('security_check')
    expect(r.text).toContain('Image: egg-v0.1.0')
    expect(r.text).toContain('CVE-2026-111497 (high, fixed in egg-v0.1.1)')
    expect(r.text).toContain(`move_out with image ${img('c')}`)
    expect(r.text).toContain('To do (urgent)')
  })

  it('reports nothing to do on the latest image with no pending updates, and remembers its answer', async () => {
    let fetched = 0
    const call = await connect(deps({ fetchFeed: async () => { fetched++; return FEED } }), img('c'))
    expect((await call('security_check')).text).toContain('Nothing to do.')
    clock += 60 * 60_000
    expect((await call('security_check')).text).toContain('Checked ')
    expect(fetched).toBe(1)
    await call('security_check', { refresh: true })
    expect(fetched).toBe(2)
  })

  it('reads the moved launch data first: a gremlin that moved to a new image is judged by that image', async () => {
    const call = await connect(deps(), img('a'))
    writeFileSync(join(home, 'launch.json'), JSON.stringify({ mode: 'egg', image: img('c') }))
    expect((await call('security_check')).text).toContain('egg-v0.1.2, the latest release')
  })

  it('flags a runtime missing a fix, and pending OS security updates', async () => {
    const call = await connect(deps({
      runtimeChecks: [{ id: 'CVE-2026-111497', fixedIn: 'Node 24.22.1', present: () => false }],
      osUpdates: async () => ({ security: ['libssl3', 'libbrotli1'], other: 1 }),
    }), img('c'))
    const r = await call('security_check')
    expect(r.text).toContain('lacks fixes for CVE-2026-111497')
    expect(r.text).toContain('2 security update(s) pending (libssl3, libbrotli1)')
    expect(r.text).toContain('security_patch_os')
  })

  it('still checks the runtime and OS when the feed is unreachable', async () => {
    const call = await connect(deps({ fetchFeed: async () => { throw new Error('offline') } }), img('a'))
    const r = await call('security_check')
    expect(r.isError).toBe(false)
    expect(r.text).toContain('could not read it (offline)')
    expect(r.text).toContain('Runtime: Node')
  })
})

describe('security_patch_os', () => {
  it('applies updates and makes the next check look again', async () => {
    const call = await connect(deps(), img('c'))
    await call('security_check')
    const r = await call('security_patch_os')
    expect(r.text).toContain('3 upgraded')
    expect(applied).toBe(1)
    expect((await call('security_check')).text).not.toContain('Checked ')
  })

  it('reports a failure as a tool error', async () => {
    const call = await connect(deps({ patchOs: async () => { throw new Error('sudo: a password is required') } }), img('c'))
    const r = await call('security_patch_os')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('sudo')
  })
})

describe('move_out with a newer image', () => {
  it('passes a same-repository image to the supervisor and refuses other repositories', async () => {
    const call = await connect(deps(), img('a'))
    const token = 'ss_t_' + 'a'.repeat(27)
    expect((await call('move_out', { host: 'sporestack', sporestackToken: token, image: 'evil.example/egg@sha256:' + 'e'.repeat(64) })).isError).toBe(true)
    expect(existsSync(join(home, 'moveout-request.json'))).toBe(false)
    expect((await call('move_out', { host: 'sporestack', sporestackToken: token, image: img('c') })).isError).toBe(false)
    expect(JSON.parse(readFileSync(join(home, 'moveout-request.json'), 'utf8')).image).toBe(img('c'))
  })
})
