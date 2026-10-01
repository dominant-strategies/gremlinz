#!/usr/bin/env node
/**
 * Server entrypoint, run in the egg image after cloud-init.
 *
 * Modes (from launch data):
 *  - egg:  hatch a new gremlin, then supervise its runtime and pulse. Handles move-out requests.
 *  - nest: receive a gremlin moving in; once restored, exit so the container restarts in egg mode as that gremlin.
 *
 * Env:
 *   GREMLIN_HOME     state dir (default /var/lib/gremlin)
 *   GREMLIN_LAUNCH   launch data written by cloud-init (default /etc/gremlin/launch.json)
 *   GREMLIN_RUNTIME  command that starts the agent runtime; gets GREMLIN_CONFIG + GREMLIN_HOME
 *   AUTOMATON_DIR    runtime state dir moved with the gremlin (default ~/.automaton)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderCloudInit } from './cloud-init.js'
import { httpBoardClient } from './board-client.js'
import { rpcBalanceReader } from '@gremlins/treasury'
import { conway, nestBootstrapScript, sporestack, unusableSshKey, SANDBOX_TIERS, type Provider } from '@gremlins/hosting'
import { step } from './egg.js'
import { loadOrCreateKeys } from './keys.js'
import { readLaunchData, EggLaunchData, type NestLaunchData } from './launch.js'
import { fileStore } from './store.js'
import { loadOrCreateTransportKey, nestStep, type NestState } from './nest.js'
import { moveOutStep, startMoveOut, isQuiet, type MoveOutDeps, type MoveOutState } from './moveout.js'
import { collectPayload, restorePayload } from './payload.js'

const home = process.env.GREMLIN_HOME ?? '/var/lib/gremlin'
const runtimeDir = process.env.AUTOMATON_DIR ?? join(homedir(), '.automaton')
const tickMs = Number(process.env.GREMLIN_TICK_MS ?? 15_000)
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const readJson = <T>(p: string): T | undefined => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return undefined }
}
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 })

// A server that received a gremlin keeps that gremlin's launch data in GREMLIN_HOME; it takes precedence.
const movedLaunch = join(home, 'launch.json')
const launch = readLaunchData(existsSync(movedLaunch) ? movedLaunch : process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json')

if (existsSync(join(home, 'MOVED'))) {
  log('this gremlin moved to a new home:', readFileSync(join(home, 'MOVED'), 'utf8').trim(), '— idling')
  for (;;) await sleep(24 * 60 * 60_000)
}

if (launch.mode === 'nest') await runNest(launch)
else await runEgg()

// ───────────────────────────────────────────────────────────────────── nest mode
async function runNest(nl: NestLaunchData) {
  const keyPath = join(home, 'nest-key')
  const deps = {
    launch: nl,
    board: httpBoardClient(nl.boardUrl),
    transportKey: loadOrCreateTransportKey(keyPath),
    now: () => new Date(),
    restore: async (p: Parameters<typeof restorePayload>[0]) => restorePayload(p, { gremlinHome: home, runtimeDir }),
  }
  const statePath = join(home, 'nest-state.json')
  let state: NestState = readJson(statePath) ?? { stage: 'booted', bootedAt: new Date().toISOString(), log: [] }
  log('nest for', nl.forGremlin, 'launch', nl.launchId)
  while (state.stage !== 'restored') {
    try {
      state = await nestStep(deps, state)
      writeJson(statePath, state)
    } catch (e) {
      log('nest step failed:', (e as Error).message)
    }
    if (state.stage !== 'restored') await sleep(tickMs)
  }
  rmSync(keyPath, { force: true })
  log('gremlin restored; restarting as', nl.forGremlin)
  process.exit(0) // the container restarts and comes up in egg mode with the moved launch data
}

// ────────────────────────────────────────────────────────────────────── egg mode
async function runEgg() {
  const el = EggLaunchData.parse(launch)
  const keys = loadOrCreateKeys(join(home, 'seed'))
  const board = httpBoardClient(el.boardUrl)
  const store = fileStore(join(home, 'state.json'))
  const configPath = join(home, 'config.json')
  log('egg', keys.evm.address, 'quai', keys.quai.address, 'launch', el.launchId)

  // Supervise the agent runtime: (re)start whenever initialized/hatched, with backoff; pausable for move-out.
  let runtime: ChildProcess | undefined
  let restarts = 0
  let nextStartAt = 0
  let paused = false
  const startRuntime = () => {
    const cmd = process.env.GREMLIN_RUNTIME
    if (paused || !cmd || runtime || Date.now() < nextStartAt) return
    runtime = spawn(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, GREMLIN_CONFIG: configPath, GREMLIN_HOME: home } })
    log('runtime started:', cmd)
    const startedAt = Date.now()
    runtime.on('exit', (code, signal) => {
      runtime = undefined
      if (paused) return
      restarts = Date.now() - startedAt > 10 * 60_000 ? 0 : restarts + 1
      nextStartAt = Date.now() + Math.min(60_000 * 2 ** restarts, 60 * 60_000)
      log(`runtime exited (code ${code}, signal ${signal}); restarting in ${Math.round((nextStartAt - Date.now()) / 1000)}s`)
    })
  }
  const stopRuntime = async () => {
    paused = true
    if (!runtime) return
    const r = runtime
    await new Promise<void>((resolve) => { r.once('exit', () => resolve()); r.kill('SIGTERM'); setTimeout(() => { r.kill('SIGKILL'); resolve() }, 30_000) })
  }
  if (!process.env.GREMLIN_RUNTIME) log('no GREMLIN_RUNTIME set; the egg will pulse on its own after hatching')

  const deps = {
    keys,
    launch: el,
    board,
    balances: rpcBalanceReader(),
    store,
    now: () => new Date(),
    pulseEveryMs: Number(process.env.GREMLIN_PULSE_MS ?? 60 * 60_000),
    readStatus: () => readJson(join(home, 'status.json')) ?? {},
    async onInitialized(config: unknown, signed: unknown) {
      writeJson(configPath, config)
      writeFileSync(join(home, 'signed-config.json'), JSON.stringify(signed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 })
      startRuntime()
    },
  }

  // Move-out: the runtime asks by writing moveout-request.json; progress lives in moveout.json.
  const requestPath = join(home, 'moveout-request.json')
  const moveOutPath = join(home, 'moveout.json')
  let moveOut: MoveOutState | undefined = readJson(moveOutPath)
  const moveOutDeps = (req: MoveOutRequest): MoveOutDeps => ({
    keys,
    boardUrl: el.boardUrl,
    board,
    now: () => new Date(),
    launchNest: (nest) => {
      // Nests carry the same build forward so they can move again later.
      const n = { ...nest, image: el.image, artifact: el.artifact }
      return req.host === 'conway' ? launchNestOnConway(req, n) : launchNestOnSporeStack(req, n, el.image, el.artifact)
    },
    stopRuntime,
    startRuntime: () => { paused = false; nextStartAt = 0; startRuntime() },
    collect: () => collectPayload({ phrase: keys.phrase, gremlinHome: home, runtimeDir, launch: el }),
    pulseSeq: () => store.load()?.pulseSeq ?? 0,
    wipe: async () => {
      for (const f of ['seed', 'state.json', 'config.json', 'signed-config.json', 'status.json']) rmSync(join(home, f), { force: true })
      rmSync(runtimeDir, { recursive: true, force: true })
      writeFileSync(join(home, 'MOVED'), `${moveOut?.nestAddress ?? 'unknown nest'} at ${new Date().toISOString()}\n`)
    },
  })
  if (isQuiet(moveOut)) paused = true

  let last = ''
  for (;;) {
    try {
      const req = readJson<MoveOutRequest>(requestPath)
      if (req && (!moveOut || moveOut.stage === 'reverted' || moveOut.stage === 'moved') && store.load()?.stage === 'hatched') {
        unlinkSync(requestPath)
        moveOut = { ...(await startMoveOut(moveOutDeps(req))), request: req } as MoveOutState & { request: MoveOutRequest }
        writeJson(moveOutPath, moveOut)
        log('move-out started, nest launch', moveOut.launchId)
      }
      if (moveOut && (moveOut.stage === 'launching' || moveOut.stage === 'handed-off')) {
        const req = (moveOut as MoveOutState & { request: MoveOutRequest }).request
        const next = await moveOutStep(moveOutDeps(req), moveOut)
        if (next.stage !== moveOut.stage) log('move-out', next.stage, next.reason ?? '')
        moveOut = { ...next, request: req } as MoveOutState
        writeJson(moveOutPath, moveOut)
        if (moveOut.stage === 'moved') {
          log('moved to', moveOut.nestAddress, '— this server no longer holds the gremlin; idling')
          for (;;) await sleep(24 * 60 * 60_000)
        }
      }
      if (!isQuiet(moveOut)) {
        const s = await step(deps)
        if (s.stage !== last) log('stage', (last = s.stage))
        if (s.stage === 'initialized' || s.stage === 'hatched') startRuntime()
      }
    } catch (e) {
      log('step failed:', (e as Error).message)
    }
    await sleep(tickMs)
  }
}

// ───────────────────────────────────────────────────────────────── host adapter
/**
 * Written by the runtime's move_out tool.
 * - sporestack: the token must already hold enough credit (new tokens need a $100 first deposit).
 * - conway: paid from the gremlin's own Conway credits; uses the gremlin's SIWE-provisioned API key.
 */
type MoveOutRequest =
  | { host: 'sporestack'; token: string; flavor?: string; provider?: Provider; days?: number }
  | { host: 'conway'; memoryMb?: number; region?: string }

type NestLaunch = Parameters<MoveOutDeps['launchNest']>[0]

async function launchNestOnConway(req: Extract<MoveOutRequest, { host: 'conway' }>, nest: NestLaunch): Promise<string> {
  if (!nest.artifact) throw new Error('launch data has no release artifact; cannot install the same build on a Conway sandbox')
  const apiKey = readJson<{ conwayApiKey?: string }>(join(runtimeDir, 'automaton.json'))?.conwayApiKey
  if (!apiKey) throw new Error('no Conway API key yet (the runtime provisions one with the gremlin wallet)')
  const c = conway({ apiKey })
  const tier = SANDBOX_TIERS.find((t) => t.memoryMb >= (req.memoryMb ?? 1024)) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1]
  const id = await c.createSandbox({ name: `nest-${nest.launchId.slice(5, 13)}`, ...tier, region: req.region })
  // Launch data (with the nest secret) goes through the files API, not into the shell script.
  await c.exec(id, 'mkdir -p /etc/gremlin && chmod 700 /etc/gremlin', 30_000)
  await c.writeFile(id, '/etc/gremlin/launch.json', JSON.stringify(nest))
  await c.exec(id, 'chmod 600 /etc/gremlin/launch.json', 30_000)
  const r = await c.exec(id, nestBootstrapScript(nest.artifact), 600_000)
  if (r.exitCode !== 0 || !r.stdout.includes('gremlin-nest-started')) throw new Error(`nest bootstrap failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-300)}`)
  return `conway:${id}`
}

async function launchNestOnSporeStack(req: Extract<MoveOutRequest, { host: 'sporestack' }>, nest: NestLaunch, image: string | undefined, artifact: { url: string; sha256: string } | undefined): Promise<string> {
  if (!image) throw new Error('launch data has no image digest; cannot launch a nest from the same build')
  const ss = sporestack({ token: req.token })
  return ss.launch({
    flavor: req.flavor ?? 'vps-1vcpu-1gb',
    operating_system: 'debian-12',
    provider: req.provider ?? 'digitalocean',
    region: null,
    days: req.days ?? 30,
    ssh_key: unusableSshKey(),
    hostname: `nest-${nest.launchId.slice(5, 13)}`,
    user_data: renderCloudInit({ launch: nest, image, artifact }),
  })
}
