import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BalanceReader } from '@gremlins/treasury'
import { registerBoardTools } from './tools/board.js'
import { registerTreasuryTools } from './tools/treasury.js'
import { registerStatusTools } from './tools/status.js'
import { registerMoveOutTools } from './tools/moveout.js'
import { registerRegistryTools } from './tools/registry.js'
import { registerWalletTools } from './tools/wallet.js'

export interface ServerDeps {
  /** Override for tests and local development (pretend balances). */
  balances?: BalanceReader
  now?: () => number
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' })
  registerBoardTools(server)
  registerTreasuryTools(server, deps.balances)
  registerStatusTools(server)
  registerMoveOutTools(server, deps.now)
  registerRegistryTools(server)
  registerWalletTools(server)
  return server
}
