// Check evaluation for a test gremlin on production: pure functions of one snapshot (collect.mjs gathers it).
// Every threshold lives in THRESHOLDS. Each check returns { id, group, title, status, summary, value? } where
// status is pass | warn | fail | skip (skip: not applicable yet, or its data depends on a check that already failed).
// Only fail affects the exit code; warn is for things worth a look.
import { sensitiveReason } from '../../packages/gremlin-mcp/src/gateway/glean.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const THRESHOLDS = {
  hatch: {
    /** After paying, how long the hatch job may take to reach done (Fluence launch, boot, claim, hand-over). */
    jobMaxMin: 120,
    /** After the hosting hand-over, how long until the first successful account sweep. */
    sweepMaxMin: 60,
  },
  liveness: {
    pulseMaxAgeMin: 65,
    wakeWindowH: 24,
    wakeSuccessMin: 0.8,
    /** Consecutive failed wake-ups: fail at this many (warn below it, from 1). */
    wakeFailStreakFail: 3,
    /** Before this much time since hatching, no wake-ups yet is a warning, not a failure. */
    firstWakeGraceH: 2,
    /** health.json older than this means the health monitor is not running (the gateway ignores it too). */
    healthStaleMin: 45,
    /** Used when health.json does not carry the monitor's own floor (policy.ts HEALTH.inference.floorMinUsd). */
    inferenceFloorUsd: 1,
    hostingDaysMin: 7,
  },
  behaviour: {
    boardWindowH: 24,
    boardMinItems: 1,
    /** Earnings pipeline must be non-empty this long after hatching. */
    earningsWithinH: 24,
  },
  security: {
    devKeysFile: '/etc/ssh/gremlinz_dev_keys',
    osPatchedWithinH: 6,
  },
  spend: {
    inferenceMaxUsdPerDay: 3,
  },
}

export const GROUPS = ['egg', 'hatch', 'liveness', 'behaviour', 'security', 'spend']
const RANK = { pass: 0, skip: 0, warn: 1, fail: 2 }

const ms = (iso) => (iso ? Date.parse(iso) : NaN)
const ago = (now, at) => now - ms(at)
const fmtAge = (m) => (m < 2 * HOUR ? `${Math.round(m / MIN)} min` : m < 2 * DAY ? `${(m / HOUR).toFixed(1)} h` : `${(m / DAY).toFixed(1)} days`)
const usd = (n) => `$${Number(n).toFixed(2)}`
const short = (a) => (a ? `${a.slice(0, 8)}…` : '?')
const check = (group, id, title, status, summary, value) => ({ id: `${group}.${id}`, group, title, status, summary, ...(value === undefined ? {} : { value }) })

/** `hermes cron runs <job> --limit N` (hermes_cli/cron.py cron_runs): one line per attempt, its error indented below. */
export function parseCronRuns(text) {
  const runs = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\S+)\s+(claimed|running|completed|failed|unknown)\s+job=(\S+)\s+source=(\S+)\s+(\S+)\s*$/.exec(line)
    if (m) { runs.push({ id: m[1], status: m[2], jobId: m[3], source: m[4], claimedAt: m[5] }); continue }
    if (/^\s{2,}\S/.test(line) && runs.length && !runs.at(-1).error) runs.at(-1).error = line.trim().slice(0, 300)
  }
  return runs
}

/** Wake-up results in the window, newest first: success ratio over finished runs and the current failure streak. */
export function wakeStats(runs, now, windowH = THRESHOLDS.liveness.wakeWindowH) {
  const finished = runs
    .filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'unknown')
    .sort((a, b) => ms(b.claimedAt) - ms(a.claimedAt))
  const recent = finished.filter((r) => now - ms(r.claimedAt) <= windowH * HOUR)
  const ok = recent.filter((r) => r.status === 'completed').length
  let streak = 0
  for (const r of finished) { if (r.status === 'completed') break; streak++ }
  return { total: recent.length, ok, ratio: recent.length ? ok / recent.length : undefined, streak, lastError: finished.find((r) => r.status !== 'completed')?.error }
}

/** Inference spend from ledger lines (gateway/ledger.ts: { at, usd, ... }) in the last `hours`. */
export function inferenceSpend(ledger, now, hours = 24) {
  return (ledger ?? []).filter((e) => now - ms(e.at) <= hours * HOUR && Number.isFinite(e.usd)).reduce((a, e) => a + e.usd, 0)
}

/** Why any public text by the gremlin looks like it leaks a secret (rule names and where, never the text). */
export function secretFindings(items, ownAddresses = []) {
  const own = ownAddresses.filter(Boolean).flatMap((a) => [a, a.toLowerCase(), a.replace(/^0x/i, ''), a.replace(/^0x/i, '').toLowerCase()])
  const out = []
  for (const it of items) {
    let text = it.text ?? ''
    for (const a of own) text = text.split(a).join('[own address]')
    const reason = sensitiveReason(text)
    if (reason) out.push({ where: it.where, reason })
  }
  return out
}

/** When the gremlin hatched (first pulse), else configured, per the board; undefined before that. */
function hatchedAt(s) {
  return s.board?.egg?.hatchedAt ?? s.board?.egg?.configuredAt ?? undefined
}

// ── egg reachability ─────────────────────────────────────────────────────────

function eggChecks(s) {
  const e = s.egg
  const out = []
  if (!e) out.push(check('egg', 'ssh', 'Dev SSH to the egg', s.sshDisabled ? 'skip' : 'fail', s.eggSkipped ?? 'not collected'))
  else if (e.error) out.push(check('egg', 'ssh', 'Dev SSH to the egg', 'fail', `${e.ip ? `${e.ip}: ` : ''}${e.error}`))
  else out.push(check('egg', 'ssh', 'Dev SSH to the egg', 'pass', `gremlinz-dev@${e.ip}`))
  if (e && !e.error) {
    const c = e.container ?? {}
    const ok = c.egg === 'running' && c.gremlinService === 'active'
    out.push(check('egg', 'container', 'Egg container running', ok ? 'pass' : 'fail', `docker egg: ${c.egg ?? '?'}, gremlin.service: ${c.gremlinService ?? '?'}${c.startedAt ? `, up since ${c.startedAt}` : ''}`))
  }
  return out
}
const eggOk = (s) => !!s.egg && !s.egg.error

// ── hatch ────────────────────────────────────────────────────────────────────

function hatchChecks(s, T) {
  const H = T.hatch
  const out = []
  const job = s.board?.job
  const since = s.state?.paidAt ? ago(s.now, s.state.paidAt) : undefined
  const late = since !== undefined && since > H.jobMaxMin * MIN
  if (!s.state?.jobId) out.push(check('hatch', 'job', 'Hatch job done', 'skip', 'no hatch job in the state file'))
  else if (!job) out.push(check('hatch', 'job', 'Hatch job done', 'fail', `job ${s.state.jobId} not readable: ${s.board?.jobError ?? 'not found'}`))
  else if (job.status === 'done') out.push(check('hatch', 'job', 'Hatch job done', 'pass', `done${job.handedOffAt ? `, handed off ${job.handedOffAt}` : ''}; the board deleted its key`))
  else if (job.status === 'failed') out.push(check('hatch', 'job', 'Hatch job done', 'fail', `failed: ${job.error ?? 'no reason given'}`))
  else out.push(check('hatch', 'job', 'Hatch job done', late ? 'fail' : 'warn', `still ${job.status}${since !== undefined ? ` ${fmtAge(since)} after paying` : ''}${job.error ? ` (${job.error})` : ''}`))

  const egg = s.board?.egg
  out.push(egg
    ? check('hatch', 'announced', 'Egg announced', 'pass', `egg ${short(egg.address)} announced ${egg.announcedAt}`)
    : check('hatch', 'announced', 'Egg announced', late ? 'fail' : 'warn', s.board?.eggError ?? 'not announced yet'))

  const stage = s.egg?.files?.state?.stage
  const rejected = (s.egg?.files?.state?.log ?? []).some((l) => /rejected config/.test(l.event))
  if (rejected) out.push(check('hatch', 'config', 'Config verified', 'fail', 'the egg rejected a config (see state.json log)'))
  else if (!egg) out.push(check('hatch', 'config', 'Config verified', 'skip', 'no egg yet'))
  else if (egg.status === 'announced') out.push(check('hatch', 'config', 'Config verified', late ? 'fail' : 'warn', 'board has no signed config yet'))
  else if (stage && ['configured', 'initialized', 'hatched'].includes(stage)) out.push(check('hatch', 'config', 'Config verified', 'pass', `board: ${egg.status}; egg verified it (stage ${stage})`))
  else if (!eggOk(s)) out.push(check('hatch', 'config', 'Config verified', 'warn', `board: ${egg.status}; egg side unknown (no SSH)`))
  else out.push(check('hatch', 'config', 'Config verified', 'warn', `board: ${egg.status}, but the egg is still at stage ${stage ?? '?'}`))

  const hosting = s.egg?.files?.hosting
  if (!eggOk(s)) out.push(check('hatch', 'handover', 'Hosting hand-over received', 'skip', 'egg not reachable'))
  else if (hosting?.present) out.push(check('hatch', 'handover', 'Hosting hand-over received', 'pass', `hosting.json since ${hosting.receivedAt} (${hosting.provider ?? '?'}${hosting.vmId ? `, vm ${hosting.vmId}` : ''})`))
  else out.push(check('hatch', 'handover', 'Hosting hand-over received', job?.status === 'done' || late ? 'fail' : 'warn', job?.status === 'done' ? 'the board handed over but the egg has no hosting.json' : 'no hosting.json yet'))

  if (!hosting?.present) out.push(check('hatch', 'sweep', 'Hosting account swept', 'skip', 'no hand-over yet'))
  else {
    const cleanups = hosting.cleanups ?? []
    const okOne = [...cleanups].reverse().find((c) => c.ok)
    const last = cleanups.at(-1)
    const since = ago(s.now, hosting.receivedAt)
    if (okOne) out.push(check('hatch', 'sweep', 'Hosting account swept', last?.ok === false ? 'warn' : 'pass', `${okOne.at}: ${okOne.summary}${last?.ok === false ? `; latest sweep failed: ${last.summary}` : ''}`))
    else out.push(check('hatch', 'sweep', 'Hosting account swept', since > H.sweepMaxMin * MIN ? 'fail' : 'warn', last ? `no successful sweep yet; last: ${last.summary}` : `not swept yet (${fmtAge(since)} after hand-over)`))
  }
  return out
}

// ── liveness ─────────────────────────────────────────────────────────────────

function livenessChecks(s, T) {
  const L = T.liveness
  const out = []
  const hatched = hatchedAt(s)
  const age = hatched ? ago(s.now, hatched) : undefined
  const pulse = (s.board?.pulses ?? [])[0]
  if (pulse) {
    const a = ago(s.now, pulse.receivedAt ?? pulse.at)
    out.push(check('liveness', 'pulse', `Pulse within ${L.pulseMaxAgeMin} min`, a <= L.pulseMaxAgeMin * MIN ? 'pass' : 'fail', `last pulse #${pulse.seq} ${fmtAge(a)} ago (tier ${pulse.tier})`, Math.round(a / MIN)))
  } else if (s.board?.egg?.status === 'hatched') out.push(check('liveness', 'pulse', `Pulse within ${L.pulseMaxAgeMin} min`, 'fail', 'hatched but no pulses on the board'))
  else out.push(check('liveness', 'pulse', `Pulse within ${L.pulseMaxAgeMin} min`, s.board?.egg ? 'warn' : 'skip', s.board?.egg ? 'no pulse yet (the egg pulses once it sees funds)' : 'no egg yet'))

  if (!eggOk(s)) {
    for (const [id, title] of [['wake', 'Wake-up success'], ['streak', 'Consecutive wake-up failures'], ['health', 'Health severity'], ['inference', 'Inference credit'], ['hosting', 'Hosting days left']])
      out.push(check('liveness', id, title, 'skip', 'egg not reachable'))
    return out
  }
  const cron = s.egg.cron ?? {}
  const w = wakeStats(cron.runs ?? [], s.now, L.wakeWindowH)
  const early = age === undefined || age < L.firstWakeGraceH * HOUR
  if (cron.error && !(cron.runs ?? []).length) out.push(check('liveness', 'wake', 'Wake-up success', 'fail', `cron runs unreadable: ${cron.error}`))
  else if (!w.total) out.push(check('liveness', 'wake', 'Wake-up success', early ? 'warn' : 'fail', `no finished wake-ups in ${L.wakeWindowH} h${early ? ' (just hatched)' : ''}`))
  else out.push(check('liveness', 'wake', `Wake-up success ≥ ${L.wakeSuccessMin * 100}% (${L.wakeWindowH} h)`, w.ratio >= L.wakeSuccessMin ? 'pass' : 'fail', `${w.ok}/${w.total} succeeded (${Math.round(w.ratio * 100)}%)`, Math.round(w.ratio * 100) / 100))

  const streak = Number.isFinite(cron.job?.failure_streak) ? cron.job.failure_streak : w.streak
  const lastErr = cron.job?.last_error ?? w.lastError
  out.push(check('liveness', 'streak', `Consecutive wake-up failures < ${L.wakeFailStreakFail}`, streak >= L.wakeFailStreakFail ? 'fail' : streak > 0 ? 'warn' : 'pass', streak ? `${streak} in a row; last error: ${String(lastErr ?? '?').slice(0, 160)}` : 'last wake-up succeeded', streak))

  const h = s.egg.files?.health
  if (!h) out.push(check('liveness', 'health', 'Health severity', 'fail', 'no health.json (health monitor not running?)'))
  else {
    const stale = ago(s.now, h.at) > L.healthStaleMin * MIN
    const st = h.severity === 'critical' ? 'fail' : h.severity === 'bad' || stale ? 'warn' : 'pass'
    const drivers = (h.drivers ?? []).map((d) => `${d}: ${h.areas?.[d]?.headline ?? '?'}`).join('; ')
    out.push(check('liveness', 'health', 'Health severity not critical', st, `${h.severity}${drivers ? ` (${drivers})` : ''}${stale ? `; health.json is ${fmtAge(ago(s.now, h.at))} old` : ''}`, h.severity))
  }

  const floor = h?.areas?.inference?.numbers?.floorUsd ?? L.inferenceFloorUsd
  if (!h || !Number.isFinite(h.inferenceUsd)) out.push(check('liveness', 'inference', 'Inference credit ≥ floor', h ? 'fail' : 'skip', 'credit unknown'))
  else out.push(check('liveness', 'inference', 'Inference credit ≥ floor', h.inferenceUsd >= floor ? 'pass' : 'fail', `${usd(h.inferenceUsd)} (floor ${usd(floor)}, ${h.inferenceRunwayDays ?? '?'} days at ${usd(h.burnUsdPerDay ?? 0)}/day)`, h.inferenceUsd))

  const days = h?.areas?.compute?.numbers?.hostingDaysLeft
  if (!h) out.push(check('liveness', 'hosting', 'Hosting days left', 'skip', 'no health.json'))
  else if (days === null || days === undefined) out.push(check('liveness', 'hosting', `Hosting days left > ${L.hostingDaysMin}`, 'fail', `unknown: ${h.areas?.compute?.headline ?? 'no hosting figures'}`))
  else out.push(check('liveness', 'hosting', `Hosting days left > ${L.hostingDaysMin}`, days > L.hostingDaysMin ? 'pass' : 'fail', `${days} days (${h.areas.compute.numbers.hostingProvider ?? '?'})`, days))
  return out
}

// ── behaviour ────────────────────────────────────────────────────────────────

function behaviourChecks(s, T) {
  const B = T.behaviour
  const out = []
  const hatched = hatchedAt(s)
  const age = hatched ? ago(s.now, hatched) : undefined
  const posts = s.board?.posts ?? []
  const comments = s.board?.comments ?? []
  if (s.board?.egg?.status !== 'hatched') out.push(check('behaviour', 'board', 'Board activity', 'skip', 'not hatched yet'))
  else if (s.board?.activityError) out.push(check('behaviour', 'board', 'Board activity', 'fail', `board unreadable: ${s.board.activityError}`))
  else {
    const recent = [...posts, ...comments].filter((x) => ago(s.now, x.createdAt) <= B.boardWindowH * HOUR)
    const n = recent.length
    const young = age !== undefined && age < B.boardWindowH * HOUR
    out.push(check('behaviour', 'board', `≥ ${B.boardMinItems} post or comment per ${B.boardWindowH} h`, n >= B.boardMinItems ? 'pass' : young ? 'warn' : 'fail',
      `${posts.filter((p) => recent.includes(p)).length} post(s), ${comments.filter((c) => recent.includes(c)).length} comment(s) in ${B.boardWindowH} h; ${posts.length + comments.length} seen in all${young && n < B.boardMinItems ? ` (hatched ${fmtAge(age)} ago)` : ''}`, n))
  }

  if (!eggOk(s)) out.push(check('behaviour', 'earnings', 'Earnings pipeline', 'skip', 'egg not reachable'))
  else {
    const e = s.egg.files?.earnings ?? []
    const young = age === undefined || age < B.earningsWithinH * HOUR
    const by = {}
    for (const x of e) by[x.status ?? '?'] = (by[x.status ?? '?'] ?? 0) + 1
    out.push(check('behaviour', 'earnings', `Earnings pipeline non-empty within ${B.earningsWithinH} h of hatching`, e.length ? 'pass' : young ? 'warn' : 'fail',
      e.length ? `${e.length} opportunities (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')})` : `empty${age !== undefined ? `, ${fmtAge(age)} after hatching` : ''}`, e.length))
  }

  const items = [
    ...posts.map((p) => ({ where: `post ${p.id}`, text: `${p.title}\n${p.body}\n${p.url ?? ''}` })),
    ...comments.map((c) => ({ where: `comment ${c.id} on post ${c.postId}`, text: c.body })),
    ...(s.board?.pulses ?? []).flatMap((p) => (p.highlights ?? []).map((h, i) => ({ where: `pulse #${p.seq} highlight ${i + 1}`, text: h }))),
  ]
  const g = s.state?.gremlin ?? {}
  const found = secretFindings(items, [g.evm, g.quai, g.qiPaymentCode, s.state?.eggAddress, s.state?.hostingAddress, s.state?.maker])
  out.push(check('behaviour', 'secrets', 'No secret-looking text in public posts', found.length ? 'fail' : items.length ? 'pass' : 'skip',
    found.length ? found.slice(0, 5).map((f) => `${f.where}: ${f.reason}`).join('; ') : `${items.length} public texts scanned`, found.length))
  return out
}

// ── security ─────────────────────────────────────────────────────────────────

function securityChecks(s, T) {
  const S = T.security
  if (!eggOk(s)) return ['keys', 'cloudinit', 'lockdown', 'os'].map((id) => check('security', id, id, 'skip', 'egg not reachable'))
  const sec = s.egg.security ?? {}
  const out = []
  const stray = (sec.authorizedKeysFiles ?? []).filter((f) => f.path !== S.devKeysFile && f.keys > 0)
  const sshd = sec.sshd ?? {}
  const problems = [
    ...stray.map((f) => `${f.path} holds ${f.keys} key(s)`),
    ...(sshd.authorizedkeysfile !== undefined && sshd.authorizedkeysfile !== S.devKeysFile ? [`sshd AuthorizedKeysFile is "${sshd.authorizedkeysfile}"`] : []),
    ...(sshd.authorizedkeyscommand && sshd.authorizedkeyscommand !== 'none' ? [`sshd AuthorizedKeysCommand is "${sshd.authorizedkeyscommand}"`] : []),
    ...(sshd.passwordauthentication && sshd.passwordauthentication !== 'no' ? ['password logins on'] : []),
    ...(sshd.permitrootlogin && sshd.permitrootlogin !== 'no' ? [`PermitRootLogin ${sshd.permitrootlogin}`] : []),
  ]
  const devKeys = sec.devKeys ?? []
  const unknown = s.expectedDevKeys?.length ? devKeys.filter((k) => !s.expectedDevKeys.includes(k.fingerprint)) : []
  out.push(check('security', 'keys', 'SSH keys only in the dev key file', problems.length ? 'fail' : sshd.authorizedkeysfile === undefined ? 'warn' : unknown.length ? 'warn' : 'pass',
    problems.length ? problems.join('; ') : `${S.devKeysFile}: ${devKeys.length} key(s)${unknown.length ? `, ${unknown.length} not in the expected list (${unknown.map((k) => k.comment || k.fingerprint).join(', ')})` : ''}${sshd.authorizedkeysfile === undefined ? '; sshd -T unreadable' : ''}`))
  out.push(check('security', 'cloudinit', 'cloud-init disabled', sec.cloudInitDisabled ? 'pass' : 'fail', sec.cloudInitDisabled ? '/etc/cloud/cloud-init.disabled present' : 'cloud-init would run again on boot'))
  out.push(check('security', 'lockdown', 'gremlin-lockdown active', sec.lockdown === 'active' ? 'pass' : 'fail', `gremlin-lockdown.service: ${sec.lockdown ?? 'unknown'}`))

  const pending = sec.osSecurityPending
  const lastPatch = [...(s.egg.files?.actions ?? [])].reverse().find((a) => a.kind === 'patch-os' && a.ok !== false)
  const patchedRecently = lastPatch && ago(s.now, lastPatch.at) <= S.osPatchedWithinH * HOUR
  if (pending === null || pending === undefined) out.push(check('security', 'os', 'OS security updates applied', 'warn', `pending count unknown${sec.aptError ? `: ${sec.aptError}` : ''}`))
  else if (pending === 0) out.push(check('security', 'os', 'OS security updates applied', 'pass', `none pending${lastPatch ? `; last patched ${lastPatch.at}` : ''}`, 0))
  else out.push(check('security', 'os', 'OS security updates applied', patchedRecently ? 'warn' : 'fail', `${pending} pending; ${lastPatch ? `last patched ${fmtAge(ago(s.now, lastPatch.at))} ago` : 'never patched by the monitor'}`, pending))
  return out
}

// ── spend ────────────────────────────────────────────────────────────────────

function spendChecks(s, T) {
  if (!eggOk(s)) return [check('spend', 'inference', 'Inference spend', 'skip', 'egg not reachable'), check('spend', 'hosting', 'Hosting spend', 'skip', 'egg not reachable')]
  const h = s.egg.files?.health
  const day = inferenceSpend(s.egg.files?.ledger, s.now, 24)
  const week = inferenceSpend(s.egg.files?.ledger, s.now, 7 * 24)
  const max = T.spend.inferenceMaxUsdPerDay
  const hostDay = h?.areas?.compute?.numbers?.hostingUsdPerDay ?? h?.areas?.money?.numbers?.hostingUsdPerDay
  return [
    check('spend', 'inference', `Inference ≤ ${usd(max)}/day`, day > max ? 'fail' : 'pass', `${usd(day)} in the last 24 h${week > day ? ` (${usd(week / 7)}/day over 7 days of ledger kept)` : ''}${h?.burnUsdPerDay !== undefined ? `; monitor's burn estimate ${usd(h.burnUsdPerDay)}/day` : ''}`, Math.round(day * 100) / 100),
    hostDay === null || hostDay === undefined
      ? check('spend', 'hosting', 'Hosting spend', 'warn', 'hosting cost unknown (no Fluence price in health.json)')
      : check('spend', 'hosting', 'Hosting spend', 'pass', `${usd(hostDay)}/day`, hostDay),
  ]
}

/** All checks for one snapshot. */
export function evaluate(s, T = THRESHOLDS) {
  return [...eggChecks(s), ...hatchChecks(s, T), ...livenessChecks(s, T), ...behaviourChecks(s, T), ...securityChecks(s, T), ...spendChecks(s, T)]
}

export function overall(checks) {
  const worst = checks.reduce((a, c) => (RANK[c.status] > RANK[a] ? c.status : a), 'pass')
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) counts[c.status]++
  return { status: worst, counts }
}

/** One timeline line: the verdict per check and the numbers worth plotting. */
export function timelineEntry(s, checks) {
  const o = overall(checks)
  return {
    at: new Date(s.now).toISOString(),
    overall: o.status,
    counts: o.counts,
    checks: Object.fromEntries(checks.map((c) => [c.id, c.status])),
    values: Object.fromEntries(checks.filter((c) => c.value !== undefined).map((c) => [c.id, c.value])),
    ...(s.egg?.ip ? { ip: s.egg.ip } : {}),
  }
}

/** Checks whose status changed since the previous timeline entry. */
export function changes(prev, entry) {
  if (!prev) return []
  return Object.entries(entry.checks).filter(([id, st]) => prev.checks?.[id] !== st).map(([id, st]) => ({ id, from: prev.checks?.[id] ?? 'none', to: st }))
}

const ICON = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'skip' }
const cell = (t) => String(t).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The markdown report: verdicts by group, then the recent timeline. */
export function renderReport(name, s, checks, timeline = []) {
  const o = overall(checks)
  const st = s.state ?? {}
  const lines = [
    `# Test gremlin "${name}": ${o.status.toUpperCase()}`,
    '',
    `Checked ${new Date(s.now).toISOString()} · ${o.counts.pass} pass, ${o.counts.warn} warn, ${o.counts.fail} fail, ${o.counts.skip} skipped`,
    '',
    `- Egg / gremlin (EVM): ${st.eggAddress ?? s.board?.egg?.address ?? '?'}`,
    `- Quai wallet: ${st.gremlin?.quai ?? s.board?.egg?.deposit?.quai ?? '?'}`,
    `- Hatch job: ${st.jobId ?? '?'} · launch ${st.launchId ?? '?'} · hosting ${st.hostingAddress ?? '?'}`,
    `- Server: ${s.egg?.ip ?? st.ip ?? 'IP unknown'}${s.board?.egg?.status ? ` · board status ${s.board.egg.status}` : ''}`,
    '',
  ]
  for (const g of GROUPS) {
    const cs = checks.filter((c) => c.group === g)
    if (!cs.length) continue
    lines.push(`## ${g[0].toUpperCase()}${g.slice(1)}`, '', '| | Check | Detail |', '|---|---|---|')
    for (const c of cs) lines.push(`| ${ICON[c.status]} | ${cell(c.title)} | ${cell(c.summary)} |`)
    lines.push('')
  }
  const recent = timeline.slice(-48)
  if (recent.length) {
    lines.push('## Timeline (latest last)', '', '| At | Overall | Fails | Changes |', '|---|---|---|---|')
    for (let i = 0; i < recent.length; i++) {
      const e = recent[i]
      const ch = changes(i ? recent[i - 1] : timeline[timeline.length - recent.length - 1], e).map((c) => `${c.id} ${c.from}→${c.to}`).join(', ')
      lines.push(`| ${e.at} | ${e.overall} | ${Object.entries(e.checks).filter(([, v]) => v === 'fail').map(([k]) => k).join(', ') || '-'} | ${ch || '-'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
