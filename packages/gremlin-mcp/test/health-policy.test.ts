import { describe, expect, it } from 'vitest'
import {
  HEALTH, bugsArea, computeArea, conserveFor, directive, earningsArea, inferenceArea, moneyArea, planTopUp, severity, tierFor, updatesArea,
  type Area, type Areas, type InferenceInput,
} from '../src/health/policy.js'

const inf = (o: Partial<InferenceInput> = {}): InferenceInput => ({
  hashferenceUsd: 5, veniceUsd: 0, measuredBurnUsdPerDay: 1, walletUsd: 200, quaiUsd: 200, toppedUpLast24hUsd: 0, everToppedUp: true, wakeFailedForInference: false, ...o,
})
const ok = (headline = 'fine'): Area => ({ level: 'ok', headline, numbers: {}, did: [], next: [] })
const areas = (o: Partial<Areas> = {}): Areas => ({ compute: ok(), inference: ok(), money: ok(), earnings: ok(), updates: ok(), bugs: ok(), ...o })

describe('inference top-up policy', () => {
  it('does nothing while credit is at or above the floor (max $1, 3 days of burn)', () => {
    const p = planTopUp(inf({ hashferenceUsd: 3, measuredBurnUsdPerDay: 1 }))
    expect(p).toMatchObject({ floorUsd: 3, targetUsd: 7, usd: 0 })
  })

  it('below the floor, tops up to 7 days of burn', () => {
    expect(planTopUp(inf({ hashferenceUsd: 2, measuredBurnUsdPerDay: 1 }))).toMatchObject({ usd: 5, targetUsd: 7 })
  })

  it('assumes $0.50/day before there is history, and the floor never drops below $1', () => {
    const p = planTopUp(inf({ hashferenceUsd: 0.5, measuredBurnUsdPerDay: 0 }))
    expect(p).toMatchObject({ burnUsdPerDay: 0.5, floorUsd: 1.5, targetUsd: 3.5, usd: 3 })
    expect(planTopUp(inf({ hashferenceUsd: 0.5, measuredBurnUsdPerDay: 0.1 })).floorUsd).toBe(1.5)
    expect(Math.max(HEALTH.inference.floorMinUsd, 3 * 0.1)).toBe(1)
  })

  it('counts Venice credit as inference already held (treasury rule: convert only what is needed)', () => {
    expect(planTopUp(inf({ hashferenceUsd: 0, veniceUsd: 6, measuredBurnUsdPerDay: 1 })).usd).toBe(0)
  })

  it('caps by $20 of top-ups a day', () => {
    expect(planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 10 })).usd).toBe(20)
    expect(planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 10, toppedUpLast24hUsd: 15 })).usd).toBe(5)
    expect(planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 10, toppedUpLast24hUsd: 19.5 }))).toMatchObject({ usd: 0, why: expect.stringContaining('$20/day') })
  })

  it('caps by 25% of the wallet, by the QUAI on hand, and keeps the $10 hosting reserve', () => {
    expect(planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 2, walletUsd: 40, quaiUsd: 40 })).usd).toBe(10) // 25% of 40
    expect(planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 2, walletUsd: 200, quaiUsd: 4 })).usd).toBe(3.8) // 95% of the QUAI
    const r = planTopUp(inf({ hashferenceUsd: 0, measuredBurnUsdPerDay: 2, walletUsd: 10.5, quaiUsd: 10.5 }))
    expect(r.usd).toBe(0) // 25% would be $2.62, but only $0.50 is above the reserve
    expect(r.why).toContain('hosting reserve')
  })

  it('never pays blind: an unreadable wallet means no top-up', () => {
    expect(planTopUp(inf({ hashferenceUsd: 0, walletUsd: undefined })).usd).toBe(0)
  })

  it('first run: a funded gremlin with no credit prepays the initial target at once', () => {
    const p = planTopUp(inf({ hashferenceUsd: 0, everToppedUp: false, measuredBurnUsdPerDay: 0, walletUsd: 50, quaiUsd: 50 }))
    expect(p).toMatchObject({ firstRun: true, targetUsd: HEALTH.inference.firstRunTargetUsd, usd: 3 })
    expect(planTopUp(inf({ hashferenceUsd: 0, everToppedUp: false, walletUsd: 0, quaiUsd: 0 }))).toMatchObject({ firstRun: true, usd: 0 })
  })

  it('a wake-up that failed for lack of inference triggers a top-up even at the floor edge', () => {
    expect(planTopUp(inf({ hashferenceUsd: 3, measuredBurnUsdPerDay: 1, wakeFailedForInference: true })).usd).toBe(4)
  })

  it('judges inference: ok, low, bad (wake failing, no top-up) and starved', () => {
    const i = inf({ hashferenceUsd: 2, measuredBurnUsdPerDay: 1 })
    expect(inferenceArea(i, planTopUp(i), { boughtUsd: 5, did: [] })).toMatchObject({ status: 'ok', level: 'ok' })
    expect(inferenceArea(i, planTopUp(i), { boughtUsd: 0, did: [] })).toMatchObject({ status: 'low', level: 'low' })
    const w = inf({ hashferenceUsd: 0.5, measuredBurnUsdPerDay: 1, wakeFailedForInference: true, walletUsd: 0, quaiUsd: 0 })
    expect(inferenceArea(w, planTopUp(w), { boughtUsd: 0, did: [] })).toMatchObject({ status: 'low', level: 'bad' })
    const s = inf({ hashferenceUsd: 0, walletUsd: 5, quaiUsd: 5 })
    expect(inferenceArea(s, planTopUp(s), { boughtUsd: 0, did: [] })).toMatchObject({ status: 'starved', level: 'critical', daysLeft: 0 })
  })
})

describe('area evaluations', () => {
  it('compute: hosting runway tiers, disk, restarts; unknown hosting is said, not alarmed', () => {
    const base = { cores: 2, restarts24h: 0, diskFreeFrac: 0.5, memFreeFrac: 0.5, load1: 0.2 }
    expect(computeArea({ ...base, hosting: { provider: 'fluence', daysLeft: 1.5, hourlyUsd: 0.05 } })).toMatchObject({ level: 'critical', daysLeft: 1.5 })
    expect(computeArea({ ...base, hosting: { provider: 'fluence', daysLeft: 5 } }).level).toBe('bad')
    const low = computeArea({ ...base, hosting: { provider: 'fluence', daysLeft: 10, hourlyUsd: 0.05 } })
    expect(low.level).toBe('low')
    expect(low.next[0]).toMatch(/Renew hosting within 10 days \(fluence, \$1\.20\/day\)/)
    expect(computeArea({ ...base, diskFreeFrac: 0.1 }).level).toBe('low')
    expect(computeArea({ ...base, diskFreeFrac: 0.03 }).level).toBe('bad')
    expect(computeArea({ ...base, restarts24h: 4 }).level).toBe('low')
    const unknown = computeArea(base)
    expect(unknown.level).toBe('ok')
    expect(unknown.headline).toContain('hosting runway unknown')
  })

  it('money: runway = (wallet + credits) / (inference + hosting burn), tiers at 30, 7 and 3 days', () => {
    const m = moneyArea({ walletUsd: 50, inferenceUsd: 10, inferenceBurnUsdPerDay: 1, hostingBalanceUsd: 0, hostingUsdPerDay: 1 })
    expect(m.numbers).toMatchObject({ runwayDays: 30, burnUsdPerDay: 2, hostingReserveUsd: 10 })
    expect(m.level).toBe('ok')
    expect(moneyArea({ walletUsd: 20, inferenceUsd: 0, inferenceBurnUsdPerDay: 1, hostingUsdPerDay: 1 }).level).toBe('low')
    expect(moneyArea({ walletUsd: 10, inferenceUsd: 0, inferenceBurnUsdPerDay: 1, hostingUsdPerDay: 1 }).level).toBe('bad')
    expect(moneyArea({ walletUsd: 4, inferenceUsd: 0, inferenceBurnUsdPerDay: 1, hostingUsdPerDay: 1 })).toMatchObject({ level: 'critical', daysLeft: 2 })
    expect(moneyArea({ inferenceUsd: 1, inferenceBurnUsdPerDay: 1 }).level).toBe('ok') // unknown
  })

  it('earnings: expected income from agreed and delivered work; low with an empty pipeline and a short runway', () => {
    const o = (status: 'idea' | 'agreed' | 'delivered' | 'paid', amountUsd: number) => ({ id: status, what: status, status, amountUsd, at: '', updatedAt: '' })
    const e = earningsArea({ opportunities: [o('idea', 100), o('agreed', 20), o('delivered', 10), o('paid', 50)], received7dUsd: 5, received30dUsd: 55, burnUsdPerDay: 2, runwayDays: 10 })
    expect(e).toMatchObject({ level: 'ok', numbers: { open: 3, expectedUsd: 30, expectedCoversDays: 15, received30dUsd: 55 } })
    expect(earningsArea({ opportunities: [o('paid', 5)], received7dUsd: 0, received30dUsd: 5, burnUsdPerDay: 2, runwayDays: 10 }).level).toBe('low')
    expect(earningsArea({ opportunities: [], received7dUsd: 0, received30dUsd: 0, burnUsdPerDay: 2, runwayDays: 60 }).level).toBe('ok')
  })

  it('updates: a high hole is critical with runway to move, bad without; OS fixes pending are low', () => {
    const hole = { osSecurityPending: 0, missing: [{ id: 'CVE-1', severity: 'high' as const }], moveTo: { tag: 'v9', image: 'r@sha256:' + 'a'.repeat(64) }, runtimeMissing: [] }
    const c = updatesArea({ ...hole, runwayDays: 30 })
    expect(c.level).toBe('critical')
    expect(c.next[0]).toContain('move_out with image r@sha256:')
    expect(updatesArea({ ...hole, runwayDays: 3 }).level).toBe('bad')
    expect(updatesArea({ osSecurityPending: 2, missing: [], runtimeMissing: [] }).level).toBe('low')
    const patched = updatesArea({ osSecurityPending: 2, missing: [], runtimeMissing: [], patchedOs: '2 upgraded' })
    expect(patched.did[0]).toContain('security_patch_os')
    expect(patched.next).toEqual([])
  })

  it('bugs: recurring issues and failing providers are low; wake-ups failing for other reasons are bad', () => {
    const issue = { sig: 'a', source: 'cron', title: 't', sample: 's', firstSeen: '', lastSeen: '', count: 3 }
    expect(bugsArea({ issues: [issue], wake: { failureStreak: 0, forInference: false }, providers: [] }).level).toBe('low')
    expect(bugsArea({ issues: [], wake: { failureStreak: 0, forInference: false }, providers: [{ provider: 'venice', calls: 20, errorRate: 0.6 }] }).level).toBe('low')
    expect(bugsArea({ issues: [], wake: { failureStreak: 3, lastError: 'boom', forInference: false }, providers: [] }).level).toBe('bad')
    expect(bugsArea({ issues: [], wake: { failureStreak: 3, forInference: true }, providers: [] }).level).toBe('ok') // inference's problem, not a bug
  })
})

describe('severity and the directive', () => {
  const money = moneyArea({ walletUsd: 4, inferenceUsd: 0, inferenceBurnUsdPerDay: 1, hostingUsdPerDay: 1 })

  it('overall severity is the worst area; the drivers are the areas at that level', () => {
    expect(severity(areas())).toEqual({ severity: 'ok', drivers: [] })
    const low = { ...ok(), level: 'low' as const }
    expect(severity(areas({ bugs: low, money }))).toEqual({ severity: 'critical', drivers: ['money'] })
    expect(severity(areas({ bugs: low, earnings: low }))).toEqual({ severity: 'low', drivers: ['earnings', 'bugs'] })
  })

  it('says nothing when all is well', () => {
    expect(directive(areas())).toBeUndefined()
  })

  it('low: one line naming the area and numbers, a priority this turn', () => {
    const d = directive(areas({ earnings: earningsArea({ opportunities: [], received7dUsd: 0, received30dUsd: 0, burnUsdPerDay: 1, runwayDays: 20 }) }))
    expect(d).toBe('Health (low) earnings: 0 open opportunities, $0.00 expected, $0.00 received in 30 days. Make it a priority this turn.')
  })

  it('bad: fix before optional work, with the next steps', () => {
    const d = directive(areas({ money: moneyArea({ walletUsd: 10, inferenceUsd: 0, inferenceBurnUsdPerDay: 1, hostingUsdPerDay: 1 }) }))
    expect(d).toBe('Health (bad) money: runway 5.0 days ($10.00 at $2.00/day). Fix this before optional work. Next: Earning comes first: make a concrete plan to earn and act on it this turn (earning_add tracks it).')
  })

  it('critical: survival mode with days left, next steps, and keep turns short when money is the problem', () => {
    const d = directive(areas({ money }))!
    expect(d).toBe('Survival mode: money: runway 2.0 days ($4.00 at $2.00/day) (2.0 days left). Until it\'s fixed, every action must serve fixing it; defer everything else. Next: Earning comes first: make a concrete plan to earn and act on it this turn (earning_add tracks it). Keep turns short: every model call costs money.')
    expect(d.length).toBeLessThanOrEqual(HEALTH.directive.maxChars)
  })

  it('stays compact however many areas are failing', () => {
    const long = { ...money, headline: 'x'.repeat(400) }
    expect(directive(areas({ money: long, compute: long, inference: long }))!.length).toBe(HEALTH.directive.maxChars)
  })

  it('maps to the board tier and decides when to conserve', () => {
    expect(tierFor('ok', 'ok')).toBe('normal')
    expect(tierFor('low', 'low')).toBe('low_compute')
    expect(tierFor('bad', 'ok')).toBe('low_compute')
    expect(tierFor('low', 'starved')).toBe('critical')
    expect(tierFor('critical', 'ok')).toBe('critical')
    expect(conserveFor('bad', areas())).toBe(true)
    expect(conserveFor('critical', areas({ money }))).toBe(true)
    expect(conserveFor('critical', areas({ inference: { ...money } }))).toBe(false) // starved: quality is all it has
    expect(conserveFor('low', areas())).toBe(false)
  })
})
