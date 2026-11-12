import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Supervisor } from '../src/runner/supervisor.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (condition: () => boolean) => { for (let i = 0; i < 200; i++) { if (condition()) return; await sleep(20) }; throw new Error('recovery did not complete') }
const supervisors: Supervisor[] = []
afterEach(async () => { await Promise.all(supervisors.splice(0).map(s => s.stop())) })
const make = () => {
  const s = new Supervisor(() => {}, { intervalMs: 20, restartMs: 20, maxRestartMs: 100, stopMs: 50, startupMs: 500, probeTimeoutMs: 40, failuresBeforeRestart: 2 })
  supervisors.push(s)
  return s
}

describe('process recovery (real child processes)', () => {
  it('restarts a killed child without interrupting another service', async () => {
    const s = make()
    for (const name of ['agent', 'health']) await s.start({ name, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] })
    const before = s.snapshot().services
    process.kill(before.agent!.pid!, 'SIGKILL')
    await until(() => !!s.snapshot().services.agent?.pid && s.snapshot().services.agent!.pid !== before.agent!.pid)
    expect(s.snapshot().services.health!.pid).toBe(before.health!.pid)
  })
  it('detects a SIGSTOP hang and replaces the unresponsive process', async () => {
    const s = make(), dir = mkdtempSync(join(tmpdir(), 'watchdog-')), portFile = join(dir, 'port')
    const program = `const fs=require('node:fs'),s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(s.address().port)))`
    await s.start({ name: 'gateway', command: process.execPath, args: ['-e', program], probe: async signal => {
      const port = readFileSync(portFile, 'utf8')
      const response = await fetch(`http://127.0.0.1:${port}`, { signal })
      await response.text()
      return response.ok
    } })
    const pid = s.snapshot().services.gateway!.pid!
    process.kill(pid, 'SIGSTOP')
    await until(() => !!s.snapshot().services.gateway?.pid && s.snapshot().services.gateway!.pid !== pid && s.snapshot().services.gateway!.ready)
    expect(s.snapshot().healthy).toBe(true)
  })
  it('reports spawn failure and remains stoppable', async () => {
    const s = make()
    await expect(s.start({ name: 'missing', command: '/definitely/missing/gremlin', args: [] })).rejects.toThrow('did not become ready')
    expect(s.snapshot().healthy).toBe(false)
  })
})
