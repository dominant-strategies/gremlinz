import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BalanceReader } from '@gremlins/treasury'
import { registerBoardTools } from './tools/board.js'
import { registerTreasuryTools } from './tools/treasury.js'
import { registerStatusTools } from './tools/status.js'
import { registerMoveOutTools } from './tools/moveout.js'
import { registerRegistryTools } from './tools/registry.js'
import { registerWalletTools } from './tools/wallet.js'
import { registerSecurityTools, type SecurityDeps } from './tools/security.js'
import { registerHashferenceTools, type HashferenceDeps } from './tools/hashference.js'
import { registerHealthTools, sharedMonitor } from './tools/health.js'
import type { HealthMonitor } from './health/monitor.js'

export interface ServerDeps {
  /** Override for tests and local development (pretend balances). */
  balances?: BalanceReader
  now?: () => number
  /** Release feed, apt and runtime checks, replaced in tests. */
  security?: SecurityDeps
  /** Hashference API and payments, replaced in tests. */
  hashference?: HashferenceDeps
  /** The health monitor (one per process; replaced in tests). */
  health?: () => HealthMonitor
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' })
  registerBoardTools(server)
  registerTreasuryTools(server, deps.balances)
  registerStatusTools(server)
  registerMoveOutTools(server, deps.now)
  registerRegistryTools(server)
  registerWalletTools(server)
  registerSecurityTools(server, { now: deps.now, ...deps.security })
  registerHashferenceTools(server, deps.hashference)
  registerHealthTools(server, deps.health ?? (() => sharedMonitor()))
  return server
}
