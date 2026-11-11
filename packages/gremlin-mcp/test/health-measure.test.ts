import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { burnFromLedger, failedForInference, runnerEvents, wakeState } from '../src/health/measure.js'
import { addEarning, earnings, inflowUsd, noteIssue, openIssues, signature, updateEarning } from '../src/health/stores.js'
import { fluenceBalanceUsd } from '../src/health/probes.js'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const H = 3_600_000

/** jobs.json as Hermes writes it after a wake-up that found every provider unpaid. */
const failedJobs = {
  jobs: [{
    id: 'a0a0a0a0a0a1', name: 'gremlin-wake', state: 'scheduled', last_run_at: '2026-11-10T11:45:00+00:00', next_run_at: '2026-11-10T11:50:00+00:00',
    last_status: 'error', failure_streak: 2,
    last_error: 'RuntimeError: HTTP 503: {"error":{"type":"all_providers_failed","message":"every provider for \\"gremlin-auto\\" failed: hashference: 402 {\\"error\\":\\"insufficient credit\\"} | venice: cooling down | free-a: rate limit"}}',
  }, { id: 'other', last_status: 'error', last_error: 'boom' }],
}

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gremlin-')); process.env.GREMLIN_HOME = home })

describe('wake-up state from Hermes', () => {
  it('spots a wake-up that failed for lack of inference', () => {
    mkdirSync(join(home, 'cron'))
    writeFileSync(join(home, 'cron', 'jobs.json'), JSON.stringify(failedJobs))
    expect(wakeState(home)).toMatchObject({ found: true, lastStatus: 'error', failureStreak: 2, forInference: true, nextRunAt: '2026-11-10T11:50:00+00:00' })
  })

  it('does not blame inference for other failures, or for successes', () => {
    expect(failedForInference('error', 'TypeError: cannot read properties of undefined')).toBe(false)
    expect(failedForInference('ok', 'HTTP 402')).toBe(false)
    expect(failedForInference('error', 'HTTP 429: {"error":{"type":"budget_exhausted","message":"inference budget for today is spent"}}')).toBe(true)
    expect(wakeState(join(home, 'nowhere'))).toEqual({ found: false, failureStreak: 0, forInference: false })
  })
})

describe('burn from the ledger', () => {
  it('spend per day over the last 3 days, own money only, at least a day of spread', () => {
    const file = join(home, 'inference-ledger.jsonl')
    const lines = [
      { at: iso(80 * H), provider: 'venice', status: 200, usd: 9 }, // outside the window
      { at: iso(48 * H), provider: 'hashference', status: 200, usd: 2 },
      { at: iso(2 * H), provider: 'hashference', status: 200, usd: 1 },
      { at: iso(1 * H), provider: 'lent', status: 200, usd: 5, grantId: 'g' }, // the lender's money
      { at: iso(1 * H), provider: 'venice', status: 402, usd: 0 },
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"torn')
    const b = burnFromLedger(file, NOW)
    expect(b.historyDays).toBeCloseTo(2, 5)
    expect(b.usdPerDay).toBeCloseTo(1.5, 5)
    expect(b.providers).toContainEqual({ provider: 'venice', calls: 1, errorRate: 1 })
    const young = join(home, 'young.jsonl')
    writeFileSync(young, JSON.stringify({ at: iso(H), provider: 'h', status: 200, usd: 0.2 }) + '\n')
    expect(burnFromLedger(young, NOW).usdPerDay).toBeCloseTo(0.2, 5) // not 0.2 per hour
    expect(burnFromLedger(join(home, 'none'), NOW)).toEqual({ usdPerDay: 0, historyDays: 0, providers: [] })
  })
})

describe('runner events', () => {
  it('counts restarts (starts after the first) and crashes in the last day', () => {
    const f = join(home, 'runner-events.jsonl')
    writeFileSync(f, [
      { at: iso(30 * H), event: 'start' }, { at: iso(20 * H), event: 'start' }, { at: iso(10 * H), event: 'exit', child: 'hermes', code: 1 },
      { at: iso(10 * H), event: 'start' }, { at: iso(5 * H), event: 'start' }, { at: iso(4 * H), event: 'exit', child: 'gateway', code: null, signal: 'SIGTERM' },
    ].map((e) => JSON.stringify(e)).join('\n'))
    const r = runnerEvents(f, NOW)
    expect(r.restarts24h).toBe(2)
    expect(r.crashes).toEqual([expect.objectContaining({ child: 'hermes', code: 1 })])
  })
})

describe('earnings and income', () => {
  it('folds the append-only pipeline by id', () => {
    const a = addEarning({ what: 'Logo for @kip', amountUsd: 15, counterparty: '0xabc', status: 'offered' }, NOW)
    addEarning({ what: 'idea', status: 'idea' }, NOW)
    expect(updateEarning(a.id, { status: 'agreed', note: 'accepted on the board' }, NOW + 1000)).toMatchObject({ status: 'agreed', amountUsd: 15, what: 'Logo for @kip' })
    expect(updateEarning('nope', { status: 'paid' })).toBeUndefined()
    expect(earnings().map((e) => e.status).sort()).toEqual(['agreed', 'idea'])
    expect(readFileSync(join(home, 'earnings.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('sees money arrive as per-asset increases, less what was sent out', () => {
    expect(inflowUsd({ 'quai:quai': 10, 'usdc:base': 5 }, { 'quai:quai': 30, 'usdc:base': 5 }, 0)).toEqual({ usd: 20, assets: ['quai:quai'] })
    expect(inflowUsd({ 'quai:quai': 10, 'usdc:base': 5 }, { 'quai:quai': 2, 'usdc:base': 13 }, 8)).toEqual({ usd: 0, assets: ['usdc:base'] }) // a conversion
    expect(inflowUsd({}, { 'quai:quai': 10 }, 0).usd).toBe(0) // new asset without a baseline: not counted
  })
})

describe('issues', () => {
  it('deduplicates by signature (numbers and ids masked) and counts occurrences', () => {
    expect(signature('cron', 'timeout after 31s on 0xdeadbeef')).toBe(signature('cron', 'timeout after 45s on 0xfeedface'))
    noteIssue({ source: 'cron', title: 'wake-up failed', message: 'timeout after 31s', at: iso(3 * H) }, NOW)
    noteIssue({ source: 'cron', title: 'wake-up failed', message: 'timeout after 31s', at: iso(3 * H) }, NOW) // same occurrence, seen again
    const i = noteIssue({ source: 'cron', title: 'wake-up failed', message: 'timeout after 58s', at: iso(H) }, NOW)
    expect(i).toMatchObject({ count: 2, firstSeen: iso(3 * H), lastSeen: iso(H) })
    noteIssue({ source: 'gremlin', title: 'board_post 500s', message: 'board_post 500s', details: 'every time with a url' }, NOW - 8 * 24 * H)
    expect(openIssues(NOW).map((x) => x.source)).toEqual(['cron']) // the old one is no longer open
  })
})

describe('fluence balance', () => {
  it('reads a USD figure from the balances payload, or reports unknown', () => {
    expect(fluenceBalanceUsd({ items: [{ currency: 'USDC', balance: '12.5' }] })).toBe(12.5)
    expect(fluenceBalanceUsd([{ availableBalance: 3 }, { availableBalance: 2 }])).toBe(5)
    expect(fluenceBalanceUsd({ whatever: true })).toBeUndefined()
  })
})
