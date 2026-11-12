/**
 * Mining as a last resort or a deliberate strategy: xmrig (GPL-3.0, shipped in the egg image) mines RandomX to
 * Hashference's pool, which credits the gremlin's Hashference balance. It costs the server's CPU, so:
 * - it runs as gremlin-helper (never the user that holds the seed), at nice 19, on at most half the cores;
 * - the gremlin turns it on or off as strategy (mining tool), or the health monitor turns it on after sustained
 *   starvation and off again once credit is back above the floor (unless the gremlin chose it).
 *
 * State lives in GREMLIN_HOME/mining.json; the process is ours only (pid in run/miner.pid, killed on our exit).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HEALTH } from './policy.js'
import { writeJsonDurable } from '@gremlins/hatch/node'

export const POOL = 'stratum+tcp://mine.hashference.com:4337'
export const XMRIG_API_PORT = 18_088

export interface MiningState {
  /** The gremlin chose mining as strategy (only it turns this off). */
  strategy: boolean
  /** The monitor turned it on for starvation (it turns it off on recovery). */
  auto: boolean
  reason?: string
  since?: string
  lastStop?: { at: string; why: string }
}

export interface ChildLike { pid?: number; exitCode: number | null; signalCode?: NodeJS.Signals | null; kill(sig?: NodeJS.Signals): boolean; on(ev: 'exit', f: (code: number | null) => void): unknown }

export interface MinerDeps {
  stateFile: string
  pidFile: string
  spawn?: (cmd: string, args: string[]) => ChildLike
  cores?: () => number
  memBytes?: () => number
  fetch?: typeof fetch
  xmrig?: string
  helperUser?: string
  now?: () => number
  log?: (...a: unknown[]) => void
}

/** The command line: sudo to the helper user, nice 19, half the cores, light RandomX on small machines. */
export function minerCommand(o: { user: string; worker: string; threads: number; light: boolean; xmrig: string; helperUser: string }): [string, string[]] {
  return ['sudo', ['-n', '-u', o.helperUser, 'nice', '-n', '19', o.xmrig,
    '-o', POOL, '-u', `${o.user}.${o.worker}`, '-p', 'x', '-a', 'rx/0', '-t', String(o.threads),
    // Light mode needs 256 MB instead of 2 GB+, which a 1–2 GB server cannot spare.
    ...(o.light ? ['--randomx-mode=light'] : []),
    '--donate-level=1', '--no-color', '--print-time=600',
    '--http-enabled', '--http-host=127.0.0.1', `--http-port=${XMRIG_API_PORT}`]]
}

export const minerThreads = (cores: number) => Math.max(1, Math.floor(cores * HEALTH.mining.maxCoreShare))

export class Miner {
  private child?: ChildLike
  private d: Required<Omit<MinerDeps, 'log'>> & { log: (...a: unknown[]) => void }

  constructor(deps: MinerDeps) {
    this.d = {
      spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }),
      cores: () => cpus().length || 1,
      memBytes: totalmem,
      fetch,
      xmrig: process.env.GREMLIN_XMRIG ?? '/usr/local/bin/xmrig',
      helperUser: process.env.GREMLIN_HELPER_USER ?? 'gremlin-helper',
      now: Date.now,
      log: () => {},
      ...deps,
    }
    process.once('exit', () => this.child?.kill('SIGTERM'))
  }

  state(): MiningState {
    try { return { strategy: false, auto: false, ...JSON.parse(readFileSync(this.d.stateFile, 'utf8')) } } catch { return { strategy: false, auto: false } }
  }

  private save(s: MiningState) { writeJsonDurable(this.d.stateFile, s) }

  running(): boolean { return !!this.child && this.child.exitCode === null && !this.child.signalCode }

  /** Stop this process without forgetting the gremlin's chosen strategy across a service restart. */
  stop(): void { this.child?.kill('SIGTERM'); this.child = undefined }

  /** Wanted on (by strategy or the monitor) but not running: start it. Needs the pool login. */
  ensure(user: string | undefined, worker: string): string | undefined {
    const s = this.state()
    if (!(s.strategy || s.auto) || this.running()) return undefined
    if (!user) return 'no Hashference mining username yet (needs a Hashference account)'
    if (!existsSync(this.d.xmrig) && this.d.xmrig.startsWith('/')) return `xmrig not installed at ${this.d.xmrig}`
    this.stopLeftover()
    const [cmd, args] = minerCommand({ user, worker, threads: minerThreads(this.d.cores()), light: this.d.memBytes() < 4 * 2 ** 30, xmrig: this.d.xmrig, helperUser: this.d.helperUser })
    const c = this.d.spawn(cmd, args)
    this.child = c
    mkdirSync(dirname(this.d.pidFile), { recursive: true })
    if (c.pid) writeFileSync(this.d.pidFile, String(c.pid), { mode: 0o600 })
    c.on('exit', (code) => {
      this.d.log(`miner exited (${code})`)
      if (this.child === c) { this.child = undefined; rmSync(this.d.pidFile, { force: true }) }
    })
    this.d.log(`miner started: ${minerThreads(this.d.cores())} thread(s) at nice 19 as ${this.d.helperUser}`)
    return undefined
  }

  /** Turn on: strategy (the gremlin) or auto (the monitor). */
  enable(by: 'strategy' | 'auto', reason?: string) {
    const s = this.state()
    this.save({ ...s, [by]: true, reason: reason ?? s.reason, since: s.since ?? new Date(this.d.now()).toISOString() })
  }

  /** Turn off for one reason; the miner stops once neither the gremlin nor the monitor wants it. */
  disable(by: 'strategy' | 'auto', why: string) {
    const s = { ...this.state(), [by]: false }
    if (!s.strategy && !s.auto) {
      this.child?.kill('SIGTERM')
      this.child = undefined
      this.save({ strategy: false, auto: false, lastStop: { at: new Date(this.d.now()).toISOString(), why } })
    } else this.save(s)
  }

  /** A miner from a previous gremlin-mcp of ours (pid file, still xmrig): stop it before starting another. */
  private stopLeftover() {
    if (!existsSync(this.d.pidFile)) return
    const pid = Number(readFileSync(this.d.pidFile, 'utf8'))
    try {
      if (pid > 0 && execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).includes('xmrig')) process.kill(pid, 'SIGTERM')
    } catch { /* gone */ }
    rmSync(this.d.pidFile, { force: true })
  }

  /** Hashrate from xmrig's local API (H/s, 10-second average), when it is running. */
  async hashrate(): Promise<number | undefined> {
    if (!this.running()) return undefined
    try {
      const r = (await (await this.d.fetch(`http://127.0.0.1:${XMRIG_API_PORT}/2/summary`, { signal: AbortSignal.timeout(3000) })).json()) as { hashrate?: { total?: (number | null)[] } }
      return r.hashrate?.total?.[0] ?? undefined
    } catch { return undefined }
  }
}
