/** Let healthy inference acquire and validate replacement capacity without putting credentials in model context. */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AccessSource } from '../gateway/access.js'
import { GLEAN_ENDPOINTS, sensitiveReason } from '../gateway/glean.js'
import { recordAction } from '../health/stores.js'
import { fail, text } from '../result.js'

export interface AccessDeps {
  fetch?: typeof fetch
  adminUrl?: () => string
  checkHealth: () => Promise<{ status: string; inferenceUsd: number }>
}

export function registerInferenceAccess(server: McpServer, deps: AccessDeps) {
  const request = async (path = '', body?: unknown) => {
    const base = new URL(deps.adminUrl?.() ?? process.env.GREMLIN_GATEWAY_ADMIN ?? (process.env.GREMLIN_GATEWAY_URL ?? 'http://127.0.0.1:8711/v1').replace(/\/v1\/?$/, ''))
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('access management requires the local gateway')
    const r = await (deps.fetch ?? fetch)(new URL(`/admin/access${path}`, base), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path === '/docs' ? 180_000 : 30_000) })
    if (!r.ok) {
      // The admin API returns controlled diagnostics, never provider response bodies or raw credentials.
      const out = await r.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(out.error?.message ?? `gateway access ${r.status}`)
    }
    return r.json()
  }
  server.registerTool('inference_access', {
    description: 'Maintain your ability to think while good inference still works. docs: check official renewal/API/terms documentation for changes (cached daily; refresh forces a check), inspect bounded untrusted evidence, and use web tools for full documents when truncated. review_docs: acknowledge inspection of the exact document hash with a summary; this never marks a renewal flow as tested. status: inspect credentials and sources, never raw keys. repair: run independent account/key/credit recovery and refresh lender grants. discover: list official acquisition leads, then use web research to find current official signup, wallet enrollment, free tiers or providers you can afford. connect: after obtaining an authorized key in a secure server-side JSON file {apiKey} at GREMLIN_HOME/inference-keys/name.json (pass keyFile as inference-keys/name.json) (or an existing environment variable), register official docs/terms, endpoint, models and prices; a small budgeted probe must succeed before the gateway adopts it live. Free/keyless sources need no key. remove: retire a discovered source. Never pass a raw key, seek exposed third-party keys, or bypass quotas. New providers must fit your maker model policy and spending limits.',
    inputSchema: {
      action: z.enum(['status', 'repair', 'discover', 'connect', 'remove', 'docs', 'review_docs']),
      source: AccessSource.optional(),
      refresh: z.boolean().optional(),
      documentId: z.string().min(1).max(200).optional(),
      documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      reviewSummary: z.string().min(1).max(1500).optional(),
      sourceId: z.string().regex(/^discovered-[a-z0-9-]{1,48}$/).optional(),
    },
  }, async ({ action, source, sourceId, refresh, documentId, documentHash, reviewSummary }) => {
    try {
      if (action === 'docs') return text(JSON.stringify(await request('/docs', { force: refresh === true })))
      if (action === 'review_docs') {
        if (!documentId || !documentHash || !reviewSummary || sensitiveReason(reviewSummary)) return fail('review_docs needs the current documentId/documentHash and a reviewSummary without secrets')
        return text(JSON.stringify(await request('/docs/review', { id: documentId, hash: documentHash, summary: reviewSummary })))
      }
      if (action === 'repair') {
        const h = await deps.checkHealth()
        await request('/refresh', {})
        return text(JSON.stringify({ recoveryChecked: true, health: { status: h.status, creditUsd: h.inferenceUsd }, access: await request() }))
      }
      if (action === 'discover') {
        await request('/refresh', {})
        return text(JSON.stringify({ access: await request(), acquisition: [
          { provider: 'Hashference', docs: 'https://hashference.com/docs/agents.md', method: 'Owned Quai wallet: inference_access repair creates or repairs your account/key; health monitor buys credit within its limits.' },
          { provider: 'lender grants', method: 'New grants are fetched now and opened only by your gateway. Additional grants require a willing lender to create a sealed grant; record required lender action without exposing a key.' },
          ...GLEAN_ENDPOINTS.map(e => ({ provider: e.id, baseUrl: e.baseUrl, terms: e.terms, method: e.apiKeyEnv ? `Official account enrollment; existing credential reference ${e.apiKeyEnv}` : 'Keyless lead; verify current official availability and terms before connecting' })),
        ], next: 'Research official provider documentation for additional sources. Complete legitimate enrollment in server-side tooling, saving returned credentials with mode 0600 without printing them. Check tool calling, privacy, prices, reset periods and allowed models; then connect with a credential reference. If enrollment needs an unsupported wallet/auth adapter or owner input, record that requirement instead of claiming access exists. Preserve enough working inference to finish recovery.' }))
      }
      if (action === 'connect') {
        if (!source) return fail('connect requires source metadata and a credential reference, never a raw key')
        if (sensitiveReason(source)) return fail('Source metadata looks like it contains a secret; keep keys in a secure file or environment variable')
        const result = await request('/connect', source)
        recordAction({ kind: 'inference-source-added', detail: `validated and connected ${source.id}` })
        return text(JSON.stringify(result))
      }
      if (action === 'remove') {
        if (!sourceId) return fail('remove requires sourceId')
        const result = await request('/remove', { id: sourceId })
        recordAction({ kind: 'inference-source-removed', detail: sourceId })
        return text(JSON.stringify(result))
      }
      return text(JSON.stringify(await request()))
    } catch (e) { return fail(`Inference access: ${(e as Error).message.slice(0, 300)}`) }
  })
}
