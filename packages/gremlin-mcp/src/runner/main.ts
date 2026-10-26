#!/usr/bin/env node
/**
 * gremlin-run: the one command the egg supervises (GREMLIN_RUNTIME). Bootstraps the Hermes home from the signed
 * config, installs the gremlin plugin, starts the inference gateway, waits for it, then runs Hermes' gateway
 * (cron wake-ups, no chat platforms). If any child exits, the others are stopped and gremlin-run exits, so the egg
 * restarts everything with its backoff.
 *
 * Separate OS users (GREMLIN_SEPARATE_USERS=1, as root in the egg image): the gateway and gremlin-mcp run as the
 * gremlin user (it can read the seed); Hermes runs as the hermes user (it cannot) and reaches gremlin-mcp over
 * localhost HTTP with a token made fresh each start. GREMLIN_MCP_HTTP=1 uses the HTTP path without switching users.
 *
 * Env: GREMLIN_HOME, GREMLIN_CONFIG, HERMES_HOME, HERMES_BIN (hermes executable), GREMLIN_RUNTIME_DIR (checkout of
 * gremlin-runtime: plugin + skills), GATEWAY_CONFIG (optional; generated if absent), GREMLIN_OLLAMA_URL /
 * GREMLIN_OLLAMA_MODEL (local development), GREMLIN_DAILY_USD, GREMLIN_USER / HERMES_USER (default gremlin / hermes).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chownSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayConfig } from '../bootstrap/gateway-config.js'
import { home } from '../env.js'

const here = dirname(fileURLToPath(import.meta.url))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[gremlin-run]', ...a)
const hermesHome = process.env.HERMES_HOME ?? '/var/lib/gremlin-hermes'
const runtimeDir = process.env.GREMLIN_RUNTIME_DIR ?? '/opt/gremlin-runtime'
const hermesBin = process.env.HERMES_BIN ?? 'hermes'
const skillsDir = join(runtimeDir, 'gremlin', 'skills')

// Who runs what
interface Ids { uid: number; gid: number }
const separate = process.env.GREMLIN_SEPARATE_USERS === '1'
if (separate && process.getuid?.() !== 0) { log('GREMLIN_SEPARATE_USERS=1 needs root (to start each child as its own user)'); process.exit(78) }
const idsOf = (user: string): Ids => ({ uid: Number(execFileSync('id', ['-u', user], { encoding: 'utf8' })), gid: Number(execFileSync('id', ['-g', user], { encoding: 'utf8' })) })
const gremlinIds = separate ? idsOf(process.env.GREMLIN_USER ?? 'gremlin') : undefined
const hermesIds = separate ? idsOf(process.env.HERMES_USER ?? 'hermes') : undefined
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

// Hermes' home belongs to the hermes user. (It can therefore replace files there, including SOUL.md and config.yaml;
// those are regenerated on every start and guarded by the plugin. The OS boundary protects the seed and GREMLIN_HOME.)
const chownTree = (p: string, ids: Ids) => {
  chownSync(p, ids.uid, ids.gid)
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) chownTree(join(p, f), ids)
}
if (hermesIds) chownTree(hermesHome, hermesIds)

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
const pidFile = (name: string) => join(runDir, `${name}.pid`)
let stoppedLeftovers = false
for (const [name, marker] of [['gateway', 'gateway/main.js'], ['mcp', 'main.js --http'], ['hermes', 'gateway run']] as const) {
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

start('gateway', process.execPath, [resolve(here, '..', 'gateway', 'main.js')], { ...env, GATEWAY_CONFIG: gatewayConfigPath }, gremlinIds)
const port = (JSON.parse(readFileSync(gatewayConfigPath, 'utf8')) as { port?: number }).port ?? 8711
await waitHealthy('inference gateway', `http://127.0.0.1:${port}/health`, (r) => r.ok)

if (mcpHttp) {
  start('mcp', process.execPath, [resolve(here, '..', 'main.js'), '--http'], { ...env, GREMLIN_MCP_TOKEN: mcpToken!, GREMLIN_MCP_PORT: String(mcpPort) }, gremlinIds)
  await waitHealthy('gremlin-mcp', `http://127.0.0.1:${mcpPort}/mcp`, (r) => r.status === 401) // up, and asking for the token
}

// 4. Hermes (cron wake-ups; no chat platforms). With separate users it gets only what it needs: no GREMLIN_* secrets.
const hermesEnv: NodeJS.ProcessEnv = separate
  ? { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: hermesHome, HERMES_HOME: hermesHome, GREMLIN_PROTECTED_DIRS: home() }
  : { ...env, GREMLIN_PROTECTED_DIRS: home() }
start('hermes', hermesBin, ['gateway', 'run', '--external-supervisor', '--replace'], hermesEnv, hermesIds)
log(`running: gateway on ${port}${mcpHttp ? `, gremlin-mcp on ${mcpPort}` : ''}, hermes home ${hermesHome}${separate ? ' (separate users)' : ''}`)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stopAll(0))
