/**
 * The health monitor's files in GREMLIN_HOME (all 0600):
 *   health.json          the latest judgement (the board's tier, the gateway's directive and health_status read it)
 *   health-state.json    what the monitor remembers between checks (since when starved, cached probes, last snapshot)
 *   health-actions.jsonl every action it took (top-ups, cooldown resets, re-runs, patches, mining), and spending reasons
 *   earnings.jsonl       the gremlin's earning pipeline, append-only (events folded by id)
 *   income.jsonl         money seen arriving (balance increases between checks)
 *   issues.jsonl         problems worth fixing, one line per signature (rewritten on change)
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homeFile } from '../env.js'
import { appendDurable, writeJsonDurable } from '@gremlins/hatch/node'
import { HEALTH, type Earning, type EarningStatus, type Issue } from './policy.js'

const DAY = 86_400_000

function jsonl<T>(file: string): T[] {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  return raw.split('\n').flatMap((l) => { if (!l.startsWith('{')) return []; try { return [JSON.parse(l) as T] } catch { return [] } })
}

export function writeAtomic(file: string, data: unknown) {
  writeJsonDurable(file, data)
}

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return undefined }
}

// ── actions ──────────────────────────────────────────────────────────────────

export interface Action { at: string; kind: string; ok?: boolean; usd?: number; detail?: string; [k: string]: unknown }

export const actionsFile = () => homeFile('health-actions.jsonl')

export function recordAction(a: Omit<Action, 'at'>, now: number = Date.now()) {
  appendDurable(actionsFile(), JSON.stringify({ at: new Date(now).toISOString(), ...a }) + '\n')
}

export const readActions = (): Action[] => jsonl<Action>(actionsFile())

// ── earnings ─────────────────────────────────────────────────────────────────

type EarningEvent = Partial<Omit<Earning, 'updatedAt'>> & { id: string; at: string; note?: string }

export const earningsFile = () => homeFile('earnings.jsonl')

/** The pipeline now: events folded by id, later fields winning. */
export function earnings(): Earning[] {
  const by = new Map<string, Earning>()
  for (const e of jsonl<EarningEvent>(earningsFile())) {
    const cur = by.get(e.id)
    const { note: _note, ...fields } = e
    if (!cur) { if (e.what && e.status) by.set(e.id, { ...(fields as Earning), updatedAt: e.at }); continue }
    by.set(e.id, { ...cur, ...Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && k !== 'at')), updatedAt: e.at })
  }
  return [...by.values()]
}

export function addEarning(e: { what: string; amountUsd?: number; counterparty?: string; status: EarningStatus; ref?: string }, now = Date.now()): Earning {
  const id = randomUUID().slice(0, 8)
  const at = new Date(now).toISOString()
  appendFileSync(earningsFile(), JSON.stringify({ id, at, ...e }) + '\n', { mode: 0o600 })
  return { id, ...e, at, updatedAt: at }
}

export function updateEarning(id: string, patch: { status?: EarningStatus; amountUsd?: number; ref?: string; note?: string }, now = Date.now()): Earning | undefined {
  if (!earnings().some((e) => e.id === id)) return undefined
  appendFileSync(earningsFile(), JSON.stringify({ id, at: new Date(now).toISOString(), ...patch }) + '\n', { mode: 0o600 })
  return earnings().find((e) => e.id === id)
}

// ── income ───────────────────────────────────────────────────────────────────

export const incomeFile = () => homeFile('income.jsonl')

export function recordIncome(usd: number, assets: string[], now = Date.now()) {
  appendFileSync(incomeFile(), JSON.stringify({ at: new Date(now).toISOString(), usd, assets }) + '\n', { mode: 0o600 })
}

export function incomeSince(sinceMs: number): number {
  return jsonl<{ at: string; usd: number }>(incomeFile()).filter((i) => Date.parse(i.at) >= sinceMs).reduce((a, i) => a + (i.usd || 0), 0)
}

/**
 * Money that arrived between two balance snapshots: per-asset increases valued in USD, less what was sent out in the
 * same window (a conversion between its own assets shows up as an increase of the target asset). Conservative: a send
 * and a donation in the same window cancel out.
 */
export function inflowUsd(before: Record<string, number>, after: Record<string, number>, sentUsd: number): { usd: number; assets: string[] } {
  const ups = Object.entries(after).filter(([k, v]) => before[k] !== undefined && v > before[k]! + 0.01)
  const usd = Math.max(0, ups.reduce((a, [k, v]) => a + v - before[k]!, 0) - sentUsd)
  return { usd: Math.round(usd * 100) / 100, assets: ups.map(([k]) => k) }
}

// ── issues ───────────────────────────────────────────────────────────────────

export const issuesFile = () => homeFile('issues.jsonl')

/** Same problem, same signature: numbers, hex and ids are masked so "timeout after 31s" and "after 45s" match. */
export function signature(source: string, message: string): string {
  const norm = message.toLowerCase().replace(/0x[0-9a-f]+/g, '0x…').replace(/[0-9a-f]{8,}/g, '…').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200)
  return createHash('sha256').update(`${source}\n${norm}`).digest('hex').slice(0, 12)
}

export function readIssues(): Issue[] {
  return jsonl<Issue>(issuesFile())
}

/** Record an occurrence: a new signature becomes an issue, a known one counts up. Returns the issue. */
export function noteIssue(o: { source: string; title: string; message: string; details?: string; at?: string }, now = Date.now()): Issue {
  const sig = signature(o.source, o.message)
  const issues = readIssues()
  const at = o.at ?? new Date(now).toISOString()
  let issue = issues.find((i) => i.sig === sig)
  if (issue) {
    // The same occurrence seen again on the next check (same timestamp) is not a new one.
    if (issue.lastSeen !== at) { issue.count++; issue.lastSeen = at > issue.lastSeen ? at : issue.lastSeen }
    if (o.details) issue.details = o.details.slice(0, 2000)
  } else {
    issue = { sig, source: o.source, title: o.title.slice(0, 160), sample: o.message.slice(0, 500), firstSeen: at, lastSeen: at, count: 1, ...(o.details ? { details: o.details.slice(0, 2000) } : {}) }
    issues.push(issue)
  }
  writeFileSync(issuesFile() + '.tmp', issues.map((i) => JSON.stringify(i)).join('\n') + '\n', { mode: 0o600 })
  renameSync(issuesFile() + '.tmp', issuesFile())
  return issue
}

export const openIssues = (now = Date.now()) => readIssues().filter((i) => Date.parse(i.lastSeen) >= now - HEALTH.bugs.openForMs)

export const topUpsSince = (sinceMs: number) => readActions().filter((a) => a.kind === 'topup' && a.ok && Date.parse(a.at) >= sinceMs).reduce((s, a) => s + (a.usd ?? 0), 0)
export const everToppedUp = () => readActions().some((a) => a.kind === 'topup' && a.ok)
export const DAY_MS = DAY
