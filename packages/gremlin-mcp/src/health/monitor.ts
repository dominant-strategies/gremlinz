/**
 * The health monitor: deterministic code that keeps the gremlin able to think and tells it, in numbers, what needs
 * attention. It runs inside gremlin-mcp (which holds the keys) every 10 minutes and on demand (health_status):
 *
 * 1. measure: Hashference and Venice credit, inference burn (ledger), wallet value, hosting runway, machine resources,
 *    the wake-up job's last result, security state, recorded issues and earnings;
 * 2. act, within the caps in policy.ts: make sure a Hashference account exists; buy credit when below the floor (or on
 *    the first run, so a new gremlin starts on paid inference); after a top-up, or when a wake-up failed for lack of
 *    inference, clear the gateway's cooldown and get the wake-up re-run; apply pending OS security updates; start
 *    the miner after sustained starvation and stop it on recovery;
 * 3. judge each area (policy.ts) and write health.json (read by health_status, the gateway's directive, and dev-mode
 *    operators over SSH) and the board tier in status.json.
 *
 * Wake-up re-run: Hermes already re-runs a failed wake-up after 5, 15 and 30 minutes (retry_failures). Once the
 * monitor has fixed the cause, that pending retry succeeds, and it runs inside Hermes' own gateway with its claims and
 * environment, so nothing can run twice. Only when no retry is due soon (the ladder is spent) does the monitor ask
 * Hermes to run it now (`hermes cron run`), at most once per failed run.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homeFile, keys } from '../env.js'
import { readStatus, updateStatus } from '../status.js'
import { account, buyCredit, readKey, setupKey, type HashferenceKey } from '../hashference.js'
import type { SecurityResult } from '../tools/security.js'
import { WAKE_JOB_ID } from '../bootstrap/hermes.js'
import {
  HEALTH, bugsArea, computeArea, conserveFor, directive, earningsArea, inferenceArea, moneyArea, planTopUp, severity, tierFor, updatesArea,
  type AreaName, type Areas, type InferenceStatus, type Level,
} from './policy.js'
import { burnFromLedger, cronIncidents, localResources, reportedBalance, runnerEvents, wakeState, type LocalResources, type WakeState } from './measure.js'
import {
  DAY_MS, earnings, everToppedUp, incomeSince, inflowUsd, noteIssue, openIssues, readActions, readJson, recordAction, recordIncome, topUpsSince, writeAtomic,
} from './stores.js'
import type { HostingInfo, WalletSnapshot } from './probes.js'
import { Miner } from './miner.js'

export interface HealthFile {
  at: string
  severity: Level
  drivers: AreaName[]
  /** Exactly what the gateway adds to every model call (absent when all is well). */
  directive?: string
  /** The router prefers cheaper models. */
  conserve: boolean
  /** Inference in one word (the original contract): ok | low | starved. */
  status: InferenceStatus
  inferenceUsd: number
  burnUsdPerDay: number
  inferenceRunwayDays: number
  walletUsd?: number
  lastTopUp?: { at: string; usd: number; status?: string; tx?: string }
  lastWakeFailure?: { at?: string; error?: string; forInference: boolean }
  starvedSince?: string
  mining: { on: boolean; strategy: boolean; auto: boolean; hashrate?: number }
  areas: Areas
  /** Suggestions the monitor does not apply itself (e.g. the wake-up interval). */
  suggestions: string[]
  notes: string[]
}

interface State {
  starvedSince?: number
  rerunFor?: string
  lastPatchAt?: number
  wallet?: { at: number; snap: WalletSnapshot }
  hosting?: { at: number; info?: HostingInfo }
  /** Wallet value per asset at the last check, to see money arriving. */
  lastAssets?: Record<string, number>
  lastAssetsAt?: number
}

export interface MonitorDeps {
  now?: () => number
  hermesHome?: string
  log?: (...a: unknown[]) => void
  /** The gremlin's Quai signer, for Hashference sign-in (setupKey). */
  quaiSigner?: () => { address: string; signMessage(m: string): Promise<string> }
  hashference?: {
    fetch?: typeof fetch
    base?: string
    pay?: (to: string, amountWei: bigint) => Promise<string>
    sleep?: (ms: number) => Promise<void>
  }
  wallet?: () => Promise<WalletSnapshot>
  hosting?: () => Promise<HostingInfo | undefined>
  security?: (refresh: boolean) => Promise<SecurityResult>
  patchOs?: () => Promise<string>
  resources?: () => LocalResources
  /** Clear a provider's cooldown in the gateway (POST /admin/cooldown/reset). */
  resetCooldown?: (provider?: string) => Promise<boolean>
  /** Ask Hermes to run the wake-up now. */
  rerunWake?: () => Promise<void>
  miner?: Miner
  /** Worker name for the mining pool (default: start of the Quai address). */
  worker?: string
}

const DAY = DAY_MS

export function defaultResetCooldown(adminUrl = process.env.GREMLIN_GATEWAY_ADMIN ?? 'http://127.0.0.1:8711') {
  return async (provider?: string) => {
    const r = await fetch(`${adminUrl}/admin/cooldown/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(provider ? { provider } : {}), signal: AbortSignal.timeout(5000) })
    return r.ok
  }
}

export function defaultRerunWake(hermesBin = process.env.HERMES_BIN ?? 'hermes', hermesHome = process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes') {
  // Same OS user as Hermes (the gremlin), same home; Hermes' .env carries the MCP token. Runs detached from our loop.
  return () => new Promise<void>((resolve, reject) => {
    const c = execFile(hermesBin, ['cron', 'run', WAKE_JOB_ID], { env: { ...process.env, HERMES_HOME: hermesHome, HOME: hermesHome }, timeout: 60 * 60_000 }, () => {})
    c.once('spawn', () => resolve())
    c.once('error', reject)
  })
}

export class HealthMonitor {
  private d: MonitorDeps & { now: () => number; log: (...a: unknown[]) => void; hermesHome: string }
  private running?: Promise<HealthFile>
  readonly miner: Miner

  constructor(deps: MonitorDeps = {}) {
    this.d = { ...deps, now: deps.now ?? Date.now, log: deps.log ?? (() => {}), hermesHome: deps.hermesHome ?? process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes' }
    this.miner = deps.miner ?? new Miner({ stateFile: homeFile('mining.json'), pidFile: homeFile('miner.pid'), log: this.d.log })
  }

  /** The loop: a check now, then every HEALTH.checkEveryMs. */
  start(): () => void {
    const tick = () => void this.check().catch((e) => this.d.log('health check failed:', (e as Error).message))
    tick()
    const t = setInterval(tick, HEALTH.checkEveryMs)
    t.unref?.()
    return () => clearInterval(t)
  }

  /** One check; concurrent callers share the one in flight. `refresh` re-reads the cached probes too. */
  check(opts: { refresh?: boolean } = {}): Promise<HealthFile> {
    this.running ??= this.run(opts).finally(() => { this.running = undefined })
    return this.running
  }

  private async run({ refresh = false }: { refresh?: boolean }): Promise<HealthFile> {
    const now = this.d.now()
    const iso = new Date(now).toISOString()
    const st: State = readJson<State>(homeFile('health-state.json')) ?? {}
    const notes: string[] = []
    const did: Record<AreaName, string[]> = { compute: [], inference: [], money: [], earnings: [], updates: [], bugs: [] }
    const act = (area: AreaName, kind: string, detail: string, extra: Record<string, unknown> = {}) => {
      did[area].push(detail)
      recordAction({ kind, detail, ...extra }, now)
      this.d.log(`health: ${detail}`)
    }

    // ── measure ──
    const key = await this.ensureKey(notes)
    let hfUsd: number | undefined
    let miningUser: string | undefined
    if (key) {
      try { const a = await account(key, this.hf()); hfUsd = a.availableUsd; miningUser = a.miningUsername } catch (e) { notes.push(`Hashference balance unreadable: ${(e as Error).message.slice(0, 120)}`) }
    }
    const veniceUsd = reportedBalance(homeFile('balance-venice.json'))
    const burn = burnFromLedger(homeFile('inference-ledger.jsonl'), now)
    const wallet = await this.cached(st, 'wallet', HEALTH.walletEveryMs, refresh, () => this.d.wallet?.() ?? import('./probes.js').then((p) => p.walletSnapshot()), notes)
    const hosting = await this.cached(st, 'hosting', HEALTH.hostingEveryMs, refresh, () => this.d.hosting?.() ?? import('./probes.js').then((p) => p.hostingInfo()), notes)
    const wake = wakeState(this.d.hermesHome)
    if (wallet?.errors.length) notes.push(`wallet: ${wallet.errors.slice(0, 3).join('; ')}`)

    // ── inference: top up, unblock, re-run ──
    const inInput = {
      hashferenceUsd: hfUsd, veniceUsd, measuredBurnUsdPerDay: burn.usdPerDay, walletUsd: wallet?.totalUsd, quaiUsd: wallet?.quaiUsd,
      toppedUpLast24hUsd: topUpsSince(now - DAY), everToppedUp: everToppedUp(), wakeFailedForInference: wake.forInference,
    }
    const plan = planTopUp(inInput)
    let bought = 0
    if (plan.usd > 0 && key) {
      try {
        const p = await buyCredit(key, plan.usd, { ...this.hf(), pay: this.d.hashference?.pay ?? (await import('../tools/hashference.js')).payQuai, now: this.d.now })
        bought = plan.usd
        act('inference', 'topup', `bought $${plan.usd.toFixed(2)} of Hashference credit (${plan.why}); invoice ${p.status}`, { ok: true, usd: plan.usd, status: p.status, tx: p.tx })
        if (wallet) { wallet.totalUsd -= plan.usd; if (wallet.quaiUsd !== undefined) wallet.quaiUsd -= plan.usd; wallet.byAsset['quai:quai'] = (wallet.byAsset['quai:quai'] ?? 0) - plan.usd }
      } catch (e) {
        act('inference', 'topup', `top-up of $${plan.usd.toFixed(2)} failed: ${(e as Error).message.slice(0, 160)}`, { ok: false, usd: plan.usd })
      }
    } else if (plan.usd > 0) notes.push('top-up wanted but there is no Hashference account yet')
    if (plan.usd === 0 && (plan.firstRun || plan.creditUsd < plan.floorUsd)) notes.push(`no top-up: ${plan.why}`)

    // A paid provider benched for 30 minutes after a 402 would otherwise sit out the credit we just bought.
    const unblock = bought > 0 || (wake.forInference && plan.creditUsd >= plan.floorUsd)
    if (unblock) {
      const provider = bought > 0 ? 'hashference' : undefined
      try {
        if (await (this.d.resetCooldown ?? defaultResetCooldown())(provider)) act('inference', 'cooldown-reset', `cleared the gateway cooldown for ${provider ?? 'all providers'}`)
      } catch (e) { notes.push(`gateway cooldown reset failed: ${(e as Error).message.slice(0, 100)}`) }
      if (wake.forInference) await this.rerun(wake, st, now, act, notes)
    }

    // ── updates: OS security fixes are free and safe, so apply them ──
    let sec: SecurityResult | undefined
    try { sec = await (this.d.security ?? (async (r) => (await import('../tools/security.js')).runSecurityCheck({}, r)))(refresh) } catch (e) { notes.push(`security check failed: ${(e as Error).message.slice(0, 100)}`) }
    let patched: string | undefined
    if (sec?.summary?.osSecurityPending && now - (st.lastPatchAt ?? 0) >= HEALTH.updates.patchOsEveryMs) {
      st.lastPatchAt = now
      try {
        patched = await (this.d.patchOs ?? (async () => (await import('../tools/security.js')).patchOs()))()
        act('updates', 'patch-os', `applied ${sec.summary.osSecurityPending} pending OS security update(s): ${patched}`, { ok: true })
      } catch (e) { act('updates', 'patch-os', `OS patch failed: ${(e as Error).message.slice(0, 160)}`, { ok: false }) }
    }

    // ── income seen arriving ──
    if (wallet && st.lastAssets && st.wallet?.at !== st.lastAssetsAt) {
      // Top-ups only lower QUAI; sends are subtracted because a conversion raises the asset it lands in.
      const inflow = inflowUsd(st.lastAssets, wallet.byAsset, sentSince(st.lastAssetsAt ?? 0))
      if (inflow.usd > 0) { recordIncome(inflow.usd, inflow.assets, now); did.earnings.push(`saw $${inflow.usd.toFixed(2)} arrive (${inflow.assets.join(', ')})`) }
    }
    if (wallet && st.wallet) { st.lastAssets = { ...wallet.byAsset }; st.lastAssetsAt = st.wallet.at }

    // ── bugs: collect ──
    if (wake.lastStatus === 'error' && wake.lastError && !wake.forInference) noteIssue({ source: 'cron', title: 'wake-up failed', message: wake.lastError, at: wake.lastRunAt }, now)
    for (const inc of await cronIncidents(this.d.hermesHome)) noteIssue({ source: `cron:${inc.type}`, title: `cron job ${inc.jobId} failing`, message: inc.error, at: inc.lastSeen }, now)
    const runner = runnerEvents(homeFile('runner-events.jsonl'), now)
    for (const c of runner.crashes) noteIssue({ source: 'runner', title: `${c.child ?? 'runtime'} crashed`, message: `${c.child} exited with code ${c.code}${c.signal ? ` (${c.signal})` : ''}`, at: c.at }, now)

    // ── judge ──
    const res = (this.d.resources ?? (() => localResources(homeFile(''))))()
    const inference = inferenceArea(inInput, plan, { boughtUsd: bought, did: did.inference })
    const compute = computeArea({ hosting, diskFreeFrac: res.diskFreeFrac, memFreeFrac: res.memFreeFrac, load1: res.load1, cores: res.cores, uptimeSec: res.uptimeSec, restarts24h: runner.restarts24h })
    const hostingUsdPerDay = hosting?.hourlyUsd !== undefined ? hosting.hourlyUsd * 24 : undefined
    const money = moneyArea({ walletUsd: wallet?.totalUsd, inferenceUsd: inference.numbers.inferenceUsd as number, inferenceBurnUsdPerDay: plan.burnUsdPerDay, hostingBalanceUsd: hosting?.balanceUsd, hostingUsdPerDay })
    const runwayDays = (money.numbers.runwayDays as number | null) ?? undefined
    const earningsA = earningsArea({ opportunities: earnings(), received7dUsd: incomeSince(now - 7 * DAY), received30dUsd: incomeSince(now - 30 * DAY), burnUsdPerDay: money.numbers.burnUsdPerDay as number, runwayDays })
    const updates = updatesArea({ checkedAt: sec?.at, error: sec?.summary?.error, osSecurityPending: sec?.summary?.osSecurityPending ?? 0, missing: sec?.summary?.missing ?? [], moveTo: sec?.summary?.moveTo, runtimeMissing: sec?.summary?.runtimeMissing ?? [], runwayDays, patchedOs: patched })
    const bugs = bugsArea({ issues: openIssues(now), wake: { failureStreak: wake.failureStreak, lastError: wake.lastError, forInference: wake.forInference }, providers: burn.providers })
    const areas: Areas = { compute, inference, money, earnings: earningsA, updates, bugs }
    for (const a of Object.keys(did) as AreaName[]) if (a !== 'inference') areas[a].did.push(...did[a])

    // ── mining: last resort ──
    st.starvedSince = inference.status === 'starved' ? st.starvedSince ?? now : undefined
    const ms = this.miner.state()
    if (st.starvedSince !== undefined && now - st.starvedSince >= HEALTH.mining.autoAfterStarvedMs && !ms.auto) {
      this.miner.enable('auto', 'starved for 6 hours: no inference credit and no funds to top up')
      act('inference', 'mining-on', 'started mining to Hashference after 6 hours starved (last resort; stops once credit is back above the floor)')
    } else if (ms.auto && inference.status === 'ok') {
      this.miner.disable('auto', 'credit back above the floor')
      act('inference', 'mining-off', `stopped mining: credit back above the floor${ms.strategy ? ' (still on: you chose mining as strategy)' : ''}`)
    }
    let minerProblem: string | undefined
    try { minerProblem = this.miner.ensure(miningUser, this.d.worker ?? (key?.address ?? 'gremlin').replace(/^0x/, '').slice(0, 8)) } catch (e) { minerProblem = (e as Error).message.slice(0, 120) }
    if (minerProblem) notes.push(`mining wanted but not running: ${minerProblem}`)
    const mstate = this.miner.state()

    // ── write ──
    const { severity: sev, drivers } = severity(areas)
    const lastTop = readActions().filter((a) => a.kind === 'topup' && a.ok).at(-1)
    const suggestions: string[] = []
    if (sev === 'critical' && drivers.some((d) => d === 'money' || d === 'compute'))
      suggestions.push('Money or hosting is short: consider fewer wake-ups (GREMLIN_WAKE_MINUTES) only if earning does not need you awake; the monitor does not change the interval itself.')
    const health: HealthFile = {
      at: iso, severity: sev, drivers, ...(directive(areas) ? { directive: directive(areas) } : {}), conserve: conserveFor(sev, areas),
      status: inference.status, inferenceUsd: inference.numbers.inferenceUsd as number, burnUsdPerDay: plan.burnUsdPerDay, inferenceRunwayDays: inference.numbers.inferenceRunwayDays as number,
      ...(wallet ? { walletUsd: Math.round(wallet.totalUsd * 100) / 100 } : {}),
      ...(lastTop ? { lastTopUp: { at: lastTop.at, usd: lastTop.usd ?? 0, status: lastTop.status as string | undefined, tx: lastTop.tx as string | undefined } } : {}),
      ...(wake.lastStatus === 'error' ? { lastWakeFailure: { at: wake.lastRunAt, error: wake.lastError?.slice(0, 300), forInference: wake.forInference } } : {}),
      ...(st.starvedSince !== undefined ? { starvedSince: new Date(st.starvedSince).toISOString() } : {}),
      mining: { on: this.miner.running(), strategy: mstate.strategy, auto: mstate.auto, ...(await this.miner.hashrate().then((h) => (h === undefined ? {} : { hashrate: h }))) },
      areas, suggestions, notes,
    }
    writeAtomic(homeFile('health.json'), health)
    writeAtomic(homeFile('health-state.json'), st)
    const tier = tierFor(sev, inference.status)
    if (readStatus().tier !== tier) updateStatus({ tier })
    return health
  }

  private hf() { return { fetch: this.d.hashference?.fetch, base: this.d.hashference?.base, sleep: this.d.hashference?.sleep } }

  /** Hashference account: idempotent (an existing key is reused; signing in again returns the same workspace). */
  private async ensureKey(notes: string[]): Promise<HashferenceKey | undefined> {
    const file = homeFile('hashference.json')
    const k = readKey(file)
    if (k) return k
    try {
      const w = this.d.quaiSigner ? undefined : keys().quai
      const signer = this.d.quaiSigner?.() ?? { address: w!.address, signMessage: (m: string) => w!.signMessage(m) }
      const made = await setupKey(signer, file, { fetch: this.d.hashference?.fetch, base: this.d.hashference?.base, label: 'gremlin' })
      recordAction({ kind: 'hashference-setup', ok: true, detail: 'created the Hashference account' }, this.d.now())
      return made
    } catch (e) {
      notes.push(`Hashference setup failed: ${(e as Error).message.slice(0, 120)}`)
      return undefined
    }
  }

  private async cached<K extends 'wallet' | 'hosting'>(st: State, k: K, everyMs: number, refresh: boolean, read: () => Promise<K extends 'wallet' ? WalletSnapshot : HostingInfo | undefined>, notes: string[]) {
    const now = this.d.now()
    const c = st[k] as { at: number; snap?: WalletSnapshot; info?: HostingInfo } | undefined
    if (!refresh && c && now - c.at < everyMs) return (k === 'wallet' ? c.snap : c.info) as K extends 'wallet' ? WalletSnapshot | undefined : HostingInfo | undefined
    try {
      const v = await read()
      ;(st as Record<string, unknown>)[k] = k === 'wallet' ? { at: now, snap: v } : { at: now, info: v }
      return v as K extends 'wallet' ? WalletSnapshot | undefined : HostingInfo | undefined
    } catch (e) {
      notes.push(`${k} unreadable: ${(e as Error).message.slice(0, 120)}`)
      return (k === 'wallet' ? c?.snap : c?.info) as K extends 'wallet' ? WalletSnapshot | undefined : HostingInfo | undefined
    }
  }

  /** Get a wake-up that failed for lack of inference run again (see the header for why usually Hermes does it). */
  private async rerun(wake: WakeState, st: State, now: number, act: (a: AreaName, k: string, d: string) => void, notes: string[]) {
    const failed = wake.lastRunAt ?? 'unknown'
    if (st.rerunFor === failed) return
    const next = wake.nextRunAt ? Date.parse(wake.nextRunAt) : NaN
    if (Number.isFinite(next) && next - now <= 20 * 60_000) {
      st.rerunFor = failed
      act('inference', 'rerun-wake', `left the re-run to Hermes' retry at ${wake.nextRunAt} (inference is unblocked)`)
      return
    }
    try {
      await (this.d.rerunWake ?? defaultRerunWake())()
      st.rerunFor = failed
      act('inference', 'rerun-wake', 'asked Hermes to run the failed wake-up again now')
    } catch (e) { notes.push(`could not re-run the wake-up: ${(e as Error).message.slice(0, 100)}`) }
  }
}

/** USD sent out (send log) since `sinceMs`, so a conversion or payment isn't mistaken for income. */
function sentSince(sinceMs: number): number {
  let sends = ''
  try { sends = readFileSync(homeFile('sends.jsonl'), 'utf8') } catch { /* none yet */ }
  return sends.split('\n').flatMap((l) => { try { const s = JSON.parse(l) as { at: string; usd?: number; dryRun?: boolean }; return !s.dryRun && Date.parse(s.at) >= sinceMs ? [s.usd ?? 0] : [] } catch { return [] } }).reduce((a, b) => a + b, 0)
}
