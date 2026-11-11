import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { HealthMonitor, type HealthFile, type MonitorDeps } from '../src/health/monitor.js'
import { Miner, POOL, type ChildLike } from '../src/health/miner.js'
import { HEALTH } from '../src/health/policy.js'
import { createGateway } from '../src/gateway/server.js'
import { GatewayConfig } from '../src/gateway/config.js'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const H = 3_600_000

/** A fake Hashference account: balance in credits, QUAI invoices that are paid once our payer is called. */
function fakeHashference(startUsd: number) {
  const s = { credits: startUsd * 1000, invoices: 0, paidWei: [] as bigint[] }
  const pending = new Map<string, number>()
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    if (u.pathname === '/v1/account') return json(200, { account: { miningUsername: 'gremlin-abc', balance: { availableCredits: s.credits, reservedCredits: 0, pendingCredits: 0 } } })
    if (u.pathname === '/v1/payments' && init.method === 'POST') {
      const b = JSON.parse(String(init.body)) as { creditMicrousd: number }
      const id = `inv${++s.invoices}`
      pending.set(id, b.creditMicrousd / 1000)
      return json(201, { invoice: { id, status: 'awaiting_payment', amountAtomic: String(BigInt(b.creditMicrousd) * 10n ** 12n), addresses: ['0x00aa00000000000000000000000000000000aaaa'], expiresAt: new Date(Date.now() + 300_000).toISOString(), creditMicrousd: b.creditMicrousd } })
    }
    const m = /^\/v1\/payments\/(inv\d+)$/.exec(u.pathname)
    if (m) return json(200, { invoice: { id: m[1], status: pending.has(m[1]!) ? 'awaiting_payment' : 'paid', amountAtomic: '1', addresses: ['x'], expiresAt: 'x', creditMicrousd: 1 } })
    return json(404, {})
  }) as typeof fetch
  // Paying credits the newest invoice.
  const pay = async (_to: string, wei: bigint) => {
    s.paidWei.push(wei)
    const [id, credits] = [...pending].at(-1)!
    pending.delete(id)
    s.credits += credits
    return '0xtx'
  }
  return { s, f, pay }
}

function fakeSpawner() {
  const spawned: { cmd: string; args: string[]; child: ChildLike & { killed?: string } }[] = []
  const spawn = (cmd: string, args: string[]) => {
    const handlers: ((c: number | null) => void)[] = []
    const child = {
      pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: undefined as string | undefined,
      kill(sig?: NodeJS.Signals) { this.killed = sig; this.signalCode = sig ?? 'SIGTERM'; for (const h of handlers) h(null); return true },
      on(_ev: 'exit', f: (c: number | null) => void) { handlers.push(f); return this },
    }
    spawned.push({ cmd, args, child })
    return child
  }
  return { spawned, spawn }
}

interface Setup { hfUsd?: number; walletUsd?: number; jobs?: unknown; now?: () => number }

function setup(o: Setup = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  process.env.GREMLIN_HOME = home
  const hermes = join(home, 'hermes')
  mkdirSync(join(hermes, 'cron'), { recursive: true })
  if (o.jobs) writeFileSync(join(hermes, 'cron', 'jobs.json'), JSON.stringify(o.jobs))
  writeFileSync(join(home, 'hashference.json'), JSON.stringify({ apiKey: 'hf_k', address: '0x00a1b2c3d4000000000000000000000000000000', createdAt: '' }))
  const hf = fakeHashference(o.hfUsd ?? 0)
  const wallet = { totalUsd: o.walletUsd ?? 100, quaiUsd: o.walletUsd ?? 100, byAsset: { 'quai:quai': o.walletUsd ?? 100 }, errors: [] as string[] }
  const resets: (string | undefined)[] = []
  const reruns: number[] = []
  const sp = fakeSpawner()
  const miner = new Miner({ stateFile: join(home, 'mining.json'), pidFile: join(home, 'miner.pid'), spawn: sp.spawn, xmrig: 'xmrig', cores: () => 8, memBytes: () => 2 * 2 ** 30, fetch: (async () => json(200, { hashrate: { total: [812.5] } })) as typeof fetch })
  const deps: MonitorDeps = {
    now: o.now, hermesHome: hermes,
    hashference: { fetch: hf.f, pay: hf.pay, sleep: async () => {} },
    wallet: async () => wallet,
    hosting: async () => ({ provider: 'fluence', balanceUsd: 30, hourlyUsd: 0.05, daysLeft: 25 }),
    security: async () => ({ at: Date.now(), report: '', cached: true, summary: { osSecurityPending: 0, missing: [], runtimeMissing: [] } }),
    resources: () => ({ diskFreeFrac: 0.6, memFreeFrac: 0.5, load1: 0.1, cores: 8, uptimeSec: 3600 }),
    resetCooldown: async (p) => { resets.push(p); return true },
    rerunWake: async () => { reruns.push(Date.now()) },
    miner,
  }
  return { home, hermes, hf, wallet, resets, reruns, sp, miner, monitor: new HealthMonitor(deps) }
}

const health = (home: string) => JSON.parse(readFileSync(join(home, 'health.json'), 'utf8')) as HealthFile
const status = (home: string) => JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')) as { tier: string }

describe('health monitor', () => {
  beforeEach(() => { delete process.env.GREMLIN_HOME })

  it('first run after hatching: prepays the initial inference target from the funded wallet', async () => {
    const t = setup({ hfUsd: 0, walletUsd: 60 })
    const h = await t.monitor.check()
    expect(t.hf.s.paidWei).toEqual([BigInt(HEALTH.inference.firstRunTargetUsd * 1_000_000) * 10n ** 12n])
    expect(h.lastTopUp).toMatchObject({ usd: 3, status: 'paid' })
    expect(h.areas.inference.did[0]).toContain('first run: prepay inference')
    expect(t.resets).toEqual(['hashference']) // a 402 cooldown would otherwise waste the new credit
    expect(h.status).toBe('ok')
    const actions = readFileSync(join(t.home, 'health-actions.jsonl'), 'utf8')
    expect(actions).toContain('"kind":"topup"')
    // The second check finds the credit and does nothing more.
    await t.monitor.check()
    expect(t.hf.s.paidWei).toHaveLength(1)
  })

  it('writes health.json with every area, and the board tier', async () => {
    const t = setup({ hfUsd: 10, walletUsd: 500 })
    const h = await t.monitor.check()
    expect(Object.keys(h.areas).sort()).toEqual(['bugs', 'compute', 'earnings', 'inference', 'money', 'updates'])
    expect(health(t.home)).toMatchObject({ status: 'ok', inferenceUsd: 10, burnUsdPerDay: 0.5, inferenceRunwayDays: 20, walletUsd: 500 })
    expect(h.areas.compute.numbers).toMatchObject({ hostingDaysLeft: 25, hostingUsdPerDay: 1.2 })
    expect(h.areas.money.numbers).toMatchObject({ runwayDays: 317.65, burnUsdPerDay: 1.7 })
    expect(h.severity).toBe('ok')
    expect(h.directive).toBeUndefined()
    expect(status(t.home).tier).toBe('normal')
  })

  it('a wake-up that failed for lack of inference: top up, clear the cooldown, re-run it', async () => {
    const jobs = { jobs: [{ id: 'a0a0a0a0a0a1', last_status: 'error', last_run_at: '2026-11-10T10:00:00Z', next_run_at: '2026-11-10T12:00:00Z', failure_streak: 4, last_error: 'HTTP 503 all_providers_failed: hashference: 402 | venice: 402' }] }
    const t = setup({ hfUsd: 0.4, walletUsd: 100, jobs, now: () => Date.parse('2026-11-10T11:00:00Z') })
    writeFileSync(join(t.home, 'health-actions.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', kind: 'topup', ok: true, usd: 3 }) + '\n') // not a first run
    const h = await t.monitor.check()
    expect(t.hf.s.paidWei).toHaveLength(1)
    expect(t.resets).toEqual(['hashference'])
    expect(t.reruns).toHaveLength(1) // the retry ladder is spent (next run in an hour): ask Hermes now
    expect(h.lastWakeFailure).toMatchObject({ forInference: true })
    await t.monitor.check()
    expect(t.reruns).toHaveLength(1) // once per failed run
  })

  it('leaves the re-run to Hermes when its retry is due soon', async () => {
    const jobs = { jobs: [{ id: 'a0a0a0a0a0a1', last_status: 'error', last_run_at: '2026-11-10T10:55:00Z', next_run_at: '2026-11-10T11:05:00Z', failure_streak: 1, last_error: 'every provider for "gremlin-auto" failed: hashference: cooling down' }] }
    const t = setup({ hfUsd: 5, walletUsd: 100, jobs, now: () => Date.parse('2026-11-10T11:00:00Z') })
    writeFileSync(join(t.home, 'health-actions.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', kind: 'topup', ok: true, usd: 3 }) + '\n')
    const h = await t.monitor.check()
    // Credit was there all along: the provider was only benched. Clear every cooldown; no purchase.
    expect(t.hf.s.paidWei).toEqual([])
    expect(t.resets).toEqual([undefined])
    expect(t.reruns).toEqual([])
    expect(h.areas.inference.did.join(' ')).toContain("left the re-run to Hermes' retry")
  })

  it('starved: mining starts only after 6 hours, and stops once credit is back above the floor', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z')
    const t = setup({ hfUsd: 0, walletUsd: 4, now: () => now }) // $4 is under the $10 hosting reserve: no top-up possible
    writeFileSync(join(t.home, 'health-actions.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', kind: 'topup', ok: true, usd: 3 }) + '\n')
    let h = await t.monitor.check()
    expect(h.status).toBe('starved')
    expect(h.severity).toBe('critical')
    expect(status(t.home).tier).toBe('critical')
    expect(t.sp.spawned).toEqual([])
    now += 5 * H
    await t.monitor.check()
    expect(t.sp.spawned).toEqual([])
    now += 1 * H
    h = await t.monitor.check()
    expect(t.sp.spawned).toHaveLength(1)
    const { cmd, args } = t.sp.spawned[0]!
    expect([cmd, ...args.slice(0, 7)]).toEqual(['sudo', '-n', '-u', 'gremlin-helper', 'nice', '-n', '19', 'xmrig'])
    expect(args).toEqual(expect.arrayContaining(['-o', POOL, '-u', 'gremlin-abc.00a1b2c3', '-p', 'x', '-t', '4', '--randomx-mode=light']))
    expect(h.mining).toMatchObject({ on: true, auto: true, hashrate: 812.5 })
    expect(h.directive).toMatch(/^Survival mode: inference: starved/)
    // Credit comes back (mined, or someone paid): the monitor stops the miner it started.
    t.hf.s.credits = 5000
    now += H
    h = await t.monitor.check()
    expect(t.sp.spawned[0]!.child.killed).toBe('SIGTERM')
    expect(h.mining).toMatchObject({ on: false, auto: false })
    expect(h.starvedSince).toBeUndefined()
  })

  it('keeps mining the gremlin chose as strategy when credit recovers', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z')
    const t = setup({ hfUsd: 0, walletUsd: 4, now: () => now })
    writeFileSync(join(t.home, 'health-actions.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00Z', kind: 'topup', ok: true, usd: 3 }) + '\n')
    t.miner.enable('strategy', 'cheap power here')
    await t.monitor.check()
    expect(t.sp.spawned).toHaveLength(1)
    t.hf.s.credits = 5000
    now += H
    await t.monitor.check()
    expect(t.sp.spawned[0]!.child.killed).toBeUndefined()
    t.miner.disable('strategy', 'enough')
    expect(t.sp.spawned[0]!.child.killed).toBe('SIGTERM')
  })

  it('applies pending OS security updates by itself', async () => {
    const t = setup({ hfUsd: 10 })
    let patched = 0
    const m = new HealthMonitor({
      ...(t.monitor as unknown as { d: MonitorDeps }).d,
      security: async () => ({ at: Date.now(), report: '', cached: false, summary: { osSecurityPending: 3, missing: [], runtimeMissing: [] } }),
      patchOs: async () => { patched++; return '3 upgraded, 0 newly installed' },
    })
    const h = await m.check()
    expect(patched).toBe(1)
    expect(h.areas.updates.did[0]).toContain('3 upgraded')
    expect(existsSync(join(t.home, 'health-state.json'))).toBe(true)
    await m.check()
    expect(patched).toBe(1) // not again within 6 hours
  })
})

describe('gateway cooldown reset after a top-up', () => {
  it('a provider benched for wanting payment is tried again at once after the reset', async () => {
    let paid = false
    const up: Server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (!paid) { res.statusCode = 402; return res.end('{"error":"insufficient credit"}') }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'thinking again' } }] }))
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const gw = createGateway(GatewayConfig.parse({
      providers: [{ id: 'hashference', kind: 'openai', baseUrl: `http://127.0.0.1:${(up.address() as { port: number }).port}/v1` }],
      routes: { 'gremlin-main': [{ provider: 'hashference', model: 'm' }] }, glean: { enabled: false },
    }))
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
    const chat = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content: 'hi' }] }) })
    try {
      expect((await chat()).status).toBe(503)
      paid = true
      expect((await chat()).status).toBe(503) // still benched for 30 minutes
      const { defaultResetCooldown } = await import('../src/health/monitor.js')
      expect(await defaultResetCooldown(base)('hashference')).toBe(true)
      const r = await chat()
      expect(r.status).toBe(200)
      expect((await r.json()).choices[0].message.content).toBe('thinking again')
    } finally { gw.close(); up.close() }
  })
})
