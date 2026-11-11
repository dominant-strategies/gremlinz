/**
 * Readings for the health monitor from files other processes write: the inference ledger (gateway), Hermes' cron
 * state (jobs.json, executions.db incidents), the runner's event log, and this machine's resources. Every reader
 * tolerates a missing or torn file: no reading is a fact too ("unknown"), never a crash.
 */
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '../gateway/ledger.js'
import { WAKE_JOB_ID } from '../bootstrap/hermes.js'
import { HEALTH } from './policy.js'

const DAY = 86_400_000

function jsonl<T>(file: string): T[] {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  return raw.split('\n').flatMap((l) => { if (!l.startsWith('{')) return []; try { return [JSON.parse(l) as T] } catch { return [] } })
}

export interface Burn {
  usdPerDay: number
  /** Days of history the figure is based on (0: none). */
  historyDays: number
  /** Per provider over the last 24 hours. */
  providers: { provider: string; calls: number; errorRate: number }[]
}

/** Spend per day over the last few days (the gremlin's own money: lent keys excluded), and provider error rates. */
export function burnFromLedger(file: string, now: number, windowDays: number = HEALTH.inference.burnWindowDays): Burn {
  const since = now - windowDays * DAY
  const entries = jsonl<LedgerEntry>(file).filter((e) => Date.parse(e.at) >= since)
  const own = entries.filter((e) => !e.grantId)
  const first = Math.min(...own.map((e) => Date.parse(e.at)))
  // A gremlin a few hours old: spread its spend over at least a day, not over its short life.
  const historyDays = own.length ? Math.min(windowDays, (now - first) / DAY) : 0
  const spent = own.reduce((a, e) => a + (e.usd || 0), 0)
  const by = new Map<string, { calls: number; errors: number }>()
  for (const e of entries.filter((x) => Date.parse(x.at) >= now - DAY)) {
    const p = by.get(e.provider) ?? { calls: 0, errors: 0 }
    p.calls++
    if (e.status >= 400) p.errors++
    by.set(e.provider, p)
  }
  return {
    usdPerDay: own.length ? spent / Math.max(1, historyDays) : 0,
    historyDays,
    providers: [...by].map(([provider, p]) => ({ provider, calls: p.calls, errorRate: p.errors / p.calls })),
  }
}

export interface WakeState {
  found: boolean
  lastStatus?: string
  lastError?: string
  lastRunAt?: string
  nextRunAt?: string
  failureStreak: number
  /** The last run failed because no model could be paid for (or all providers were benched). */
  forInference: boolean
}

/** What the gateway says when nothing could answer for lack of money (see gateway/server.ts and providers.ts). */
const NO_INFERENCE = /all_providers_failed|every provider for .* failed|\b402\b|payment required|cooling down|budget_exhausted|inference budget for today is spent|insufficient (credit|balance|funds)|no Hashference key/i

export const failedForInference = (status?: string, error?: string) => status === 'error' && !!error && NO_INFERENCE.test(error)

export function wakeState(hermesHome: string, jobId: string = WAKE_JOB_ID): WakeState {
  try {
    const { jobs } = JSON.parse(readFileSync(join(hermesHome, 'cron', 'jobs.json'), 'utf8')) as { jobs?: Record<string, unknown>[] }
    const j = jobs?.find((x) => x.id === jobId)
    if (!j) return { found: false, failureStreak: 0, forInference: false }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const lastStatus = str(j.last_status)
    const lastError = str(j.last_error)
    return {
      found: true, lastStatus, lastError, lastRunAt: str(j.last_run_at), nextRunAt: str(j.next_run_at),
      failureStreak: Number(j.failure_streak) || 0, forInference: failedForInference(lastStatus, lastError),
    }
  } catch {
    return { found: false, failureStreak: 0, forInference: false }
  }
}

export interface Incident { jobId: string; sig: string; state: string; type: string; firstSeen: string; lastSeen: string; error: string }

/** Hermes' cron incidents (cron/executions.db), open ones only. Needs node:sqlite; without it, none. */
export async function cronIncidents(hermesHome: string): Promise<Incident[]> {
  const file = join(hermesHome, 'cron', 'executions.db')
  if (!existsSync(file)) return []
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rows = db.prepare("SELECT job_id, error_sig, state, failure_type, first_seen_at, last_seen_at, error FROM cron_incidents WHERE state IN ('detected','alerted') ORDER BY last_seen_at DESC LIMIT 20").all() as Record<string, string>[]
      return rows.map((r) => ({ jobId: r.job_id!, sig: r.error_sig!, state: r.state!, type: r.failure_type!, firstSeen: r.first_seen_at!, lastSeen: r.last_seen_at!, error: r.error! }))
    } finally { db.close() }
  } catch { return [] }
}

export interface RunnerEvent { at: string; event: 'start' | 'exit'; child?: string; code?: number | null; signal?: string | null }

/** Runner starts and child exits in the last 24 hours (gremlin-run appends them to runner-events.jsonl). */
export function runnerEvents(file: string, now: number): { restarts24h: number; crashes: RunnerEvent[] } {
  const recent = jsonl<RunnerEvent>(file).filter((e) => Date.parse(e.at) >= now - DAY)
  const starts = recent.filter((e) => e.event === 'start').length
  return {
    // The first start of the day is the normal one; each further start is the egg restarting a failed runtime.
    restarts24h: Math.max(0, starts - 1),
    crashes: recent.filter((e) => e.event === 'exit' && e.code !== 0 && e.signal !== 'SIGTERM'),
  }
}

export interface LocalResources { diskFreeFrac?: number; memFreeFrac: number; load1: number; cores: number; uptimeSec: number }

export function localResources(path: string): LocalResources {
  let diskFreeFrac: number | undefined
  try { const s = statfsSync(path); diskFreeFrac = s.bavail / s.blocks } catch { /* unknown */ }
  return { diskFreeFrac, memFreeFrac: freemem() / totalmem(), load1: loadavg()[0]!, cores: cpus().length || 1, uptimeSec: uptime() }
}

/** Last reported balance of a gateway provider (balance-<id>.json, written by the gateway). */
export function reportedBalance(file: string): number | undefined {
  try { const b = JSON.parse(readFileSync(file, 'utf8')) as { usd?: number }; return typeof b.usd === 'number' && Number.isFinite(b.usd) ? b.usd : undefined } catch { return undefined }
}
