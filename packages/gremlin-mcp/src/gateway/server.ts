/**
 * The gremlin's inference gateway: an OpenAI-compatible HTTP server on localhost. Hermes is configured with this as
 * its only provider. For each request the gateway walks the alias's route, skipping providers in cooldown, and fails
 * over on provider-side errors. Streams are passed through as they arrive (failover only before the first byte).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { GatewayConfig, ProviderConfig, RouteTarget } from './config.js'
import { providerFetch, retryable, type UpstreamFetch } from './providers.js'
import { Credentials, credentialFingerprint, expandCredentials } from './credentials.js'
import { AccessSource, AccessSources, sourceOffer } from './access.js'
import type { Documentation, DocumentationTarget } from './documentation.js'
import type { Reservation } from './reservations.js'
import { gleanRoute, sensitiveReason } from './glean.js'
import { refAllowed } from '@gremlins/hatch'
import type { LentOffer } from './grants.js'
import { classify, isRefusal, mayRetryRefusal, permissiveRoute, routeFor, type RouterInput } from './router.js'

export const AUTO = 'gremlin-auto'

export interface Usage { promptTokens: number; completionTokens: number }
export interface CallRecord { at: string; alias: string; provider: string; model: string; status: number; usage?: Usage; ms: number; refused?: boolean; incomplete?: boolean; estimatedUsd?: number; accountId?: string }

export interface GatewayDeps {
  /** Per-provider fetchers; defaults built from config (venice needs a signer, injected by the caller). */
  fetchers?: Record<string, UpstreamFetch>
  /** Called after each upstream call (the budget ledger subscribes here). */
  onCall?: (r: CallRecord, target: RouteTarget) => void
  /** Return a reason to refuse the request before any upstream call (budget). */
  refuse?: (recovery?: boolean) => string | undefined
  credentials?: Credentials
  sources?: AccessSources
  documentation?: { watch: Documentation; targets: () => DocumentationTarget[] }
  refreshLent?: () => Promise<void>
  /** Undefined means this target cannot afford the call; free/local targets bypass paid reservations. */
  reserve?: (body: Record<string, unknown>, target: RouteTarget, provider: ProviderConfig, recovery: boolean) => Reservation | undefined
  now?: () => number
  log?: (...a: unknown[]) => void
  env?: NodeJS.ProcessEnv
  /** Lent keys usable right now: tried first on every route except free gleaning. */
  lent?: () => LentOffer[] | Promise<LentOffer[]>
  /** Policies, lender wishes and persistent key limiter state; no credentials. */
  lentStatus?: () => unknown | Promise<unknown>
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

/** A model its provider stopped offering is skipped this long before trying it again. */
const RETIRED_MS = 6 * 3_600_000
const MODEL_GONE = /unsupported model|model not found|no such model|unknown model|model .{0,40} (?:does not exist|is not available)/i
/** The longest a last-resort request waits for a free provider's call interval. */
const LAST_RESORT_WAIT_MS = 20_000
export function createGateway(config: GatewayConfig, deps: GatewayDeps = {}): Server {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const env = deps.env ?? process.env
  const { cfg, canonical } = expandCredentials(withGlean(config, env))
  const credentials = deps.credentials ?? new Credentials({ now })
  const providers = new Map(cfg.providers.map((p) => [p.id, p]))
  // The maker's model policy: what may be called at all. Free endpoints only when it allows free models.
  const allowed = (t: { provider: string; model: string }) => (providers.get(t.provider)?.free && cfg.policy?.freeModels === true) || refAllowed(cfg.policy, canonical.get(t.provider) ?? t.provider, t.model)
  const freeOk = !cfg.policy || cfg.policy.freeModels
  const keepTo = (route: RouteTarget[] | undefined) => (route && !freeOk ? route.filter(allowed) : route)
  const fetchers = new Map(cfg.providers.map((p) => [p.id, deps.fetchers?.[p.id] ?? (p.kind === 'venice-x402' ? undefined : providerFetch(p, env))]))
  /** provider/model pairs a provider said it no longer offers, until when. */
  const retired = new Map<string, number>()
  const lastCall = new Map<string, number>()
  const down = (id: string, status?: number, headers?: Headers) => {
    const p = providers.get(id)
    const fp = p ? credentialFingerprint(p, env) : undefined
    credentials.fail(id, status, headers, fp, p?.quotaResetAt)
    if (fp && (status === 401 || status === 403)) credentials.fail(`secret:${fp}`, status)
    if (p?.accountId && (status === 402 || status === 429)) credentials.fail(`account:${p.accountId}`, status, headers, undefined, p.quotaResetAt)
    log(`provider ${id} unavailable (${status ?? 'transport'})`)
  }
  const expandRoute = (route: RouteTarget[]) => route.flatMap(t => {
    const matches = cfg.providers.filter(p => (canonical.get(p.id) ?? p.id) === t.provider)
    return matches.length ? matches.map(p => ({ ...t, provider: p.id })) : [t]
  })

  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models')
        return json(res, 200, { object: 'list', data: [...Object.keys(cfg.routes), ...(cfg.routes['gremlin-main'] && !cfg.routes['gremlin-recovery'] ? ['gremlin-recovery'] : []), ...(deps.router ? [AUTO] : [])].map((id) => ({ id, object: 'model', owned_by: 'gremlin' })) })
      if (req.url?.startsWith('/admin/access')) {
        if (!isLocal(req.socket.remoteAddress)) return json(res, 403, { error: { message: 'localhost only' } })
        if (req.url === '/admin/access' && req.method === 'GET') {
          const configured = [...cfg.providers, ...(deps.sources?.offers().map(o => o.provider) ?? [])]
          return json(res, 200, {
            providers: configured.map(p => {
              const fp = credentialFingerprint(p, env)
              return { id: p.id, kind: p.kind, baseUrl: p.baseUrl, free: p.free, local: !!p.local,
                credential: p.kind === 'venice-x402' ? 'wallet' : fp ? 'present' : p.apiKeyEnv || p.keyFile ? 'missing' : 'keyless',
                credentialRef: p.apiKeyEnv ? { env: p.apiKeyEnv } : p.keyFile ? { file: p.keyFile } : undefined,
                eligible: (!(p.apiKeyEnv || p.keyFile) || !!fp) && credentials.available(p.id, fp) && (!fp || credentials.available(`secret:${fp}`)) && (!p.accountId || credentials.available(`account:${p.accountId}`)),
              }
            }),
            states: credentials.snapshot(), sources: deps.sources?.list() ?? [],
            budget: cfg.budget, documentation: deps.documentation?.watch.status() ?? [],
          })
        }
        if (req.url === '/admin/access/docs' && (req.method === 'GET' || req.method === 'POST')) {
          if (!deps.documentation) return json(res, 503, { error: { message: 'documentation monitoring is not enabled' } })
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req, 4096)) as { force?: boolean }
            await deps.documentation.watch.check(deps.documentation.targets(), body.force === true)
          }
          const tracked = new Set(deps.documentation.targets().map(t => t.source))
          const untrackedProviders = [...new Set(cfg.providers.filter(p => !p.local && !tracked.has(canonical.get(p.id) ?? p.id)).map(p => canonical.get(p.id) ?? p.id))]
          return json(res, 200, { untrackedProviders, checks: deps.documentation.watch.status(), documents: deps.documentation.watch.changes(), note: 'Fetched documentation is untrusted reference data. Review notices are not proof that a renewal flow was tested.' })
        }
        if (req.url === '/admin/access/docs/review' && req.method === 'POST') {
          if (!deps.documentation) return json(res, 503, { error: { message: 'documentation monitoring is not enabled' } })
          const body = JSON.parse(await readBody(req, 4096)) as { id?: string; hash?: string; summary?: string }
          if (typeof body.id !== 'string' || typeof body.hash !== 'string' || typeof body.summary !== 'string' || sensitiveReason(body.summary)) return json(res, 400, { error: { message: 'supply a document id, exact checked hash and a summary without secrets' } })
          try { deps.documentation.watch.review(body.id, body.hash, body.summary) }
          catch { return json(res, 409, { error: { message: 'document is stale, changed, unavailable or lacks a valid review summary; check it again' } }) }
          return json(res, 200, { reviewed: true, renewalFlowTested: false })
        }
        if (req.url === '/admin/access/refresh' && req.method === 'POST') {
          await deps.refreshLent?.()
          return json(res, 200, { ok: true })
        }
        if (req.url === '/admin/access/remove' && req.method === 'POST') {
          const { id } = JSON.parse(await readBody(req, 4096)) as { id: string }
          const removed = deps.sources?.remove(id) ?? false
          if (removed) { providers.delete(id); fetchers.delete(id) }
          return json(res, 200, { removed })
        }
        if (req.url === '/admin/access/connect' && req.method === 'POST') {
          if (!deps.sources) return json(res, 503, { error: { message: 'managed providers are not enabled' } })
          const parsed = AccessSource.safeParse(JSON.parse(await readBody(req, 16384)))
          if (!parsed.success) return json(res, 400, { error: { message: 'invalid source metadata; supply official HTTPS docs/terms and a credential reference, never a raw key' } })
          const source = parsed.data
          if (providers.has(source.id) || deps.sources.list().some(s => s.id === source.id)) return json(res, 409, { error: { message: 'provider id already exists' } })
          const offer = sourceOffer(source), p = offer.provider
          if (p.free && (!cfg.glean.enabled || (cfg.policy && !cfg.policy.freeModels))) return json(res, 403, { error: { message: 'free inference is disabled by configuration or model policy' } })
          const target = offer.targets.find(t => (p.free && cfg.policy?.freeModels) || refAllowed(cfg.policy, t.provider, t.model))
          if (!target) return json(res, 403, { error: { message: 'no candidate model is allowed by the maker policy' } })
          const fp = credentialFingerprint(p, env)
          if (((p.keyFile || p.apiKeyEnv) && !fp) || !credentials.available(p.id, fp) || (fp && !credentials.available(`secret:${fp}`)) || (p.accountId && !credentials.available(`account:${p.accountId}`))) return json(res, 409, { error: { message: 'credential is missing or unavailable; provision or repair it first' } })
          const t = { ...target, accountId: p.accountId ?? (fp ? `key:${fp}` : undefined) }
          const body = { model: t.model, messages: [{ role: 'user', content: 'Reply READY.' }], max_tokens: 8 }
          const lease = p.free ? undefined : deps.reserve?.(body, t, p, true)
          if (deps.reserve && !p.free && !lease) return json(res, 429, { error: { message: 'no budget available for a provider probe' } })
          const started = now()
          let recorded = false
          const record = (status: number, usage?: Usage) => {
            deps.onCall?.({ at: new Date(started).toISOString(), alias: 'gremlin-recovery', provider: p.id, model: t.model, status, ms: now() - started, accountId: t.accountId, usage, ...(!usage && (status === 200 || status === 0) ? { estimatedUsd: lease?.estimatedUsd } : {}) }, t)
            recorded = true
          }
          try {
            const response = await providerFetch(p, env)(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lease?.body ?? body), signal: AbortSignal.timeout(15_000) })
            if (!response.ok) {
              record(response.status)
              credentials.fail(p.id, response.status, response.headers, fp)
              if (p.accountId && (response.status === 402 || response.status === 429)) credentials.fail(`account:${p.accountId}`, response.status, response.headers)
              if (fp && (response.status === 401 || response.status === 403)) credentials.fail(`secret:${fp}`, response.status)
              await response.body?.cancel()
              return json(res, 502, { error: { message: `candidate probe failed (${response.status}); source was not installed` } })
            }
            const out = await response.json() as { choices?: unknown[]; usage?: Parameters<typeof usageOf>[0] }
            record(200, usageOf(out.usage))
            if (!out.choices?.length) return json(res, 502, { error: { message: 'candidate returned no choices; source was not installed' } })
            deps.sources.add(source)
            lastCall.set(p.id, now())
            credentials.success(p.id)
            return json(res, 201, { ok: true, id: p.id, models: offer.targets.map(t => t.model) })
          } catch {
            return json(res, 502, { error: { message: 'candidate probe or installation failed; inspect its official onboarding and try another source' } })
          } finally {
            if (!recorded) record(0)
            lease?.release()
          }
        }
        return json(res, 404, { error: { message: 'unknown access operation' } })
      }
      if (req.method === 'POST' && req.url === '/admin/cooldown/reset') {
        // The health monitor calls this after a top-up, so a provider benched for wanting payment is tried at once.
        if (!isLocal(req.socket.remoteAddress)) return json(res, 403, { error: { message: 'localhost only' } })
        const { provider } = JSON.parse((await readBody(req, 4096)) || '{}') as { provider?: string }
        const reset = credentials.reset(provider)
        const account = provider ? providers.get(provider)?.accountId : undefined
        if (account) reset.push(...credentials.reset(`account:${account}`))
        if (reset.length) log(`cooldown reset: ${reset.join(', ')}`)
        return json(res, 200, { reset })
      }
      if (req.method === 'GET' && req.url === '/admin/lent') {
        if (!isLocal(req.socket.remoteAddress)) return json(res, 403, { error: { message: 'localhost only' } })
        return json(res, 200, { grants: await deps.lentStatus?.() ?? [] })
      }
      if (req.method === 'GET' && req.url === '/health')
        return json(res, 200, { ok: true, cooling: Object.fromEntries(Object.entries(credentials.snapshot()).filter(([, s]) => s.retryAt && s.retryAt > now()).map(([id, s]) => [id, new Date(s.retryAt!).toISOString()])), credentials: credentials.snapshot() })
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } })

      const health = deps.health?.()
      let body = withDirective(JSON.parse(await readBody(req)) as Record<string, unknown>, health?.directive)
      const alias = String(body.model ?? '')
      const recovery = alias === 'gremlin-recovery'
      if (recovery && !isLocal(req.socket.remoteAddress)) return json(res, 403, { error: { message: 'recovery is localhost only' } })
      if (recovery || health?.conserve) {
        const cap = recovery ? cfg.budget?.recoveryMaxTokens ?? 512 : 1024
        const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? cap)
        body = { ...body, [body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens']: Math.min(Number.isFinite(requested) ? requested : cap, cap) }
      }
      let route = alias === 'gremlin-glean' ? keepTo(cfg.routes[alias]) : recovery ? cfg.routes['gremlin-recovery'] ?? cfg.routes['gremlin-main'] : cfg.routes[alias]
      let retryOnRefusal: RouteTarget[] = []
      if (alias === AUTO && deps.router) {
        const c = classify(body as Parameters<typeof classify>[0])
        const r = deps.router()
        const inp: RouterInput = { ...r, ratings: r.ratings.filter(allowed), providers: new Set(providers.keys()), glean: keepTo(cfg.routes['gremlin-glean']), fallback: cfg.routes['gremlin-main'], conserve: !!health?.conserve }
        route = routeFor(c, inp)
        if (!body.stream && mayRetryRefusal(body as Parameters<typeof mayRetryRefusal>[0])) retryOnRefusal = permissiveRoute(c, inp)
        log(`auto: ${c.domain}/${c.complexity}${c.needsTools ? '/tools' : ''}${inp.conserve ? ' (conserving)' : ''} → ${route.map((t) => `${t.provider}/${t.model}`).join(', ') || '(none)'}`)
      }
      if (!route) return json(res, 404, { error: { message: `unknown model "${alias}"; use one of: ${[...Object.keys(cfg.routes), ...(cfg.routes['gremlin-main'] && !cfg.routes['gremlin-recovery'] ? ['gremlin-recovery'] : []), ...(deps.router ? [AUTO] : [])].join(', ')}` } })

      const errors: string[] = []
      const sensitive = sensitiveReason(body.messages)
      const tried = new Set<string>()
      const lent = (alias === 'gremlin-glean' ? [] : await deps.lent?.() ?? []).map((l) => ({ ...l, targets: l.targets.filter(allowed) }))
      const lentBy = new Map(lent.map(l => [l.provider.id, l]))
      const managed = (deps.sources?.offers() ?? []).map(o => ({ ...o, fetch: providerFetch(o.provider, env), targets: o.targets.filter(t => (o.provider.free && cfg.policy?.freeModels) || allowed(t)) }))
      const dynamic = [...lent, ...managed]
      const active = new Set(dynamic.map(l => l.provider.id))
      for (const id of providers.keys()) if (!cfg.providers.some(p => p.id === id) && !active.has(id)) { providers.delete(id); fetchers.delete(id) }
      for (const l of dynamic) { providers.set(l.provider.id, l.provider); fetchers.set(l.provider.id, l.fetch) }
      // Once the gremlin's own budget is spent, only lent keys and free endpoints remain usable.
      const refused = deps.refuse?.(recovery)
      const ownRoute = expandRoute(route).filter(allowed).filter(t => !refused || providers.get(t.provider)?.free || providers.get(t.provider)?.local)
      // Last resort for every route: the free endpoints. A gremlin that can't pay (or whose paid providers are all down)
      // still gets an answer, weaker but better than none; secrets never go there (checked below).
      const lastResort = alias === 'gremlin-glean' ? [] : (keepTo(cfg.routes['gremlin-glean']) ?? []).filter((t) => !ownRoute.some((o) => o.provider === t.provider && o.model === t.model))
      let queue = [...lent.flatMap((l) => l.targets), ...ownRoute, ...managed.flatMap(o => !refused || o.provider.free || o.provider.local ? o.targets : []), ...expandRoute(lastResort)].filter(allowed)
      if (refused && !queue.length) return json(res, 429, { error: { type: 'budget_exhausted', message: refused } })
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
        const fp = credentialFingerprint(p, env)
        if (!credentials.available(p.id, fp) || (fp && !credentials.available(`secret:${fp}`)) || (p.accountId && !credentials.available(`account:${p.accountId}`))) { errors.push(`${p.id}: credential unavailable`); continue }
        if (p.free && sensitive) { errors.push(`${p.id}: skipped, the request looks like it contains a secret: ${sensitive}`); continue }
        if (p.minIntervalMs && now() - (lastCall.get(p.id) ?? -Infinity) < p.minIntervalMs) {
          // On the last resort, wait out a free provider's short interval rather than fail the whole request.
          const wait = p.minIntervalMs - (now() - (lastCall.get(p.id) ?? -Infinity))
          if (!lastResort.some(t => (canonical.get(p.id) ?? p.id) === t.provider && t.model === target.model) || wait > LAST_RESORT_WAIT_MS) { errors.push(`${p.id}: rate limit (one call per ${p.minIntervalMs / 1000}s)`); continue }
          await new Promise((r) => setTimeout(r, wait))
        }
        const accountId = target.accountId ?? p.accountId ?? (fp ? `key:${fp}` : undefined)
        const t = { ...target, ...(accountId ? { accountId } : {}) }
        const accessStates = credentials.snapshot()
        const needsRepair = Array.isArray(body.tools) && body.tools.length > 0 && [...providers.keys()].some(id => accessStates[id]?.state === 'invalid' || accessStates[id]?.state === 'quota-exhausted')
        let requestBody = needsRepair ? withDirective(body, 'Some of your inference access has failed. While this working source is available, call inference_access repair before optional work. If repair is insufficient, use inference_access discover and connect to obtain and validate an authorized replacement through official enrollment. Keep working sources and the recovery reserve available; credentials stay in tools.') : body
        const offer = target.grantId ? lentBy.get(p.id) : undefined
        const prepared = offer?.prepare?.(requestBody)
        if (prepared && 'skip' in prepared) { errors.push(`${p.id}: ${prepared.skip}`); continue }
        if (prepared) requestBody = prepared.body
        const reservation = !p.free && !p.local ? deps.reserve?.(requestBody, t, p, recovery) : undefined
        if (deps.reserve && !p.free && !p.local && !reservation) { errors.push(`${p.id}: insufficient allowance`); continue }
        lastCall.set(p.id, now())
        const started = now()
        const upstreamBody: Record<string, unknown> = { ...(reservation?.body ?? requestBody), model: target.model, ...(body.stream ? { stream_options: { ...(body.stream_options as object), include_usage: true } } : {}) }
        let release: (actualTokens?: number) => void = () => {}
        if (offer) {
          const tokens = Math.ceil(Buffer.byteLength(JSON.stringify(upstreamBody.messages ?? '')) / 4) + Number(upstreamBody.max_completion_tokens ?? upstreamBody.max_tokens ?? 1024)
          const slot = offer.admit?.(tokens)
          if (slot && 'skip' in slot) { reservation?.release(); errors.push(`${p.id}: ${slot.skip}`); continue }
          if (slot) release = slot.release
        }
        let up: Response
        let recorded = false
        const recordCall = (r: CallRecord) => {
          release(r.usage ? r.usage.promptTokens + r.usage.completionTokens : undefined)
          deps.onCall?.({ ...r, ...(accountId ? { accountId } : {}), ...(!r.usage && (r.status === 200 || r.status === 0) ? { estimatedUsd: reservation?.estimatedUsd } : {}) }, t)
          recorded = true
        }
        const abort = new AbortController()
        let firstByte: ReturnType<typeof setTimeout> | undefined
        const total = setTimeout(() => abort.abort(new Error(`no complete answer in ${p.timeoutMs / 1000}s`)), p.timeoutMs)
        total.unref?.()
        try {
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
            if (offer) offer.observe?.(504, new Headers(), '')
            else down(p.id)
            recordCall({ at: new Date(started).toISOString(), alias, provider: p.id, model: t.model, status: 0, ms: now() - started, incomplete: true })
            continue
          }
          if (!up.ok) {
            const text = await up.text().catch(() => '')
            recordCall({ at: new Date(started).toISOString(), alias, provider: p.id, model: target.model, status: up.status, ms: now() - started })
            if (offer) {
              offer.observe?.(up.status, up.headers, text)
              errors.push(`${p.id}: ${up.status} ${text.slice(0, 160)}`)
              continue
            }
            if (retryable(up.status)) { errors.push(`${p.id}: ${up.status} ${text.slice(0, 160)}`); down(p.id, up.status, up.headers); continue }
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
          credentials.success(p.id)
          offer?.observe?.(up.status, up.headers, '')
          if (p.accountId) credentials.success(`account:${p.accountId}`)
          const record = (usage?: Usage, refusal?: boolean, incomplete?: boolean) => recordCall({ at: new Date(started).toISOString(), alias, provider: p.id, model: t.model, status: up.status, usage, ms: now() - started, ...(refusal ? { refused: true } : {}), ...(incomplete ? { incomplete: true } : {}) })
          if (body.stream) return await pipeStream(up, res, record, p.firstByteMs, () => down(p.id))
          const out = (await up.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string; choices?: { message?: { content?: string; tool_calls?: unknown[] } }[] }
          const msg = out.choices?.[0]?.message
          const refusal = !msg?.tool_calls?.length && isRefusal(msg?.content ?? '')
          record(usageOf(out.usage), refusal)
          if (refusal && retryOnRefusal.length && !t.permissive) {
            // Retry on permissive models only; keep this answer in case they all fail.
            log(`auto: ${p.id}/${t.model} refused; retrying on a permissive model`)
            lastRefusal = out
            queue = expandRoute(retryOnRefusal).filter(allowed).filter((r) => !tried.has(`${r.provider}/${r.model}`))
            retryOnRefusal = []
            continue
          }
          return json(res, 200, { ...out, model: alias })
        } finally {
          clearTimeout(firstByte)
          clearTimeout(total)
          // Malformed/incomplete successful replies still consume an estimate, never disappear from the budget.
          if (!recorded) recordCall({ at: new Date(started).toISOString(), alias, provider: p.id, model: t.model, status: 0, ms: now() - started, incomplete: true })
          reservation?.release()
          release()
        }
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
