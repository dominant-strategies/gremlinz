#!/usr/bin/env node
/**
 * gremlin-run: the one command the egg supervises (GREMLIN_RUNTIME). Bootstraps the Hermes home from the signed
 * config, installs the gremlin plugin, starts the inference gateway, waits for it, then runs Hermes' gateway
 * (cron wake-ups, no chat platforms). Each service has its own liveness checks and restart backoff; the egg
 * restarts this supervisor if it fails.
 *
 * OS users (GREMLIN_SEPARATE_USERS=1): trusted services own the seed. Hermes runs as gremlin-agent without root or
 * seed access. Its subagents' shell commands run as gremlin-helper, which shares the work folder. Hermes reaches MCP
 * HTTP with a token made fresh each start. GREMLIN_MCP_HTTP=1 uses the HTTP path without switching users.
 *
 * Env: GREMLIN_HOME, GREMLIN_CONFIG, HERMES_HOME, HERMES_BIN (hermes executable), GREMLIN_RUNTIME_DIR (checkout of
 * gremlin-runtime: plugin + skills), GATEWAY_CONFIG (optional; generated if absent), GREMLIN_OLLAMA_URL /
 * GREMLIN_OLLAMA_MODEL (local development), GREMLIN_DAILY_USD, GREMLIN_USER (default gremlin), GREMLIN_WORK_GROUP
 * (default gremlin-work: the gremlin and its helper share the work folder).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayConfig } from '../bootstrap/gateway-config.js'
import { boardUrl, home, homeFile, keys } from '../env.js'
import { GremlinConfig } from '@gremlins/hatch'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { telemetry, devTelemetryEnabled } from '../dev/telemetry.js'
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
const hermesUser = 'gremlin-agent'
const hermesIds = separate ? idsOf(hermesUser) : undefined
// Nothing the gremlin's processes create is readable by other users; the work folder is shared with the helper
// through its setgid group (group rw).
if (separate) process.umask(0o007)
const mcpHttp = separate || process.env.GREMLIN_MCP_HTTP === '1'
const independentHealth = mcpHttp && process.env.GREMLIN_HEALTH !== '0'
const mcpPort = Number(process.env.GREMLIN_MCP_PORT ?? 8712)
const mcpToken = mcpHttp ? randomBytes(32).toString('hex') : undefined
const serviceToken = mcpHttp ? randomBytes(32).toString('hex') : undefined

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
const telemetryLaunch = (() => { try { return JSON.parse(readFileSync(existsSync(homeFile('launch.json')) ? homeFile('launch.json') : process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json', 'utf8')) } catch { return undefined } })()
const telemetryOn = devTelemetryEnabled(process.env, telemetryLaunch)
const env = { ...process.env, GREMLIN_DEV_TELEMETRY: telemetryOn ? '1' : '0', HERMES_HOME: hermesHome, GREMLIN_SKILLS: skillsDir, GREMLIN_BOARD_URL: boardUrl(),
  ...(mcpHttp ? { GREMLIN_MCP_TOKEN: mcpToken! } : {}),
  ...(serviceToken ? { GREMLIN_SERVICE_TOKEN: serviceToken } : {}),
  ...(separate ? { GREMLIN_HERMES_USER: hermesUser } : {}),
  ...(independentHealth ? { GREMLIN_HEALTH_URL: `http://127.0.0.1:${healthPort}` } : {}) }

// Hermes' home belongs to the gremlin. The helper user (subagents' shell) may pass through it to the work folder,
// which the two share through a setgid group; everything else in it is owner-only.
const workDir = join(hermesHome, 'work')
const chownTree = (p: string, ids: Ids, mode: (directory: boolean, old: number) => number) => {
  const s = lstatSync(p)
  if (!s.isDirectory() && (!s.isFile() || s.nlink !== 1)) return
  chownSync(p, ids.uid, ids.gid)
  chmodSync(p, mode(s.isDirectory(), s.mode))
  if (s.isDirectory()) for (const f of readdirSync(p)) chownTree(join(p, f), ids, mode)
}
if (hermesIds) {
  mkdirSync(hermesHome, { recursive: true, mode: 0o700 })
  const h = lstatSync(hermesHome)
  if (!h.isDirectory()) throw new Error('Hermes home must be a directory')
  // Migrate persisted homes once. Later writes in this tree run as the agent, including on restart.
  if (h.uid !== hermesIds.uid || !existsSync(workDir)) {
    chownTree(hermesHome, hermesIds, (d, old) => d ? 0o700 : old & 0o700)
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    if (!lstatSync(workDir).isDirectory()) throw new Error('Hermes work folder must be a directory')
    chownTree(workDir, { uid: hermesIds.uid, gid: gidOf(process.env.GREMLIN_WORK_GROUP ?? 'gremlin-work') }, (d, old) => d ? 0o2770 : (old & 0o770) | 0o660)
    chmodSync(hermesHome, 0o711)
  }
}
const agentEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: hermesHome, HERMES_HOME: hermesHome }
const publicBootEnv = { ...agentEnv, GREMLIN_BOARD_URL: env.GREMLIN_BOARD_URL, GREMLIN_SKILLS: skillsDir, GREMLIN_WAKE_MINUTES: process.env.GREMLIN_WAKE_MINUTES,
  GREMLIN_GATEWAY_URL: process.env.GREMLIN_GATEWAY_URL, GREMLIN_BOOTSTRAP_PLUGIN: join(runtimeDir, 'gremlin', 'plugin', 'gremlin') }
const bootContext = () => {
  let privateDirections: string | undefined
  try { privateDirections = JSON.parse(readFileSync(homeFile('private-directions.json'), 'utf8')).text } catch { /* optional */ }
  const k = keys()
  return JSON.stringify({ config: JSON.parse(readFileSync(process.env.GREMLIN_CONFIG ?? homeFile('config.json'), 'utf8')), evmAddress: k.evm.address, quaiAddress: k.quai.address, privateDirections })
}
const bootEnv = { ...(separate ? { ...publicBootEnv, GREMLIN_BOOTSTRAP_CONTEXT: bootContext() } : { ...env, ...publicBootEnv }),
  ...(mcpHttp ? { GREMLIN_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, GREMLIN_MCP_TOKEN: mcpToken! } : {}) }
const boot = spawnSync(process.execPath, [resolve(here, '..', 'bootstrap', 'main.js')], { ...hermesIds, env: bootEnv, stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL' })
if (boot.error) log('bootstrap failed:', boot.error.message)
if (boot.status !== 0) process.exit(boot.status ?? 1)
// The egg (root) writes the seed and its state into GREMLIN_HOME; the gremlin user must own it and nobody else read it.
if (gremlinIds) {
  chownTree(home(), gremlinIds, d => d ? 0o700 : 0o600)
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
    emergencyUsd: process.env.GREMLIN_EMERGENCY_USD ? Number(process.env.GREMLIN_EMERGENCY_USD) : undefined,
    policy: makerPolicy(),
  }), null, 2), { mode: 0o600 })
  if (gremlinIds) chownSync(gatewayConfigPath, gremlinIds.uid, gremlinIds.gid)
}

if (telemetryOn) {
  try {
    const dir = homeFile('dev-telemetry')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (gremlinIds) chownSync(dir, gremlinIds.uid, gremlinIds.gid)
  } catch { /* Optional diagnostics must not prevent service startup. */ }
}
const diagnostics = telemetry('runner', env)
// Each service recovers independently; provider/network errors are handled by the gateway, not by restarting Hermes.
const supervisor = new Supervisor(e => {
  if (e.event === 'service-start' && typeof e.pid === 'number') {
    const identity = processIdentity(e.pid)
    if (identity) writeJsonDurable(pidFile(String(e.child)), identity)
  } else if (e.event === 'exit') rmSync(pidFile(String(e.child)), { force: true })
  diagnostics.emit('service', { service: e.child, action: e.event, status: typeof e.code === 'number' && e.code >= 0 ? e.code : undefined, ok: e.event === 'service-start' })
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
      probe: httpProbe(`http://127.0.0.1:${healthPort}/healthz`, serviceToken) })
    await supervisor.start({ name: 'mcp', command: process.execPath, args: [resolve(here, '..', 'main.js'), '--http'], env: { ...env, GREMLIN_MCP_PORT: String(mcpPort), GREMLIN_GATEWAY_ADMIN: `http://127.0.0.1:${port}` }, ...gremlinIds,
      probe: httpProbe(`http://127.0.0.1:${mcpPort}/healthz`, mcpToken) })
  }
  const subagentEnv = { GREMLIN_PROTECTED_DIRS: home(), GREMLIN_SUBAGENT_ROOTS: `${workDir}:/tmp` }
  const hermesEnv: NodeJS.ProcessEnv = separate
    ? { ...agentEnv, ...subagentEnv }
    : { ...env, ...subagentEnv }
  const startedAt = Date.now()
  await supervisor.start({ name: 'hermes', command: hermesBin, args: ['gateway', 'run', '--external-supervisor', '--replace'], env: hermesEnv, ...hermesIds,
    probe: async () => schedulerResponsive(hermesHome, startedAt, Date.now(), hermesIds ? file => execFileSync('/bin/cat', [file], { ...hermesIds, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }) : undefined, separate) })
  writeJsonDurable(join(home(), 'runtime-health.json'), supervisor.snapshot())
  log(`running: gateway ${port}, MCP ${mcpHttp ? mcpPort : 'stdio'}, independent health ${mcpHttp ? healthPort : 'on-demand'}`)
} catch (error) {
  log('runtime startup failed:', (error as Error).message)
  await stop(1)
}
