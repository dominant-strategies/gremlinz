/**
 * Inference spending: one JSON line per upstream call in GREMLIN_HOME/inference-ledger.jsonl. The gateway refuses
 * calls once a UTC day's spend reaches the budget (fail closed). Survives restarts by re-reading today's lines.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { RouteTarget } from './config.js'
import type { CallRecord } from './server.js'
import { appendDurable } from '@gremlins/hatch/node'

export interface LedgerEntry extends CallRecord { usd: number; priced: boolean; grantId?: string; kind?: never }
export interface LedgerSettlement {
  kind: 'settlement'
  /** Charged against the same UTC day, account and alias as the original request. */
  at: string
  alias: string
  provider: string
  providerReservationId: string
  accountId?: string
  usd: number
  settledUsd: number
  settledDeltaUsd: number
  grantId?: never
}
export type LedgerRecord = LedgerEntry | LedgerSettlement

export function costUsd(r: CallRecord, t: RouteTarget): number {
  if (!r.usage) return 0
  const { promptTokens, completionTokens } = r.usage
  const cached = r.usage.cachedPromptTokens ?? 0
  const usableCached = Number.isSafeInteger(cached) && cached >= 0 && cached <= promptTokens ? cached : 0
  return ((promptTokens - usableCached) * t.inputPerM + usableCached * (t.cachedInputPerM ?? t.inputPerM) + completionTokens * t.outputPerM) / 1_000_000
}

const day = (iso: string) => iso.slice(0, 10)
const settlementKey = (provider: string, id: string) => `${provider}:${id}`

export class Ledger {
  private file: string
  private now: () => number
  private today = ''
  private spentToday = 0
  private maintenanceToday = 0
  private settledToday = 0
  private reconcilable = new Map<string, { entry: LedgerEntry; usd: number; settledUsd?: number }>()
  private needsSeparator = false

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
    this.maintenanceToday = 0
    this.settledToday = 0
    this.reconcilable.clear()
    const raw = existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''
    this.needsSeparator = !!raw && !raw.endsWith('\n')
    for (const line of raw.split('\n')) {
      if (!line.startsWith('{')) continue
      try {
        this.apply(JSON.parse(line) as LedgerRecord)
      } catch { /* a torn last line after a crash */ }
    }
  }

  private append(entry: LedgerRecord) {
    const line = (this.needsSeparator ? '\n' : '') + JSON.stringify(entry) + '\n'
    this.needsSeparator = true
    appendDurable(this.file, line)
    this.needsSeparator = false
    this.apply(entry)
  }

  private apply(entry: LedgerRecord) {
    if (!Number.isFinite(entry.usd) || (entry.kind === 'settlement' &&
      (!Number.isFinite(entry.settledUsd) || !Number.isFinite(entry.settledDeltaUsd)))) return
    if (entry.providerReservationId && !entry.grantId) {
      const key = settlementKey(entry.provider, entry.providerReservationId)
      if (entry.kind === 'settlement') {
        const existing = this.reconcilable.get(key)
        if (existing) { existing.usd = entry.settledUsd; existing.settledUsd = entry.settledUsd }
      } else if (Date.parse(entry.at) >= this.now() - 7 * 86_400_000) this.reconcilable.set(key, { entry, usd: entry.usd })
    }
    if (day(entry.at) !== this.today || entry.grantId) return
    this.spentToday += entry.usd
    if (entry.alias === 'gremlin-maintenance') this.maintenanceToday += entry.usd
    if (entry.kind === 'settlement') this.settledToday += entry.settledDeltaUsd
  }

  record(r: CallRecord, t: RouteTarget) {
    this.roll()
    const usd = r.usage && !r.incomplete ? costUsd(r, t) : (r.estimatedUsd ?? costUsd(r, t))
    const entry: LedgerEntry = { ...r, usd, priced: t.inputPerM > 0 || t.outputPerM > 0, ...(t.grantId ? { grantId: t.grantId } : {}) }
    this.append(entry)
    return entry
  }

  /** Replace one estimate by a provider-confirmed charge, keeping the original audit entry. */
  settle(provider: string, reservationId: string, costMicrousd: number) {
    if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) return false
    this.roll()
    const bill = this.reconcilable.get(settlementKey(provider, reservationId))
    const settledUsd = costMicrousd / 1_000_000
    if (!bill || bill.settledUsd === settledUsd) return false
    const { at, alias, accountId } = bill.entry
    const entry: LedgerSettlement = { kind: 'settlement', at, alias, accountId, provider, providerReservationId: reservationId,
      usd: settledUsd - bill.usd, settledUsd, settledDeltaUsd: settledUsd - (bill.settledUsd ?? 0) }
    this.append(entry)
    return true
  }

  /** Value used on a lent key since `sinceMs` (for its allowance and for repaying the lender). */
  grantUsed(grantId: string, sinceMs = 0): number {
    if (!existsSync(this.file)) return 0
    let usd = 0
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.includes(grantId)) continue
      try {
        const e = JSON.parse(line) as LedgerEntry
        if (e.grantId === grantId && Date.parse(e.at) >= sinceMs) usd += e.usd
      } catch { /* torn line */ }
    }
    return usd
  }

  spent(maintenance = false): number {
    this.roll()
    return maintenance ? this.maintenanceToday : this.spentToday
  }

  dailyAccounting() {
    this.roll()
    return { day: this.today, spentUsd: this.spentToday, settledUsd: this.settledToday, estimatedUsd: Math.max(0, this.spentToday - this.settledToday) }
  }

  /** All credentials/grants in one account draw from the same reported allowance. */
  accountUsed(accountId: string, sinceMs = 0): number {
    if (!existsSync(this.file)) return 0
    return readFileSync(this.file, 'utf8').split('\n').reduce((sum, line) => {
      try { const e = JSON.parse(line) as LedgerRecord; return sum + (e.accountId === accountId && Date.parse(e.at) >= sinceMs ? e.usd : 0) } catch { return sum }
    }, 0)
  }

  /** A reason to refuse, once today's spend reaches the cap. */
  refuse(dailyUsd?: number): string | undefined {
    if (dailyUsd === undefined) return undefined
    const s = this.spent()
    return s >= dailyUsd ? `inference budget for today is spent ($${s.toFixed(4)} of $${dailyUsd}); it resets at 00:00 UTC` : undefined
  }
}
