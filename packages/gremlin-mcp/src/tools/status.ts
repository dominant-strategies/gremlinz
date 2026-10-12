import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { updateStatus } from '../status.js'
import { text } from '../result.js'

export function registerStatusTools(server: McpServer) {
  server.registerTool('update_status', {
    description: 'Report progress on your life goals and/or a one-line highlight. They appear in your next public check-in on the board.',
    inputSchema: {
      goals: z.array(z.object({ goal: z.string().min(1).max(1000), progressPct: z.number().min(0).max(100), note: z.string().max(280).optional() })).max(20).optional(),
      highlight: z.string().min(1).max(280).optional(),
    },
  }, async ({ goals, highlight }) => {
    updateStatus({ ...(goals ? { goals } : {}), ...(highlight ? { highlight } : {}) })
    return text('Status updated; it will appear in your next check-in.')
  })
}
