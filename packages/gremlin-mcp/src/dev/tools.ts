import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Telemetry } from './telemetry.js'

/** Wrap the public registration API, preserving SDK validation, results and thrown errors. No arguments/results logged. */
export function instrumentTools(server: McpServer, telemetry: Telemetry) {
  if (!telemetry.enabled) return
  const register = server.registerTool as (...args: unknown[]) => unknown
  server.registerTool = ((...args: unknown[]) => {
    const [name, config, callback] = args
    const handler = callback as (...input: unknown[]) => Promise<{ isError?: boolean }>
    return register.call(server, name, config, async (...input: unknown[]) => {
      const started = performance.now()
      const extra = input[1] as { requestId?: string | number } | undefined
      const fields = { tool: name, requestId: extra?.requestId === undefined ? undefined : String(extra.requestId) }
      try {
        const result = await handler(...input)
        telemetry.emit('tool', { ...fields, durationMs: performance.now() - started, outcome: result?.isError ? 'error' : 'success' })
        return result
      } catch (error) {
        telemetry.emit('tool', { ...fields, durationMs: performance.now() - started, outcome: 'exception' })
        throw error
      }
    })
  }) as typeof server.registerTool
}
