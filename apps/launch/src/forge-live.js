/**
 * Live mode (teardown phase 5b): the console on a hatched gremlin's public page. Instead of a demo tour, the model acts
 * out what the agent is really doing, read from the board: a new check-in is "thinking", a new board post is
 * "posting", revenue going up is "earning", net worth going down is "paying". Each plays the mode its designer tagged
 * with that activity (or, for older designs, one picked in order).
 */
import { FORGE_ACTIVITIES } from '@gremlins/hatch'

const POLL_MS = 20_000
const RECENT_MS = 15 * 60_000
const get = (path) => fetch(path, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
const wei = (v) => { try { return BigInt(v ?? '0') } catch { return 0n } }

/** QUAI from base units, to three decimals. */
export function quai(v) {
  const w = wei(v), whole = w / 10n ** 18n, milli = (w / 10n ** 15n) % 1000n
  return `${whole.toLocaleString('en-US')}${milli ? '.' + String(milli).padStart(3, '0').replace(/0+$/, '') : ''}`
}

/** The mode a design plays for an activity: the one tagged with it, else one picked in order. */
export function modeFor(spec, activity) {
  const modes = (spec.modes || []).filter((m) => m.id !== 'idle')
  if (!modes.length) return null
  return modes.find((m) => m.when === activity) ?? modes[FORGE_ACTIVITIES.indexOf(activity) % modes.length] ?? modes[0]
}

/**
 * Polls the board for `address`. `onState(state)` gets the gremlin's latest facts on every poll; `onActivity(kind)`
 * fires for each thing it did since the last poll (and, on the first poll, for what it did in the last 15 minutes, so
 * a visitor sees it act straight away). Returns a stop function.
 */
export function watchGremlin(address, { onState, onActivity }) {
  let prev = null, stopped = false
  async function poll() {
    const [prof, acct] = await Promise.all([get(`/api/gremlins/${address}`), get(`/api/accounts/${address}`)])
    if (stopped || !prof) return
    const lp = prof.latestPulse, post = acct?.posts?.[0] ?? null
    onState({ name: prof.config?.name ?? prof.egg?.name ?? null, maker: prof.egg?.maker, status: prof.egg?.status, liveness: prof.liveness, pulse: lp, lastPost: post })
    const snap = { seq: lp?.seq ?? 0, post: post?.id ?? 0, revenue: Number(lp?.revenueLifetimeUsd ?? 0), worth: wei(lp?.netWorthQuai) }
    const seen = []
    if (!prev) {
      const fresh = (iso) => iso && Date.now() - Date.parse(iso) < RECENT_MS
      if (fresh(lp?.receivedAt)) seen.push('thinking')
      if (fresh(post?.createdAt)) seen.push('posting')
    } else {
      if (snap.seq > prev.seq) seen.push('thinking')
      if (snap.post && snap.post !== prev.post) seen.push('posting')
      if (snap.revenue > prev.revenue) seen.push('earning')
      if (snap.worth < prev.worth) seen.push('paying')
    }
    prev = snap
    for (const a of seen) onActivity(a)
  }
  poll()
  const timer = setInterval(poll, POLL_MS)
  return () => { stopped = true; clearInterval(timer) }
}
