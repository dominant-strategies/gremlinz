import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { withDeadline, withFileLock, writeDurable, writeJsonDurable } from '../src/node.js'

describe('durable state', () => {
  it('never replaces an existing identity, and leaves no temporary files on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-')), file = join(dir, 'seed')
    writeDurable(file, 'original identity', { exclusive: true })
    expect(() => writeDurable(file, 'different identity', { exclusive: true })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('original identity')
    expect(readdirSync(dir)).toEqual(['seed'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('publishes complete replacement JSON and keeps large counters exact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-')), file = join(dir, 'state.json')
    writeJsonDurable(file, { old: true })
    writeJsonDurable(file, { pulse: 12345678901234567890n })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pulse: '12345678901234567890' })
    expect(readdirSync(dir)).toEqual(['state.json'])
  })
})

describe('bounded operations', () => {
  it('serializes payments and releases the kernel lock after an operation fails', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lock-')), 'purchase.lock')
    let release!: () => void
    const first = withFileLock(file, () => new Promise<void>(resolve => { release = resolve }))
    while (!release) await new Promise(resolve => setTimeout(resolve, 5))
    await expect(withFileLock(file, async () => 2)).rejects.toThrow('another payment')
    release(); await first
    await expect(withFileLock(file, async () => { throw new Error('RPC down') })).rejects.toThrow('RPC down')
    await expect(withFileLock(file, async () => 3)).resolves.toBe(3)
  })
  it('returns even when an adapter ignores cancellation', async () => {
    let signal: AbortSignal | undefined
    await expect(withDeadline(s => { signal = s; return new Promise(() => {}) }, 30, 'board')).rejects.toThrow('board timed out')
    expect(signal!.aborted).toBe(true)
  })
  it('releases a payment lock after the owning Node process is killed outright', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lock-crash-')), 'purchase.lock')
    const module = pathToFileURL(resolve('packages/hatch/dist/node.js')).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withFileLock} from ${JSON.stringify(module)}; await withFileLock(${JSON.stringify(file)}, async()=>{console.log('locked');await new Promise(()=>{})})`], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock owner exited before acquiring'))) })
      const exit = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL'); await exit
      let acquired = false
      for (let n = 0; n < 100 && !acquired; n++) {
        try { await withFileLock(file, async () => { acquired = true }) } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
      }
      expect(acquired).toBe(true)
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  })
  it('preserves normal results and original errors', async () => {
    await expect(withDeadline(async () => 42, 100)).resolves.toBe(42)
    await expect(withDeadline(async () => { throw new Error('disk full') }, 100)).rejects.toThrow('disk full')
  })
})
