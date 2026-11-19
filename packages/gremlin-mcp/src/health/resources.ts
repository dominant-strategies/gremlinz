import { lstatSync, opendirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homeFile } from '../env.js'
import { localResources, type LocalResources } from './measure.js'
import { HEALTH, resourceLevels, worst } from './policy.js'
import { readJson, writeAtomic } from './stores.js'

const resourceFile = () => homeFile('resource-health.json')
const OLD_TEMP_MS = 24 * 60 * 60_000
const TEMP_REPORT = /^\.(?:health|health-tier|runtime-health|resource-health)\.json\.\d+\.[a-f0-9-]{36}\.tmp$/

interface ResourceHealth {
  at: number
  resources: LocalResources
  pressure?: 'low' | 'critical'
  lastCleanupAt?: number
  reclaimedBytes?: number
}

function pressureFor(resources: LocalResources): ResourceHealth['pressure'] {
  const levels = resourceLevels(resources)
  const level = worst(levels.disk, levels.memory)
  return level === 'ok' ? undefined : level === 'critical' ? 'critical' : 'low'
}

/** Retain active logs, work, credentials, and financial journals. Only remove known diagnostic artifacts. */
function cleanDiagnostics(now: number): number {
  const remove = (path: string, expired: (mtime: number) => boolean) => {
    try {
      const st = lstatSync(path)
      if (!st.isFile() || st.nlink !== 1 || !expired(st.mtimeMs)) return 0
      unlinkSync(path)
      return st.blocks * 512
    } catch { return 0 }
  }
  let reclaimed = 0
  try {
    const dir = homeFile('dev-telemetry')
    if (lstatSync(dir).isDirectory()) {
      for (const name of ['gateway', 'mcp', 'runner', 'health']) for (const segment of [1, 2])
        reclaimed += remove(join(dir, `${name}.jsonl.${segment}`), () => true)
    }
  } catch { /* telemetry is optional */ }
  try {
    const dir = opendirSync(homeFile(''))
    try {
      for (let i = 0; i < 1024; i++) {
        const entry = dir.readSync()
        if (!entry) break
        if (TEMP_REPORT.test(entry.name)) reclaimed += remove(homeFile(entry.name), mtime => now - mtime >= OLD_TEMP_MS)
      }
    } finally { dir.closeSync() }
  } catch { /* disk measurements and monitoring continue */ }
  return reclaimed
}

/** Called on its own timer, before health checks that may be waiting on a provider. */
export function checkResources(measure: () => LocalResources, now: number): ResourceHealth {
  const previous = readJson<ResourceHealth>(resourceFile())
  let lastCleanupAt = previous?.lastCleanupAt
  let reclaimedBytes = previous?.reclaimedBytes
  let resources = measure()
  if (resourceLevels(resources).disk !== 'ok' &&
      (lastCleanupAt === undefined || now < lastCleanupAt || now - lastCleanupAt >= HEALTH.compute.cleanupEveryMs)) {
    lastCleanupAt = now
    reclaimedBytes = cleanDiagnostics(now)
    resources = measure()
  }
  const health = { at: now, resources, pressure: pressureFor(resources), lastCleanupAt, reclaimedBytes } satisfies ResourceHealth
  try { writeAtomic(resourceFile(), health) } catch { /* a full disk must not stop pressure relief */ }
  return health
}

export function readResourcePressure(now: number): ResourceHealth['pressure'] {
  const state = readJson<ResourceHealth>(resourceFile())
  if (state && now >= state.at && now - state.at <= 4 * HEALTH.compute.resourceEveryMs)
    return state.pressure
  return pressureFor(localResources('/', homeFile(''), process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes', '/tmp'))
}
