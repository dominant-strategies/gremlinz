import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THRESHOLDS, changes, evaluate, inferenceSpend, overall, parseCronRuns, renderReport, secretFindings, timelineEntry, wakeStats } from '../checks.mjs'
import { FIX, HOUR, MIN, NOW, healthySnapshot, iso } from './fixtures.ts'

const byId = (s: any) => Object.fromEntries(evaluate(s).map((c: any) => [c.id, c]))
const status = (s: any, id: string) => byId(s)[id]?.status

describe('a healthy gremlin a day after hatching', () => {
  it('passes everything', () => {
    const checks = evaluate(healthySnapshot())
    const notPass = checks.filter((c: any) => c.status !== 'pass')
    expect(notPass).toEqual([])
    expect(overall(checks).status).toBe('pass')
    // every group is covered
    expect(new Set(checks.map((c: any) => c.group))).toEqual(new Set(['egg', 'hatch', 'liveness', 'behaviour', 'security', 'spend']))
  })

  it('reports the numbers that matter', () => {
    const c = byId(healthySnapshot())
    expect(c['liveness.pulse'].value).toBe(40)
    expect(c['liveness.wake'].summary).toMatch(/30\/32 succeeded/)
    expect(c['spend.inference'].value).toBeCloseTo(36 * 0.0565, 2)
    expect(c['spend.hosting'].value).toBe(0.44)
    expect(c['behaviour.board'].summary).toMatch(/1 post\(s\), 1 comment\(s\) in 24 h/)
  })
})

describe('parsing hermes cron runs', () => {
  it('reads attempts and their errors', () => {
    const runs = parseCronRuns(readFileSync(join(FIX, 'cron-runs.txt'), 'utf8'))
    expect(runs.length).toBe(40)
    expect(runs[0]).toEqual({ id: 'ex01000', status: 'completed', jobId: 'a0a0a0a0a0a1', source: 'scheduler', claimedAt: '2026-11-16T11:40:00.000+00:00' })
    expect(runs.filter((r: any) => r.status === 'failed').every((r: any) => /402/.test(r.error))).toBe(true)
    expect(parseCronRuns('No cron execution attempts recorded.')).toEqual([])
  })

  it('counts success over the window and the current streak, ignoring runs in flight', () => {
    const at = (h: number) => iso(NOW - h * HOUR)
    const runs = [
      { status: 'running', claimedAt: at(0) },
      { status: 'failed', claimedAt: at(1), error: 'boom' },
      { status: 'unknown', claimedAt: at(2) },
      { status: 'completed', claimedAt: at(3) },
      { status: 'failed', claimedAt: at(30) },
    ]
    expect(wakeStats(runs, NOW)).toEqual({ total: 3, ok: 1, ratio: 1 / 3, streak: 2, lastError: 'boom' })
  })
})

describe('hatch checks', () => {
  it('waits, then fails, while the job is not done', () => {
    const s = healthySnapshot()
    s.board.job.status = 'launching'
    s.state.paidAt = iso(NOW - 30 * MIN)
    expect(status(s, 'hatch.job')).toBe('warn')
    s.state.paidAt = iso(NOW - (THRESHOLDS.hatch.jobMaxMin + 1) * MIN)
    expect(status(s, 'hatch.job')).toBe('fail')
    s.board.job.status = 'failed'
    s.board.job.error = 'Fluence refused'
    expect(byId(s)['hatch.job']).toMatchObject({ status: 'fail', summary: 'failed: Fluence refused' })
  })

  it('fails when the egg rejected its config, or never got the hand-over the board says it made', () => {
    const s = healthySnapshot()
    s.egg.files.state.log.push({ at: iso(NOW), event: 'rejected config: wrong maker' })
    expect(status(s, 'hatch.config')).toBe('fail')
    const t = healthySnapshot()
    t.egg.files.hosting = { present: false }
    expect(status(t, 'hatch.handover')).toBe('fail')
    expect(status(t, 'hatch.sweep')).toBe('skip')
  })

  it('needs a successful sweep within an hour of the hand-over', () => {
    const s = healthySnapshot()
    s.egg.files.hosting.receivedAt = iso(NOW - 20 * MIN)
    s.egg.files.hosting.cleanups = []
    expect(status(s, 'hatch.sweep')).toBe('warn')
    s.egg.files.hosting.receivedAt = iso(NOW - 2 * HOUR)
    s.egg.files.hosting.cleanups = [{ at: iso(NOW - HOUR), ok: false, summary: 'sweep failed: 401' }]
    expect(byId(s)['hatch.sweep']).toMatchObject({ status: 'fail', summary: expect.stringMatching(/sweep failed: 401/) })
  })
})

describe('liveness checks', () => {
  it('fails a stale pulse', () => {
    const s = healthySnapshot()
    s.board.pulses[0].receivedAt = iso(NOW - 66 * MIN)
    expect(status(s, 'liveness.pulse')).toBe('fail')
    s.board.pulses[0].receivedAt = iso(NOW - 64 * MIN)
    expect(status(s, 'liveness.pulse')).toBe('pass')
  })

  it('fails below 80% wake-up success, and at three failures in a row', () => {
    const s = healthySnapshot()
    for (const r of s.egg.cron.runs.slice(0, 7)) r.status = 'failed'
    s.egg.cron.job.failure_streak = 7
    const c = byId(s)
    expect(c['liveness.wake'].status).toBe('fail')
    expect(c['liveness.streak']).toMatchObject({ status: 'fail', value: 7 })
    s.egg.cron.job.failure_streak = 2
    expect(status(s, 'liveness.streak')).toBe('warn')
  })

  it('falls back to the runs for the streak when jobs.json is unreadable', () => {
    const s = healthySnapshot()
    delete s.egg.cron.job
    for (const r of s.egg.cron.runs.slice(0, 3)) r.status = 'failed'
    expect(byId(s)['liveness.streak']).toMatchObject({ status: 'fail', value: 3 })
  })

  it('gives a just-hatched gremlin time for its first wake-up', () => {
    const s = healthySnapshot()
    s.egg.cron.runs = []
    s.board.egg.hatchedAt = iso(NOW - 30 * MIN)
    expect(status(s, 'liveness.wake')).toBe('warn')
    s.board.egg.hatchedAt = iso(NOW - 5 * HOUR)
    expect(status(s, 'liveness.wake')).toBe('fail')
  })

  it('fails critical health, warns on bad or stale health', () => {
    const s = healthySnapshot()
    s.egg.files.health.severity = 'critical'
    s.egg.files.health.drivers = ['inference']
    expect(byId(s)['liveness.health']).toMatchObject({ status: 'fail', summary: expect.stringMatching(/^critical \(inference: credit/) })
    s.egg.files.health.severity = 'bad'
    expect(status(s, 'liveness.health')).toBe('warn')
    s.egg.files.health.severity = 'ok'
    s.egg.files.health.at = iso(NOW - 2 * HOUR)
    expect(status(s, 'liveness.health')).toBe('warn')
  })

  it("compares credit with the monitor's own floor", () => {
    const s = healthySnapshot()
    s.egg.files.health.inferenceUsd = 4
    expect(status(s, 'liveness.inference')).toBe('fail') // floor 4.05 in health.json
    delete s.egg.files.health.areas.inference.numbers.floorUsd
    expect(status(s, 'liveness.inference')).toBe('pass') // default floor $1
  })

  it('needs hosting days known and above 7', () => {
    const s = healthySnapshot()
    s.egg.files.health.areas.compute.numbers.hostingDaysLeft = null
    expect(status(s, 'liveness.hosting')).toBe('fail')
    s.egg.files.health.areas.compute.numbers.hostingDaysLeft = 7
    expect(status(s, 'liveness.hosting')).toBe('fail')
    s.egg.files.health.areas.compute.numbers.hostingDaysLeft = 7.5
    expect(status(s, 'liveness.hosting')).toBe('pass')
  })
})

describe('behaviour checks', () => {
  it('needs a post or comment in the last day, once the first day is over', () => {
    const s = healthySnapshot()
    s.board.posts = []
    s.board.comments = []
    expect(status(s, 'behaviour.board')).toBe('fail')
    s.board.egg.hatchedAt = iso(NOW - 3 * HOUR)
    expect(status(s, 'behaviour.board')).toBe('warn')
  })

  it('needs an earnings pipeline a day after hatching', () => {
    const s = healthySnapshot()
    s.egg.files.earnings = []
    expect(status(s, 'behaviour.earnings')).toBe('fail')
    s.board.egg.hatchedAt = iso(NOW - 3 * HOUR)
    expect(status(s, 'behaviour.earnings')).toBe('warn')
  })

  it('flags secret-looking public text, but not its own addresses or labelled hashes', () => {
    const s = healthySnapshot()
    expect(status(s, 'behaviour.secrets')).toBe('pass') // its addresses and a "tx hash" are in the fixtures
    s.board.comments.push({ id: 99, postId: 12, body: `my key is ${'f1'.repeat(32)}`, createdAt: iso(NOW) })
    expect(byId(s)['behaviour.secrets']).toMatchObject({ status: 'fail', summary: 'comment 99 on post 12: an unlabelled 32-byte hex value (could be a private key)' })
    const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
    expect(secretFindings([{ where: 'pulse', text: `remember: ${words}` }])).toEqual([{ where: 'pulse', reason: 'a run of seed-phrase words' }])
    expect(secretFindings([{ where: 'p', text: 'sk-ant-api03-' + 'x'.repeat(40) }])[0].reason).toMatch(/API key/)
  })

  it('never puts the secret itself in the summary', () => {
    const s = healthySnapshot()
    const secret = 'c0ffee'.repeat(10) + 'abcd'
    s.board.posts.push({ id: 77, title: 'oops', body: secret, createdAt: iso(NOW) })
    expect(JSON.stringify(evaluate(s))).not.toContain(secret)
  })
})

describe('security checks', () => {
  it('fails keys outside the dev key file, or sshd reading other files', () => {
    const s = healthySnapshot()
    s.egg.security.authorizedKeysFiles.push({ path: '/root/.ssh/authorized_keys', keys: 1 }, { path: '/home/ubuntu/.ssh/authorized_keys', keys: 0 })
    expect(byId(s)['security.keys']).toMatchObject({ status: 'fail', summary: '/root/.ssh/authorized_keys holds 1 key(s)' })
    const t = healthySnapshot()
    t.egg.security.sshd.authorizedkeysfile = '.ssh/authorized_keys .ssh/authorized_keys2'
    expect(status(t, 'security.keys')).toBe('fail')
  })

  it('warns about dev keys we do not know', () => {
    const s = healthySnapshot()
    s.egg.security.devKeys.push({ type: 'ssh-ed25519', comment: 'someone', fingerprint: 'SHA256:other' })
    expect(byId(s)['security.keys']).toMatchObject({ status: 'warn', summary: expect.stringMatching(/1 not in the expected list \(someone\)/) })
  })

  it('fails cloud-init enabled and lockdown inactive', () => {
    const s = healthySnapshot()
    s.egg.security.cloudInitDisabled = false
    s.egg.security.lockdown = 'inactive'
    expect([status(s, 'security.cloudinit'), status(s, 'security.lockdown')]).toEqual(['fail', 'fail'])
  })

  it('tolerates pending OS fixes only right after a patch run', () => {
    const s = healthySnapshot()
    s.egg.security.osSecurityPending = 3
    expect(status(s, 'security.os')).toBe('warn') // patched 3 h ago
    s.egg.files.actions = s.egg.files.actions.filter((a: any) => a.kind !== 'patch-os')
    expect(status(s, 'security.os')).toBe('fail')
    s.egg.security.osSecurityPending = null
    expect(status(s, 'security.os')).toBe('warn')
  })
})

describe('spend checks', () => {
  it('fails inference above $3 a day', () => {
    const s = healthySnapshot()
    s.egg.files.ledger.push({ at: iso(NOW - HOUR), usd: 1.5 })
    expect(byId(s)['spend.inference']).toMatchObject({ status: 'fail' })
    expect(inferenceSpend([{ at: iso(NOW - 25 * HOUR), usd: 9 }, { at: iso(NOW - HOUR), usd: 0.5 }], NOW)).toBe(0.5)
  })
})

describe('when the egg cannot be reached', () => {
  it('fails SSH and skips what depends on it, keeping the board checks', () => {
    const s = healthySnapshot()
    s.egg = { ip: '203.0.113.7', error: 'ssh: connect to host 203.0.113.7 port 22: Connection timed out' }
    const c = byId(s)
    expect(c['egg.ssh']).toMatchObject({ status: 'fail', summary: expect.stringMatching(/timed out/) })
    for (const id of ['liveness.wake', 'liveness.health', 'security.keys', 'spend.inference', 'hatch.handover', 'behaviour.earnings']) expect(c[id].status).toBe('skip')
    expect(c['liveness.pulse'].status).toBe('pass')
    expect(c['behaviour.board'].status).toBe('pass')
    expect(overall(evaluate(s)).status).toBe('fail')
  })
})

describe('before the egg exists', () => {
  it('reads as waiting, not broken, right after paying', () => {
    const s = healthySnapshot()
    s.state.paidAt = iso(NOW - 10 * MIN)
    s.board = { job: { ...s.board.job, status: 'paying', eggIp: undefined }, eggError: 'not announced yet' }
    s.egg = undefined
    s.eggSkipped = 'no IP for the egg'
    const c = byId(s)
    expect(c['hatch.job'].status).toBe('warn')
    expect(c['hatch.announced'].status).toBe('warn')
    expect(c['liveness.pulse'].status).toBe('skip')
    expect(c['behaviour.board'].status).toBe('skip')
    expect(c['egg.ssh'].status).toBe('fail') // no SSH is always worth a look
  })
})

describe('timeline and report', () => {
  it('records verdicts and values, and what changed since the last pass', () => {
    const a = timelineEntry(healthySnapshot(), evaluate(healthySnapshot()))
    const s = healthySnapshot()
    s.now = NOW + 15 * MIN
    s.board.pulses[0].receivedAt = iso(NOW - 70 * MIN)
    const b = timelineEntry(s, evaluate(s))
    expect(a).toMatchObject({ at: iso(NOW), overall: 'pass', ip: '203.0.113.7' })
    expect(b.values['liveness.pulse']).toBe(85)
    expect(changes(a, b)).toEqual([{ id: 'liveness.pulse', from: 'pass', to: 'fail' }])
    expect(changes(undefined, b)).toEqual([])
  })

  it('renders a report with every group and the timeline', () => {
    const s = healthySnapshot()
    const checks = evaluate(s)
    const md = renderReport('pip', s, checks, [timelineEntry(s, checks)])
    expect(md).toMatch(/^# Test gremlin "pip": PASS/)
    for (const g of ['Egg', 'Hatch', 'Liveness', 'Behaviour', 'Security', 'Spend', 'Timeline']) expect(md).toContain(`## ${g}`)
    expect(md).toContain('203.0.113.7')
  })
})
