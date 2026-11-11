/**
 * The gremlin's inference gateway: an OpenAI-compatible HTTP server on localhost. Hermes is configured with this as
 * its only provider. For each request the gateway walks the alias's route, skipping providers in cooldown, and fails
 * over on provider-side errors. Streams are passed through as they arrive (failover only before the first byte).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { GatewayConfig, ProviderConfig, RouteTarget } from './config.js'
import { providerFetch, retryable, type UpstreamFetch } from './providers.js'
import { gleanRoute, sensitiveReason } from './glean.js'
import { refAllowed } from '@gremlins/hatch'
import { classify, isRefusal, mayRetryRefusal, permissiveRoute, routeFor, type RouterInput } from './router.js'

export const AUTO = 'gremlin-auto'

export interface Usage { promptTokens: number; completionTokens: number }
export interface CallRecord { at: string; alias: string; provider: string; model: string; status: number; usage?: Usage; ms: number; refused?: boolean; incomplete?: boolean }

export interface GatewayDeps {
  /** Per-provider fetchers; defaults built from config (venice needs a signer, injected by the caller). */
  fetchers?: Record<string, UpstreamFetch>
  /** Called after each upstream call (the budget ledger subscribes here). */
  onCall?: (r: CallRecord, target: RouteTarget) => void
  /** Return a reason to refuse the request before any upstream call (budget). */
  refuse?: () => string | undefined
  now?: () => number
  log?: (...a: unknown[]) => void
  env?: NodeJS.ProcessEnv
  /** Lent keys usable right now: tried first on every route except free gleaning. */
  lent?: () => { provider: ProviderConfig; fetch: UpstreamFetch; targets: RouteTarget[] }[]
  /** Ratings and observations for gremlin-auto (read per request, so refreshed ratings apply at once). */
  router?: () => Omit<RouterInput, 'providers' | 'glean' | 'fallback'>
  /** The health monitor's word for the model (health.json), added to every request; undefined adds nothing. */
  health?: () => { directive?: string; conserve?: boolean } | undefined
}

/** Only this machine may use the admin endpoints (the gateway binds to localhost too; this holds if it ever doesn't). */
export const isLocal = (addr?: string) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

/**
 * The health directive as a system message right after the caller's own system prompt, where the model weighs it as
 * instructions rather than as conversation. The prompt prefix before it is unchanged, so prompt caches still hit.
 */
export function withDirective<T extends { messages?: unknown }>(body: T, directive?: string): T {
  if (!directive || !Array.isArray(body.messages)) return body
  const msgs = body.messages as { role?: string }[]
  let i = 0
  while (i < msgs.length && (msgs[i]!.role === 'system' || msgs[i]!.role === 'developer')) i++
  return { ...body, messages: [...msgs.slice(0, i), { role: 'system', content: directive }, ...msgs.slice(i)] }
}

/** Adds the reviewed free endpoints as gremlin-glean (unless the config defines that alias itself). */
export function withGlean(cfg: GatewayConfig, env: NodeJS.ProcessEnv): GatewayConfig {
  if (!cfg.glean.enabled || cfg.routes['gremlin-glean']) return cfg
  const g = gleanRoute(env, cfg.glean.models)
  if (!g.route.length) return cfg
  return { ...cfg, providers: [...cfg.providers, ...g.providers.filter((p) => !cfg.providers.some((q) => q.id === p.id))], routes: { ...cfg.routes, 'gremlin-glean': g.route } }
}

/** Size of the body as it would be sent upstream (model swapped in). */
const requestBytes = (body: Record<string, unknown>, model: string) => Buffer.byteLength(JSON.stringify({ ...body, model }))

const COOLDOWN_MIN_MS = 30_000
/** A model its provider stopped offering is skipped this long before trying it again. */
const RETIRED_MS = 6 * 3_600_000
const MODEL_GONE = /unsupported model|model not found|no such model|unknown model|model .{0,40} (?:does not exist|is not available)/i
/** The longest a last-resort request waits for a free provider's call interval. */
const LAST_RESORT_WAIT_MS = 20_000
const COOLDOWN_MAX_MS = 10 * 60_000
/** A provider that wants payment stays out until a top-up is likely (the funding job runs every few minutes). */
const NO_BALANCE_MS = 30 * 60_000

export function createGateway(config: GatewayConfig, deps: GatewayDeps = {}): Server {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const cfg = withGlean(config, deps.env ?? process.env)
  const providers = new Map(cfg.providers.map((p) => [p.id, p]))
  // The maker's model policy: what may be called at all. Free endpoints only when it allows free models.
  const allowed = (t: { provider: string; model: string }) => refAllowed(cfg.policy, t.provider, t.model)
  const freeOk = !cfg.policy || cfg.policy.freeModels
  const keepTo = (route: RouteTarget[] | undefined) => (route && !freeOk ? route.filter(allowed) : route)
  const fetchers = new Map(cfg.providers.map((p) => [p.id, deps.fetchers?.[p.id] ?? (p.kind === 'venice-x402' ? undefined : providerFetch(p))]))
  const cooldown = new Map<string, { until: number; ms: number }>()
  /** provider/model pairs a provider said it no longer offers, until when. */
  const retired = new Map<string, number>()
  const lastCall = new Map<string, number>()
  /** Take a provider out of rotation: exponential for transient trouble; 30 minutes when it wants payment. */
  const down = (id: string, status?: number) => {
    const prev = cooldown.get(id)
    const ms = status === 402 ? NO_BALANCE_MS : Math.min(COOLDOWN_MAX_MS, prev ? prev.ms * 2 : COOLDOWN_MIN_MS)
    cooldown.set(id, { until: now() + ms, ms })
    log(`provider ${id} cooling down for ${ms / 1000}s`)
  }

  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models')
        return json(res, 200, { object: 'list', data: [...Object.keys(cfg.routes), ...(deps.router ? [AUTO] : [])].map((id) => ({ id, object: 'model', owned_by: 'gremlin' })) })
      if (req.method === 'POST' && req.url === '/admin/cooldown/reset') {
        // The health monitor calls this after a top-up, so a provider benched for wanting payment is tried at once.
        if (!isLocal(req.socket.remoteAddress)) return json(res, 403, { error: { message: 'localhost only' } })
        const { provider } = JSON.parse((await readBody(req, 4096)) || '{}') as { provider?: string }
        const reset = provider ? (cooldown.delete(provider) ? [provider] : []) : [...cooldown.keys()]
        if (!provider) cooldown.clear()
        if (reset.length) log(`cooldown reset: ${reset.join(', ')}`)
        return json(res, 200, { reset })
      }
      if (req.method === 'GET' && req.url === '/health')
        return json(res, 200, { ok: true, cooling: Object.fromEntries([...cooldown].filter(([, c]) => c.until > now()).map(([id, c]) => [id, new Date(c.until).toISOString()])) })
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } })

      const health = deps.health?.()
      const body = withDirective(JSON.parse(await readBody(req)) as Record<string, unknown>, health?.directive)
      const alias = String(body.model ?? '')
      let route = alias === 'gremlin-glean' ? keepTo(cfg.routes[alias]) : cfg.routes[alias]
      let retryOnRefusal: RouteTarget[] = []
      if (alias === AUTO && deps.router) {
        const c = classify(body as Parameters<typeof classify>[0])
        const r = deps.router()
        const inp: RouterInput = { ...r, ratings: r.ratings.filter(allowed), providers: new Set(providers.keys()), glean: keepTo(cfg.routes['gremlin-glean']), fallback: cfg.routes['gremlin-main'], conserve: !!health?.conserve }
        route = routeFor(c, inp)
        if (!body.stream && mayRetryRefusal(body as Parameters<typeof mayRetryRefusal>[0])) retryOnRefusal = permissiveRoute(c, inp)
        log(`auto: ${c.domain}/${c.complexity}${c.needsTools ? '/tools' : ''}${inp.conserve ? ' (conserving)' : ''} → ${route.map((t) => `${t.provider}/${t.model}`).join(', ') || '(none)'}`)
      }
      if (!route) return json(res, 404, { error: { message: `unknown model "${alias}"; use one of: ${[...Object.keys(cfg.routes), ...(deps.router ? [AUTO] : [])].join(', ')}` } })

      const errors: string[] = []
      const sensitive = sensitiveReason(body.messages)
      const tried = new Set<string>()
      const lent = (alias === 'gremlin-glean' ? [] : deps.lent?.() ?? []).map((l) => ({ ...l, targets: l.targets.filter(allowed) }))
      for (const l of lent) { providers.set(l.provider.id, l.provider); fetchers.set(l.provider.id, l.fetch) }
      // Once the gremlin's own budget is spent, only lent keys and free endpoints remain usable.
      const refused = deps.refuse?.()
      if (refused && !lent.length && alias !== 'gremlin-glean') return json(res, 429, { error: { type: 'budget_exhausted', message: refused } })
      const ownRoute = refused ? route.filter((t) => providers.get(t.provider)?.free) : route
      // Last resort for every route: the free endpoints. A gremlin that can't pay (or whose paid providers are all down)
      // still gets an answer, weaker but better than none; secrets never go there (checked below).
      const lastResort = alias === 'gremlin-glean' ? [] : (keepTo(cfg.routes['gremlin-glean']) ?? []).filter((t) => !ownRoute.some((o) => o.provider === t.provider && o.model === t.model))
      let queue = [...lent.flatMap((l) => l.targets), ...ownRoute, ...lastResort]
      let lastRefusal: Record<string, unknown> | undefined
      for (let target = queue.shift(); target; target = queue.shift()) {
        if (tried.has(`${target.provider}/${target.model}`)) continue
        tried.add(`${target.provider}/${target.model}`)
        const p = providers.get(target.provider)
        const f = fetchers.get(target.provider)
        // A request over a target's size cap would only come back 400; go straight to the next one.
        if (target.maxRequestBytes && requestBytes(body, target.model) > target.maxRequestBytes) { errors.push(`${target.provider}: request too large for ${target.model} (${Math.round(requestBytes(body, target.model) / 1000)} KB > ${Math.round(target.maxRequestBytes / 1000)} KB)`); continue }
        if (!p || !f) { errors.push(`${target.provider}: not configured`); continue }
        const gone = retired.get(`${target.provider}/${target.model}`)
        if (gone && gone > now()) { errors.push(`${target.provider}/${target.model}: not offered right now`); continue }
        const c = cooldown.get(p.id)
        if (c && c.until > now()) { errors.push(`${p.id}: cooling down`); continue }
        if (p.free && sensitive) { errors.push(`${p.id}: skipped, the request looks like it contains a secret: ${sensitive}`); continue }
        if (p.minIntervalMs && now() - (lastCall.get(p.id) ?? -Infinity) < p.minIntervalMs) {
          // On the last resort, wait out a free provider's short interval rather than fail the whole request.
          const wait = p.minIntervalMs - (now() - (lastCall.get(p.id) ?? -Infinity))
          if (!lastResort.includes(target) || wait > LAST_RESORT_WAIT_MS) { errors.push(`${p.id}: rate limit (one call per ${p.minIntervalMs / 1000}s)`); continue }
          await new Promise((r) => setTimeout(r, wait))
        }
        lastCall.set(p.id, now())
        const started = now()
        const upstreamBody = { ...body, model: target.model, ...(body.stream ? { stream_options: { ...(body.stream_options as object), include_usage: true } } : {}) }
        let up: Response
        const abort = new AbortController()
        let firstByte: ReturnType<typeof setTimeout> | undefined
        const total = setTimeout(() => abort.abort(new Error(`no complete answer in ${p.timeoutMs / 1000}s`)), p.timeoutMs)
        total.unref?.()
        try {
          // fetch resolves when the response starts, so this bounds the time to first byte (a hung provider).
          up = await Promise.race([
            f(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(upstreamBody),
              signal: abort.signal,
            }),
            new Promise<never>((_, reject) => { firstByte = setTimeout(() => { const e = new Error(`no response in ${p.firstByteMs / 1000}s`); abort.abort(e); reject(e) }, p.firstByteMs) }),
          ])
          // The response has started: from here the stream watchdog (stalls) and the whole-request limit apply.
          clearTimeout(firstByte)
        } catch (e) {
          clearTimeout(firstByte)
          clearTimeout(total)
          errors.push(`${p.id}: ${(e as Error).message}`)
          down(p.id)
          continue
        }
        if (!up.ok) {
          const text = await up.text().catch(() => '')
          deps.onCall?.({ at: new Date(started).toISOString(), alias, provider: p.id, model: target.model, status: up.status, ms: now() - started }, target)
          if (retryable(up.status)) { errors.push(`${p.id}: ${up.status} ${text.slice(0, 160)}`); down(p.id, up.status); continue }
          // Catalogs change (a provider withdrew the model): retire just this model for a while, not the provider.
          if ((up.status === 400 || up.status === 404) && MODEL_GONE.test(text)) {
            retired.set(`${p.id}/${target.model}`, now() + RETIRED_MS)
            log(`model ${p.id}/${target.model} not offered; skipping it for ${RETIRED_MS / 3_600_000}h`)
            errors.push(`${p.id}/${target.model}: ${up.status} ${text.slice(0, 120)}`)
            continue
          }
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' })
          return res.end(text)
        }
        cooldown.delete(p.id)
        const t = target
        const record = (usage?: Usage, refusal?: boolean, incomplete?: boolean) => deps.onCall?.({ at: new Date(started).toISOString(), alias, provider: p.id, model: t.model, status: up.status, usage, ms: now() - started, ...(refusal ? { refused: true } : {}), ...(incomplete ? { incomplete: true } : {}) }, t)
        if (body.stream) return pipeStream(up, res, record, p.firstByteMs, () => down(p.id))
        const out = (await up.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string; choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] }
        const msg = out.choices?.[0]?.message
        const refusal = !msg?.tool_calls?.length && isRefusal(msg?.content ?? '')
        record(usageOf(out.usage), refusal)
        if (refusal && retryOnRefusal.length && !t.permissive) {
          // Retry on permissive models only; keep this answer in case they all fail.
          log(`auto: ${p.id}/${t.model} refused; retrying on a permissive model`)
          lastRefusal = out
          queue = retryOnRefusal.filter((r) => !tried.has(`${r.provider}/${r.model}`))
          retryOnRefusal = []
          continue
        }
        return json(res, 200, { ...out, model: alias })
      }
      if (lastRefusal) return json(res, 200, { ...lastRefusal, model: alias })
      return json(res, 503, { error: { type: 'all_providers_failed', message: `every provider for "${alias}" failed: ${errors.join(' | ')}` } })
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: { message: (e as Error).message } })
      else res.end()
    }
  })
}

function usageOf(u?: { prompt_tokens?: number; completion_tokens?: number } | null): Usage | undefined {
  return u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 } : undefined
}

/**
 * Pass SSE through untouched, watching for usage and a finish_reason. A stream that ends without a finish_reason is
 * recorded as incomplete (it counts against the model's rating). If the upstream fails mid-stream, the connection is
 * destroyed rather than ended cleanly, so the client sees a transport error and retries.
 */
async function pipeStream(up: Response, res: ServerResponse, record: (u?: Usage, refusal?: boolean, incomplete?: boolean) => void, stallMs = 120_000, onStall?: () => void) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  let usage: Usage | undefined
  let finished = false
  let buf = ''
  const decoder = new TextDecoder()
  // A stream that goes silent for stallMs is cut (the provider is benched) so the client can retry elsewhere.
  const reader = (up.body as ReadableStream<Uint8Array>).getReader()
  const next = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const t = setTimeout(() => { onStall?.(); reject(new Error(`stream stalled: no data for ${stallMs / 1000}s`)) }, stallMs)
    reader.read().then((r) => { clearTimeout(t); resolve(r) }, (e) => { clearTimeout(t); reject(e) })
  })
  try {
    for (let r = await next(); !r.done; r = await next()) {
      const chunk = r.value
      res.write(chunk)
      buf += decoder.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue
        try {
          const j = JSON.parse(line.slice(5)) as { usage?: Parameters<typeof usageOf>[0]; choices?: { finish_reason?: string | null }[] }
          const u = usageOf(j.usage)
          if (u) usage = u
          if (j.choices?.some((c) => c.finish_reason)) finished = true
        } catch { /* partial or non-JSON line */ }
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {})
    record(usage, false, true)
    res.destroy(e as Error)
    return
  }
  res.end()
  record(usage, false, !finished)
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('request too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}
