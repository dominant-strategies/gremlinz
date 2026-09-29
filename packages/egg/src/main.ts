#!/usr/bin/env node
/**
 * Egg entrypoint, run by the server's init system after cloud-init.
 *
 * Env:
 *   GREMLIN_HOME     state dir (default /var/lib/gremlin)
 *   GREMLIN_LAUNCH   launch data written by cloud-init (default /etc/gremlin/launch.json)
 *   GREMLIN_RUNTIME  command that starts the agent runtime once hatched; gets GREMLIN_CONFIG + GREMLIN_HOME
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { httpBoardClient } from './board-client.js'
import { rpcBalanceReader } from './balances.js'
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
  async onInitialized(config: unknown) {
    const configPath = join(home, 'config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    const cmd = process.env.GREMLIN_RUNTIME
    if (!cmd) return log('initialized; no GREMLIN_RUNTIME set, egg keeps pulsing on its own')
    spawn(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, GREMLIN_CONFIG: configPath, GREMLIN_HOME: home } }).unref()
    log('runtime started:', cmd)
  },
}

let last = ''
for (;;) {
  try {
    const s = await step(deps)
    if (s.stage !== last) log('stage', (last = s.stage))
  } catch (e) {
    log('step failed:', (e as Error).message)
  }
  await new Promise((r) => setTimeout(r, Number(process.env.GREMLIN_TICK_MS ?? 15_000)))
}
