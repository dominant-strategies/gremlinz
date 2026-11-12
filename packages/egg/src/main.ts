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
import { cleanupFluenceAccount, fluence, localSigner, sporestack, unusableSshKey, type Provider } from '@gremlins/hosting'
import { step, type RuntimeStatus } from './egg.js'
import { loadOrCreateKeys } from './keys.js'
import { readLaunchData, EggLaunchData, type NestLaunchData } from './launch.js'
import { fileStore } from './store.js'
import { loadOrCreateTransportKey, nestStep, type NestState } from './nest.js'
import { moveOutStep, nestBuild, startMoveOut, isQuiet, type MoveOutDeps, type MoveOutState } from './moveout.js'
import { collectPayload, restorePayload } from './payload.js'
import { hostingFileStore, hostingStep } from './hosting.js'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { restartPlan } from './restart.js'

const home = process.env.GREMLIN_HOME ?? '/var/lib/gremlin'
const runtimeDir = process.env.AUTOMATON_DIR ?? join(homedir(), '.automaton')
const tickMs = Number(process.env.GREMLIN_TICK_MS ?? 15_000)
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const readJson = <T>(p: string): T | undefined => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return undefined }
}
const writeJson = writeJsonDurable
const heartbeat = (extra: object = {}) => writeJson(join(home, 'egg-heartbeat.json'), { at: new Date().toISOString(), ...extra })

// A server that received a gremlin keeps that gremlin's launch data in GREMLIN_HOME; it takes precedence.
const movedLaunch = join(home, 'launch.json')
const launch = readLaunchData(existsSync(movedLaunch) ? movedLaunch : process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json')

if (existsSync(join(home, 'MOVED'))) {
  log('this gremlin moved to a new home:', readFileSync(join(home, 'MOVED'), 'utf8').trim(), '— idling')
  for (;;) { heartbeat({ mode: 'moved', runtimeWanted: false }); await sleep(tickMs) }
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
    restore: async (p: Parameters<typeof restorePayload>[0]) => {
      await restorePayload(p, { gremlinHome: home, runtimeDir })
      // The moved launch data names the old server's build and access; this server's are what apply now (maybe a newer
      // release; dev access carries over because the egg passed it on).
      const moved = join(home, 'launch.json')
      const old = readJson<Record<string, unknown>>(moved)
      if (old) writeJson(moved, { ...old, image: nl.image, artifact: nl.artifact, dev: nl.dev })
    },
  }
  const statePath = join(home, 'nest-state.json')
  let state: NestState = readJson(statePath) ?? { stage: 'booted', bootedAt: new Date().toISOString(), log: [] }
  log('nest for', nl.forGremlin, 'launch', nl.launchId)
  while (state.stage !== 'restored') {
    heartbeat({ mode: 'nest', runtimeWanted: false })
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

/**
 * Local development only: GREMLIN_DEV_BALANCES='{"quai:9":"1000000000000000000000"}' makes the egg see fixed
 * balances, so a local gremlin hatches without real money. Refused unless the board is on this machine.
 */
function devBalances(boardUrl: string) {
  const raw = process.env.GREMLIN_DEV_BALANCES
  if (!raw) return undefined
  const host = new URL(boardUrl).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    log(`ignoring GREMLIN_DEV_BALANCES: board ${host} is not local`)
    return undefined
  }
  const fixed = Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]))
  log('DEV: using pretend balances', raw)
  return { read: async () => fixed }
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
  const restartPath = join(home, 'runtime-restarts.json')
  const previous = readJson<{ failures: number; nextStartAt: number }>(restartPath)
  let restarts = previous?.failures ?? 0
  let nextStartAt = previous?.nextStartAt ?? 0
  let paused = false
  const startRuntime = () => {
    const cmd = process.env.GREMLIN_RUNTIME
    if (paused || !cmd || runtime || Date.now() < nextStartAt) return
    runtime = spawn(cmd, { shell: true, detached: true, stdio: 'inherit', env: { ...process.env, GREMLIN_CONFIG: configPath, GREMLIN_HOME: home } })
    log('runtime started:', cmd)
    const startedAt = Date.now()
    runtime.once('error', error => log('runtime spawn failed:', error.message))
    runtime.on('close', (code, signal) => {
      runtime = undefined
      if (paused) return
      const plan = restartPlan(restarts, Date.now() - startedAt, Date.now())
      restarts = plan.failures
      nextStartAt = plan.nextStartAt
      writeJson(restartPath, plan)
      log(`runtime exited (code ${code}, signal ${signal}); restarting in ${Math.round((nextStartAt - Date.now()) / 1000)}s`)
    })
  }
  const stopRuntime = async () => {
    paused = true
    if (!runtime) return
    const r = runtime
    const signal = (sig: NodeJS.Signals) => { try { if (r.pid) process.kill(-r.pid, sig) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e } }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { signal('SIGKILL'); resolve() }, 15_000)
      r.once('close', () => { clearTimeout(timer); resolve() })
      signal('SIGTERM')
    })
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void stopRuntime().finally(() => process.exit(0)) })
  if (!process.env.GREMLIN_RUNTIME) log('no GREMLIN_RUNTIME set; the egg will pulse on its own after hatching')

  const deps = {
    keys,
    launch: el,
    board,
    balances: devBalances(el.boardUrl) ?? rpcBalanceReader(),
    store,
    now: () => new Date(),
    pulseEveryMs: Number(process.env.GREMLIN_PULSE_MS ?? 60 * 60_000),
    readStatus: () => {
      const status = readJson<RuntimeStatus>(join(home, 'status.json')) ?? {}
      const health = readJson<{ tier: RuntimeStatus['tier']; at: string }>(join(home, 'health-tier.json'))
      return { ...status, ...(health && Date.now() - Date.parse(health.at) < 45 * 60_000 ? { tier: health.tier } : {}) }
    },
    async onInitialized(config: unknown, signed: unknown) {
      writeJson(configPath, config)
      writeJson(join(home, 'signed-config.json'), signed)
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
      // Nests carry their build forward so they can move again later: this server's, or a newer release of it that the
      // gremlin asked for (how it picks up fixes that need a new image).
      const { image, artifact } = nestBuild(req, el.image, el.artifact)
      return launchNestOnSporeStack(req, { ...nest, image, artifact, dev: el.dev }, image, artifact)
    },
    stopRuntime,
    startRuntime: () => { paused = false; nextStartAt = 0; startRuntime() },
    collect: () => collectPayload({ phrase: keys.phrase, gremlinHome: home, runtimeDir, launch: el }),
    pulseSeq: () => store.load()?.pulseSeq ?? 0,
    wipe: async () => {
      for (const f of ['seed', 'state.json', 'config.json', 'signed-config.json', 'status.json', 'hosting.json']) rmSync(join(home, f), { force: true })
      rmSync(runtimeDir, { recursive: true, force: true })
      writeFileSync(join(home, 'MOVED'), `${moveOut?.nestAddress ?? 'unknown nest'} at ${new Date().toISOString()}\n`)
    },
  })
  if (isQuiet(moveOut)) paused = true

  // Hatch custody: take over the hosting account the hatch backend made for this egg, and keep it swept.
  const hosting = hostingFileStore(join(home, 'hosting.json'))
  const hostingMem = {}
  const hostingDeps = {
    launch: el, keys, board, now: () => new Date(), ...hosting,
    cleanup: (f: { hostingKey: string; vmId: string; keepVmIds?: string[] }) =>
      cleanupFluenceAccount(fluence({ signer: localSigner(f.hostingKey as `0x${string}`) }), { vmId: f.vmId, keepVmIds: f.keepVmIds }),
  }
  let lastHosting = ''

  let last = ''
  for (;;) {
    const stage = store.load()?.stage
    if (!isQuiet(moveOut) && (stage === 'initialized' || stage === 'hatched')) startRuntime()
    heartbeat({ mode: 'egg', runtimeWanted: !paused && !!process.env.GREMLIN_RUNTIME && (stage === 'initialized' || stage === 'hatched'), nextStartAt })
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
          for (;;) { heartbeat({ mode: 'moved', runtimeWanted: false }); await sleep(tickMs) }
        }
      }
      if (!isQuiet(moveOut)) {
        const s = await step(deps)
        if (s.stage !== last) log('stage', (last = s.stage))
        if (s.stage === 'initialized' || s.stage === 'hatched') startRuntime()
        // After announcing: the board only hands over to an egg it has seen announced.
        if (s.stage !== 'booted') {
          try {
            const h = await hostingStep(hostingDeps, hostingMem)
            if (h !== lastHosting && h !== 'idle') log('hosting', (lastHosting = h), h === 'swept' ? hosting.load()?.cleanups.at(-1)?.summary ?? '' : '')
          } catch (e) {
            log('hosting step failed:', (e as Error).message)
          }
        }
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
 * (Conway was a host until it discontinued its service.)
 */
type MoveOutRequest = { host: 'sporestack'; token: string; flavor?: string; provider?: Provider; days?: number; image?: string }


type NestLaunch = Parameters<MoveOutDeps['launchNest']>[0]

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
