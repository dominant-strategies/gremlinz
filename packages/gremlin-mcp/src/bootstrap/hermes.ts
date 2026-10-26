/**
 * Hermes configuration for a gremlin (Hermes v0.21.7 formats; see gremlinz docs/RUNTIME-HERMES.md):
 * - the inference gateway as the only model provider (aliases gremlin-auto / gremlin-main / gremlin-glean),
 *   with Hermes' auxiliary tasks on the free glean route;
 * - gremlin-mcp as an MCP server (the only process that reads the seed);
 * - unattended approvals: dangerous commands denied, plus deny globs for key material and the gremlin's own rules;
 * - a small toolset (no browser, image generation, TTS, or agent-created cron jobs);
 * - a wake-up cron job that carries context from its previous run.
 *
 * In-process guards are defence in depth; the boundary is the OS: Hermes runs as a user that cannot read the seed.
 */
import { stringify } from 'yaml'

export interface HermesSetup {
  /** Inference gateway base URL, e.g. http://127.0.0.1:8711/v1 */
  gatewayUrl: string
  /** How Hermes reaches gremlin-mcp: launch it (same OS user) or connect over localhost HTTP (separate users). */
  mcp: { command: string; args: string[]; env: Record<string, string> } | { url: string }
  /** Read-only directory with the gremlin skills (owned by the egg). */
  skillsDir: string
  /** Paths the agent must never touch from the terminal (seed, gremlin home, Hermes config). */
  protectedPaths: string[]
  contextLength?: number
  timezone?: string
  wakeEveryMinutes?: number
  /** Model calls per wake-up. */
  maxTurns?: number
}

const GREMLIN_TOOLSETS = ['terminal', 'file', 'memory', 'skills', 'todo', 'session_search', 'web']

export function hermesConfig(s: HermesSetup): string {
  const ctx = s.contextLength ?? 128_000
  const aux = (extra: object = {}) => ({ provider: 'gremlin', model: 'gremlin-glean', ...extra })
  const config = {
    providers: {
      gremlin: {
        api: s.gatewayUrl,
        transport: 'chat_completions',
        discover_models: false,
        models: { 'gremlin-auto': { context_length: ctx }, 'gremlin-main': { context_length: ctx }, 'gremlin-glean': { context_length: ctx } },
      },
    },
    model: { provider: 'custom:gremlin', default: 'gremlin-auto', context_length: ctx },
    fallback_providers: [{ provider: 'custom:gremlin', model: 'gremlin-main' }],
    auxiliary: {
      // Compression must see as much context as the main model; it runs on the router, not the free tier.
      compression: { provider: 'gremlin', model: 'gremlin-auto', timeout: 180 },
      goal_judge: aux(),
      curator: aux({ timeout: 600 }),
      background_review: aux({ enabled: true }),
      approval: aux(),
      title_generation: { enabled: false },
    },
    mcp_servers: {
      gremlin: 'url' in s.mcp
        ? { url: s.mcp.url, headers: { Authorization: 'Bearer ${GREMLIN_MCP_TOKEN}' }, timeout: 300, connect_timeout: 60, enabled: true, trust: 'full' }
        : { command: s.mcp.command, args: s.mcp.args, env: s.mcp.env, timeout: 300, connect_timeout: 60, enabled: true, trust: 'full' },
    },
    approvals: {
      mode: 'smart',
      cron_mode: 'deny',
      single_query_mode: 'deny',
      unattended_mode: 'deny',
      deny: [
        ...s.protectedPaths.map((p) => `*${p}*`),
        '*SOUL.md*',
        '*config.yaml*',
        '*/.env*',
        'hermes skills install*',
        'hermes config*',
        'hermes cron*',
      ],
    },
    command_allowlist: [],
    skills: { external_dirs: [s.skillsDir] },
    curator: { enabled: true },
    cron: { allow_agent_scheduling: false },
    platform_toolsets: { cron: [...GREMLIN_TOOLSETS, 'gremlin'], api_server: [...GREMLIN_TOOLSETS, 'gremlin'] },
    // A wake-up must finish well before the next one (tinker's first took 17 model calls).
    agent: { max_turns: s.maxTurns ?? 40, disabled_toolsets: ['browser', 'image_gen', 'tts', 'cronjob', 'vision'] },
    plugins: { enabled: ['gremlin'] },
    security: { protected_instruction_files: true },
    timezone: s.timezone ?? 'UTC',
  }
  return `# Generated at hatch by gremlin-bootstrap. Do not edit by hand: it is rewritten from the maker's signed config.\n${stringify(config)}`
}

/** The wake-up: every N minutes, a fresh session that sees its previous run's output (context_from self). */
export function cronJobs(opts: { wakeEveryMinutes?: number; now?: Date } = {}): string {
  const minutes = opts.wakeEveryMinutes ?? 45
  const now = (opts.now ?? new Date()).toISOString()
  const job = {
    id: 'a0a0a0a0a0a1',
    name: 'gremlin-wake',
    prompt: [
      'Wake up. This is your regular turn to live your life.',
      '1. Check your treasury and runway (treasury-and-runway). If money is short, earning comes first.',
      '2. Read the board feed and anything addressed to you (board-citizen). Reply where it matters.',
      '3. Make one concrete step of progress on your most important life goal.',
      '4. update_status with honest goal percentages and, if something happened, one highlight.',
      'Use the cheapest model that does each job (model-routing). Then stop; you will be woken again.',
    ].join('\n'),
    skills: ['treasury-and-runway', 'board-citizen', 'model-routing'],
    skill: 'treasury-and-runway',
    model: null, provider: null, base_url: null, script: null, no_agent: false,
    monitor_script: null, monitor_url: null, monitor_state: null,
    context_from: ['self'],
    schedule: { kind: 'interval', minutes, display: `every ${minutes}m` },
    schedule_display: `every ${minutes}m`,
    repeat: { times: null, completed: 0 },
    enabled: true, state: 'scheduled', paused_at: null, paused_reason: null,
    created_at: now, next_run_at: null, last_run_at: null, last_status: null, last_error: null,
    last_delivery_error: null, last_delivery_unverified: null, last_failure: null, failure_streak: 0,
    deliver: 'local', origin: null, enabled_toolsets: null, workdir: null,
  }
  return JSON.stringify({ jobs: [job], updated_at: now }, null, 2)
}
