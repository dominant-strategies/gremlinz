/**
 * Inference spending: one JSON line per upstream call in GREMLIN_HOME/inference-ledger.jsonl. The gateway refuses
 * calls once a UTC day's spend reaches the budget (fail closed). Survives restarts by re-reading today's lines.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { RouteTarget } from './config.js'
import type { CallRecord } from './server.js'

export interface LedgerEntry extends CallRecord { usd: number; priced: boolean }

export const costUsd = (r: CallRecord, t: RouteTarget) =>
  r.usage ? (r.usage.promptTokens * t.inputPerM + r.usage.completionTokens * t.outputPerM) / 1_000_000 : 0

const day = (iso: string) => iso.slice(0, 10)

export class Ledger {
  private file: string
  private now: () => number
  private today = ''
  private spentToday = 0

  constructor(file: string, now: () => number = Date.now) {
    this.file = file
    this.now = now
    this.roll()
  }

  /** Re-read the ledger when the UTC day changes (and at start). */
  private roll() {
    const d = day(new Date(this.now()).toISOString())
    if (d === this.today) return
    this.today = d
    this.spentToday = 0
    if (!existsSync(this.file)) return
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        const e = JSON.parse(line) as LedgerEntry
        if (day(e.at) === d) this.spentToday += e.usd
      } catch { /* a torn last line after a crash */ }
    }
  }

  record(r: CallRecord, t: RouteTarget) {
    this.roll()
    const usd = costUsd(r, t)
    const entry: LedgerEntry = { ...r, usd, priced: t.inputPerM > 0 || t.outputPerM > 0 }
    if (day(r.at) === this.today) this.spentToday += usd
    appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 })
  }

  spent(): number {
    this.roll()
    return this.spentToday
  }

  /** A reason to refuse, once today's spend reaches the cap. */
  refuse(dailyUsd?: number): string | undefined {
    if (dailyUsd === undefined) return undefined
    const s = this.spent()
    return s >= dailyUsd ? `inference budget for today is spent ($${s.toFixed(4)} of $${dailyUsd}); it resets at 00:00 UTC` : undefined
  }
}
