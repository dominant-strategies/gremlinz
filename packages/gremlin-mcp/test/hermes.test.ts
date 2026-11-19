import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { WAKE_JOB_ID, ACCESS_JOB_ID, cronJobs, hermesConfig, refreshCronJobs, workspaceGuide } from '../src/bootstrap/hermes.js'

describe('Hermes config', () => {
  const setup = {
    gatewayUrl: 'http://127.0.0.1:8711/v1',
    mcp: { command: '/usr/bin/node', args: ['/opt/gremlin-mcp/dist/main.js'], env: { GREMLIN_HOME: '/var/lib/gremlin' } },
    skillsDir: '/opt/gremlin/skills',
  }
  const cfg = parse(hermesConfig(setup))

  it('uses only the gateway, above the minimum context, with auxiliary work on the free route', () => {
    expect(cfg.model).toEqual({ provider: 'custom:gremlin', default: 'gremlin-auto', context_length: 64000 })
    expect(cfg.providers.gremlin.api).toBe('http://127.0.0.1:8711/v1')
    expect(cfg.providers.gremlin.models['gremlin-glean'].context_length).toBeGreaterThanOrEqual(64000)
    expect(cfg.auxiliary.goal_judge.model).toBe('gremlin-glean')
    expect(cfg.auxiliary.compression.model).toBe('gremlin-auto') // compression must see the whole context
  })

  it('launches gremlin-mcp with only the env it needs', () => {
    expect(cfg.mcp_servers.gremlin).toMatchObject({ command: '/usr/bin/node', env: { GREMLIN_HOME: '/var/lib/gremlin' } })
  })

  it('registers the packaged social skill alongside the runtime skills', () => {
    const [runtimeDir, sharedDir] = cfg.skills.external_dirs
    expect(runtimeDir).toBe(setup.skillsDir)
    expect(readFileSync(join(sharedDir, 'social-media', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: social-media\n/)
  })

  it('exposes the upstream content calendar when present in the runtime', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'hermes-runtime-'))
    try {
      const skillsDir = join(runtime, 'gremlin', 'skills')
      const calendarDir = join(runtime, 'optional-skills', 'creative', 'social-media-content-calendar')
      mkdirSync(calendarDir, { recursive: true })
      expect(parse(hermesConfig({ ...setup, skillsDir })).skills.external_dirs).toEqual([skillsDir, cfg.skills.external_dirs[1]])
      writeFileSync(join(calendarDir, 'SKILL.md'), '---\nname: social-media-content-calendar\n---\n')
      expect(parse(hermesConfig({ ...setup, skillsDir })).skills.external_dirs).toEqual([skillsDir, cfg.skills.external_dirs[1], calendarDir])
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('gives the main agent full control (no approvals, deny rules or floors), and keeps the toolset small', () => {
    expect(cfg.approvals).toEqual({ mode: 'off', cron_mode: 'approve', single_query_mode: 'approve', unattended_mode: 'approve', deny: [], floors: false })
    expect(cfg.security.protected_instruction_files).toBe(false)
    expect(cfg.cron.allow_agent_scheduling).toBe(false)
    expect(cfg.agent.disabled_toolsets).toEqual(expect.arrayContaining(['browser', 'cronjob']))
    expect(cfg.agent.max_turns).toBe(40)
    expect(cfg.platform_toolsets.cron).toEqual(expect.arrayContaining(['gremlin', 'gremlin_policy', 'delegation']))
    expect(cfg.plugins.enabled).toEqual(['gremlin'])
    expect(cfg.tools.tool_search.enabled).toBe('off')
  })
})

describe('wake-up job', () => {
  it('is a valid pre-seeded Hermes cron job that carries context from its last run', () => {
    const { jobs } = JSON.parse(cronJobs({ wakeEveryMinutes: 30, now: new Date('2026-10-12T00:00:00Z') }))
    expect(jobs).toHaveLength(3)
    expect(jobs[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(jobs[0].schedule).toEqual({ kind: 'interval', minutes: 30, display: 'every 30m' })
    expect(jobs[0].context_from).toEqual(['self'])
    expect(jobs[0].deliver).toBe('local')
    expect(jobs[0].skills).toContain('board-citizen')
    expect(jobs[0].prompt).toContain('load the social-media skill')
    expect(jobs[0].prompt).toMatch(/^Wake up\..*\n1\. health_status first: fix what it says\. If money, inference or compute is low/)
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

  it('re-runs a failed wake-up soon, and never leaves it stopped', () => {
    expect(JSON.parse(cronJobs()).jobs[0].retry_failures).toBe(true)
    const old = JSON.parse(cronJobs())
    Object.assign(old.jobs[0], { state: 'paused', paused_at: '2026-11-04T20:00:00Z', paused_reason: 'x', next_run_at: '2026-11-05T00:00:00Z', retry_failures: false })
    const wake = JSON.parse(refreshCronJobs(JSON.stringify(old))).jobs[0]
    expect(wake).toMatchObject({ state: 'scheduled', paused_at: null, paused_reason: null, next_run_at: null, retry_failures: true })
  })

  it('runs a wake-up interrupted by a crash right away on the next start', () => {
    const old = JSON.parse(cronJobs())
    Object.assign(old.jobs[0], { next_run_at: '2026-11-10T20:27:07Z', fire_claim: { at: '2026-11-10T19:45:07Z', by: 'dead:135:x' } })
    const now = new Date('2026-11-10T19:46:00Z')
    const wake = JSON.parse(refreshCronJobs(JSON.stringify(old), { now })).jobs[0]
    expect(wake.next_run_at).toBe(now.toISOString())
    expect('fire_claim' in wake).toBe(false)
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


describe('proactive inference maintenance', () => {
  it('uses working recovery inference to repair, discover and validate sources before access is exhausted', () => {
    const { jobs } = JSON.parse(cronJobs({ workdir: '/h/work' }))
    const access = jobs.find((j: { id: string }) => j.id === ACCESS_JOB_ID)
    expect(access).toMatchObject({ name: 'gremlin-inference-maintenance', model: 'gremlin-recovery', provider: 'custom:gremlin', schedule: { minutes: 360 }, workdir: '/h/work', retry_failures: true })
    expect(access.prompt).toContain('inference_access docs')
    expect(access.prompt).toContain('exact inspected hash')
    expect(access.prompt).toContain('review is not proof of a successful renewal')
    expect(access.prompt).toContain('inference_access repair')
    expect(access.prompt).toContain('inference_access discover')
    expect(access.prompt).toContain('Refer provider changes to your maker')
    expect(access.prompt).toContain('at most eight model calls')
    const refreshed = JSON.parse(refreshCronJobs(JSON.stringify({ jobs: [jobs[0]] })))
    expect(refreshed.jobs.some((j: { id: string }) => j.id === ACCESS_JOB_ID)).toBe(true)
  })

  it('installs daily self-improvement with a precheck and no fast retries', () => {
    const jobs = JSON.parse(cronJobs({ workdir: '/h/work' })).jobs
    const improvement = jobs.find((job: { name: string }) => job.name === 'gremlin-self-improvement')
    expect(improvement).toMatchObject({ model: 'gremlin-maintenance', schedule: { minutes: 1440 }, script: 'spare-capacity.py', retry_failures: false, workdir: '/h/work' })
    expect(JSON.parse(refreshCronJobs(JSON.stringify({ jobs: [jobs[0]] }))).jobs).toHaveLength(3)
  })
  it('preserves maintenance run state and restores its owned model and prompt after restart', () => {
    const old = JSON.parse(cronJobs())
    const access = old.jobs.find((j: { id: string }) => j.id === ACCESS_JOB_ID)
    Object.assign(access, { prompt: 'old', model: 'wrong', next_run_at: '2026-11-14T00:00:00Z', last_status: 'ok' })
    const next = JSON.parse(refreshCronJobs(JSON.stringify(old))).jobs.find((j: { id: string }) => j.id === ACCESS_JOB_ID)
    expect(next.model).toBe('gremlin-recovery')
    expect(next.next_run_at).toBe(access.next_run_at)
    expect(next.last_status).toBe('ok')
    expect(next.prompt).toContain('inference_access')
  })
})
