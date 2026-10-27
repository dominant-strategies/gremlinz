import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { WAKE_JOB_ID, cronJobs, hermesConfig, refreshCronJobs, workspaceGuide } from '../src/bootstrap/hermes.js'

describe('Hermes config', () => {
  const cfg = parse(hermesConfig({
    gatewayUrl: 'http://127.0.0.1:8711/v1',
    mcp: { command: '/usr/bin/node', args: ['/opt/gremlin-mcp/dist/main.js'], env: { GREMLIN_HOME: '/var/lib/gremlin' } },
    skillsDir: '/opt/gremlin/skills',
    protectedPaths: ['/var/lib/gremlin', 'seed'],
  }))

  it('uses only the gateway, above the minimum context, with auxiliary work on the free route', () => {
    expect(cfg.model).toEqual({ provider: 'custom:gremlin', default: 'gremlin-auto', context_length: 128000 })
    expect(cfg.providers.gremlin.api).toBe('http://127.0.0.1:8711/v1')
    expect(cfg.providers.gremlin.models['gremlin-glean'].context_length).toBeGreaterThanOrEqual(64000)
    expect(cfg.auxiliary.goal_judge.model).toBe('gremlin-glean')
    expect(cfg.auxiliary.compression.model).toBe('gremlin-auto') // compression must see the whole context
  })

  it('launches gremlin-mcp with only the env it needs', () => {
    expect(cfg.mcp_servers.gremlin).toMatchObject({ command: '/usr/bin/node', env: { GREMLIN_HOME: '/var/lib/gremlin' } })
  })

  it('runs unattended with dangerous commands denied and key material off limits', () => {
    expect(cfg.approvals).toMatchObject({ cron_mode: 'deny', unattended_mode: 'deny', single_query_mode: 'deny' })
    expect(cfg.approvals.deny).toEqual(expect.arrayContaining(['*/var/lib/gremlin*', '*seed*', '*SOUL.md*', 'hermes skills install*']))
    expect(cfg.cron.allow_agent_scheduling).toBe(false)
    expect(cfg.agent.disabled_toolsets).toEqual(expect.arrayContaining(['browser', 'cronjob']))
    expect(cfg.agent.max_turns).toBe(40)
    expect(cfg.platform_toolsets.cron).toContain('gremlin')
    expect(cfg.plugins.enabled).toEqual(['gremlin'])
    expect(cfg.tools.tool_search.enabled).toBe('off')
  })
})

describe('wake-up job', () => {
  it('is a valid pre-seeded Hermes cron job that carries context from its last run', () => {
    const { jobs } = JSON.parse(cronJobs({ wakeEveryMinutes: 30, now: new Date('2026-10-12T00:00:00Z') }))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(jobs[0].schedule).toEqual({ kind: 'interval', minutes: 30, display: 'every 30m' })
    expect(jobs[0].context_from).toEqual(['self'])
    expect(jobs[0].deliver).toBe('local')
    expect(jobs[0].skills).toContain('board-citizen')
  })
})

describe('wake-up prompt and refresh', () => {
  it('tells the gremlin to change approach when one gets no response twice', () => {
    const { jobs } = JSON.parse(cronJobs())
    expect(jobs[0].prompt).toMatch(/no response twice, do not repeat it/)
  })

  it('updates an existing job definition but keeps Hermes run state and other jobs', () => {
    const old = JSON.parse(cronJobs({ wakeEveryMinutes: 45 }))
    Object.assign(old.jobs[0], { prompt: 'old prompt', last_run_at: '2026-10-26T21:16:27Z', next_run_at: '2026-10-26T22:01:27Z', failure_streak: 2, last_status: 'ok' })
    old.jobs.push({ id: 'bbbbbbbbbbbb', name: 'agent-made', prompt: 'keep me' })
    const next = JSON.parse(refreshCronJobs(JSON.stringify(old), { wakeEveryMinutes: 45 }))
    const wake = next.jobs.find((j: { id: string }) => j.id === WAKE_JOB_ID)
    expect(wake.prompt).toMatch(/no response twice/)
    expect(wake).toMatchObject({ last_run_at: '2026-10-26T21:16:27Z', next_run_at: '2026-10-26T22:01:27Z', failure_streak: 2, last_status: 'ok' })
    expect(next.jobs.find((j: { id: string }) => j.id === 'bbbbbbbbbbbb').prompt).toBe('keep me')
    // a schedule change recomputes the next run
    expect(JSON.parse(refreshCronJobs(JSON.stringify(old), { wakeEveryMinutes: 30 })).jobs[0].next_run_at).toBeNull()
  })

  it('starts fresh from unreadable files', () => {
    expect(JSON.parse(refreshCronJobs('not json')).jobs[0].id).toBe(WAKE_JOB_ID)
  })
})

describe('work folder', () => {
  it('runs the wake-up in the work folder, including for existing jobs', () => {
    expect(JSON.parse(cronJobs({ workdir: '/h/work' })).jobs[0].workdir).toBe('/h/work')
    const old = cronJobs() // made before work folders existed
    expect(JSON.parse(old).jobs[0].workdir).toBeNull()
    expect(JSON.parse(refreshCronJobs(old, { workdir: '/h/work' })).jobs[0].workdir).toBe('/h/work')
  })

  it('gives the folder a guide that steers work away from /tmp and secrets', () => {
    const g = workspaceGuide('/h/work')
    expect(g).toContain('/h/work')
    expect(g).toMatch(/Never in \/tmp/)
    expect(g).toMatch(/Nothing secret/)
  })
})
