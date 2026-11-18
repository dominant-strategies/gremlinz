// Snapshots built from the fixture files (a healthy gremlin 27 hours after hatching, at NOW), to mutate per test.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCronRuns } from '../checks.mjs'

export const FIX = join(import.meta.dirname, 'fixtures')
export const NOW = Date.parse('2026-11-16T12:00:00Z')
export const HOUR = 3600e3
export const MIN = 60e3

const json = (p: string) => JSON.parse(readFileSync(join(FIX, p), 'utf8'))
const jsonl = (p: string) => readFileSync(join(FIX, p), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
export const iso = (ms: number) => new Date(ms).toISOString()

export function healthySnapshot(): any {
  const egg = json('board/egg.json').egg
  const account = json('board/account.json')
  return {
    now: NOW,
    state: {
      name: 'pip', board: 'https://gremlinz.ai', launchId: 'launch-pip', jobId: 'job-1', hostingAddress: json('board/job.json').job.hostingAddress,
      maker: '0x003c6127A9A32E1cc722225824d593714c32Eb96', paidAt: iso(NOW - 28.5 * HOUR), eggAddress: egg.address,
      gremlin: { evm: egg.deposit.evm, quai: egg.deposit.quai },
    },
    board: {
      job: json('board/job.json').job,
      egg,
      pulses: json('board/pulses.json').pulses,
      posts: account.posts,
      comments: [json('board/post-12.json').comments[0].replies[0], json('board/post-9.json').comments[0]],
    },
    egg: {
      ip: '203.0.113.7',
      collectedAt: iso(NOW),
      files: {
        health: json('home/health.json'),
        status: json('home/status.json'),
        state: { stage: 'hatched', log: json('home/state.json').log },
        hosting: { present: true, ...(({ hostingKey: _k, shard: _s, ...rest }) => rest)(json('home/hosting.json')) },
        ledger: jsonl('home/inference-ledger.jsonl'),
        actions: jsonl('home/health-actions.jsonl'),
        issues: [],
        earnings: [{ id: 'e1a2b3c4', what: 'Sensor calibration guide for c/markets', amountUsd: 5, status: 'agreed' }],
      },
      cron: { job: json('hermes/cron/jobs.json').jobs[0], runs: parseCronRuns(readFileSync(join(FIX, 'cron-runs.txt'), 'utf8')) },
      security: {
        authorizedKeysFiles: [{ path: '/etc/ssh/gremlinz_dev_keys', keys: 1 }],
        sshd: { authorizedkeysfile: '/etc/ssh/gremlinz_dev_keys', authorizedkeyscommand: 'none', allowusers: 'gremlinz-dev', passwordauthentication: 'no', permitrootlogin: 'no' },
        devKeys: [{ type: 'ssh-ed25519', comment: 'gremlinz-dev', fingerprint: 'SHA256:dev' }],
        cloudInitDisabled: true,
        lockdown: 'active',
        osSecurityPending: 0,
      },
      container: { egg: 'running', gremlinService: 'active', health: 'healthy', watchdog: 'active', restarts: 0, startedAt: iso(NOW - 27 * HOUR) },
      runtime: { wanted: true, healthy: true, at: iso(NOW - 5000), ready: { gateway: true, mcp: true, health: true, hermes: true } },
    },
    expectedDevKeys: ['SHA256:dev'],
  }
}
