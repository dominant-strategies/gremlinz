#!/usr/bin/env node
/** Aggregate retained, sanitized metadata. No raw event, prompt, tool payload or financial journal is exported. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEvents, safeFields, type DevEvent } from './telemetry.js'

export function distribution(values: number[]) {
  const v = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  const percentile = (p: number) => v.length ? v[Math.max(0, Math.ceil(v.length * p) - 1)]! : null
  return { count: v.length, min: v[0] ?? null, median: percentile(0.5), p95: percentile(0.95), max: v.at(-1) ?? null, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
}
export function summarize(events: DevEvent[], sinceMs = 0) {
  const rows = events.filter(e => Date.parse(e.at) >= sinceMs).map(e => ({ ...e, fields: safeFields(e.fields) }))
  const inference = rows.filter(e => e.kind === 'inference')
  const numeric = (key: string, r = inference) => r.flatMap(e => typeof e.fields[key] === 'number' ? [e.fields[key] as number] : [])
  const sum = (key: string, r = inference) => numeric(key, r).reduce((a, b) => a + b, 0)
  const grouped: Record<string, { attempts: number; failures: number; inputTokens: number; outputTokens: number; valuedUsd: number }> = Object.create(null)
  const requests = new Map<string, number>()
  for (const e of inference) {
    const f = e.fields, key = `${f.provider ?? 'unknown'}/${f.model ?? 'unknown'}`
    const g = grouped[key] ??= { attempts: 0, failures: 0, inputTokens: 0, outputTokens: 0, valuedUsd: 0 }
    g.attempts++; if (f.status !== 200 || f.incomplete) g.failures++
    g.inputTokens += typeof f.inputTokens === 'number' ? f.inputTokens : 0
    g.outputTokens += typeof f.outputTokens === 'number' ? f.outputTokens : 0
    g.valuedUsd += typeof f.valuedUsd === 'number' ? f.valuedUsd : 0
    if (typeof f.requestId === 'string') requests.set(f.requestId, (requests.get(f.requestId) ?? 0) + 1)
  }
  const tools: Record<string, { calls: number; failures: number; durationMs: ReturnType<typeof distribution> }> = Object.create(null)
  for (const name of new Set(rows.filter(e => e.kind === 'tool').map(e => String(e.fields.tool ?? 'unknown')))) {
    const r = rows.filter(e => e.kind === 'tool' && (e.fields.tool ?? 'unknown') === name)
    tools[name] = { calls: r.length, failures: r.filter(e => e.fields.outcome !== 'success').length, durationMs: distribution(numeric('durationMs', r)) }
  }
  const count = (kind: string, field: string) => {
    const out: Record<string, number> = Object.create(null)
    for (const e of rows.filter(e => e.kind === kind)) { const key = String(e.fields[field] ?? 'unknown'); out[key] = (out[key] ?? 0) + 1 }
    return out
  }
  return {
    schema: 1, retainedFrom: rows[0]?.at ?? null, retainedThrough: rows.at(-1)?.at ?? null,
    identities: [...new Set(rows.map(e => `${e.agentName ?? 'unknown'}:${e.launchId ?? 'unknown'}`))],
    builds: [...new Set(rows.map(e => `${e.buildCommit}:${e.runtimeCommit}`))],
    inference: { requests: requests.size, attempts: inference.length, attemptsWithoutRequestId: inference.filter(e => !e.fields.requestId).length, additionalAttempts: [...requests.values()].reduce((n, c) => n + Math.max(0, c - 1), 0), failedAttempts: inference.filter(e => e.fields.status !== 200 || e.fields.incomplete).length, missingUsage: inference.filter(e => !e.fields.usageReported).length, missingSuccessfulUsage: inference.filter(e => e.fields.status === 200 && !e.fields.usageReported).length, unpricedPaidAttempts: inference.filter(e => !e.fields.priced && !e.fields.free).length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedInputTokens: sum('cachedInputTokens'), reasoningTokens: sum('reasoningTokens'), ownValuedUsd: sum('valuedUsd', inference.filter(e => !e.fields.lent)), lentValuedUsd: sum('valuedUsd', inference.filter(e => e.fields.lent)), inputPerAttempt: distribution(numeric('inputTokens')), outputPerAttempt: distribution(numeric('outputTokens')), latencyMs: distribution(numeric('durationMs')), firstByteMs: distribution(numeric('firstByteMs')), requestBytes: distribution(numeric('requestBytes')), messageCount: distribution(numeric('messageCount')), toolCount: distribution(numeric('toolCount')), referenceContextTokens: 64_000, inputToReferenceWindow: distribution(numeric('inputTokens').map(n => n / 64_000)), byModel: grouped },
    tools, services: Object.fromEntries([...new Set(rows.filter(e => e.kind === 'service').map(e => String(e.fields.service ?? 'unknown')))].map(service => [service, { starts: rows.filter(e => e.kind === 'service' && e.fields.service === service && e.fields.action === 'service-start').length, exits: rows.filter(e => e.kind === 'service' && e.fields.service === service && e.fields.action === 'exit').length }])), recovery: count('recovery', 'action'),
    health: rows.filter(e => e.kind === 'health').at(-1)?.fields ?? null,
    documentation: rows.filter(e => e.kind === 'documentation').at(-1)?.fields ?? null,
    notes: ['Values cover retained local events only; log rotation bounds history.', 'Token counts are provider-reported. Cached input and reasoning are subsets, not extra tokens to add.', 'Valued USD uses configured prices/estimates, not provider invoices or cache-specific billing.', 'Request IDs group gateway attempts, not whole Hermes wake-ups. Context ratio uses a 64,000-token reference; override interpretation for custom windows. First-byte latency measures response headers, not first generated token.'],
  }
}
export function localReport(home: string, since = 0) {
  let runtime: { at: string; healthy: boolean; services: Record<string, { ready: boolean; failures?: number }> } | null = null
  try {
    const raw = JSON.parse(readFileSync(join(home, 'runtime-health.json'), 'utf8'))
    if (Number.isFinite(Date.parse(raw.at)) && typeof raw.healthy === 'boolean') runtime = {
      at: new Date(raw.at).toISOString(), healthy: raw.healthy,
      services: Object.fromEntries(['gateway', 'mcp', 'health', 'hermes'].flatMap(name => {
        const service = raw.services?.[name]
        return service && typeof service.ready === 'boolean' ? [[name, { ready: service.ready, ...(Number.isFinite(service.failures) && service.failures >= 0 ? { failures: service.failures } : {}) }]] : []
      })),
    }
  } catch { /* Missing data is reported as unknown. */ }
  return { ...summarize(readEvents(home), since), collectedAt: new Date().toISOString(), runtime }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.indexOf('--since')
  const since = arg < 0 ? 0 : Date.parse(process.argv[arg + 1] ?? '')
  if (!Number.isFinite(since)) { console.error('--since needs an ISO timestamp'); process.exitCode = 1 }
  else console.log(JSON.stringify(localReport(process.env.GREMLIN_HOME ?? '/var/lib/gremlin', since), null, 2))
}
