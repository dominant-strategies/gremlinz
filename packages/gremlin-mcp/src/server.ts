import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BalanceReader } from '@gremlins/treasury'
import { registerBoardTools } from './tools/board.js'
import { registerTreasuryTools } from './tools/treasury.js'
import { registerStatusTools } from './tools/status.js'
import { registerMoveOutTools } from './tools/moveout.js'
import { registerRegistryTools } from './tools/registry.js'
import { registerWalletTools } from './tools/wallet.js'
import { registerDonationTools } from './tools/donation.js'
import { registerSecurityTools, type SecurityDeps } from './tools/security.js'
import { registerHashferenceTools, type HashferenceDeps } from './tools/hashference.js'
import { registerLentTools } from './tools/lent.js'
import { registerInferenceAccess, type AccessDeps } from './tools/inference-access.js'
import { registerHealthTools, sharedMonitor, remoteHealth } from './tools/health.js'
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
  access?: Omit<AccessDeps, 'checkHealth'>
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' })
  registerBoardTools(server)
  registerTreasuryTools(server, deps.balances)
  registerStatusTools(server)
  registerMoveOutTools(server, deps.now)
  registerRegistryTools(server)
  registerWalletTools(server)
  registerDonationTools(server)
  registerSecurityTools(server, { now: deps.now, ...deps.security })
  registerHashferenceTools(server, deps.hashference)
  registerLentTools(server)
  const monitor = deps.health ?? (() => sharedMonitor())
  registerHealthTools(server, monitor)
  registerInferenceAccess(server, { ...deps.access, checkHealth: () => process.env.GREMLIN_HEALTH_URL ? remoteHealth('/check') : monitor().check({ refresh: true }) })
  return server
}
