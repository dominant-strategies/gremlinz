#!/usr/bin/env node
/** gremlin-gateway: GATEWAY_CONFIG=/path/gateway.json gremlin-gateway. Started by the egg before Hermes. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { GatewayConfig } from './config.js'
import { createGateway } from './server.js'
import { Ledger, type LedgerEntry } from './ledger.js'
import { loadRatings, observe, type ModelRating, type Observed } from './ratings.js'
import { boardUrl, homeFile, keys } from '../env.js'
import { allowance, fetchGrants, lentOffers, period, remainingUsd, type OpenGrant } from './grants.js'
import { veniceFetch } from './venice.js'

const cfg = GatewayConfig.parse(JSON.parse(readFileSync(process.env.GATEWAY_CONFIG ?? '/etc/gremlin/gateway.json', 'utf8')))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ledgerFile = homeFile('inference-ledger.jsonl')
const ledger = new Ledger(ledgerFile)

// Wallet-signed providers sign with the gremlin's EVM key; the last reported balance is kept for the runway.
const fetchers = Object.fromEntries(cfg.providers.filter((p) => p.kind === 'venice-x402').map((p) => [p.id, veniceFetch(p, keys().evm.privateKey, (b) =>
  writeFileSync(homeFile(`balance-${p.id}.json`), JSON.stringify(b), { mode: 0o600 }))]))

// gremlin-auto reads ratings (GREMLIN_HOME/ratings.json, refreshed by the rating skill) and the last 30 days of the
// ledger, at most once a minute.
let cache: { at: number; ratings: ModelRating[]; seen: Map<string, Observed> } | undefined
const router = () => {
  if (!cache || Date.now() - cache.at > 60_000) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const entries = existsSync(ledgerFile)
      ? readFileSync(ledgerFile, 'utf8').split('\n').flatMap((l) => { try { const e = JSON.parse(l) as LedgerEntry; return e.at >= since ? [e] : [] } catch { return [] } })
      : []
    cache = { at: Date.now(), ratings: loadRatings(homeFile('ratings.json')), seen: observe(entries) }
  }
  return { ratings: cache.ratings, seen: cache.seen }
}

// Lent keys: fetched from the board every 10 minutes (held in memory only), remaining budgets every 2 minutes.
let grants: OpenGrant[] = []
const remaining = new Map<string, number | undefined>()
const refreshGrants = async () => {
  try {
    grants = await fetchGrants(boardUrl(), keys().evm)
    if (grants.length) log(`lent keys: ${grants.map((g) => g.grant.provider.label).join(', ')}`)
  } catch (e) { log('grants refresh failed:', (e as Error).message) }
}
const refreshRemaining = async () => { for (const g of grants) remaining.set(g.grant.grantId, await remainingUsd(g)) }
void refreshGrants().then(refreshRemaining)
setInterval(() => void refreshGrants(), 10 * 60_000).unref()
setInterval(() => void refreshRemaining(), 2 * 60_000).unref()
const lent = () => lentOffers(grants.map((g) => {
  const now = Date.now()
  const used = ledger.grantUsed(g.grant.grantId, period(g.grant.policy.period, now).start)
  return { g, allow: allowance(g.grant.policy, now, used, remaining.get(g.grant.grantId)) }
}))

createGateway(cfg, { log, fetchers, router, lent, onCall: (r, t) => ledger.record(r, t), refuse: () => ledger.refuse(cfg.budget?.dailyUsd) })
  .listen(cfg.port, cfg.host, () => log(`gateway on http://${cfg.host}:${cfg.port}/v1 (${Object.keys(cfg.routes).join(', ')}, gremlin-auto)`))
