#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function containerHealthy(home: string, now = Date.now()): boolean {
  try {
    const egg = JSON.parse(readFileSync(join(home, 'egg-heartbeat.json'), 'utf8'))
    const age = now - Date.parse(egg.at)
    if (!Number.isFinite(age) || age < -5_000 || age > 120_000) return false
    if (!egg.runtimeWanted || now < Number(egg.nextStartAt ?? 0)) return true
    const runtime = JSON.parse(readFileSync(join(home, 'runtime-health.json'), 'utf8'))
    const runtimeAge = now - Date.parse(runtime.at)
    return runtime.healthy === true && Number.isFinite(runtimeAge) && runtimeAge >= -5_000 && runtimeAge < 30_000
  } catch { return false }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(containerHealthy(process.env.GREMLIN_HOME ?? '/var/lib/gremlin') ? 0 : 1)
