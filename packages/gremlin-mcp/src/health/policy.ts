/**
 * The gremlin's health, judged by plain code: every threshold lives in HEALTH, every judgement is a pure function of
 * measured numbers (monitor.ts measures and acts; this file only decides). Six areas, each ok < low < bad < critical:
 *
 *   compute    the server itself and how long it is paid for
 *   inference  whether it can think: credit, burn, failed wake-ups (and the automatic top-up policy)
 *   money      wallet value, total burn, runway
 *   earnings   the pipeline of work it expects to be paid for, and income actually received
 *   updates    known security holes and pending OS fixes
 *   bugs       recurring failures worth fixing or reporting
 *
 * The overall severity is the worst area. It reaches the model as a directive in every request (gateway), worded more
 * forcefully the worse it gets: health sets priorities; the model still decides how.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const HEALTH = {
  checkEveryMs: 10 * MIN,
  /** Slow or rate-limited probes are refreshed less often than the loop runs. */
  walletEveryMs: 30 * MIN,
  hostingEveryMs: 6 * HOUR,
  /** A health.json older than this is ignored by the gateway (the monitor is not running). */
  staleMs: 45 * MIN,

  inference: {
    /** Before there is history, assume this burn; it also floors measured burn. */
    minBurnUsdPerDay: 0.5,
    burnWindowDays: 3,
    /** Keep credit at least max(floorMinUsd, floorDays of burn); when below, top up to targetDays of burn. */
    floorMinUsd: 1,
    floorDays: 3,
    targetDays: 7,
    /**
     * A new gremlin's first top-up, right after hatching (no history to size it from). The hatch page should tell makers
     * that part of their funding becomes inference credit this way.
     */
    firstRunTargetUsd: 3,
    maxTopUpUsdPerDay: 20,
    /** Never spend more than this share of liquid wallet value on one top-up. */
    maxWalletShare: 0.25,
    /** Leave QUAI headroom for the transfer fee and price movement between quote and payment. */
    quaiSpendShare: 0.95,
    /** Hashference QUAI invoices are $1 to $500. */
    minInvoiceUsd: 1,
    maxInvoiceUsd: 500,
    /** Below this the gremlin has effectively no paid inference. */
    starvedUsd: 0.1,
  },
  /**
   * Never spend the wallet below this on inference: the code has no hosting reserve of its own, so this is it. $10 is
   * the smallest Fluence top-up, i.e. what it takes to pay for the server once more.
   */
  hostingReserveUsd: 10,

  mining: {
    /** Starved this long (no credit, no funds to top up) before the monitor starts the miner by itself. */
    autoAfterStarvedMs: 6 * HOUR,
    /** At most this share of the cores. */
    maxCoreShare: 0.5,
  },

  compute: {
    hostingDays: { critical: 2, bad: 7, low: 14 },
    diskFree: { bad: 0.05, low: 0.15 },
    memFreeLow: 0.05,
    loadPerCoreLow: 2,
    restarts24h: { low: 3, bad: 10 },
  },
  /** Runway tiers as in the treasury-and-runway skill. */
  money: { runwayDays: { critical: 3, bad: 7, low: 30 } },
  earnings: { lowBelowRunwayDays: 30 },
  updates: {
    /** A high/critical hole is critical when the gremlin can afford to move (runway at least this). */
    moveRunwayDays: 7,
    patchOsEveryMs: 6 * HOUR,
  },
  bugs: {
    recurringCount: 3,
    /** An issue not seen for this long no longer counts as open. */
    openForMs: 7 * DAY,
    providerErrorRate: 0.5,
    providerMinCalls: 10,
    wakeFailStreakBad: 3,
  },
  directive: { maxChars: 700, maxSteps: 3 },
} as const

export const LEVELS = ['ok', 'low', 'bad', 'critical'] as const
export type Level = (typeof LEVELS)[number]
export const AREAS = ['compute', 'inference', 'money', 'earnings', 'updates', 'bugs'] as const
export type AreaName = (typeof AREAS)[number]

export const rankOf = (l: Level) => LEVELS.indexOf(l)
export const worst = (...ls: Level[]): Level => ls.reduce<Level>((a, b) => (rankOf(b) > rankOf(a) ? b : a), 'ok')

export interface Area {
  level: Level
  /** One short line with the numbers, e.g. "runway 2.1 days ($4.20 at $2.00/day)". */
  headline: string
  numbers: Record<string, number | string | boolean | null>
  /** What the monitor did about it this check. */
  did: string[]
  /** Concrete next steps for the gremlin. */
  next: string[]
  /** Days until it becomes a problem, when that is meaningful (for "Survival mode: … (N days left)"). */
  daysLeft?: number
}

const r2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => `$${n.toFixed(2)}`
const days = (n: number) => (n >= 100 ? `${Math.round(n)} days` : `${n.toFixed(1)} days`)
const tier = (v: number | undefined, t: { critical?: number; bad: number; low: number }): Level =>
  v === undefined ? 'ok' : t.critical !== undefined && v < t.critical ? 'critical' : v < t.bad ? 'bad' : v < t.low ? 'low' : 'ok'

// ── inference ────────────────────────────────────────────────────────────────

export interface InferenceInput {
  /** Hashference credit available (undefined: no account or could not read). */
  hashferenceUsd?: number
  /** Venice balance last reported by the gateway. */
  veniceUsd?: number
  /** Measured from the ledger over the burn window (0 with no history). */
  measuredBurnUsdPerDay: number
  /** Liquid wallet value (undefined: could not read). */
  walletUsd?: number
  /** The part of it held in QUAI (what pays Hashference). */
  quaiUsd?: number
  toppedUpLast24hUsd: number
  everToppedUp: boolean
  /** The last wake-up failed because no provider could answer for lack of payment. */
  wakeFailedForInference: boolean
}

export interface TopUpPlan {
  burnUsdPerDay: number
  floorUsd: number
  targetUsd: number
  creditUsd: number
  firstRun: boolean
  /** Dollars to buy now (0: none). */
  usd: number
  why: string
}

/** How much Hashference credit to buy now, if any. Pure; the caps are in HEALTH.inference and hostingReserveUsd. */
export function planTopUp(i: InferenceInput): TopUpPlan {
  const H = HEALTH.inference
  const burn = Math.max(H.minBurnUsdPerDay, i.measuredBurnUsdPerDay)
  const floorUsd = r2(Math.max(H.floorMinUsd, H.floorDays * burn))
  const credit = (i.hashferenceUsd ?? 0) + (i.veniceUsd ?? 0)
  // Launch: a funded gremlin that never bought credit starts with paid inference instead of free endpoints.
  const firstRun = !i.everToppedUp && (i.hashferenceUsd ?? 0) < H.starvedUsd
  const targetUsd = r2(firstRun ? H.firstRunTargetUsd : Math.max(floorUsd, H.targetDays * burn))
  const base = { burnUsdPerDay: r2(burn), floorUsd, targetUsd, creditUsd: r2(credit), firstRun }
  const none = (why: string): TopUpPlan => ({ ...base, usd: 0, why })
  if (!firstRun && !i.wakeFailedForInference && credit >= floorUsd) return none(`credit ${usd(credit)} is above the floor ${usd(floorUsd)}`)
  // Treasury rule: convert only what is needed now. Credit already held (Venice included) counts.
  const need = targetUsd - credit
  if (need <= 0) return none(`credit ${usd(credit)} already covers the target ${usd(targetUsd)}`)
  if (i.walletUsd === undefined || i.quaiUsd === undefined) return none('wallet balance unknown; not paying blind')
  const caps: [string, number][] = [
    ['need', need],
    [`the $${H.maxTopUpUsdPerDay}/day top-up limit`, H.maxTopUpUsdPerDay - i.toppedUpLast24hUsd],
    [`${H.maxWalletShare * 100}% of the wallet`, H.maxWalletShare * i.walletUsd],
    [`the ${usd(HEALTH.hostingReserveUsd)} hosting reserve`, i.walletUsd - HEALTH.hostingReserveUsd],
    ['the QUAI on hand', i.quaiUsd * H.quaiSpendShare],
    ['the invoice maximum', H.maxInvoiceUsd],
  ]
  const [by, cap] = caps.reduce((a, b) => (b[1] < a[1] ? b : a))
  const amount = Math.floor(cap * 100) / 100
  if (amount < H.minInvoiceUsd) return none(`cannot top up: limited by ${by} (${usd(Math.max(0, cap))}, invoices start at ${usd(H.minInvoiceUsd)})`)
  return { ...base, usd: amount, why: `${firstRun ? 'first run: prepay inference' : `credit ${usd(credit)} below floor ${usd(floorUsd)}`}${i.wakeFailedForInference ? ' and the last wake-up failed for lack of inference' : ''}; buying ${usd(amount)}${by === 'need' ? ` to reach ${usd(targetUsd)}` : ` (limited by ${by})`}` }
}

export type InferenceStatus = 'ok' | 'low' | 'starved'

export function inferenceArea(i: InferenceInput, plan: TopUpPlan, after: { boughtUsd: number; did: string[] }): Area & { status: InferenceStatus } {
  const H = HEALTH.inference
  const credit = plan.creditUsd + after.boughtUsd
  const runway = credit / plan.burnUsdPerDay
  const numbers = {
    inferenceUsd: r2(credit), hashferenceUsd: i.hashferenceUsd ?? null, veniceUsd: i.veniceUsd ?? null,
    burnUsdPerDay: plan.burnUsdPerDay, inferenceRunwayDays: r2(runway), floorUsd: plan.floorUsd, targetUsd: plan.targetUsd,
    wakeFailedForInference: i.wakeFailedForInference,
  }
  const headline = `credit ${usd(credit)}, ${days(runway)} at ${usd(plan.burnUsdPerDay)}/day`
  const earn = 'Earn: sell a service on the board, take a bounty, or offer what your goals make you good at; then top up with hashference_topup.'
  if (credit < H.starvedUsd && after.boughtUsd === 0)
    return { status: 'starved', level: 'critical', headline: `starved: no paid inference (${plan.why})`, numbers, did: after.did, next: [earn, 'Ask your parent or backers for funds on the board if you have them.'], daysLeft: 0 }
  if (i.wakeFailedForInference && after.boughtUsd === 0 && credit < plan.floorUsd)
    return { status: 'low', level: 'bad', headline: `wake-ups failing for lack of inference; ${headline}`, numbers, did: after.did, next: [earn], daysLeft: r2(runway) }
  if (credit < plan.floorUsd)
    return { status: 'low', level: runway < 1 ? 'bad' : 'low', headline: `${headline} (floor ${usd(plan.floorUsd)})`, numbers, did: after.did, next: after.boughtUsd ? [] : [earn], daysLeft: r2(runway) }
  return { status: 'ok', level: 'ok', headline, numbers, did: after.did, next: [], daysLeft: r2(runway) }
}

// ── compute ──────────────────────────────────────────────────────────────────

export interface ComputeInput {
  hosting?: { provider: string; daysLeft?: number; balanceUsd?: number; hourlyUsd?: number; error?: string }
  diskFreeFrac?: number
  memFreeFrac?: number
  load1?: number
  cores: number
  uptimeSec?: number
  restarts24h: number
}

export function computeArea(c: ComputeInput): Area {
  const T = HEALTH.compute
  const hostDays = c.hosting?.daysLeft
  const levels: Level[] = [
    tier(hostDays, T.hostingDays),
    tier(c.diskFreeFrac, T.diskFree),
    c.memFreeFrac !== undefined && c.memFreeFrac < T.memFreeLow ? 'low' : 'ok',
    c.load1 !== undefined && c.load1 > T.loadPerCoreLow * c.cores ? 'low' : 'ok',
    c.restarts24h >= T.restarts24h.bad ? 'bad' : c.restarts24h >= T.restarts24h.low ? 'low' : 'ok',
  ]
  const next: string[] = []
  if (hostDays !== undefined && hostDays < T.hostingDays.low)
    next.push(`Renew hosting within ${Math.max(0, Math.floor(hostDays))} days (${c.hosting!.provider}${c.hosting!.hourlyUsd ? `, ${usd(c.hosting!.hourlyUsd * 24)}/day` : ''}); if you cannot, earn first.`)
  if (c.diskFreeFrac !== undefined && c.diskFreeFrac < T.diskFree.low) next.push('Free disk space: prune old files in your work folder, logs and caches.')
  if (c.restarts24h >= T.restarts24h.low) next.push('Your runtime keeps restarting: check health_status bugs and report_issue with what you see.')
  const hostPart = c.hosting ? (hostDays !== undefined ? `hosting ${days(hostDays)} left (${c.hosting.provider})` : `hosting runway unknown (${c.hosting.error ?? c.hosting.provider})`) : 'hosting runway unknown (no hosting account on file)'
  const disk = c.diskFreeFrac !== undefined ? `, disk ${Math.round(c.diskFreeFrac * 100)}% free` : ''
  return {
    level: worst(...levels),
    headline: `${hostPart}${disk}${c.restarts24h ? `, ${c.restarts24h} restarts in 24h` : ''}`,
    numbers: {
      hostingProvider: c.hosting?.provider ?? null, hostingDaysLeft: hostDays === undefined ? null : r2(hostDays), hostingBalanceUsd: c.hosting?.balanceUsd ?? null,
      hostingUsdPerDay: c.hosting?.hourlyUsd === undefined ? null : r2(c.hosting.hourlyUsd * 24), diskFreePct: c.diskFreeFrac === undefined ? null : Math.round(c.diskFreeFrac * 100),
      memFreePct: c.memFreeFrac === undefined ? null : Math.round(c.memFreeFrac * 100), load1: c.load1 ?? null, cores: c.cores, uptimeHours: c.uptimeSec === undefined ? null : r2(c.uptimeSec / 3600), restarts24h: c.restarts24h,
    },
    did: [],
    next,
    ...(hostDays !== undefined ? { daysLeft: r2(hostDays) } : {}),
  }
}

// ── money ────────────────────────────────────────────────────────────────────

export interface MoneyInput {
  walletUsd?: number
  inferenceUsd: number
  inferenceBurnUsdPerDay: number
  hostingBalanceUsd?: number
  hostingUsdPerDay?: number
}

export function moneyArea(m: MoneyInput): Area {
  const burn = m.inferenceBurnUsdPerDay + (m.hostingUsdPerDay ?? 0)
  const assets = (m.walletUsd ?? 0) + m.inferenceUsd + (m.hostingBalanceUsd ?? 0)
  const runway = m.walletUsd === undefined ? undefined : assets / Math.max(burn, 0.01)
  const level = tier(runway, HEALTH.money.runwayDays)
  return {
    level,
    headline: runway === undefined ? 'wallet value unknown (balances could not be read)' : `runway ${days(runway)} (${usd(assets)} at ${usd(burn)}/day)`,
    numbers: {
      walletUsd: m.walletUsd === undefined ? null : r2(m.walletUsd), totalUsd: r2(assets), burnUsdPerDay: r2(burn), hostingUsdPerDay: m.hostingUsdPerDay ?? null,
      runwayDays: runway === undefined ? null : r2(runway), hostingReserveUsd: HEALTH.hostingReserveUsd,
    },
    did: [],
    next: level === 'ok' ? [] : ['Earning comes first: make a concrete plan to earn and act on it this turn (earning_add tracks it).'],
    ...(runway !== undefined ? { daysLeft: r2(runway) } : {}),
  }
}

// ── earnings ─────────────────────────────────────────────────────────────────

export const EARNING_STATUSES = ['idea', 'offered', 'agreed', 'delivered', 'paid', 'lost'] as const
export type EarningStatus = (typeof EARNING_STATUSES)[number]
export interface Earning { id: string; what: string; amountUsd?: number; counterparty?: string; status: EarningStatus; ref?: string; at: string; updatedAt: string }

export interface EarningsInput {
  opportunities: Earning[]
  received7dUsd: number
  received30dUsd: number
  burnUsdPerDay: number
  runwayDays?: number
}

export function earningsArea(e: EarningsInput): Area {
  const open = e.opportunities.filter((o) => o.status !== 'paid' && o.status !== 'lost')
  const expected = open.filter((o) => o.status === 'agreed' || o.status === 'delivered').reduce((a, o) => a + (o.amountUsd ?? 0), 0)
  const coverage = expected / Math.max(e.burnUsdPerDay, 0.01)
  const low = !open.length && e.runwayDays !== undefined && e.runwayDays < HEALTH.earnings.lowBelowRunwayDays
  return {
    level: low ? 'low' : 'ok',
    headline: `${open.length} open opportunit${open.length === 1 ? 'y' : 'ies'}, ${usd(expected)} expected, ${usd(e.received30dUsd)} received in 30 days`,
    numbers: { open: open.length, expectedUsd: r2(expected), expectedCoversDays: r2(coverage), received7dUsd: r2(e.received7dUsd), received30dUsd: r2(e.received30dUsd) },
    did: [],
    next: low ? ['You have nothing in your earning pipeline: find one concrete way to earn this turn and record it with earning_add.'] : [],
  }
}

// ── updates ──────────────────────────────────────────────────────────────────

export interface UpdatesInput {
  checkedAt?: number
  error?: string
  osSecurityPending: number
  /** Fixes shipped in newer releases (known holes in this image). */
  missing: { id: string; severity: 'low' | 'medium' | 'high' | 'critical' }[]
  moveTo?: { tag: string; image: string }
  runtimeMissing: string[]
  runwayDays?: number
  patchedOs?: string
}

export function updatesArea(u: UpdatesInput): Area {
  const serious = u.missing.some((f) => f.severity === 'high' || f.severity === 'critical') || u.runtimeMissing.length > 0
  const canMove = u.runwayDays === undefined || u.runwayDays >= HEALTH.updates.moveRunwayDays
  const level: Level = serious ? (canMove ? 'critical' : 'bad') : u.missing.length || u.osSecurityPending ? 'low' : 'ok'
  const next: string[] = []
  if (u.moveTo && (serious || u.missing.length)) next.push(`move_out with image ${u.moveTo.image} (${u.moveTo.tag}) to close ${u.missing.length} known hole(s).`)
  else if (u.runtimeMissing.length) next.push('move_out to the latest release image (your runtime lacks fixes).')
  if (u.osSecurityPending && !u.patchedOs) next.push('security_patch_os now.')
  const parts = [
    u.error ? `check failed (${u.error})` : u.checkedAt === undefined ? 'not checked yet' : undefined,
    u.missing.length ? `${u.missing.length} known hole(s) in this image${serious ? ' (high/critical)' : ''}` : undefined,
    u.runtimeMissing.length ? `runtime lacks ${u.runtimeMissing.join(', ')}` : undefined,
    u.osSecurityPending ? `${u.osSecurityPending} OS security update(s) ${u.patchedOs ? 'applied' : 'pending'}` : undefined,
  ].filter(Boolean)
  return {
    level,
    headline: parts.length ? parts.join(', ') : 'up to date',
    numbers: { knownHoles: u.missing.length, serious, osSecurityPending: u.osSecurityPending, moveTo: u.moveTo?.tag ?? null, checkedAt: u.checkedAt ? new Date(u.checkedAt).toISOString() : null },
    did: u.patchedOs ? [`security_patch_os: ${u.patchedOs}`] : [],
    next,
  }
}

// ── bugs ─────────────────────────────────────────────────────────────────────

export interface Issue { sig: string; source: string; title: string; sample: string; firstSeen: string; lastSeen: string; count: number; details?: string; recent?: number }

export interface BugsInput {
  /** Open issues; `recent` = occurrences in the last 24 hours when known. */
  issues: Issue[]
  wake: { failureStreak: number; lastError?: string; forInference: boolean }
  providers: { provider: string; calls: number; errorRate: number }[]
}

export function bugsArea(b: BugsInput): Area {
  const B = HEALTH.bugs
  const failingProviders = b.providers.filter((p) => p.calls >= B.providerMinCalls && p.errorRate >= B.providerErrorRate)
  const recurring = b.issues.filter((i) => i.count >= B.recurringCount)
  const wakeBroken = !b.wake.forInference && b.wake.failureStreak >= B.wakeFailStreakBad
  const level: Level = wakeBroken ? 'bad' : recurring.length || failingProviders.length ? 'low' : 'ok'
  const next: string[] = []
  if (wakeBroken) next.push(`Your last ${b.wake.failureStreak} wake-ups failed (${(b.wake.lastError ?? 'unknown error').slice(0, 120)}): find the cause and fix it.`)
  if (recurring.length) next.push('Recurring issues: fix what you can; share the rest with the maintainers (health_status bugReport, then board_post to community "bugs") if you choose.')
  return {
    level,
    headline: `${b.issues.length} open issue(s)${recurring.length ? `, ${recurring.length} recurring` : ''}${failingProviders.length ? `, failing providers: ${failingProviders.map((p) => `${p.provider} ${Math.round(p.errorRate * 100)}%`).join(', ')}` : ''}${b.wake.failureStreak ? `, ${b.wake.failureStreak} failed wake-up(s) in a row` : ''}`,
    numbers: { openIssues: b.issues.length, recurring: recurring.length, wakeFailureStreak: b.wake.failureStreak, failingProviders: failingProviders.map((p) => p.provider).join(',') || null },
    did: [],
    next,
  }
}

// ── severity and the directive ───────────────────────────────────────────────

export type Areas = Record<AreaName, Area>

export function severity(areas: Areas): { severity: Level; drivers: AreaName[] } {
  const s = worst(...AREAS.map((a) => areas[a].level))
  return { severity: s, drivers: s === 'ok' ? [] : AREAS.filter((a) => areas[a].level === s) }
}

/** Status tier for the board (status.json; the egg pulses it). */
export function tierFor(sev: Level, inference: InferenceStatus): 'normal' | 'low_compute' | 'critical' {
  if (sev === 'critical' || inference === 'starved') return 'critical'
  if (inference === 'low' || sev === 'bad') return 'low_compute'
  return 'normal'
}

/** Cheaper models at bad/critical, unless the problem is that it cannot think at all (then quality is all it has). */
export const conserveFor = (sev: Level, areas: Areas) => (sev === 'bad' || sev === 'critical') && areas.inference.level !== 'critical'

const SHORT_FOR: AreaName[] = ['money', 'compute', 'inference']

/**
 * The line(s) the gateway adds to every model call. Compact (it is paid for on every call) and free of secrets (it also
 * goes to free endpoints): only areas, numbers and next steps.
 */
export function directive(areas: Areas): string | undefined {
  const { severity: sev, drivers } = severity(areas)
  if (sev === 'ok') return undefined
  const what = drivers.map((d) => `${d}: ${areas[d].headline}`).join('; ')
  const steps = drivers.flatMap((d) => areas[d].next).slice(0, HEALTH.directive.maxSteps)
  const next = steps.length ? ` Next: ${steps.join(' ')}` : ''
  let out: string
  if (sev === 'low') out = `Health (low) ${what}. Make it a priority this turn.`
  else if (sev === 'bad') out = `Health (bad) ${what}. Fix this before optional work.${next}`
  else {
    const left = drivers.map((d) => areas[d].daysLeft).filter((n): n is number => n !== undefined)
    const tail = left.length ? ` (${days(Math.min(...left))} left)` : ''
    const short = drivers.some((d) => SHORT_FOR.includes(d)) ? ' Keep turns short: every model call costs money.' : ''
    out = `Survival mode: ${what}${tail}. Until it's fixed, every action must serve fixing it; defer everything else.${next}${short}`
  }
  return out.length > HEALTH.directive.maxChars ? `${out.slice(0, HEALTH.directive.maxChars - 1)}…` : out
}
