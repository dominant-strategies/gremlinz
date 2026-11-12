#!/usr/bin/env node
// Uses a throwaway identity and no network. Never point this at a live gremlin's data.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'

const image = process.argv[2] ?? 'gremlins/egg:reliability-dev'
const name = `gremlinz-reliability-${randomUUID().slice(0, 8)}`
const fixture = mkdtempSync(join(tmpdir(), 'gremlinz-docker-'))
const home = join(fixture, 'gremlin'), hermes = join(fixture, 'hermes'), config = join(fixture, 'etc')
for (const path of [home, hermes, config, join(hermes, 'cron'), join(hermes, 'work')]) mkdirSync(path, { recursive: true, mode: 0o700 })
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
const phrase = Wallet.createRandom().mnemonic.phrase + '\n'
const seedHash = createHash('sha256').update(phrase).digest('hex')
writeFileSync(join(home, 'seed'), phrase, { mode: 0o600 })
const maker = Wallet.createRandom().address
json(join(config, 'launch.json'), { mode: 'egg', maker, configHash: '0x' + '1'.repeat(64), boardUrl: 'http://127.0.0.1:9', launchId: name })
json(join(home, 'config.json'), { version: 1, name: 'reliability-test', persona: 'A disposable recovery test.', goals: ['Test recovery'], maker, parent: 'maker', revenueSplit: { kind: 'none' }, mischiefScope: { game: false, board: false, email: false, phone: false, money: false }, constitution: [], createdAt: new Date().toISOString() })
json(join(home, 'state.json'), { stage: 'hatched', bootedAt: new Date().toISOString(), lastPulseAt: new Date().toISOString(), pulseSeq: 1, log: [] })
// Keep the real Hermes scheduler idle throughout this fault test.
json(join(hermes, 'cron/jobs.json'), { jobs: [{ id: 'a0a0a0a0a0a1', state: 'scheduled', enabled: true, schedule: { kind: 'interval', minutes: 45, display: 'every 45m' }, next_run_at: new Date(Date.now() + 86_400_000).toISOString() }] })
writeFileSync(join(hermes, 'work', 'memory-sentinel.txt'), 'preserve my work\n')
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const inside = (...args) => docker('exec', name, ...args)
const read = path => JSON.parse(inside('cat', path))
const snapshot = () => read('/var/lib/gremlin/runtime-health.json')
const wait = async (message, predicate, timeout = 120_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    try { if (await predicate()) { console.log(`PASS ${message}`); return } } catch { /* startup/restart */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out: ${message}`)
}
const run = () => docker('run', '-d', '--name', name, '--network', 'none', '--init', '--restart=no', '--stop-timeout=20', '--memory=1536m', '--cpus=1.5', '--pids-limit=512',
  '--health-interval=5s', '--health-start-period=20s', '-e', 'GREMLIN_TICK_MS=1000',
  '-v', `${home}:/var/lib/gremlin`, '-v', `${hermes}:/var/lib/gremlin-hermes`, '-v', `${config}:/etc/gremlin:ro`, image)
const unchanged = () => {
  assert.equal(inside('sha256sum', '/var/lib/gremlin/seed').split(' ')[0], seedHash)
  assert.equal(inside('cat', '/var/lib/gremlin-hermes/work/memory-sentinel.txt'), 'preserve my work')
  assert.equal(inside('stat', '-c', '%u', '/var/lib/gremlin/state.json'), inside('id', '-u', 'gremlin'))
}
try {
  console.log(`Testing ${image}; container ${name}; disposable state ${fixture}`)
  run()
  await wait('real Hermes, gateway, MCP and independent health worker start', () => snapshot().healthy && Object.keys(snapshot().services).length === 4)
  await wait('Docker health check reports healthy', () => docker('inspect', '--format', '{{.State.Health.Status}}', name) === 'healthy')
  inside('node', '--input-type=module', '-e', "import {writeJsonDurable} from '@gremlins/hatch/node'; const p='/var/lib/gremlin/ownership-probe.json'; writeJsonDurable(p,{value:1}); writeJsonDurable(p,{value:2})")
  assert.equal(inside('sudo', '-n', '-u', 'gremlin', 'cat', '/var/lib/gremlin/ownership-probe.json'), '{\n  "value": 2\n}')
  console.log('PASS root-created and replaced state stays readable by the gremlin user')
  let before = snapshot()
  inside('kill', '-KILL', String(before.services.hermes.pid))
  await wait('Hermes restarts independently', () => {
    const after = snapshot()
    return after.healthy && after.services.hermes.pid !== before.services.hermes.pid && after.services.health.pid === before.services.health.pid && after.services.gateway.pid === before.services.gateway.pid
  })
  before = snapshot()
  inside('kill', '-STOP', String(before.services.mcp.pid))
  await wait('hung MCP is replaced while the health worker and Hermes stay running', () => {
    const after = snapshot()
    return after.healthy && after.services.mcp.pid !== before.services.mcp.pid && after.services.health.pid === before.services.health.pid && after.services.hermes.pid === before.services.hermes.pid
  })
  before = snapshot()
  const runnerPid = inside('pgrep', '-f', '^node /app/packages/gremlin-mcp/dist/runner/main.js$')
  assert.match(runnerPid, /^\d+$/)
  inside('kill', '-KILL', runnerPid)
  await wait('egg replaces a killed supervisor and cleans up its old children', () => {
    const after = snapshot()
    return after.healthy && Object.keys(before.services).every(key => after.services[key].pid !== before.services[key].pid)
  })
  unchanged()
  docker('restart', '--time', '20', name)
  await wait('container restarts with the same identity and memory', () => snapshot().healthy)
  unchanged()
  docker('rm', '-f', '-v', name)
  run()
  await wait('container recreation reuses both explicit state mounts', () => snapshot().healthy)
  unchanged()
  console.log('PASS seed and work survived crashes, restart and container recreation; no network or real funds used')
} catch (error) {
  try { console.error(docker('logs', '--tail', '100', name)) } catch { /* container may not exist */ }
  throw error
} finally {
  try { docker('rm', '-f', '-v', name) } catch { /* already gone */ }
  console.log(`Test container removed. Disposable state retained at ${fixture} (container-owned permissions).`)
}
