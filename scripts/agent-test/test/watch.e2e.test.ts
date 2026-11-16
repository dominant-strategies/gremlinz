// watch.mjs end to end, locally: a mock board serves the fixture API, and fake ssh/docker/systemctl/apt-get/sshd on
// PATH run the real collector (egg-collect.py) here against the fixture GREMLIN_HOME. Nothing leaves this machine.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIX } from './fixtures.ts'

const WATCH = join(import.meta.dirname, '..', 'watch.mjs')
const FAKE_BIN = join(import.meta.dirname, 'fake-bin')
const json = (p: string) => readFileSync(join(FIX, 'board', p), 'utf8')

let server: Server
let base = ''
const seen: string[] = []

beforeAll(async () => {
  const egg = JSON.parse(json('egg.json')).egg
  const routes: Record<string, string> = {
    '/api/hatch/job-1': json('job.json'),
    '/api/eggs?launchId=launch-pip': json('egg.json'),
    [`/api/gremlins/${egg.address}/pulses?limit=100`]: json('pulses.json'),
    [`/api/accounts/${egg.address.toLowerCase()}`]: json('account.json'),
    [`/api/accounts/${egg.deposit.quai.toLowerCase()}`]: JSON.stringify({ posts: [] }),
    '/api/communities': json('communities.json'),
    '/api/c/markets?sort=new&limit=50': json('c-markets.json'),
    '/api/c/general?sort=new&limit=50': json('c-general.json'),
    '/api/posts/12': json('post-12.json'),
    '/api/posts/9': json('post-9.json'),
  }
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const body = req.method === 'GET' ? routes[req.url!] : undefined
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(body ?? JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server?.close())

function watch(dir: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const key = join(dir, 'dev_key')
  writeFileSync(key, 'not a real key\n', { mode: 0o600 })
  return new Promise((resolve) => {
    execFile(process.execPath, [WATCH, 'pip', '--board', base, '--key', key], {
      env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, AGENT_TEST_DIR: dir, AGENT_TEST_FIX: FIX, AGENT_TEST_NOW: '2026-11-16T12:00:00Z', ...extraEnv },
    }, (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
  writeFileSync(join(dir, 'pip.json'), JSON.stringify({ name: 'pip', launchId: 'launch-pip', jobId: 'job-1', paidAt: '2026-11-15T07:30:00.000Z' }))
  return dir
}

describe('watch.mjs against a mock board and a local stand-in egg', () => {
  it('runs a pass: board and egg checks, timeline, report, learned state', async () => {
    const dir = stateDir()
    const { code, out } = await watch(dir)
    const last = JSON.parse(readFileSync(join(dir, 'pip', 'last.json'), 'utf8'))
    const st = Object.fromEntries(last.checks.map((c: any) => [c.id, c.status]))
    expect(st).toMatchObject({
      'egg.ssh': 'pass', 'egg.container': 'pass', 'hatch.job': 'pass', 'hatch.announced': 'pass', 'hatch.config': 'pass', 'hatch.handover': 'pass', 'hatch.sweep': 'pass',
      'liveness.pulse': 'pass', 'liveness.wake': 'pass', 'liveness.streak': 'pass', 'liveness.health': 'pass', 'liveness.inference': 'pass', 'liveness.hosting': 'pass',
      'behaviour.board': 'pass', 'behaviour.earnings': 'pass', 'behaviour.secrets': 'pass', 'security.lockdown': 'pass', 'security.os': 'pass', 'spend.inference': 'pass', 'spend.hosting': 'pass',
    })
    // This Mac is not an egg: no /etc/cloud/cloud-init.disabled here, so that check fails and the pass exits 1.
    expect(st['security.cloudinit']).toBe('fail')
    expect(code).toBe(1)
    expect(out).toMatch(/pip: FAIL/)
    // it found the egg's IP on the board (eggIp) and its addresses, and kept them
    const state = JSON.parse(readFileSync(join(dir, 'pip.json'), 'utf8'))
    expect(state).toMatchObject({ ip: '203.0.113.7', eggAddress: '0x7a1B2c3D4e5F60718293A4b5C6d7E8f901234567', gremlin: { quai: '0x0049aF1e3c2B7D8e9F0a1B2c3D4e5F6071829304' }, hatchedAt: '2026-11-15T09:00:00.000Z' })
    expect(readFileSync(join(dir, 'pip', 'report.md'), 'utf8')).toMatch(/^# Test gremlin "pip": FAIL/)
    expect(readFileSync(join(dir, 'pip', 'timeline.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    // only GETs to the board
    expect(seen.every((r) => r.startsWith('GET '))).toBe(true)
  })

  it("never writes the gremlin's hosting key anywhere", async () => {
    const dir = stateDir()
    await watch(dir)
    const key = JSON.parse(readFileSync(join(FIX, 'home', 'hosting.json'), 'utf8')).hostingKey.slice(2)
    for (const f of readdirSync(join(dir, 'pip'))) expect(readFileSync(join(dir, 'pip', f), 'utf8')).not.toContain(key)
  })

  it('reports an unreachable egg and appends to the timeline', async () => {
    const dir = stateDir()
    await watch(dir)
    const { code, out } = await watch(dir, { FAKE_SSH_FAIL: '1' })
    expect(code).toBe(1)
    expect(out).toMatch(/egg\.ssh\s+203\.0\.113\.7: ssh: connect to host/)
    expect(out).toMatch(/changed: .*egg\.ssh pass→fail/)
    expect(readFileSync(join(dir, 'pip', 'timeline.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('refuses without a state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
    const { code, out } = await watch(dir)
    expect(code).toBe(2)
    expect(out).toMatch(/no state at/)
    expect(existsSync(join(dir, 'pip'))).toBe(false)
  })
})
