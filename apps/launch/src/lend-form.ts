/**
 * The lending page's form, as plain data: which providers can be picked (forbidden ones listed with why), and the
 * budget presets and custom rules turned into a grant policy. No DOM, so it is tested directly.
 */
import { GrantPolicy, PROVIDERS, lendingProvider, presetPolicy, type LendingProvider } from '@gremlins/hatch'

export interface ProviderOption { id: string; name: string; selectable: boolean; stance: LendingProvider['stance']; note: string; kind: LendingProvider['kind'] }

/** Lendable providers first (API, then your own server), then the ones that can't be lent and why. */
export function providerOptions(): ProviderOption[] {
  const order = (p: LendingProvider) => (p.stance === 'forbidden' ? 2 : p.kind === 'custom' ? 1 : 0)
  return [...PROVIDERS].sort((a, b) => order(a) - order(b)).map((p) => ({
    id: p.id, name: p.name, kind: p.kind, stance: p.stance, selectable: p.stance !== 'forbidden',
    note: p.stance === 'forbidden' ? p.reason! : p.setup,
  }))
}

export type Every = GrantPolicy['period']['every']

export interface BudgetForm {
  preset: 'leftover' | 'fixed' | 'custom'
  every: Every
  resetAt: string
  dayOfWeek: number
  dayOfMonth: number
  /** Your budget on the key per period (leftover, custom). */
  budgetUsd: number
  /** leftover: share of what's left, and how close to the reset. */
  pct: number
  hours: number
  /** fixed: dollars per period the gremlin may use. */
  usd: number
  /** custom: one rule. */
  custom: { withinHoursOfReset: number; share: 'budget' | 'remaining'; pct: number; minRemainingPct?: number }
  maxPerCallUsd?: number
  limits?: { rpm?: number; tpm?: number; concurrency?: number }
}

export const DEFAULT_BUDGET: BudgetForm = {
  preset: 'leftover', every: 'month', resetAt: '00:00', dayOfWeek: 1, dayOfMonth: 1, budgetUsd: 20, pct: 50, hours: 6, usd: 5,
  custom: { withinHoursOfReset: 24, share: 'budget', pct: 25 },
}

/** The policy the form describes; throws with a plain message when something is missing or out of range. */
export function formPolicy(f: BudgetForm, providerId: string): GrantPolicy {
  const provider = lendingProvider(providerId)
  const when = { every: f.every, resetAt: f.resetAt, ...(f.every === 'week' ? { dayOfWeek: f.dayOfWeek } : {}), ...(f.every === 'month' ? { dayOfMonth: f.dayOfMonth } : {}) }
  let p: GrantPolicy
  if (f.preset === 'leftover') p = presetPolicy({ kind: 'leftover', pct: f.pct, hours: f.hours, budgetUsd: f.budgetUsd, ...when }, provider)
  else if (f.preset === 'fixed') p = presetPolicy({ kind: 'fixed', usd: f.usd, ...when })
  else {
    const c = f.custom
    if (c.share === 'remaining' && provider?.budgetApi === 'none') throw new Error(`${provider.name} doesn't report what's left on a key: use a share of your budget instead`)
    const rule = { withinHoursOfReset: c.withinHoursOfReset, ...(c.share === 'remaining' ? { usePctOfRemaining: c.pct } : { usePctOfBudget: c.pct }), ...(c.minRemainingPct !== undefined ? { minRemainingPct: c.minRemainingPct } : {}) }
    const r = GrantPolicy.safeParse({ period: when, budgetUsd: f.budgetUsd, rules: [rule] })
    if (!r.success) throw new Error('check the custom rule: hours between 1 and 744, shares between 0 and 100%, and a budget above $0')
    p = r.data
  }
  const limits = f.limits && Object.fromEntries(Object.entries(f.limits).filter(([, v]) => v !== undefined && v > 0))
  const out = { ...p, ...(f.maxPerCallUsd ? { maxPerCallUsd: f.maxPerCallUsd } : {}), ...(limits && Object.keys(limits).length ? { limits } : {}) }
  const r = GrantPolicy.safeParse(out)
  if (!r.success) throw new Error('the budget rules are out of range')
  return r.data
}
