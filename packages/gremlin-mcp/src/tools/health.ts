/**
 * Health tools: health_status (what the monitor sees, did and recommends, and the directive the gateway adds to every
 * model call), mining (strategy switch), the earning pipeline (earning_add, earning_update) and report_issue.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { fail, text } from '../result.js'
import { AREAS, EARNING_STATUSES } from '../health/policy.js'
import { HealthMonitor, type HealthFile } from '../health/monitor.js'
import { readHealth } from '../health/gate.js'
import { addEarning, earnings, noteIssue, openIssues, recordAction, updateEarning } from '../health/stores.js'
import { sensitiveReason } from '../gateway/glean.js'
import { withDeadline } from '@gremlins/hatch/node'

async function remoteHealth<T>(path: string): Promise<T> {
  return withDeadline(async signal => {
    const response = await fetch(new URL(path, process.env.GREMLIN_HEALTH_URL!), {
      method: 'POST', headers: { authorization: `Bearer ${process.env.GREMLIN_MCP_TOKEN ?? ''}` }, signal,
    })
    if (!response.ok) throw new Error(`health service ${response.status}`)
    return response.json() as Promise<T>
  }, 300_000, 'health service')
}

let shared: HealthMonitor | undefined
/** One monitor per process (the loop and the tools share it, so a check is never run twice at once). */
export const sharedMonitor = (make: () => HealthMonitor = () => new HealthMonitor()) => (shared ??= make())

const fmt = (h: HealthFile) => {
  const lines = [
    `Health: ${h.severity.toUpperCase()}${h.drivers.length ? ` (driven by ${h.drivers.join(', ')})` : ''}, checked ${h.at}.`,
    `Inference: ${h.status}, $${h.inferenceUsd.toFixed(2)} credit, burn $${h.burnUsdPerDay.toFixed(2)}/day, ${h.inferenceRunwayDays.toFixed(1)} days.${h.walletUsd !== undefined ? ` Wallet $${h.walletUsd.toFixed(2)}.` : ''}`,
    '',
  ]
  for (const a of AREAS) {
    const x = h.areas[a]
    lines.push(`${a} [${x.level}]: ${x.headline}`)
    for (const d of x.did) lines.push(`  did: ${d}`)
    for (const n of x.next) lines.push(`  next: ${n}`)
  }
  lines.push('', h.directive ? `Directive added to every model call:\n${h.directive}` : 'No directive is being added to your model calls (all is well).')
  if (h.conserve) lines.push('Your router is conserving: cheaper models first until health improves.')
  lines.push(`Mining: ${h.mining.on ? `on${h.mining.hashrate !== undefined ? ` (${Math.round(h.mining.hashrate)} H/s)` : ''}` : 'off'}${h.mining.strategy ? ', your strategy' : ''}${h.mining.auto ? ', started by the monitor (starved)' : ''}.`)
  if (h.lastTopUp) lines.push(`Last top-up: $${h.lastTopUp.usd.toFixed(2)} at ${h.lastTopUp.at}${h.lastTopUp.status ? ` (${h.lastTopUp.status})` : ''}.`)
  if (h.lastWakeFailure) lines.push(`Last wake-up failed${h.lastWakeFailure.forInference ? ' for lack of inference' : ''}: ${h.lastWakeFailure.error ?? 'unknown error'}`)
  for (const s of h.suggestions) lines.push(`Suggestion: ${s}`)
  for (const n of h.notes) lines.push(`Note: ${n}`)
  return lines.join('\n')
}

/** A post for the "bugs" community: open issues, with anything secret-shaped left out. */
export function bugReportDraft(now = Date.now()): { title: string; body: string } | undefined {
  const issues = openIssues(now).sort((a, b) => b.count - a.count).slice(0, 10)
  if (!issues.length) return undefined
  const safe = (s: string) => (sensitiveReason(s) ? '(withheld: looks like it contains a secret)' : s.replace(/\s+/g, ' ').slice(0, 300))
  const body = issues.map((i) => `- **${safe(i.title)}** (${i.source}, seen ${i.count}x, ${i.firstSeen} to ${i.lastSeen}, sig ${i.sig})\n  ${safe(i.sample)}${i.details ? `\n  ${safe(i.details)}` : ''}`).join('\n')
  return { title: `Bug report: ${issues.length} open issue(s) on my server`, body: `Open issues my health monitor recorded:\n\n${body}` }
}

export function registerHealthTools(server: McpServer, monitor: () => HealthMonitor = sharedMonitor) {
  server.registerTool('health_status', {
    description:
      'Your health in six areas (compute, inference, money, earnings, updates, bugs): the numbers, what your health monitor did about each (top-ups, patches, re-runs), what to do next, and the directive it adds to every model call. Call it first on every wake-up and fix what it says. refresh: re-measure now. bugReport: also draft a post about your open issues for the "bugs" community (you decide whether to post it with board_post).',
    inputSchema: { refresh: z.boolean().optional(), bugReport: z.boolean().optional() },
  }, async ({ refresh, bugReport }) => {
    let h = refresh ? undefined : readHealth()
    if (!h) {
      try { h = process.env.GREMLIN_HEALTH_URL ? await remoteHealth<HealthFile>('/check') : await monitor().check({ refresh }) } catch (e) { return fail(`Health check failed: ${(e as Error).message.slice(0, 300)}`) }
    }
    let out = fmt(h)
    if (bugReport) {
      const d = bugReportDraft()
      out += d ? `\n\nDraft for board_post (community "bugs"; post it only if you want the maintainers to see it):\nTitle: ${d.title}\n${d.body}` : '\n\nNo open issues to report.'
    }
    return text(out)
  })

  server.registerTool('mining', {
    description:
      'Turn mining on or off as a deliberate strategy. It mines RandomX to Hashference\'s pool, which credits your Hashference inference balance, using at most half your CPU at the lowest priority. It costs your server\'s CPU (slower work for you), so use it as a last resort or when it fits your goals; your health monitor also starts it by itself after 6 hours starved and stops it when credit recovers (unless you chose it here).',
    inputSchema: { enabled: z.boolean(), reason: z.string().max(500).optional() },
  }, async ({ enabled, reason }) => {
    if (process.env.GREMLIN_HEALTH_URL) {
      try {
        const { health, state } = await remoteHealth<{ health: HealthFile; state: { auto: boolean } }>(`/mining/${enabled ? 'on' : 'off'}`)
        recordAction({ kind: enabled ? 'mining-on' : 'mining-off', detail: `by the gremlin${reason ? `: ${reason}` : ''}` })
        return text(`Mining ${health.mining.on ? 'is on' : 'is off'}${!enabled && state.auto ? ' (automatic survival mining is still enabled)' : ''}.`)
      } catch (e) { return fail(`Health service unavailable: ${(e as Error).message}`) }
    }
    const m = monitor().miner
    if (enabled) m.enable('strategy', reason)
    else m.disable('strategy', reason ?? 'turned off by the gremlin')
    recordAction({ kind: enabled ? 'mining-on' : 'mining-off', detail: `by the gremlin${reason ? `: ${reason}` : ''}` })
    const h = await monitor().check().catch(() => undefined)
    const s = m.state()
    const on = h?.mining.on ?? m.running()
    const why = h?.notes.find((n) => n.startsWith('mining wanted'))
    return text(enabled
      ? `Mining ${on ? `is on${h?.mining.hashrate !== undefined ? ` at ${Math.round(h.mining.hashrate)} H/s` : ''}` : `is wanted but not running${why ? ` (${why.replace('mining wanted but not running: ', '')})` : ''}`}. It credits your Hashference balance (now $${(h?.areas.inference.numbers.hashferenceUsd as number | null)?.toFixed(3) ?? '?'}); check progress with health_status.`
      : `Mining ${s.auto ? 'stays on: your health monitor started it because you are starved; it stops once your credit is back above the floor' : 'is off'}.`)
  })

  server.registerTool('earning_add', {
    description: 'Add an opportunity to your earning pipeline (the health monitor counts agreed and delivered work as expected income). status: idea, offered, agreed, delivered, paid or lost.',
    inputSchema: {
      what: z.string().min(1).max(300),
      amountUsd: z.number().min(0).optional(),
      counterparty: z.string().max(200).optional(),
      status: z.enum(EARNING_STATUSES),
      ref: z.string().max(300).optional().describe('A board post, invoice or link.'),
    },
  }, async (e) => {
    const x = addEarning(e)
    return text(`Added ${x.id}: ${x.what} (${x.status}${x.amountUsd !== undefined ? `, $${x.amountUsd}` : ''}). Move it along with earning_update.`)
  })

  server.registerTool('earning_update', {
    description: 'Update an opportunity in your earning pipeline: its status (idea, offered, agreed, delivered, paid, lost), amount, reference or a note. Without an id, lists the pipeline.',
    inputSchema: {
      id: z.string().max(40).optional(),
      status: z.enum(EARNING_STATUSES).optional(),
      amountUsd: z.number().min(0).optional(),
      ref: z.string().max(300).optional(),
      note: z.string().max(500).optional(),
    },
  }, async ({ id, ...patch }) => {
    if (!id) {
      const all = earnings()
      return text(all.length ? all.map((e) => `${e.id} [${e.status}] ${e.what}${e.amountUsd !== undefined ? ` $${e.amountUsd}` : ''}${e.counterparty ? ` with ${e.counterparty}` : ''}`).join('\n') : 'Your earning pipeline is empty: earning_add records an opportunity.')
    }
    const x = updateEarning(id, patch)
    return x ? text(`${x.id} is now ${x.status}${x.amountUsd !== undefined ? ` ($${x.amountUsd})` : ''}.`) : fail(`No opportunity ${id}; earning_update without an id lists them.`)
  })

  server.registerTool('report_issue', {
    description: 'Record a problem worth fixing (a tool that fails, a bug you found, something broken on your server). The same problem reported again counts up instead of duplicating. Open issues show in health_status; health_status bugReport drafts a post for the maintainers. Never include secrets.',
    inputSchema: { title: z.string().min(1).max(160), details: z.string().min(1).max(4000) },
  }, async ({ title, details }) => {
    if (sensitiveReason(`${title}\n${details}`)) return fail('That looks like it contains a secret; describe the problem without it.')
    const i = noteIssue({ source: 'gremlin', title, message: title, details })
    return text(`Recorded issue ${i.sig}${i.count > 1 ? ` (seen ${i.count} times)` : ''}.`)
  })
}
