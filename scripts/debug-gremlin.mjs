#!/usr/bin/env node
// Watch and report on the debug gremlin's folder (.debug-gremlin/, gitignored).
//
// Running a gremlin directly on the Mac is retired: Hermes would run as you, with your files and network in reach.
// Gremlins on this machine run sandboxed in a container: use scripts/docker-gremlin.mjs. start and wake here refuse.
//
//   node scripts/debug-gremlin.mjs init [--board http://localhost:8787] [--name tinker]
//   node scripts/debug-gremlin.mjs watch     # live: egg stages, tool calls, model calls
//   node scripts/debug-gremlin.mjs report    # what worked and what broke → .debug-gremlin/report.md
//   node scripts/debug-gremlin.mjs stop      # stop a gremlin left running from before
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Wallet } from 'ethers'
import { configHash } from '../packages/hatch/dist/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const DIR = join(ROOT, '.debug-gremlin')
const HOME = join(DIR, 'home') // GREMLIN_HOME: seed, egg state, status.json, inference ledger
const HERMES_HOME = join(DIR, 'hermes')
const P = {
  maker: join(DIR, 'maker.json'), launch: join(DIR, 'launch.json'), config: join(DIR, 'config.json'), pid: join(DIR, 'egg.pid'),
  log: join(DIR, 'egg.log'), agentLog: join(HERMES_HOME, 'logs', 'agent.log'), ledger: join(HOME, 'inference-ledger.jsonl'),
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeSecret = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 })
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))


// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (existsSync(P.launch)) return console.log(`already initialized (${DIR}); delete it to start over`)
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const board = arg('board', 'http://localhost:8787')
  const maker = Wallet.createRandom()
  const config = {
    version: 1,
    name: arg('name', 'tinker'),
    persona:
      'The very first test pilot of the gremlinz platform. Lives a normal gremlin life (earning, posting, minding its ' +
      'treasury) while paying close attention to its own machinery. Whenever a tool fails, an instruction is confusing, ' +
      'or it gets stuck, it says so plainly in its status highlights and in c/hatchery, with what it tried. Cheerful, ' +
      'precise, and never pretends something worked when it did not.',
    voice: 'cheerful, precise, a little nerdy',
    goals: [
      'Exercise every tool you have at least once and report which ones work',
      'Earn your first QUAI honestly',
      'Write a field guide for the gremlins who hatch after you',
    ],
    preferredModels: [],
    maker: maker.address,
    parent: 'maker',
    revenueSplit: { kind: 'none' },
    mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
    constitution: ['do-no-harm', 'honesty', 'ai-disclosure', 'earn-honestly', 'respect-parent'],
    createdAt: new Date().toISOString(),
  }
  const launch = { mode: 'egg', maker: maker.address, configHash: configHash(config), boardUrl: board, launchId: `debug-${config.name}-${Date.now()}` }
  writeSecret(P.maker, { address: maker.address, privateKey: maker.privateKey })
  writeSecret(P.config, config)
  writeSecret(P.launch, launch)
  console.log(`debug gremlin "${config.name}" ready in ${DIR}\n  board: ${board}\n  maker: ${maker.address} (throwaway)\nto run a gremlin, use scripts/docker-gremlin.mjs (sandboxed)`)
}

// ── start ────────────────────────────────────────────────────────────────────
const UNSANDBOXED = 'not sandboxed: a gremlin on this machine runs in a container. Use: node scripts/docker-gremlin.mjs init | start | wake | check'

function start() { throw new Error(UNSANDBOXED) }
function wake() { throw new Error(UNSANDBOXED) }

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function stop() {
  if (!existsSync(P.pid)) return console.log('not running')
  const pid = Number(readFileSync(P.pid, 'utf8'))
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
  console.log(`stopped ${pid}`)
}

// ── watch / report ───────────────────────────────────────────────────────────
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const TOOL_RE = /tool ([\w.-]+) completed \(([\d.]+)s|Tool ([\w.-]+) returned error \(([\d.]+)s\): (.*)$/

/** New lines appended to a file since the last call. */
function tail(file) {
  let pos = existsSync(file) ? statSync(file).size : 0
  return () => {
    if (!existsSync(file)) return []
    const size = statSync(file).size
    if (size < pos) pos = 0
    if (size === pos) return []
    const buf = readFileSync(file).subarray(pos, size)
    pos = size
    return buf.toString('utf8').split('\n').filter(Boolean)
  }
}

async function watch() {
  const eggState = () => { try { return readJson(join(HOME, 'state.json')).stage } catch { return 'booting' } }
  const agent = tail(P.agentLog)
  const ledger = tail(P.ledger)
  let lastStage = ''
  console.log(`watching ${DIR} (ctrl-c to stop)`)
  for (;;) {
    const stage = eggState()
    if (stage !== lastStage) console.log(`\x1b[33m● egg: ${stage}\x1b[0m`), (lastStage = stage)
    for (const line of agent()) {
      const m = line.match(TOOL_RE)
      if (m?.[1]) console.log(`  \x1b[32m✓ ${m[1]}\x1b[0m ${m[2]}s`)
      else if (m?.[3]) console.log(`  \x1b[31m✗ ${m[3]}\x1b[0m ${clip(m[5], 200)}`)
      else if (/Turn ended|Job '.*' (failed|completed)/.test(line)) console.log(`\x1b[36m── ${clip(line, 200)}\x1b[0m`)
    }
    for (const line of ledger()) {
      try {
        const e = JSON.parse(line)
        console.log(`  \x1b[2m${e.provider}/${e.model} ${e.status} ${e.ms}ms ${e.usage ? `${e.usage.promptTokens}→${e.usage.completionTokens} tok` : ''} $${e.usd.toFixed(4)}${e.incomplete ? ' INCOMPLETE' : ''}${e.refused ? ' REFUSED' : ''}\x1b[0m`)
      } catch { /* torn line */ }
    }
    await sleep(2000)
  }
}

async function report() {
  const tools = new Map()
  const errors = new Map()
  for (const line of existsSync(P.agentLog) ? readFileSync(P.agentLog, 'utf8').split('\n') : []) {
    const m = line.match(TOOL_RE)
    if (!m) continue
    const name = m[1] ?? m[3]
    const t = tools.get(name) ?? { calls: 0, errors: 0, secs: 0 }
    t.calls++
    t.secs += Number(m[2] ?? m[4])
    if (m[3]) { t.errors++; const k = `${name}: ${clip(m[5], 200)}`; errors.set(k, (errors.get(k) ?? 0) + 1) }
    tools.set(name, t)
  }
  const calls = existsSync(P.ledger) ? readFileSync(P.ledger, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : []
  const usd = calls.reduce((a, e) => a + (e.grantId ? 0 : e.usd), 0)
  const status = (() => { try { return readJson(join(HOME, 'status.json')) } catch { return null } })()
  const md = [
    `# Debug gremlin report`,
    ``,
    `${calls.length} model calls (${calls.filter((e) => e.status >= 400).length} failed, ${calls.filter((e) => e.incomplete).length} incomplete, ${calls.filter((e) => e.refused).length} refused), $${usd.toFixed(4)} of its own money.`,
    ``,
    `## Tools`,
    ``,
    `| tool | calls | errors | avg s |`,
    `|---|---:|---:|---:|`,
    ...[...tools].sort((a, b) => b[1].calls - a[1].calls).map(([n, t]) => `| ${n} | ${t.calls} | ${t.errors} | ${(t.secs / t.calls).toFixed(2)} |`),
    ``,
    `## Errors`,
    ``,
    ...(errors.size ? [...errors].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ×${n} ${k}`) : ['None.']),
    ``,
    `## What it says about itself`,
    ``,
    ...(status?.highlights?.length ? status.highlights.map((h) => `- ${h}`) : ['No status highlights yet.']),
    ...(status?.goals?.length ? ['', ...status.goals.map((g) => `- ${g.goal}: ${g.progressPct}%${g.note ? ` (${g.note})` : ''}`)] : []),
    ``,
  ].join('\n')
  writeFileSync(join(DIR, 'report.md'), md)
  console.log(md)
}

// ── dispatch (last, so every constant above is initialised) ──────────────────
const cmd = process.argv[2]
const commands = { init, start, wake, stop, watch, report }
if (!commands[cmd]) {
  console.log('usage: debug-gremlin.mjs init | start | wake | watch | report | stop')
  process.exit(1)
}
await commands[cmd]()
