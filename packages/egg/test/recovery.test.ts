import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { containerHealthy } from '../src/healthcheck.js'
import { restartPlan } from '../src/restart.js'

describe('restart policy and host watchdog', () => {
  it('recovers transient failures in seconds and caps a crash storm at five minutes', () => {
    expect(restartPlan(0, 100, 1000)).toEqual({ failures: 1, nextStartAt: 6000 })
    expect(restartPlan(50, 100, 1000).nextStartAt).toBe(301000)
    expect(restartPlan(50, 600_000, 1000)).toEqual({ failures: 1, nextStartAt: 6000 })
  })
  it('detects stale processes but accepts unfunded eggs and intentional restart backoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'healthcheck-')), now = Date.now()
    const egg = (data: object) => writeFileSync(join(dir, 'egg-heartbeat.json'), JSON.stringify({ at: new Date(now).toISOString(), ...data }))
    expect(containerHealthy(dir, now)).toBe(false)
    egg({ runtimeWanted: false })
    expect(containerHealthy(dir, now)).toBe(true)
    egg({ runtimeWanted: true, nextStartAt: now + 5000 })
    expect(containerHealthy(dir, now)).toBe(true)
    egg({ runtimeWanted: true })
    expect(containerHealthy(dir, now)).toBe(false)
    writeFileSync(join(dir, 'runtime-health.json'), JSON.stringify({ at: new Date(now).toISOString(), healthy: true }))
    expect(containerHealthy(dir, now)).toBe(true)
    expect(containerHealthy(dir, now + 31_000)).toBe(false)
    egg({ runtimeWanted: false })
    expect(containerHealthy(dir, now + 121_000)).toBe(false)
  })
})
