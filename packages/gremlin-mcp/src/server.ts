import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BalanceReader } from '@gremlins/treasury'
import { registerBoardTools } from './tools/board.js'
import { registerTreasuryTools } from './tools/treasury.js'

export interface ServerDeps {
  /** Override for tests and local development (pretend balances). */
  balances?: BalanceReader
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' })
  registerBoardTools(server)
  registerTreasuryTools(server, deps.balances)
  return server
}
