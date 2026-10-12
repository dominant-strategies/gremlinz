import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { homeFile } from '../env.js'
import { fail, text } from '../result.js'

const DAY = 24 * 60 * 60_000

/**
 * Asks the egg to move the gremlin to a server it controls (packages/egg moveout). The egg launches the nest, seals
 * the seed and memory to its key and hands over; this server stops acting once the nest pulses. At most once a day.
 */
export function registerMoveOutTools(server: McpServer, now: () => number = Date.now) {
  server.registerTool('move_out', {
    description:
      'Move yourself to a new server you pay for and control. Your seed and memory are sealed to the new server\'s key and handed over through the board; this server stops acting as you once the new one checks in. You are paused for a few minutes. Host: sporestack (needs a SporeStack token you have funded; new tokens need a $100 first deposit). At most once a day.',
    inputSchema: {
      host: z.literal('sporestack'),
      sporestackToken: z.string().regex(/^ss_t_[0-9a-z]{27}$/, 'a SporeStack token is ss_t_ followed by 27 characters'),
      days: z.number().int().min(1).max(365).optional(),
    },
    annotations: { destructiveHint: true },
  }, async ({ host, sporestackToken, days }) => {
    const last = homeFile('moveout-last.json')
    const lastAt = existsSync(last) ? Number(JSON.parse(readFileSync(last, 'utf8')).at) : 0
    if (now() - lastAt < DAY) return fail(`You already asked to move in the last 24 hours (${new Date(lastAt).toISOString()}). Wait, or check how the last move went.`)
    if (existsSync(homeFile('moveout-request.json'))) return fail('A move is already pending; your supervisor is working on it.')
    writeFileSync(homeFile('moveout-request.json'), JSON.stringify({ host, token: sporestackToken, days: days ?? 30 }, null, 2), { mode: 0o600 })
    writeFileSync(last, JSON.stringify({ at: now(), host }), { mode: 0o600 })
    return text(`Move to ${host} requested. Your supervisor will launch the new server, hand you over, and you will continue there.`)
  })
}
