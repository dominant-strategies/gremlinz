#!/usr/bin/env node
// Check on a test gremlin hatched on production: one pass (cron/launchd friendly), or a loop.
//
//   node scripts/agent-test/watch.mjs <name>                    one pass; exit 1 if any check fails
//   node scripts/agent-test/watch.mjs <name> --every 15m        loop forever (Ctrl-C to stop)
//
// Options:
//   --board URL          board to read (default https://gremlinz.ai; GET requests only)
//   --ip IP              the egg's server (default: eggIp from the hatch job, else "ip" in the state file)
//   --no-ssh             board checks only
//   --key PATH           dev SSH key (default ~/.ssh/gremlinz_dev_ed25519, or GREMLINZ_DEV_KEY)
//   --launch-id ID --job ID --egg 0x…   start watching a gremlin hatched by hand (written into the state file)
//   --json               print the checks as JSON instead of text
//
// Reads ~/.cache/gremlinz-agent-test/<name>.json (written by hatch.mjs). Writes, in ~/.cache/gremlinz-agent-test/<name>/:
//   timeline.jsonl  one line per pass (verdict per check, key numbers)
//   report.md       the latest verdicts and the recent timeline
//   last.json       the latest snapshot (redacted on the egg: no keys leave it)
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BOARD, DEV_KEY, NAME_RE, loadState, parseArgs, parseDuration, runDir, saveState, statePath } from './common.mjs'
import { changes, evaluate, overall, renderReport, timelineEntry } from './checks.mjs'
import { learned, snapshot } from './collect.mjs'

const args = parseArgs(process.argv.slice(2))
const name = args._[0]
if (!name || !NAME_RE.test(name)) {
  console.error('usage: watch.mjs <name> [--every 15m] [--board URL] [--ip IP] [--no-ssh] [--key PATH] [--json]')
  process.exit(2)
}

function readTimeline(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

/** Fingerprints of the dev public key next to the private one, so other keys on the egg stand out. */
function expectedDevKeys(key) {
  try { return [execFileSync('ssh-keygen', ['-lf', `${key}.pub`], { encoding: 'utf8' }).split(/\s+/)[1]].filter(Boolean) } catch { return [] }
}

async function pass() {
  if (args['launch-id'] || args.job || args.egg) saveState(name, { ...(args['launch-id'] ? { launchId: args['launch-id'] } : {}), ...(args.job ? { jobId: args.job } : {}), ...(args.egg ? { eggAddress: args.egg } : {}) })
  const state = loadState(name)
  if (!state) {
    console.error(`no state at ${statePath(name)}: run hatch.mjs ${name} first, or pass --launch-id/--job/--egg`)
    process.exit(2)
  }
  const key = args.key ?? DEV_KEY
  // AGENT_TEST_NOW: judge as of another time (tests replay fixtures).
  const now = process.env.AGENT_TEST_NOW ? Date.parse(process.env.AGENT_TEST_NOW) : Date.now()
  const s = await snapshot(state, { board: args.board ?? state.board ?? DEFAULT_BOARD, ip: args.ip, ssh: !args['no-ssh'], key, now })
  s.expectedDevKeys = expectedDevKeys(key)
  const learnedNow = learned(s)
  if (Object.keys(learnedNow).length) saveState(name, learnedNow)
  s.state = { ...state, ...learnedNow, gremlin: { ...state.gremlin, ...learnedNow.gremlin } }

  const checks = evaluate(s)
  const dir = runDir(name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tl = join(dir, 'timeline.jsonl')
  const prior = readTimeline(tl)
  const entry = timelineEntry(s, checks)
  appendFileSync(tl, JSON.stringify(entry) + '\n', { mode: 0o600 })
  writeFileSync(join(dir, 'report.md'), renderReport(name, s, checks, [...prior, entry]), { mode: 0o600 })
  writeFileSync(join(dir, 'last.json'), JSON.stringify({ snapshot: s, checks }, null, 2), { mode: 0o600 })

  const o = overall(checks)
  if (args.json) console.log(JSON.stringify({ at: entry.at, overall: o, checks }, null, 2))
  else {
    console.log(`${entry.at}  ${name}: ${o.status.toUpperCase()}  (${o.counts.pass} pass, ${o.counts.warn} warn, ${o.counts.fail} fail, ${o.counts.skip} skip)`)
    for (const c of checks) if (c.status === 'warn' || c.status === 'fail') console.log(`  ${c.status.toUpperCase().padEnd(4)}  ${c.id.padEnd(20)} ${c.summary}`)
    const ch = changes(prior.at(-1), entry)
    if (ch.length) console.log(`  changed: ${ch.map((c) => `${c.id} ${c.from}→${c.to}`).join(', ')}`)
    console.log(`  report: ${join(dir, 'report.md')}`)
  }
  return o.status === 'fail' ? 1 : 0
}

if (args.every) {
  const every = parseDuration(args.every)
  for (;;) {
    const started = Date.now()
    try { await pass() } catch (e) { console.error(`${new Date().toISOString()}  pass failed: ${e.stack ?? e}`) }
    await new Promise((r) => setTimeout(r, Math.max(10_000, every - (Date.now() - started))))
  }
} else {
  process.exitCode = await pass()
}
