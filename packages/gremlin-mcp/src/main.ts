#!/usr/bin/env node
/** stdio entry point; Hermes launches it from config.yaml (mcp_servers.gremlin). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { devBalances } from './dev.js'

if (process.argv.includes('--http')) {
  // Runs as the gremlin's OS user; Hermes (another user) connects with the token. Localhost only.
  const { createHttpServer } = await import('./http.js')
  const token = process.env.GREMLIN_MCP_TOKEN ?? ''
  const port = Number(process.env.GREMLIN_MCP_PORT ?? 8712)
  // The health monitor lives here: this is the long-lived process that holds the keys (gremlin-run starts it).
  if (process.env.GREMLIN_HEALTH !== '0') {
    const [{ sharedMonitor }, { HealthMonitor }] = await Promise.all([import('./tools/health.js'), import('./health/monitor.js')])
    sharedMonitor(() => new HealthMonitor({ log: (...a) => console.log(new Date().toISOString(), ...a) })).start()
  }
  createHttpServer({ token, deps: { balances: devBalances() } }).listen(port, '127.0.0.1', () => console.log(`gremlin-mcp on http://127.0.0.1:${port}/mcp`))
} else {
  await createServer({ balances: devBalances() }).connect(new StdioServerTransport())
}
