#!/usr/bin/env node
/**
 * gremlin-run: the one command the egg supervises (GREMLIN_RUNTIME). Bootstraps the Hermes home from the signed
 * config, installs the gremlin plugin, starts the inference gateway, waits for it, then runs Hermes' gateway
 * (cron wake-ups, no chat platforms). If either child exits, the other is stopped and gremlin-run exits, so the egg
 * restarts everything with its backoff.
 *
 * Env: GREMLIN_HOME, GREMLIN_CONFIG, HERMES_HOME, HERMES_BIN (hermes executable), GREMLIN_RUNTIME_DIR (checkout of
 * gremlin-runtime: plugin + skills), GATEWAY_CONFIG (optional; generated if absent), GREMLIN_OLLAMA_URL /
 * GREMLIN_OLLAMA_MODEL (local development), GREMLIN_DAILY_USD.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

// 1. Hermes home from the signed config
const env = { ...process.env, HERMES_HOME: hermesHome, GREMLIN_SKILLS: skillsDir }
const boot = spawnSync(process.execPath, [resolve(here, '..', 'bootstrap', 'main.js')], { env, stdio: 'inherit' })
if (boot.status !== 0) process.exit(boot.status ?? 1)

// 2. the plugin, fresh every start (the agent cannot keep a modified copy)
const pluginDst = join(hermesHome, 'plugins', 'gremlin')
rmSync(pluginDst, { recursive: true, force: true })
mkdirSync(dirname(pluginDst), { recursive: true })
cpSync(join(runtimeDir, 'gremlin', 'plugin', 'gremlin'), pluginDst, { recursive: true })

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
}
const children: ChildProcess[] = []
let stopping = false
const stopAll = (code: number) => {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 3_000).unref()
}
const start = (name: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const c = spawn(cmd, args, { env: { ...env, ...extraEnv }, stdio: 'inherit' })
  c.on('exit', (code, signal) => { log(`${name} exited (code ${code}, signal ${signal})`); stopAll(code ?? 1) })
  children.push(c)
  return c
}
start('inference gateway', process.execPath, [resolve(here, '..', 'gateway', 'main.js')], { GATEWAY_CONFIG: gatewayConfigPath })

const port = (await import(gatewayConfigPath.startsWith('/') ? `file://${gatewayConfigPath}` : gatewayConfigPath, { with: { type: 'json' } })).default.port ?? 8711
for (let i = 0; i < 40; i++) {
  const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)
  if (ok) break
  if (i === 39) { log('inference gateway did not come up'); stopAll(1) }
  await new Promise((r) => setTimeout(r, 500))
}

// 4. Hermes (cron wake-ups; no chat platforms)
start('hermes', hermesBin, ['gateway', 'run', '--external-supervisor', '--replace'], { GREMLIN_PROTECTED_DIRS: home() })
log(`running: gateway on ${port}, hermes home ${hermesHome}`)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => stopAll(0))
