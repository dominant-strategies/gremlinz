/**
 * The gremlin's inference gateway: an OpenAI-compatible HTTP server on localhost. Hermes is configured with this as
 * its only provider. For each request the gateway walks the alias's route, skipping providers in cooldown, and fails
 * over on provider-side errors. Streams are passed through as they arrive (failover only before the first byte).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { GatewayConfig, RouteTarget } from './config.js'
import { providerFetch, retryable, type UpstreamFetch } from './providers.js'

export interface Usage { promptTokens: number; completionTokens: number }
export interface CallRecord { at: string; alias: string; provider: string; model: string; status: number; usage?: Usage; ms: number }

export interface GatewayDeps {
  /** Per-provider fetchers; defaults built from config (venice needs a signer, injected by the caller). */
  fetchers?: Record<string, UpstreamFetch>
  /** Called after each upstream call (the budget ledger subscribes here). */
  onCall?: (r: CallRecord, target: RouteTarget) => void
  /** Return a reason to refuse the request before any upstream call (budget). */
  refuse?: () => string | undefined
  now?: () => number
  log?: (...a: unknown[]) => void
}

const COOLDOWN_MIN_MS = 30_000
const COOLDOWN_MAX_MS = 10 * 60_000

export function createGateway(cfg: GatewayConfig, deps: GatewayDeps = {}): Server {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const providers = new Map(cfg.providers.map((p) => [p.id, p]))
  const fetchers = new Map(cfg.providers.map((p) => [p.id, deps.fetchers?.[p.id] ?? (p.kind === 'openai' ? providerFetch(p) : undefined)]))
  const cooldown = new Map<string, { until: number; ms: number }>()
  const down = (id: string) => {
    const prev = cooldown.get(id)
    const ms = Math.min(COOLDOWN_MAX_MS, prev ? prev.ms * 2 : COOLDOWN_MIN_MS)
    cooldown.set(id, { until: now() + ms, ms })
    log(`provider ${id} cooling down for ${ms / 1000}s`)
  }

  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models')
        return json(res, 200, { object: 'list', data: Object.keys(cfg.routes).map((id) => ({ id, object: 'model', owned_by: 'gremlin' })) })
      if (req.method === 'GET' && req.url === '/health')
        return json(res, 200, { ok: true, cooling: Object.fromEntries([...cooldown].filter(([, c]) => c.until > now()).map(([id, c]) => [id, new Date(c.until).toISOString()])) })
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } })

      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      const alias = String(body.model ?? '')
      const route = cfg.routes[alias]
      if (!route) return json(res, 404, { error: { message: `unknown model "${alias}"; use one of: ${Object.keys(cfg.routes).join(', ')}` } })
      const refused = deps.refuse?.()
      if (refused) return json(res, 429, { error: { type: 'budget_exhausted', message: refused } })

      const errors: string[] = []
      for (const target of route) {
        const p = providers.get(target.provider)
        const f = fetchers.get(target.provider)
        if (!p || !f) { errors.push(`${target.provider}: not configured`); continue }
        const c = cooldown.get(p.id)
        if (c && c.until > now()) { errors.push(`${p.id}: cooling down`); continue }
        const started = now()
        const upstreamBody = { ...body, model: target.model, ...(body.stream ? { stream_options: { ...(body.stream_options as object), include_usage: true } } : {}) }
        let up: Response
        try {
          up = await f(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(p.timeoutMs),
          })
        } catch (e) {
          errors.push(`${p.id}: ${(e as Error).message}`)
          down(p.id)
          continue
        }
        if (!up.ok) {
          const text = await up.text().catch(() => '')
          deps.onCall?.({ at: new Date(started).toISOString(), alias, provider: p.id, model: target.model, status: up.status, ms: now() - started }, target)
          if (retryable(up.status)) { errors.push(`${p.id}: ${up.status} ${text.slice(0, 160)}`); down(p.id); continue }
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' })
          return res.end(text)
        }
        cooldown.delete(p.id)
        const record = (usage?: Usage) => deps.onCall?.({ at: new Date(started).toISOString(), alias, provider: p.id, model: target.model, status: up.status, usage, ms: now() - started }, target)
        if (body.stream) return pipeStream(up, res, record)
        const out = (await up.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }
        record(usageOf(out.usage))
        return json(res, 200, { ...out, model: alias })
      }
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

/** Pass SSE through untouched, watching for the final usage chunk. */
async function pipeStream(up: Response, res: ServerResponse, record: (u?: Usage) => void) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  let usage: Usage | undefined
  let buf = ''
  const decoder = new TextDecoder()
  for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk)
    buf += decoder.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue
      try {
        const u = usageOf(JSON.parse(line.slice(5)).usage)
        if (u) usage = u
      } catch { /* partial or non-JSON line */ }
    }
  }
  res.end()
  record(usage)
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
