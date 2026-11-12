import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createHealthService } from '../src/health/service.js'
import type { HealthMonitor } from '../src/health/monitor.js'

const token = 'test-health-token-'.repeat(3)
const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close() } })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function start(check: () => Promise<unknown>, maxCheckMs = 1000) {
  const monitor = { check, miner: { stop() {}, state: () => ({ auto: false }), enable() {}, disable() {} } } as unknown as HealthMonitor
  const server = createHealthService(monitor, token, { intervalMs: 20, maxCheckMs })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const get = () => fetch(url + '/healthz', { headers: { authorization: `Bearer ${token}` } })
  return { get, url }
}

describe('independent health worker', () => {
  it('continues checking without Hermes or an MCP server and does not mistake low funds for a hang', async () => {
    let checks = 0
    const s = await start(async () => { checks++; return { severity: 'critical', status: 'starved' } })
    await wait(75)
    expect(checks).toBeGreaterThanOrEqual(2)
    expect((await s.get()).status).toBe(200)
    expect((await fetch(s.url + '/check', { method: 'POST' })).status).toBe(401)
  })
  it('detects a stalled check while its HTTP event loop still responds', async () => {
    let checks = 0
    const s = await start(() => { checks++; return new Promise(() => {}) }, 40)
    await wait(80)
    expect((await s.get()).status).toBe(503)
    expect(checks).toBe(1) // no overlapping checks or concurrent payments
  })
})
