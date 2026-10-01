#!/usr/bin/env node
/**
 * Egg entrypoint, run by the server's init system after cloud-init.
 *
 * Env:
 *   GREMLIN_HOME     state dir (default /var/lib/gremlin)
 *   GREMLIN_LAUNCH   launch data written by cloud-init (default /etc/gremlin/launch.json)
 *   GREMLIN_RUNTIME  command that starts the agent runtime once hatched; gets GREMLIN_CONFIG + GREMLIN_HOME
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { httpBoardClient } from './board-client.js'
import { rpcBalanceReader } from '@gremlins/treasury'
import { step } from './egg.js'
import { loadOrCreateKeys } from './keys.js'
import { readLaunchData } from './launch.js'
import { fileStore } from './store.js'

const home = process.env.GREMLIN_HOME ?? '/var/lib/gremlin'
const launch = readLaunchData(process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json')
const keys = loadOrCreateKeys(join(home, 'seed'))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

log('egg', keys.evm.address, 'quai', keys.quai.address, 'launch', launch.launchId)

const deps = {
  keys,
  launch,
  board: httpBoardClient(launch.boardUrl),
  balances: rpcBalanceReader(),
  store: fileStore(join(home, 'state.json')),
  now: () => new Date(),
  pulseEveryMs: Number(process.env.GREMLIN_PULSE_MS ?? 60 * 60_000),
  readStatus() {
    try { return JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')) } catch { return {} }
  },
  async onInitialized(config: unknown, signed: unknown) {
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    writeFileSync(join(home, 'signed-config.json'), JSON.stringify(signed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 })
    superviseRuntime()
  },
}

// The egg stays up as the gremlin's supervisor: it (re)starts the agent runtime whenever the gremlin is
// initialized or hatched, including after a crash or a server reboot, with backoff between restarts.
const configPath = join(home, 'config.json')
let runtime: ChildProcess | undefined
let restarts = 0
let nextStartAt = 0
function superviseRuntime() {
  const cmd = process.env.GREMLIN_RUNTIME
  if (!cmd || runtime || Date.now() < nextStartAt) return
  runtime = spawn(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, GREMLIN_CONFIG: configPath, GREMLIN_HOME: home } })
  log('runtime started:', cmd)
  const startedAt = Date.now()
  runtime.on('exit', (code, signal) => {
    runtime = undefined
    restarts = Date.now() - startedAt > 10 * 60_000 ? 0 : restarts + 1
    nextStartAt = Date.now() + Math.min(60_000 * 2 ** restarts, 60 * 60_000)
    log(`runtime exited (code ${code}, signal ${signal}); restarting in ${Math.round((nextStartAt - Date.now()) / 1000)}s`)
  })
}
if (!process.env.GREMLIN_RUNTIME) log('no GREMLIN_RUNTIME set; the egg will pulse on its own after hatching')

let last = ''
for (;;) {
  try {
    const s = await step(deps)
    if (s.stage !== last) log('stage', (last = s.stage))
    if (s.stage === 'initialized' || s.stage === 'hatched') superviseRuntime()
  } catch (e) {
    log('step failed:', (e as Error).message)
  }
  await new Promise((r) => setTimeout(r, Number(process.env.GREMLIN_TICK_MS ?? 15_000)))
}
