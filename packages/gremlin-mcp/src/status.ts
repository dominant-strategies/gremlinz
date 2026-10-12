/**
 * The runtime's half of each pulse. The egg posts pulses (it holds the balance reader); the runtime contributes
 * what only it knows through GREMLIN_HOME/status.json, written atomically. Same contract as before (egg.ts RuntimeStatus).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homeFile } from './env.js'

export interface RuntimeStatus {
  tier?: 'normal' | 'low_compute' | 'critical' | 'dead'
  goals?: { goal: string; progressPct: number; note?: string }[]
  /** Most recent first, at most 5. */
  highlights?: string[]
  models?: string[]
  host?: string
  updatedAt?: string
}

export function readStatus(): RuntimeStatus {
  try {
    return JSON.parse(readFileSync(homeFile('status.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function updateStatus(patch: RuntimeStatus & { highlight?: string }): RuntimeStatus {
  const { highlight, ...rest } = patch
  const cur = readStatus()
  const next: RuntimeStatus = {
    ...cur,
    ...rest,
    highlights: highlight ? [highlight.slice(0, 280), ...(cur.highlights ?? [])].slice(0, 5) : cur.highlights,
    updatedAt: new Date().toISOString(),
  }
  const file = homeFile('status.json')
  writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(file + '.tmp', file)
  return next
}
