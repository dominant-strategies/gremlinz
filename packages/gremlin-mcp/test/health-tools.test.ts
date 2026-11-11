import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import { HealthMonitor } from '../src/health/monitor.js'
import { Miner } from '../src/health/miner.js'
import { AREAS, type Area } from '../src/health/policy.js'

type R = { content: { text: string }[]; isError?: boolean }
let home: string
let client: Client
let checks = 0

const area = (level: Area['level'], headline = 'fine', numbers: Area['numbers'] = {}): Area => ({ level, headline, numbers, did: [], next: [] })
function writeHealth(severity: 'ok' | 'critical', extra: object = {}) {
  const areas = Object.fromEntries(AREAS.map((a) => [a, area('ok')]))
  areas.inference = area('ok', 'credit $2.00', { targetUsd: 7, inferenceUsd: 2 })
  if (severity === 'critical') areas.money = { ...area('critical', 'runway 2.0 days'), next: ['Earn.'] }
  writeFileSync(join(home, 'health.json'), JSON.stringify({
    at: new Date().toISOString(), severity, drivers: severity === 'ok' ? [] : ['money'], conserve: severity !== 'ok',
    ...(severity === 'critical' ? { directive: 'Survival mode: money: runway 2.0 days (2.0 days left). Until it\'s fixed, every action must serve fixing it; defer everything else.' } : {}),
    status: 'ok', inferenceUsd: 2, burnUsdPerDay: 1, inferenceRunwayDays: 2, mining: { on: false, strategy: false, auto: false }, areas, suggestions: [], notes: [], ...extra,
  }))
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  process.env.GREMLIN_HOME = home
  checks = 0
  const miner = new Miner({ stateFile: join(home, 'mining.json'), pidFile: join(home, 'miner.pid'), spawn: () => ({ pid: 1, exitCode: null, kill: () => true, on() { return this } }), xmrig: 'xmrig' })
  const monitor = new HealthMonitor({ miner })
  monitor.check = async () => { checks++; writeHealth('ok'); return JSON.parse(readFileSync(join(home, 'health.json'), 'utf8')) }
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) }, health: () => monitor, hashference: { fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch } }).connect(a)
  client = new Client({ name: 't', version: '0' })
  await client.connect(b)
})
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as R

describe('health_status', () => {
  it('shows severity, drivers, every area and the exact directive the gateway adds', async () => {
    writeHealth('critical')
    const r = await call('health_status')
    const t = r.content[0]!.text
    expect(t).toMatch(/^Health: CRITICAL \(driven by money\)/)
    for (const a of AREAS) expect(t).toContain(`${a} [`)
    expect(t).toContain('Directive added to every model call:\nSurvival mode: money: runway 2.0 days')
    expect(t).toContain('conserving')
    expect(checks).toBe(0) // a fresh health.json is read, not re-measured
  })

  it('measures when there is no fresh health.json, or on refresh', async () => {
    await call('health_status')
    expect(checks).toBe(1)
    await call('health_status', { refresh: true })
    expect(checks).toBe(2)
  })

  it('drafts a bug report from open issues, leaving out anything secret-shaped', async () => {
    writeHealth('ok')
    await call('report_issue', { title: 'board_post fails with a url', details: 'board_post returns 500 whenever url is set' })
    expect((await call('report_issue', { title: 'leak', details: 'key 0x' + 'ab'.repeat(32) })).isError).toBe(true)
    const t = (await call('health_status', { bugReport: true })).content[0]!.text
    expect(t).toContain('Draft for board_post (community "bugs"')
    expect(t).toContain('board_post fails with a url')
    expect(t).not.toContain('abab')
  })
})

describe('earning pipeline tools', () => {
  it('adds, updates and lists opportunities', async () => {
    const add = (await call('earning_add', { what: 'Translate the Quai docs to Spanish', amountUsd: 40, counterparty: '0xabc', status: 'offered' })).content[0]!.text
    const id = /Added (\w+):/.exec(add)![1]!
    expect((await call('earning_update', { id, status: 'agreed' })).content[0]!.text).toContain('is now agreed ($40)')
    expect((await call('earning_update')).content[0]!.text).toContain(`${id} [agreed] Translate the Quai docs to Spanish $40 with 0xabc`)
    expect((await call('earning_update', { id: 'nope', status: 'paid' })).isError).toBe(true)
  })
})

describe('mining tool', () => {
  it('is a strategy switch the gremlin owns', async () => {
    expect((await call('mining', { enabled: true, reason: 'idle CPU' })).content[0]!.text).toContain('Mining')
    expect(JSON.parse(readFileSync(join(home, 'mining.json'), 'utf8'))).toMatchObject({ strategy: true, reason: 'idle CPU' })
    expect((await call('mining', { enabled: false })).content[0]!.text).toContain('is off')
    expect(JSON.parse(readFileSync(join(home, 'mining.json'), 'utf8'))).toMatchObject({ strategy: false, auto: false })
  })
})

describe('spending at critical health', () => {
  const token = 'ss_t_' + 'a'.repeat(27)

  it('needs a reason for non-survival spending, and logs it', async () => {
    writeHealth('critical')
    const r = await call('move_out', { host: 'sporestack', sporestackToken: token })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('needs a reason')
    expect(existsSync(join(home, 'moveout-request.json'))).toBe(false)
    expect((await call('move_out', { host: 'sporestack', sporestackToken: token, reason: 'cheaper host: halves my hosting bill' })).isError).toBeFalsy()
    expect(readFileSync(join(home, 'health-actions.jsonl'), 'utf8')).toContain('"reason":"cheaper host: halves my hosting bill"')
  })

  it('never blocks survival: inference up to the monitor\'s target, or moving to a fixed image', async () => {
    writeHealth('critical')
    writeFileSync(join(home, 'hashference.json'), JSON.stringify({ apiKey: 'hf_k', address: '0x00', createdAt: '' }))
    // $5 fits the target ($7 - $2): allowed (fails later only because the fake Hashference is down).
    const within = await call('hashference_topup', { usd: 5 })
    expect(within.content[0]!.text).not.toContain('needs a reason')
    const beyond = await call('hashference_topup', { usd: 50 })
    expect(beyond.content[0]!.text).toContain('needs a reason')
    expect((await call('move_out', { host: 'sporestack', sporestackToken: token, image: 'ghcr.io/x/egg@sha256:' + 'c'.repeat(64) })).isError).toBeFalsy()
    expect((await call('wallet_send', { asset: 'quai:quai', to: '0x0000000000000000000000000000000000000001', amount: '1' })).content[0]!.text).toContain('needs a reason')
  })

  it('asks nothing when health is not critical', async () => {
    writeHealth('ok')
    expect((await call('move_out', { host: 'sporestack', sporestackToken: token })).isError).toBeFalsy()
  })
})
