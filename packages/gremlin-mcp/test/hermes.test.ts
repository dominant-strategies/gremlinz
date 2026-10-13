import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { cronJobs, hermesConfig } from '../src/bootstrap/hermes.js'

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
