import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Wallet } from 'ethers'
import { processIdentity, sameProcess } from '../src/runner/identity.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function port() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function running(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z' } catch { return false }
}

describe('runner recovery', () => {
  it('does not mistake a reused PID for a previous child', () => {
    const identity = processIdentity(process.pid)!
    expect(sameProcess(identity)).toBe(true)
    expect(sameProcess({ ...identity, born: 'not-the-same-process' })).toBe(false)
    expect(sameProcess({ ...identity, boot: 'a-previous-boot' })).toBe(false)
  })

  it('cleans up orphaned services after the runner itself is SIGKILLed, preserving seed and memory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'runner-recovery-')), hermes = join(home, 'hermes'), runtime = join(home, 'runtime')
    mkdirSync(join(runtime, 'gremlin/plugin/gremlin'), { recursive: true })
    mkdirSync(join(runtime, 'gremlin/skills'), { recursive: true })
    mkdirSync(hermes, { recursive: true })
    const maker = Wallet.createRandom().address
    const seed = Wallet.createRandom().mnemonic!.phrase
    writeFileSync(join(home, 'seed'), seed)
    writeFileSync(join(home, 'launch.json'), JSON.stringify({ mode: 'egg', maker, configHash: '0x'+'1'.repeat(64), boardUrl: 'http://127.0.0.1:9', launchId: 'process-test' }))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, name: 'recovery-test', persona: 'A test process.', goals: ['Test recovery'], maker, parent: 'maker', revenueSplit: { kind: 'none' }, mischiefScope: { game: false, board: false, email: false, phone: false, money: false }, constitution: [], createdAt: new Date().toISOString() }))
    writeFileSync(join(hermes, 'memory.txt'), 'keep these memories')
    const gateway = join(home, 'gateway.json')
    writeFileSync(gateway, JSON.stringify({ port: await port(), providers: [{ id: 'unused', kind: 'openai', baseUrl: 'http://127.0.0.1:9' }], routes: { 'gremlin-main': [{ provider: 'unused', model: 'unused' }] }, glean: { enabled: false, models: {} } }))
    const fakeHermes = join(home, 'hermes-test')
    writeFileSync(fakeHermes, '#!/usr/bin/env node\nsetInterval(()=>{},1000)\n', { mode: 0o700 })
    const env = { ...process.env, GREMLIN_HOME: home, HERMES_HOME: hermes, GREMLIN_RUNTIME_DIR: runtime, HERMES_BIN: fakeHermes, GATEWAY_CONFIG: gateway,
      GREMLIN_SEPARATE_USERS: '0', GREMLIN_MCP_HTTP: '1', GREMLIN_MCP_PORT: String(await port()), GREMLIN_HEALTH: '0' }
    const entry = resolve('packages/gremlin-mcp/dist/runner/main.js')
    let child: ChildProcess | undefined
    let logs = ''
    const start = () => {
      child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', data => { logs = (logs + data).slice(-10000) })
      child.stderr!.on('data', data => { logs = (logs + data).slice(-10000) })
    }
    const ready = async (oldPid?: number) => {
      const until = Date.now() + 30_000 // allow cold SDK imports while the full suite loads other workers
      while (Date.now() < until) {
        try {
          const snap = JSON.parse(readFileSync(join(home, 'runtime-health.json'), 'utf8'))
          if (snap.healthy && snap.services.gateway.pid !== oldPid) return snap as { services: Record<string, { pid: number }> }
        } catch { /* startup */ }
        if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(logs)
        await sleep(40)
      }
      throw new Error('runner did not recover: '+logs)
    }
    let oldPids: number[] = []
    try {
      start()
      const first = await ready()
      oldPids = Object.values(first.services).map(s => s.pid)
      const exited = new Promise(resolve => child!.once('exit', resolve))
      child!.kill('SIGKILL')
      await exited
      start()
      await ready(first.services.gateway!.pid)
      expect(oldPids.every(pid => !running(pid))).toBe(true)
      expect(readFileSync(join(home, 'seed'), 'utf8')).toBe(seed)
      expect(readFileSync(join(hermes, 'memory.txt'), 'utf8')).toBe('keep these memories')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child!.once('exit', resolve))
        child.kill('SIGTERM'); await exited
      }
      for (const pid of oldPids) if (running(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }, 75000)
})
