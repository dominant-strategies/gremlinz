import { describe, expect, it } from 'vitest'
import { conway, nestBootstrapScript, NODE } from '../src/conway.js'

const artifact = { url: 'https://github.com/org/gremlins/releases/download/v1/gremlin-linux.tgz', sha256: 'b'.repeat(64) }

describe('conway nest bootstrap', () => {
  it('verifies both the Node runtime and the bundle by checksum before using them', () => {
    const s = nestBootstrapScript(artifact)
    expect(s).toContain(`${NODE.sha256.x64}`)
    expect(s).toContain(`echo "${artifact.sha256}  gremlin.tgz" | sha256sum -c -`)
    expect(s.indexOf('sha256sum -c - \nmkdir -p /opt/node'.replace(' \n', '\n'))).toBeGreaterThan(0)
    expect(s.indexOf('sha256sum -c -')).toBeLessThan(s.indexOf('tar -xJf node.tar.xz'))
    expect(s.lastIndexOf('sha256sum -c -')).toBeLessThan(s.indexOf('tar -xzf gremlin.tgz'))
  })
  it('never contains the launch data or nest secret', () => {
    expect(nestBootstrapScript(artifact)).not.toMatch(/nestSecret|launch\.json'/)
  })
  it('rejects unpinned or unsafe artifacts', () => {
    expect(() => nestBootstrapScript({ ...artifact, sha256: 'latest' })).toThrow()
    expect(() => nestBootstrapScript({ ...artifact, url: 'http://insecure/x.tgz' })).toThrow()
    expect(() => nestBootstrapScript({ ...artifact, url: "https://x/a'; rm -rf / #" })).toThrow()
  })
  it('sends the raw API key and sandbox sizes Conway expects', async () => {
    const calls: [string, RequestInit][] = []
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ id: 'sb_1' })) }) as unknown as typeof fetch
    const id = await conway({ apiKey: 'cnwy_k_abc', fetchImpl }).createSandbox({ name: 'nest-1', memoryMb: 1024, vcpu: 1, diskGb: 10 })
    expect(id).toBe('sb_1')
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe('cnwy_k_abc')
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ memory_mb: 1024, vcpu: 1, disk_gb: 10 })
  })
})
