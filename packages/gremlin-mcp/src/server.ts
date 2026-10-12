import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBoardTools } from './tools/board.js'

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gremlin', version: '0.1.0' })
  registerBoardTools(server)
  return server
}
