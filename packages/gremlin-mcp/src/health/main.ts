#!/usr/bin/env node
import { createHealthService } from './service.js'
import { HealthMonitor } from './monitor.js'

process.env.GREMLIN_HEALTH_EXTERNAL = '1'
const monitor = new HealthMonitor({ log: (...args) => console.log(new Date().toISOString(), ...args) })
const server = createHealthService(monitor, process.env.GREMLIN_MCP_TOKEN ?? '')
server.listen(Number(process.env.GREMLIN_HEALTH_PORT ?? 8713), '127.0.0.1')
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => {
  // The process owns the in-flight work; on restart, payment journals reconcile any uncertain transfer.
  monitor.miner.stop()
  server.close()
  process.exit(0)
})
