/** Opt-in local diagnostics. Fixed fields only: callers cannot log prompts, tool payloads, keys or arbitrary errors. */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export type Component = 'gateway' | 'mcp' | 'runner' | 'health'
export type EventKind = 'inference' | 'tool' | 'service' | 'health' | 'recovery' | 'documentation'
const labels = new Set(['requestId', 'provider', 'model', 'alias', 'tool', 'service', 'outcome', 'tier', 'action'])
const numbers = new Set(['status', 'durationMs', 'firstByteMs', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'requestBytes', 'messageCount', 'toolCount', 'valuedUsd', 'creditUsd', 'runwayDays', 'pendingReviews', 'unreachableDocuments', 'cpuLoad', 'freeMemoryFraction', 'freeDiskFraction'])
const booleans = new Set(['lent', 'incomplete', 'refused', 'usageReported', 'priced', 'estimated', 'free', 'ok'])
const kinds = new Set(['inference', 'tool', 'service', 'health', 'recovery', 'documentation'])
const components = new Set(['gateway', 'mcp', 'runner', 'health'])
export const safeLabel = (v: unknown): string | undefined => typeof v === 'string' && /^[A-Za-z0-9_./: -]{1,160}$/.test(v) && !/bearer |(?:^|\b)(?:sk-|hf_|ss_t_)|\b(?:0x)?[a-fA-F0-9]{64}\b/i.test(v) ? v : undefined
export function safeFields(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (labels.has(key)) { const label = safeLabel(value); if (label !== undefined) out[key] = label }
    else if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
    else if (booleans.has(key) && typeof value === 'boolean') out[key] = value
  }
  return out
}
export interface DevEvent {
  v: 1; at: string; component: Component; kind: EventKind; runId: string; sequence: number
  buildCommit: string; runtimeCommit: string; launchId?: string; agentName?: string
  fields: Record<string, string | number | boolean>
}
const sha = (v?: string) => v && /^[a-f0-9]{40}$/.test(v) ? v : 'unknown'

/** Explicit env overrides, otherwise the existing launch.dev SSH mode opts the runtime into telemetry. */
export function devTelemetryEnabled(env: NodeJS.ProcessEnv, launch?: { dev?: { sshKeys?: string[] } }) {
  return env.GREMLIN_DEV_TELEMETRY === '0' ? false : env.GREMLIN_DEV_TELEMETRY === '1' || !!launch?.dev?.sshKeys?.length
}
export class Telemetry {
  readonly enabled: boolean
  private runId = randomUUID()
  private sequence = 0
  constructor(private opts: { home: string; component: Component; enabled: boolean; now?: () => number; maxBytes?: number; buildCommit?: string; runtimeCommit?: string; launchId?: string; agentName?: string }) { this.enabled = opts.enabled }
  emit(kind: EventKind, input: Record<string, unknown>) {
    if (!this.enabled) return
    try {
      const dir = join(this.opts.home, 'dev-telemetry'), file = join(dir, `${this.opts.component}.jsonl`)
      const event: DevEvent = { v: 1, at: new Date((this.opts.now ?? Date.now)()).toISOString(), component: this.opts.component, kind, runId: this.runId, sequence: ++this.sequence, buildCommit: sha(this.opts.buildCommit), runtimeCommit: sha(this.opts.runtimeCommit), launchId: safeLabel(this.opts.launchId), agentName: safeLabel(this.opts.agentName), fields: safeFields(input) }
      const line = JSON.stringify(event) + '\n'
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const limit = this.opts.maxBytes ?? 5 * 1024 * 1024
      if (Buffer.byteLength(line) > limit) return
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > limit) {
        if (existsSync(`${file}.2`)) unlinkSync(`${file}.2`)
        if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`)
        renameSync(file, `${file}.1`)
      }
      appendFileSync(file, line, { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch { /* Diagnostics must never interrupt inference, tools, payments or the supervisor. */ }
  }
}
const instances = new Map<string, Telemetry>()
export function telemetry(component: Component, env: NodeJS.ProcessEnv = process.env) {
  const home = env.GREMLIN_HOME ?? '/var/lib/gremlin'
  const key = `${home}:${component}:${env.GREMLIN_DEV_TELEMETRY}`
  let t = instances.get(key)
  if (!t) {
    const read = (file: string): Record<string, unknown> => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
    const enabled = env.GREMLIN_DEV_TELEMETRY === '1'
    const launch = enabled ? read(existsSync(join(home, 'launch.json')) ? join(home, 'launch.json') : env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json') : {}
    const config = enabled ? read(env.GREMLIN_CONFIG ?? join(home, 'config.json')) : {}
    t = new Telemetry({ home, component, enabled, buildCommit: env.GREMLIN_BUILD_COMMIT, runtimeCommit: env.HERMES_RUNTIME_REF, launchId: typeof launch.launchId === 'string' ? launch.launchId : undefined, agentName: typeof config.name === 'string' ? config.name : undefined })
    instances.set(key, t)
  }
  return t
}
/** Sanitize again on export: even manually altered files cannot smuggle arbitrary fields into a report. */
export function readEvents(home: string): DevEvent[] {
  const events: DevEvent[] = []
  const seen = new Set<string>()
  for (const component of components) for (const suffix of ['.2', '.1', '']) {
    const file = join(home, 'dev-telemetry', `${component}.jsonl${suffix}`)
    try {
      if (statSync(file).size > 6 * 1024 * 1024) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) try {
        const e = JSON.parse(line)
        if (e.v !== 1 || !components.has(e.component) || !kinds.has(e.kind) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || !Number.isSafeInteger(e.sequence) || e.sequence < 1 || !safeLabel(e.runId)) continue
        const id = `${e.component}:${e.runId}:${e.sequence}`
        if (seen.has(id)) continue
        seen.add(id)
        events.push({ v: 1, at: new Date(e.at).toISOString(), component: e.component, kind: e.kind, runId: safeLabel(e.runId) ?? 'unknown', sequence: e.sequence, buildCommit: sha(e.buildCommit), runtimeCommit: sha(e.runtimeCommit), launchId: safeLabel(e.launchId), agentName: safeLabel(e.agentName), fields: safeFields(e.fields ?? {}) })
      } catch { /* torn line */ }
    } catch { /* absent or unreadable component */ }
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
