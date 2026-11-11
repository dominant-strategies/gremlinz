/**
 * How health reaches decisions outside the monitor:
 * - `currentHealth` reads health.json for the gateway (cached; a stale file means the monitor is not running, so
 *   no directive rather than an outdated one);
 * - `spendGate` makes spending tools ask for a reason when health is critical. A reason is enough (the gremlin
 *   decides), and it is logged; survival spending (hosting, inference up to the monitor's target, refunds and
 *   deliveries it names as such) is never blocked.
 */
import { homeFile } from '../env.js'
import { HEALTH, type Level } from './policy.js'
import { readJson, recordAction } from './stores.js'
import type { HealthFile } from './monitor.js'

export function readHealth(now = Date.now()): HealthFile | undefined {
  const h = readJson<HealthFile>(homeFile('health.json'))
  return h && now - Date.parse(h.at) <= HEALTH.staleMs ? h : undefined
}

/** For the gateway: the directive and whether to conserve, re-read at most every `ttlMs`. */
export function healthReader(ttlMs = 30_000, now: () => number = Date.now) {
  let cache: { at: number; v?: { directive?: string; conserve?: boolean } } | undefined
  return () => {
    if (!cache || now() - cache.at > ttlMs) {
      const h = readHealth(now())
      cache = { at: now(), v: h ? { directive: h.directive, conserve: h.conserve } : undefined }
    }
    return cache.v
  }
}

export const REASON_HELP = 'Your health is critical: spending that does not serve survival needs a reason. Pass reason: how this payment helps you survive (pays hosting, buys inference, delivers or refunds paid work, earns). It is recorded.'

/** undefined: go ahead. A string: refuse with it. `survival` marks spending that is always allowed. */
export function spendGate(tool: string, o: { reason?: string; survival?: boolean; detail?: string }, now = Date.now()): string | undefined {
  const sev: Level | undefined = readHealth(now)?.severity
  if (sev !== 'critical') return undefined
  if (o.survival) return undefined
  if (!o.reason?.trim()) return `${tool} refused. ${REASON_HELP}`
  recordAction({ kind: 'spend-reason', tool, detail: o.detail, reason: o.reason.slice(0, 500) }, now)
  return undefined
}
