#!/usr/bin/env node
/**
 * gremlin-bootstrap: turn the maker's verified config into a Hermes home. Run by the egg once the gremlin is
 * initialized (and again on every start, so the generated files always match the signed config).
 *
 *   GREMLIN_HOME=/var/lib/gremlin HERMES_HOME=/var/lib/gremlin-hermes GREMLIN_SKILLS=/opt/gremlin/skills gremlin-bootstrap
 *
 * Writes $HERMES_HOME/SOUL.md (read-only), config.yaml, cron/jobs.json (only if absent: Hermes keeps run state in it).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GremlinConfig } from '@gremlins/hatch'
import { boardUrl, home, homeFile, keys } from '../env.js'
import { soulMarkdown } from './soul.js'
import { cronJobs, hermesConfig } from './hermes.js'

const hermesHome = process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes'
const skillsDir = process.env.GREMLIN_SKILLS ?? '/opt/gremlin/skills'
const gatewayUrl = process.env.GREMLIN_GATEWAY_URL ?? 'http://127.0.0.1:8711/v1'
const mcpMain = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main.js')

const config = GremlinConfig.parse(JSON.parse(readFileSync(process.env.GREMLIN_CONFIG ?? homeFile('config.json'), 'utf8')))
const k = keys()

const write = (rel: string, body: string, mode = 0o600) => {
  const f = join(hermesHome, rel)
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  if (existsSync(f)) rmSync(f, { force: true }) // SOUL.md is read-only from the last run
  writeFileSync(f, body, { mode })
  chmodSync(f, mode)
}

write('SOUL.md', soulMarkdown(config, { evmAddress: k.evm.address, quaiAddress: k.quai.address, boardUrl: boardUrl() }), 0o444)
write('config.yaml', hermesConfig({
  gatewayUrl,
  mcp: process.env.GREMLIN_MCP_URL
    ? { url: process.env.GREMLIN_MCP_URL }
    : { command: process.execPath, args: [mcpMain], env: { GREMLIN_HOME: home(), GREMLIN_BOARD_URL: boardUrl(), ...(process.env.GREMLIN_DEV_BALANCES ? { GREMLIN_DEV_BALANCES: process.env.GREMLIN_DEV_BALANCES } : {}) } },
  skillsDir,
  protectedPaths: [home(), 'seed', 'signed-config.json'],
  wakeEveryMinutes: Number(process.env.GREMLIN_WAKE_MINUTES ?? 45),
}))
// The MCP token for HTTP mode goes in Hermes' .env (config.yaml refers to it as ${GREMLIN_MCP_TOKEN}).
if (process.env.GREMLIN_MCP_TOKEN) write('.env', `GREMLIN_MCP_TOKEN=${process.env.GREMLIN_MCP_TOKEN}\n`)
if (!existsSync(join(hermesHome, 'cron', 'jobs.json'))) write('cron/jobs.json', cronJobs({ wakeEveryMinutes: Number(process.env.GREMLIN_WAKE_MINUTES ?? 45) }))
console.log(`gremlin-bootstrap: ${config.name} ready in ${hermesHome}`)
