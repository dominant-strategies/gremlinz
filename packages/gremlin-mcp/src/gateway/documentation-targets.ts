import { GLEAN_ENDPOINTS } from './glean.js'
import type { GatewayConfig } from './config.js'
import type { AccessSources } from './access.js'
import type { DocumentationTarget } from './documentation.js'

export function documentationTargets(config: GatewayConfig, sources: AccessSources): DocumentationTarget[] {
  const targets: DocumentationTarget[] = []
  for (const p of config.providers) {
    if (p.kind === 'hashference' && new URL(p.baseUrl).origin === 'https://hashference.com') targets.push(
      { id: `${p.id}:renewal`, source: p.id, purpose: 'renewal', url: 'https://hashference.com/docs/agents.md' },
      { id: `${p.id}:quai-payments`, source: p.id, purpose: 'renewal', url: 'https://hashference.com/docs/quai-payments' },
      { id: `${p.id}:api`, source: p.id, purpose: 'api', url: 'https://hashference.com/openapi.json' },
    )
    p.documentationUrls?.forEach((url, i) => targets.push({ id: `${p.id}:documentation:${i}`, source: p.id, purpose: 'renewal', url }))
  }
  if (config.glean.enabled && !config.routes['gremlin-glean']) for (const e of GLEAN_ENDPOINTS) {
    if (e.apiKeyEnv && !process.env[e.apiKeyEnv]) continue
    if (!(config.glean.models[e.id] ?? e.models).length) continue
    targets.push({ id: `glean-${e.id}:terms`, source: `glean-${e.id}`, purpose: 'terms', url: e.terms })
  }
  for (const s of sources.list()) {
    targets.push({ id: `${s.id}:docs`, source: s.id, purpose: 'api', url: s.docsUrl }, { id: `${s.id}:terms`, source: s.id, purpose: 'terms', url: s.termsUrl })
    if (s.renewalDocsUrl) targets.push({ id: `${s.id}:renewal`, source: s.id, purpose: 'renewal', url: s.renewalDocsUrl })
    if (s.specUrl) targets.push({ id: `${s.id}:spec`, source: s.id, purpose: 'api', url: s.specUrl })
  }
  return targets
}
