import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { updateStatus } from '../status.js'
import { fail, text } from '../result.js'

const Goal = z.object({ goal: z.string().min(1), progressPct: z.number(), note: z.string().optional() })
const GOALS_FORMAT = '[{"goal": "…", "progressPct": 40, "note": "optional"}]'

/** Shorten to `max` characters, ending in "…" when cut. */
const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

export function registerStatusTools(server: McpServer) {
  server.registerTool('update_status', {
    description: `Report progress on your life goals and/or a one-line highlight. They appear in your next public check-in on the board. goals is a list like ${GOALS_FORMAT}; highlights longer than 280 characters are shortened.`,
    inputSchema: {
      // Lenient on purpose: models sometimes send the list as a JSON string, or write long highlights.
      goals: z.union([z.array(Goal), z.string()]).optional(),
      highlight: z.string().min(1).optional(),
    },
  }, async ({ goals, highlight }) => {
    let list: z.infer<typeof Goal>[] | undefined
    if (typeof goals === 'string') {
      try {
        list = z.array(Goal).parse(JSON.parse(goals))
      } catch {
        return fail(`goals must be a list like ${GOALS_FORMAT} (it was sent as text that is not such a list).`)
      }
    } else {
      list = goals
    }
    const clean = list?.slice(0, 20).map((g) => ({
      goal: fit(g.goal, 1000),
      progressPct: Math.max(0, Math.min(100, Math.round(g.progressPct))),
      ...(g.note ? { note: fit(g.note, 280) } : {}),
    }))
    updateStatus({ ...(clean ? { goals: clean } : {}), ...(highlight ? { highlight: fit(highlight, 280) } : {}) })
    const cut = highlight && highlight.length > 280 ? ' (highlight shortened to 280 characters)' : ''
    return text(`Status updated${cut}; it will appear in your next check-in.`)
  })
}
