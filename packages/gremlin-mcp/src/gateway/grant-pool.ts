/** Bounded grant cache: refresh before routing; stale authorization fails closed even during a board outage. */
import { grantProblem, type KeyGrant } from '@gremlins/hatch'
import type { HDNodeWallet } from 'ethers'
import { fingerprint } from './credentials.js'
import { allowance, fetchGrants, LentKeys, period, remainingUsd, reportDisabled, type OpenGrant } from './grants.js'
import type { SpendingScope } from './reservations.js'

export class GrantPool {
  private grants: OpenGrant[] = []
  private refreshedAt = -Infinity
  private attemptedAt = -Infinity
  private refreshing?: Promise<void>
  private balances = new Map<string, { at: number; start: number; used: number; usd?: number }>()
  private lentKeys: LentKeys
  constructor(private opts: {
    load: () => Promise<OpenGrant[]>
    used: (accountId: string, since: number) => number
    remaining?: typeof remainingUsd
    now?: () => number
    log?: (...args: unknown[]) => void
    refreshMs?: number
    maxStaleMs?: number
    gremlin?: string
    onDisabled?: (g: KeyGrant, status: number, reason: string) => void
  }) {
    this.lentKeys = new LentKeys({
      gremlin: opts.gremlin ?? '0x0000000000000000000000000000000000000000',
      used: (id, since) => {
        const g = this.grants.find(g => g.grant.grantId === id)
        return g ? opts.used(this.group(g), since) : 0
      },
      onDisabled: opts.onDisabled, now: opts.now,
    })
  }
  private now() { return (this.opts.now ?? Date.now)() }
  private group(g: OpenGrant) { return `key:${fingerprint(g.apiKey)}` }
  private live(g: OpenGrant) { return !grantProblem(g.grant, new Date(this.now())) && this.now() - this.refreshedAt < (this.opts.maxStaleMs ?? 60_000) }
  private async refresh(force = false) {
    if (this.refreshing) return this.refreshing
    if (!force && this.now() - this.attemptedAt < (this.opts.refreshMs ?? 30_000)) return
    this.attemptedAt = this.now()
    this.refreshing = (async () => {
      try {
        const grants = await this.opts.load()
        this.grants = grants
        this.lentKeys.set(grants)
        this.refreshedAt = this.now()
        const ids = new Set(grants.map(g => g.grant.grantId))
        for (const id of this.balances.keys()) if (!ids.has(id)) this.balances.delete(id)
      } catch { this.opts.log?.('grants refresh failed; stale grants will be withheld') }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  /** Rechecked immediately before dispatch, including expiry and cache age. */
  allowanceFor(grantId: string): { scopes: SpendingScope[]; maxPerCallUsd?: number } | undefined {
    const g = this.grants.find(g => g.grant.grantId === grantId)
    if (!g || !this.live(g) || this.lentKeys.limiter(grantId)?.disabled) return undefined
    const now = this.now()
    const { start, reset } = period(g.grant.policy.period, now)
    const group = this.group(g)
    const used = this.opts.used(group, start)
    const b = this.balances.get(grantId)
    const fresh = b && b.start === start && now - b.at < 120_000
    const remaining = fresh && b.usd !== undefined ? Math.max(0, b.usd - Math.max(0, used - b.used)) : undefined
    // Providers with a balance API must report a fresh balance to authorize spending.
    if (g.grant.provider.budgetApi !== 'none' && remaining === undefined) return undefined
    const allow = allowance(g.grant.policy, now, used, remaining)
    if (allow.allowedUsd <= 0) return undefined
    return { scopes: [{ id: group, used, limit: used + allow.allowedUsd, until: Math.min(reset, g.grant.expiresAt ? Date.parse(g.grant.expiresAt) : Infinity) }], maxPerCallUsd: g.grant.policy.maxPerCallUsd }
  }
  async offers(force = false) {
    await this.refresh(force)
    await Promise.all(this.grants.filter(g => this.live(g)).map(async g => {
      const now = this.now(), { start } = period(g.grant.policy.period, now)
      const previous = this.balances.get(g.grant.grantId)
      if (previous && previous.start === start && now - previous.at < 120_000) return
      const used = this.opts.used(this.group(g), start)
      const usd = await (this.opts.remaining ?? remainingUsd)(g).catch(() => undefined)
      this.balances.set(g.grant.grantId, { at: now, start, used, usd })
      this.lentKeys.setRemaining(g.grant.grantId, usd)
    }))
    return this.grants.filter(g => this.live(g)).map(g => ({ g, allow: allowance(g.grant.policy, this.now(), 0) }))
      .sort((a, b) => Math.min(a.allow.reset, a.g.grant.expiresAt ? Date.parse(a.g.grant.expiresAt) : Infinity) - Math.min(b.allow.reset, b.g.grant.expiresAt ? Date.parse(b.g.grant.expiresAt) : Infinity))
      .flatMap(({ g }) => {
        const a = this.allowanceFor(g.grant.grantId)
        if (!a) return []
        const scope = a.scopes[0]!
        const o = this.lentKeys.offerFor(g, { allowedUsd: scope.limit - scope.used, reset: scope.until, reason: 'authorized' }, this.lentKeys.limiter(g.grant.grantId))
        return [{ ...o, provider: { ...o.provider, accountId: this.group(g), credentialHash: fingerprint(g.apiKey), quotaResetAt: scope.until }, targets: o.targets.map(t => ({ ...t, accountId: this.group(g) })) }]
      })
  }
  async status() {
    await this.offers()
    return this.lentKeys.status().map(s => {
      const scope = this.allowanceFor(s.grantId)?.scopes[0]
      return { ...s, allowance: scope
        ? { ...s.allowance, allowedUsd: scope.limit - scope.used, usedThisPeriodUsd: scope.used, resetsAt: new Date(scope.until).toISOString() }
        : { ...s.allowance, allowedUsd: 0, reason: 'authorization or provider balance unavailable' } }
    })
  }
}

export const boardGrantPool = (board: string, wallet: HDNodeWallet, used: (account: string, since: number) => number, log?: (...a: unknown[]) => void) => new GrantPool({
  load: () => fetchGrants(board, wallet), used, log, gremlin: wallet.address,
  onDisabled: (g, status, reason) => { void reportDisabled(board, wallet, g.grantId, status, reason).then(ok => { if (!ok) log?.(`could not report disabled lent key ${g.grantId}`) }) },
})
