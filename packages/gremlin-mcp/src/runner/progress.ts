import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAKE_JOB_ID } from '../bootstrap/hermes.js'

/** A paused scheduler and a future wake-up are healthy. Detect an overdue scheduler, not a provider outage. */
export function schedulerResponsive(home: string, startedAt: number, now = Date.now()): boolean {
  try {
    const jobs = JSON.parse(readFileSync(join(home, 'cron/jobs.json'), 'utf8')).jobs as Record<string, unknown>[]
    const job = jobs.find(job => job.id === WAKE_JOB_ID)
    if (!job) return false
    if (job.enabled === false || job.state === 'paused') return true
    const next = Date.parse(String(job.next_run_at ?? ''))
    if (!Number.isFinite(next)) return now - startedAt < 300_000
    return now - next < 3_600_000
  } catch { return now - startedAt < 300_000 }
}
