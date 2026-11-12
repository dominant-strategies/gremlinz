#!/usr/bin/env node
/**
 * gremlin-run: the one command the egg supervises (GREMLIN_RUNTIME). Bootstraps the Hermes home from the signed
 * config, installs the gremlin plugin, starts the inference gateway, waits for it, then runs Hermes' gateway
 * (cron wake-ups, no chat platforms). Each service has its own liveness checks and restart backoff; the egg
 * restarts this supervisor if it fails.
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
import { boardUrl, home, homeFile } from '../env.js'
import { GremlinConfig } from '@gremlins/hatch'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { Supervisor } from './supervisor.js'
import { schedulerResponsive } from './progress.js'
import { processIdentity, sameProcess } from './identity.js'

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
const independentHealth = mcpHttp && process.env.GREMLIN_HEALTH !== '0'
const mcpPort = Number(process.env.GREMLIN_MCP_PORT ?? 8712)
const mcpToken = mcpHttp ? randomBytes(32).toString('hex') : undefined

// Children of a previous gremlin-run that was itself killed outright (SIGKILL leaves them running): stop them, but
// only if the pid still belongs to the same program (pids get reused).
const runDir = join(home(), 'run')
mkdirSync(runDir, { recursive: true, mode: 0o700 })
// The miner's pid is written by gremlin-mcp (the gremlin user), so it lives in GREMLIN_HOME, not in this root-owned folder.
const pidFile = (name: string) => (name === 'miner' ? join(home(), 'miner.pid') : join(runDir, `${name}.pid`))
let stoppedLeftovers = false
// The miner is gremlin-mcp's child (as gremlin-helper, via sudo); it outlives an mcp that was killed outright.
for (const [name, marker] of [['gateway', 'gateway/main.js'], ['mcp', 'main.js --http'], ['health', 'health/main.js'], ['hermes', 'gateway run'], ['miner', 'xmrig']] as const) {
  if (!existsSync(pidFile(name))) continue
  const raw = readFileSync(pidFile(name), 'utf8')
  const record = raw.startsWith('{') ? JSON.parse(raw) as ReturnType<typeof processIdentity> : undefined
  const pid = record?.pid ?? Number(raw)
  try {
    if (record && !sameProcess(record)) { rmSync(pidFile(name), { force: true }); continue }
    const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
    if (cmdline.includes(marker)) { process.kill(record ? -pid : pid, 'SIGKILL'); stoppedLeftovers = true; log(`stopped leftover ${name} (pid ${pid}) from a previous run`) }
  } catch { /* not running */ }
  rmSync(pidFile(name), { force: true })
}
if (stoppedLeftovers) await new Promise((r) => setTimeout(r, 3_000)) // let them release ports and locks

// 1. Hermes home from the signed config
const healthPort = Number(process.env.GREMLIN_HEALTH_PORT ?? 8713)
const env = { ...process.env, HERMES_HOME: hermesHome, GREMLIN_SKILLS: skillsDir, GREMLIN_BOARD_URL: boardUrl(),
  ...(mcpHttp ? { GREMLIN_MCP_TOKEN: mcpToken! } : {}),
  ...(independentHealth ? { GREMLIN_HEALTH_URL: `http://127.0.0.1:${healthPort}` } : {}) }
const bootEnv = { ...env, ...(mcpHttp ? { GREMLIN_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, GREMLIN_MCP_TOKEN: mcpToken! } : {}) }
const boot = spawnSync(process.execPath, [resolve(here, '..', 'bootstrap', 'main.js')], { env: bootEnv, stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL' })
if (boot.error) log('bootstrap failed:', boot.error.message)
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

// 3. the inference gateway, keeping to the maker's model policy (bootstrap has already checked the config)
function makerPolicy() {
  try { return GremlinConfig.parse(JSON.parse(readFileSync(process.env.GREMLIN_CONFIG ?? homeFile('config.json'), 'utf8'))).models } catch { return undefined }
}
let gatewayConfigPath = process.env.GATEWAY_CONFIG
if (!gatewayConfigPath || !existsSync(gatewayConfigPath)) {
  // Not in HERMES_HOME: Hermes reads a gateway.json there as its own legacy config.
  gatewayConfigPath = join(home(), 'inference-gateway.json')
  writeFileSync(gatewayConfigPath, JSON.stringify(gatewayConfig({
    ollamaUrl: process.env.GREMLIN_OLLAMA_URL,
    ollamaModel: process.env.GREMLIN_OLLAMA_MODEL,
    dailyUsd: process.env.GREMLIN_DAILY_USD ? Number(process.env.GREMLIN_DAILY_USD) : undefined,
    policy: makerPolicy(),
  }), null, 2), { mode: 0o600 })
  if (gremlinIds) chownSync(gatewayConfigPath, gremlinIds.uid, gremlinIds.gid)
}

// Each service recovers independently; provider/network errors are handled by the gateway, not by restarting Hermes.
const supervisor = new Supervisor(e => {
  if (e.event === 'service-start' && typeof e.pid === 'number') {
    const identity = processIdentity(e.pid)
    if (identity) writeJsonDurable(pidFile(String(e.child)), identity)
  } else if (e.event === 'exit') rmSync(pidFile(String(e.child)), { force: true })
  event(e); log(e.event, e.child, e.error ?? '')
})
const heartbeat = setInterval(() => {
  try { writeJsonDurable(join(home(), 'runtime-health.json'), supervisor.snapshot()) } catch (e) { log('heartbeat write failed:', (e as Error).message) }
}, 5_000)
let stopping = false
const stop = async (code: number) => {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  await supervisor.stop()
  process.exit(code)
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void stop(0) })
const httpProbe = (url: string, token?: string) => async (signal: AbortSignal) => {
  const response = await fetch(url, { signal, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const ok = response.ok
  await response.body?.cancel()
  return ok
}
try {
  event({ event: 'start' })
  const port = (JSON.parse(readFileSync(gatewayConfigPath, 'utf8')) as { port?: number }).port ?? 8711
  await supervisor.start({ name: 'gateway', command: process.execPath, args: [resolve(here, '..', 'gateway', 'main.js')], env: { ...env, GATEWAY_CONFIG: gatewayConfigPath }, ...gremlinIds,
    probe: httpProbe(`http://127.0.0.1:${port}/health`) })
  if (mcpHttp) {
    // Health has its own process and payment ownership: a broken tool server cannot stop survival checks.
    if (independentHealth) await supervisor.start({ name: 'health', command: process.execPath, args: [resolve(here, '..', 'health', 'main.js')], env: { ...env, GREMLIN_HEALTH_PORT: String(healthPort), GREMLIN_GATEWAY_ADMIN: `http://127.0.0.1:${port}` }, ...gremlinIds,
      probe: httpProbe(`http://127.0.0.1:${healthPort}/healthz`, mcpToken) })
    await supervisor.start({ name: 'mcp', command: process.execPath, args: [resolve(here, '..', 'main.js'), '--http'], env: { ...env, GREMLIN_MCP_PORT: String(mcpPort) }, ...gremlinIds,
      probe: httpProbe(`http://127.0.0.1:${mcpPort}/healthz`, mcpToken) })
  }
  const subagentEnv = { GREMLIN_PROTECTED_DIRS: home(), GREMLIN_SUBAGENT_ROOTS: `${workDir}:/tmp` }
  const hermesEnv: NodeJS.ProcessEnv = separate
    ? { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: hermesHome, HERMES_HOME: hermesHome, GREMLIN_HOME: home(), ...subagentEnv }
    : { ...env, ...subagentEnv }
  const startedAt = Date.now()
  await supervisor.start({ name: 'hermes', command: hermesBin, args: ['gateway', 'run', '--external-supervisor', '--replace'], env: hermesEnv, ...hermesIds,
    probe: async () => schedulerResponsive(hermesHome, startedAt) })
  writeJsonDurable(join(home(), 'runtime-health.json'), supervisor.snapshot())
  log(`running: gateway ${port}, MCP ${mcpHttp ? mcpPort : 'stdio'}, independent health ${mcpHttp ? healthPort : 'on-demand'}`)
} catch (error) {
  log('runtime startup failed:', (error as Error).message)
  await stop(1)
}
