/** Production budget wiring, also used by integration tests. Emergency credit is part of the daily cap. */
import type { GatewayConfig } from './config.js'
import type { GatewayDeps } from './server.js'
import type { GrantPool } from './grant-pool.js'
import type { Ledger } from './ledger.js'
import { Reservations, type SpendingScope } from './reservations.js'

export const MAINTENANCE_DAILY_USD = 0.25

export function spending(cfg: GatewayConfig, ledger: Ledger, grants: Pick<GrantPool, 'allowanceFor'>, reservations: Reservations, now = Date.now): Pick<GatewayDeps, 'refuse' | 'reserve' | 'budgetStatus'> {
  const day = () => {
    const d = new Date(now())
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    return { start, until: start + 86_400_000 }
  }
  const cap = (recovery = false) => cfg.budget ? cfg.budget.dailyUsd - (recovery ? 0 : cfg.budget.emergencyUsd) : undefined
  const dailyScope = () => `own:${day().start}`
  return {
    budgetStatus: () => {
      if (!cfg.budget) return undefined
      const accounting = ledger.dailyAccounting()
      const pendingUsd = reservations.pending(dailyScope())
      const normalLimitUsd = cfg.budget.dailyUsd - cfg.budget.emergencyUsd
      return { ...accounting, pendingUsd, normalLimitUsd, dailyLimitUsd: cfg.budget.dailyUsd,
        normalRemainingUsd: Math.max(0, normalLimitUsd - accounting.spentUsd - pendingUsd),
        recoveryRemainingUsd: Math.max(0, cfg.budget.dailyUsd - accounting.spentUsd - pendingUsd) }
    },
    refuse: recovery => {
      const limit = cap(recovery)
      return limit !== undefined && ledger.spent() + reservations.pending(dailyScope()) >= limit ? 'inference daily allowance is spent; free/local and lent routes remain available' : undefined
    },
    reserve: (body, target, provider, recovery, maintenance) => {
      const { start, until } = day()
      let scopes: SpendingScope[] = []
      let maxPerCallUsd: number | undefined
      if (target.grantId) {
        const a = grants.allowanceFor(target.grantId)
        if (!a) return undefined
        scopes = a.scopes
        maxPerCallUsd = a.maxPerCallUsd
      } else {
        const limit = cap(recovery)
        if (limit !== undefined) scopes.push({ id: dailyScope(), limit, used: ledger.spent(), until })
        if (maintenance) scopes.push({ id: `maintenance:${start}`, limit: MAINTENANCE_DAILY_USD, used: ledger.spent(true), until })
        if (provider.accountId && provider.accountDailyUsd !== undefined) scopes.push({ id: `account:${provider.accountId}:${start}`, limit: provider.accountDailyUsd, used: ledger.accountUsed(provider.accountId, start), until })
      }
      return reservations.reserve(body, target, scopes, maxPerCallUsd)
    },
  }
}
