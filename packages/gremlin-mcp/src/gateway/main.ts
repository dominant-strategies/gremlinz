#!/usr/bin/env node
/** gremlin-gateway: GATEWAY_CONFIG=/path/gateway.json gremlin-gateway. Started by the egg before Hermes. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { telemetry } from '../dev/telemetry.js'
import { GatewayConfig } from './config.js'
import { createGateway } from './server.js'
import { Ledger, type LedgerRecord } from './ledger.js'
import { loadRatings, observe, type ModelRating, type Observed } from './ratings.js'
import { boardUrl, chainKeys, homeFile, keys, phrase } from '../env.js'
import { boardGrantPool } from './grant-pool.js'
import { Credentials } from './credentials.js'
import { Documentation } from './documentation.js'
import { documentationTargets } from './documentation-targets.js'
import { AccessSources } from './access.js'
import { MAINTENANCE_DAILY_USD, spending } from './spending.js'
import { Reservations } from './reservations.js'
import { veniceFetch } from './venice.js'
import { setKnownSecrets } from './glean.js'
import { base58 } from '@scure/base'
import { hashferenceFetch } from './providers.js'
import { healthReader, readHealth } from '../health/gate.js'
import { applyCatalog, fetchCatalog } from './catalog.js'
import { HASHFERENCE, readKey, settledHashferenceUsage } from '../hashference.js'

const cfg = GatewayConfig.parse(JSON.parse(readFileSync(process.env.GATEWAY_CONFIG ?? '/etc/gremlin/gateway.json', 'utf8')))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ledgerFile = homeFile('inference-ledger.jsonl')
const ledger = new Ledger(ledgerFile)
const diagnostics = telemetry('gateway')

// Wallet-signed providers sign with the gremlin's EVM key; the last reported balance is kept for the runway.
// The gremlin's own secrets are never sent to a free endpoint, wherever they turn up in a request.
setKnownSecrets([phrase(), keys().evm.privateKey, keys().quai.privateKey])
void chainKeys().then((k) => setKnownSecrets([phrase(), keys().evm.privateKey, keys().quai.privateKey, base58.encode(k.solana.secretKey)])).catch(() => {})

const keepBalance = (id: string) => (b: unknown) => writeFileSync(homeFile(`balance-${id}.json`), JSON.stringify(b), { mode: 0o600 })
const fetchers = Object.fromEntries([
  ...cfg.providers.filter((p) => p.kind === 'venice-x402').map((p) => [p.id, veniceFetch(p, keys().evm.privateKey, keepBalance(p.id))]),
  ...cfg.providers.filter((p) => p.kind === 'hashference').map((p) => [p.id, hashferenceFetch(p, keepBalance(p.id))]),
])

// The providers' catalogues, every 6 hours: prices for the maker's named models, and spare models of the kinds its model
// policy allows (so a withdrawn model is replaced by one the maker would accept).
const spares = new Set<string>()
const refreshCatalog = async () => {
  const notes = applyCatalog(cfg, await fetchCatalog(), spares)
  if (notes.length) log(`catalog: ${notes.join('; ')}`)
}
void refreshCatalog()
setInterval(() => void refreshCatalog(), 6 * 3_600_000).unref()

const billedProviders = cfg.providers.filter(p => p.kind === 'hashference' && new URL(p.baseUrl).origin === HASHFERENCE)
let syncingCharges = false
async function syncCharges() {
  if (syncingCharges) return
  syncingCharges = true
  try {
    for (const p of billedProviders) {
      const key = p.keyFile ? readKey(p.keyFile) : undefined
      if (!key) continue
      try {
        for (const charge of await settledHashferenceUsage(key)) ledger.settle(p.id, charge.id, charge.costMicrousd)
      } catch { log('Hashference charge reconciliation unavailable; keeping local estimates') }
    }
  } finally { syncingCharges = false }
}
if (billedProviders.length) {
  void syncCharges()
  setInterval(() => void syncCharges(), 60_000).unref()
}

// gremlin-auto reads ratings (GREMLIN_HOME/ratings.json, refreshed by the rating skill) and the last 30 days of the
// ledger, at most once a minute.
let cache: { at: number; ratings: ModelRating[]; seen: Map<string, Observed> } | undefined
const router = () => {
  if (!cache || Date.now() - cache.at > 60_000) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const entries = existsSync(ledgerFile)
      ? readFileSync(ledgerFile, 'utf8').split('\n').flatMap((l) => { try { const e = JSON.parse(l) as LedgerRecord; return e.kind !== 'settlement' && e.at >= since ? [e] : [] } catch { return [] } })
      : []
    cache = { at: Date.now(), ratings: loadRatings(homeFile('ratings.json')), seen: observe(entries) }
  }
  return { ratings: cache.ratings, seen: cache.seen }
}

// Grant authorization is revalidated per request with a 30-second refresh / 60-second maximum age.
const grants = boardGrantPool(boardUrl(), keys().evm, (account, since) => ledger.accountUsed(account, since), log)
const reservations = new Reservations({ file: homeFile('inference-reservations.json') })
const credentials = new Credentials({ file: homeFile('inference-credentials.json') })
const sources = new AccessSources(homeFile('inference-sources.json'))
const documentation = new Documentation({ file: homeFile('inference-docs.json'), dir: homeFile('inference-docs') })
const targets = () => documentationTargets(cfg, sources)
const providerEnv = { ...process.env }
delete providerEnv.GREMLIN_SERVICE_TOKEN
delete providerEnv.GREMLIN_MCP_TOKEN
// Public docs are checked without model access or credentials; individual documents have a 24-hour TTL.
const checkDocumentation = () => documentation.check(targets()).then(docs => { diagnostics.emit('documentation', { pendingReviews: docs.filter(d => d.status === 'needs-review').length, unreachableDocuments: docs.filter(d => d.status === 'unreachable').length }) }).catch(() => log('documentation check failed; maintenance should inspect official URLs'))
void checkDocumentation()
setInterval(() => void checkDocumentation(), 3_600_000).unref()
// The health monitor's directive goes into every request (re-read every 30 s; none when health.json is stale).
createGateway(cfg, {
  adminToken: process.env.GREMLIN_SERVICE_TOKEN, env: providerEnv,
  maintenanceReady: () => {
    const h = readHealth()
    const floor = h?.areas.inference.numbers.floorUsd
    const budget = cfg.budget
    return !!h && !!budget && h.status === 'ok' && h.areas.compute.level === 'ok' &&
      typeof floor === 'number' && h.inferenceUsd >= floor + 1 &&
      Number(h.areas.compute.numbers.diskFreePct) >= 20 && Number(h.areas.compute.numbers.memFreePct) >= 20 &&
      ledger.spent(true) < MAINTENANCE_DAILY_USD && budget.dailyUsd - budget.emergencyUsd - ledger.spent() >= MAINTENANCE_DAILY_USD
  },
  log, fetchers, router, credentials, sources, documentation: { watch: documentation, targets }, refreshLent: async () => { await grants.offers(true) }, lent: () => grants.offers(), lentStatus: () => grants.status(), health: healthReader(),
  captureDetails: diagnostics.enabled,
  onCall: (r, t) => {
    const entry = ledger.record(r, t)
    diagnostics.emit('inference', { requestId: r.requestId, provider: r.provider, model: r.model, alias: r.alias, status: r.status, durationMs: r.ms, firstByteMs: r.firstByteMs, requestBytes: r.requestBytes, messageCount: r.messageCount, toolCount: r.toolCount, inputTokens: r.usage?.promptTokens, outputTokens: r.usage?.completionTokens, cachedInputTokens: r.usage?.cachedPromptTokens, reasoningTokens: r.usage?.reasoningTokens, valuedUsd: entry.usd, priced: entry.priced, estimated: !r.usage || !!r.incomplete, usageReported: !!r.usage, lent: !!t.grantId, free: r.free, incomplete: !!r.incomplete, refused: !!r.refused })
  },
  ...spending(cfg, ledger, grants, reservations),
})
  .listen(cfg.port, cfg.host, () => log(`gateway on http://${cfg.host}:${cfg.port}/v1 (${Object.keys(cfg.routes).join(', ')}, gremlin-auto)`))
