import { spawn, type ChildProcess } from 'node:child_process'
import { withDeadline } from '@gremlins/hatch/node'

export interface ServiceSpec {
  name: string
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  uid?: number
  gid?: number
  probe?: (signal: AbortSignal) => Promise<boolean>
}
interface Service {
  spec: ServiceSpec
  child?: ChildProcess
  startedAt: number
  failures: number
  badProbes: number
  ready: boolean
  checking: boolean
  enabled: boolean
  timer?: ReturnType<typeof setTimeout>
  killer?: ReturnType<typeof setTimeout>
  lastError?: string
}

/** Each child has its own process group; stopping it also stops its shell/subagent descendants. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export class Supervisor {
  private services = new Map<string, Service>()
  private stopped = false
  private interval: ReturnType<typeof setInterval>
  private opts: { intervalMs: number; probeTimeoutMs: number; restartMs: number; maxRestartMs: number; stopMs: number; startupMs: number; failuresBeforeRestart: number }

  constructor(private report: (event: Record<string, unknown>) => void, opts: Partial<Supervisor['opts']> = {}) {
    this.opts = { intervalMs: 10_000, probeTimeoutMs: 2_000, restartMs: 5_000, maxRestartMs: 300_000, stopMs: 10_000, startupMs: 30_000, failuresBeforeRestart: 3, ...opts }
    this.interval = setInterval(() => { for (const s of this.services.values()) void this.check(s) }, this.opts.intervalMs)
  }

  async start(spec: ServiceSpec): Promise<void> {
    if (this.stopped || this.services.has(spec.name)) throw new Error(`cannot start ${spec.name}`)
    const s: Service = { spec, startedAt: 0, failures: 0, badProbes: 0, ready: false, checking: false, enabled: true }
    this.services.set(spec.name, s)
    this.launch(s)
    const until = Date.now() + this.opts.startupMs
    while (!s.ready && Date.now() < until && !this.stopped) {
      await this.check(s)
      if (!s.ready) await new Promise(resolve => setTimeout(resolve, Math.min(100, this.opts.intervalMs)))
    }
    if (!s.ready) throw new Error(`${spec.name} did not become ready`)
  }

  private launch(s: Service): void {
    if (this.stopped || !s.enabled) return
    const c = spawn(s.spec.command, s.spec.args, { env: s.spec.env, uid: s.spec.uid, gid: s.spec.gid, stdio: 'inherit', detached: true })
    s.child = c
    s.startedAt = Date.now()
    s.ready = false
    s.badProbes = 0
    s.killer = undefined
    s.lastError = undefined
    c.once('error', error => { s.lastError = error.message })
    c.once('close', (code, signal) => {
      // A leader can exit while its children remain alive. Never overlap those children with a replacement.
      signalGroup(c, 'SIGKILL')
      clearTimeout(s.killer)
      s.killer = undefined
      s.child = undefined
      s.ready = false
      this.report({ event: 'exit', child: s.spec.name, code, signal, error: s.lastError })
      if (this.stopped || !s.enabled) return
      s.failures = Date.now() - s.startedAt >= 600_000 ? 1 : s.failures + 1
      const delay = Math.min(this.opts.restartMs * 2 ** Math.min(s.failures - 1, 16), this.opts.maxRestartMs)
      s.timer = setTimeout(() => this.launch(s), delay)
    })
    this.report({ event: 'service-start', child: s.spec.name, pid: c.pid })
  }

  private async check(s: Service): Promise<void> {
    const child = s.child
    if (this.stopped || !child?.pid || s.checking || s.killer) return
    s.checking = true
    try {
      const ok = !s.spec.probe || await withDeadline(signal => s.spec.probe!(signal), this.opts.probeTimeoutMs, `${s.spec.name} liveness`)
      if (s.child !== child) return
      if (!ok) throw new Error('liveness probe failed')
      s.ready = true
      s.badProbes = 0
      s.lastError = undefined
    } catch (error) {
      if (s.child !== child) return
      s.lastError = (error as Error).message
      if (++s.badProbes >= this.opts.failuresBeforeRestart && Date.now() - s.startedAt >= this.opts.startupMs) {
        s.ready = false
        this.report({ event: 'watchdog', child: s.spec.name, error: s.lastError })
        this.terminate(s)
      }
    } finally { s.checking = false }
  }

  private terminate(s: Service): void {
    if (!s.child || s.killer) return
    const child = s.child
    // Install the timer before signalling: an immediately exiting child must be able to clear it.
    s.killer = setTimeout(() => signalGroup(child, 'SIGKILL'), this.opts.stopMs)
    signalGroup(child, 'SIGTERM')
  }

  snapshot() {
    const services = Object.fromEntries([...this.services].map(([name, s]) => [name, {
      pid: s.child?.pid, ready: s.ready, failures: s.failures, badProbes: s.badProbes, lastError: s.lastError,
    }]))
    return { at: new Date().toISOString(), healthy: this.services.size > 0 && [...this.services.values()].every(s => s.ready), services }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.interval)
    await Promise.all([...this.services.values()].map(async s => {
      s.enabled = false
      clearTimeout(s.timer)
      if (!s.child) return
      const child = s.child
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      this.terminate(s)
      await closed
    }))
  }
}
