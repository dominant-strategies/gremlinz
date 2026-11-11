#!/usr/bin/env node
/**
 * gremlin-run: the one command the egg supervises (GREMLIN_RUNTIME). Bootstraps the Hermes home from the signed
 * config, installs the gremlin plugin, starts the inference gateway, waits for it, then runs Hermes' gateway
 * (cron wake-ups, no chat platforms). If any child exits, the others are stopped and gremlin-run exits, so the egg
 * restarts everything with its backoff.
 *
 * OS users (GREMLIN_SEPARATE_USERS=1, as root in the egg image): the gateway, gremlin-mcp and Hermes (the gremlin's
 * main agent) all run as the gremlin user, which owns the seed and everything else and has passwordless sudo: the
 * main agent has full control of its server. Its subagents' shell commands run as the unprivileged gremlin-helper
 * user (the gremlin plugin does that), which reaches only the work folder. Hermes reaches gremlin-mcp over localhost
 * HTTP with a token made fresh each start. GREMLIN_MCP_HTTP=1 uses the HTTP path without switching users.
 *
 * Env: GREMLIN_HOME, GREMLIN_CONFIG, HERMES_HOME, HERMES_BIN (hermes executable), GREMLIN_RUNTIME_DIR (checkout of
 * gremlin-runtime: plugin + skills), GATEWAY_CONFIG (optional; generated if absent), GREMLIN_OLLAMA_URL /
 * GREMLIN_OLLAMA_MODEL (local development), GREMLIN_DAILY_USD, GREMLIN_USER (default gremlin), GREMLIN_WORK_GROUP
 * (default gremlin-work: the gremlin and its helper share the work folder).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, chownSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayConfig } from '../bootstrap/gateway-config.js'
import { home } from '../env.js'

const here = dirname(fileURLToPath(import.meta.url))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[gremlin-run]', ...a)
/** Starts and child exits, for the health monitor (restarts and crashes; health/measure.ts). */
const event = (e: Record<string, unknown>) => {
  try {
    const f = join(home(), 'runner-events.jsonl')
    appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 })
    if (gremlinIds) chownSync(f, gremlinIds.uid, gremlinIds.gid) // written as root, read by gremlin-mcp
  } catch { /* never fatal */ }
}
const hermesHome = process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes'
const runtimeDir = process.env.GREMLIN_RUNTIME_DIR ?? '/opt/gremlin-runtime'
const hermesBin = process.env.HERMES_BIN ?? 'hermes'
const skillsDir = join(runtimeDir, 'gremlin', 'skills')

// Who runs what
interface Ids { uid: number; gid: number }
const separate = process.env.GREMLIN_SEPARATE_USERS === '1'
if (separate && process.getuid?.() !== 0) { log('GREMLIN_SEPARATE_USERS=1 needs root (to start each child as its own user)'); process.exit(78) }
const idsOf = (user: string): Ids => ({ uid: Number(execFileSync('id', ['-u', user], { encoding: 'utf8' })), gid: Number(execFileSync('id', ['-g', user], { encoding: 'utf8' })) })
const gidOf = (group: string) => Number(execFileSync('getent', ['group', group], { encoding: 'utf8' }).split(':')[2])
const gremlinIds = separate ? idsOf(process.env.GREMLIN_USER ?? 'gremlin') : undefined
const hermesIds = gremlinIds // the main agent is the gremlin
// Nothing the gremlin's processes create is readable by other users; the work folder is shared with the helper
// through its setgid group (group rw).
if (separate) process.umask(0o007)
const mcpHttp = separate || process.env.GREMLIN_MCP_HTTP === '1'
const mcpPort = Number(process.env.GREMLIN_MCP_PORT ?? 8712)
const mcpToken = mcpHttp ? randomBytes(32).toString('hex') : undefined

// 1. Hermes home from the signed config
const env = { ...process.env, HERMES_HOME: hermesHome, GREMLIN_SKILLS: skillsDir }
const bootEnv = { ...env, ...(mcpHttp ? { GREMLIN_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, GREMLIN_MCP_TOKEN: mcpToken! } : {}) }
const boot = spawnSync(process.execPath, [resolve(here, '..', 'bootstrap', 'main.js')], { env: bootEnv, stdio: 'inherit' })
if (boot.status !== 0) process.exit(boot.status ?? 1)

// 2. the plugin, fresh every start (the agent cannot keep a modified copy)
const pluginDst = join(hermesHome, 'plugins', 'gremlin')
rmSync(pluginDst, { recursive: true, force: true })
mkdirSync(dirname(pluginDst), { recursive: true })
cpSync(join(runtimeDir, 'gremlin', 'plugin', 'gremlin'), pluginDst, { recursive: true })

// Hermes' home belongs to the gremlin. The helper user (subagents' shell) may pass through it to the work folder,
// which the two share through a setgid group; everything else in it is owner-only.
const chownTree = (p: string, ids: Ids) => {
  chownSync(p, ids.uid, ids.gid)
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) chownTree(join(p, f), ids)
}
const ownerOnly = (p: string) => { chmodSync(p, statSync(p).mode & 0o7700); if (statSync(p).isDirectory()) for (const f of readdirSync(p)) ownerOnly(join(p, f)) }
const workDir = join(hermesHome, 'work')
if (hermesIds) {
  chownTree(hermesHome, hermesIds)
  for (const f of readdirSync(hermesHome)) if (f !== 'work') ownerOnly(join(hermesHome, f))
  chmodSync(hermesHome, 0o711)
  mkdirSync(workDir, { recursive: true })
  const workGid = gidOf(process.env.GREMLIN_WORK_GROUP ?? 'gremlin-work')
  const shareTree = (p: string) => {
    chownSync(p, statSync(p).uid, workGid)
    if (statSync(p).isDirectory()) { chmodSync(p, 0o2770); for (const f of readdirSync(p)) shareTree(join(p, f)) }
    else chmodSync(p, (statSync(p).mode & 0o777) | 0o060)
  }
  shareTree(workDir)
  chmodSync(join(workDir, 'AGENTS.md'), 0o444)
}
// The egg (root) writes the seed and its state into GREMLIN_HOME; the gremlin user must own it and nobody else read it.
if (gremlinIds) {
  chownTree(home(), gremlinIds)
  const lockDown = (p: string) => { const d = statSync(p).isDirectory(); chmodSync(p, d ? 0o700 : 0o600); if (d) for (const f of readdirSync(p)) lockDown(join(p, f)) }
  lockDown(home()) // owner-only, whatever mode each file was created with
}

// 3. the inference gateway
let gatewayConfigPath = process.env.GATEWAY_CONFIG
if (!gatewayConfigPath || !existsSync(gatewayConfigPath)) {
  // Not in HERMES_HOME: Hermes reads a gateway.json there as its own legacy config.
  gatewayConfigPath = join(home(), 'inference-gateway.json')
  writeFileSync(gatewayConfigPath, JSON.stringify(gatewayConfig({
    ollamaUrl: process.env.GREMLIN_OLLAMA_URL,
    ollamaModel: process.env.GREMLIN_OLLAMA_MODEL,
    dailyUsd: process.env.GREMLIN_DAILY_USD ? Number(process.env.GREMLIN_DAILY_USD) : undefined,
  }), null, 2), { mode: 0o600 })
  if (gremlinIds) chownSync(gatewayConfigPath, gremlinIds.uid, gremlinIds.gid)
}

// Children of a previous gremlin-run that was itself killed outright (SIGKILL leaves them running): stop them, but
// only if the pid still belongs to the same program (pids get reused).
const runDir = join(home(), 'run')
mkdirSync(runDir, { recursive: true, mode: 0o700 })
// The miner's pid is written by gremlin-mcp (the gremlin user), so it lives in GREMLIN_HOME, not in this root-owned folder.
const pidFile = (name: string) => (name === 'miner' ? join(home(), 'miner.pid') : join(runDir, `${name}.pid`))
let stoppedLeftovers = false
// The miner is gremlin-mcp's child (as gremlin-helper, via sudo); it outlives an mcp that was killed outright.
for (const [name, marker] of [['gateway', 'gateway/main.js'], ['mcp', 'main.js --http'], ['hermes', 'gateway run'], ['miner', 'xmrig']] as const) {
  if (!existsSync(pidFile(name))) continue
  const pid = Number(readFileSync(pidFile(name), 'utf8'))
  try {
    const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
    if (cmdline.includes(marker)) { process.kill(pid, 'SIGTERM'); stoppedLeftovers = true; log(`stopped leftover ${name} (pid ${pid}) from a previous run`) }
  } catch { /* not running */ }
  rmSync(pidFile(name), { force: true })
}
if (stoppedLeftovers) await new Promise((r) => setTimeout(r, 3_000)) // let them release ports and locks

const children: ChildProcess[] = []
let stopping = false
let exitCode = 0
const stopAll = (code: number) => {
  if (!stopping) {
    stopping = true
    exitCode = code
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM')
    setTimeout(() => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL') }, 10_000).unref()
  }
  // Exit once every child is gone, with the first failure's code (so the egg knows it failed).
  if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(exitCode)
}
const start = (name: string, cmd: string, args: string[], childEnv: NodeJS.ProcessEnv, ids?: Ids) => {
  const c = spawn(cmd, args, { env: childEnv, stdio: 'inherit', ...(ids ?? {}) })
  writeFileSync(pidFile(name), String(c.pid), { mode: 0o600 })
  c.on('exit', (code, signal) => {
    log(`${name} exited (code ${code}, signal ${signal})`)
    if (!stopping) event({ event: 'exit', child: name, code, signal })
    rmSync(pidFile(name), { force: true })
    stopAll(code ?? (signal === 'SIGTERM' && stopping ? exitCode : 1))
  })
  children.push(c)
  return c
}
const waitHealthy = async (name: string, url: string, ok: (r: Response) => boolean) => {
  for (let i = 0; i < 40; i++) {
    if (await fetch(url).then(ok).catch(() => false)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  log(`${name} did not come up`)
  stopAll(1)
}

event({ event: 'start' })
start('gateway', process.execPath, [resolve(here, '..', 'gateway', 'main.js')], { ...env, GATEWAY_CONFIG: gatewayConfigPath }, gremlinIds)
const port = (JSON.parse(readFileSync(gatewayConfigPath, 'utf8')) as { port?: number }).port ?? 8711
await waitHealthy('inference gateway', `http://127.0.0.1:${port}/health`, (r) => r.ok)

if (mcpHttp) {
  start('mcp', process.execPath, [resolve(here, '..', 'main.js'), '--http'], { ...env, GREMLIN_MCP_TOKEN: mcpToken!, GREMLIN_MCP_PORT: String(mcpPort), GREMLIN_GATEWAY_ADMIN: `http://127.0.0.1:${port}` }, gremlinIds)
  await waitHealthy('gremlin-mcp', `http://127.0.0.1:${mcpPort}/mcp`, (r) => r.status === 401) // up, and asking for the token
}

// 4. Hermes: the main agent (cron wake-ups; no chat platforms). GREMLIN_PROTECTED_DIRS and GREMLIN_SUBAGENT_ROOTS
// tell the plugin what its subagents may not touch and where their files may go.
const subagentEnv = { GREMLIN_PROTECTED_DIRS: home(), GREMLIN_SUBAGENT_ROOTS: `${workDir}:/tmp` }
const hermesEnv: NodeJS.ProcessEnv = separate
  ? { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: hermesHome, HERMES_HOME: hermesHome, GREMLIN_HOME: home(), ...subagentEnv }
  : { ...env, ...subagentEnv }
start('hermes', hermesBin, ['gateway', 'run', '--external-supervisor', '--replace'], hermesEnv, hermesIds)
log(`running: gateway on ${port}${mcpHttp ? `, gremlin-mcp on ${mcpPort}` : ''}, hermes home ${hermesHome}${separate ? ' (as the gremlin user; subagents as gremlin-helper)' : ''}`)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stopAll(0))
