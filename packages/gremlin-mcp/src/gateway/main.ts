#!/usr/bin/env node
/** gremlin-gateway: GATEWAY_CONFIG=/path/gateway.json gremlin-gateway. Started by the egg before Hermes. */
import { readFileSync } from 'node:fs'
import { GatewayConfig } from './config.js'
import { createGateway } from './server.js'
import { Ledger } from './ledger.js'
import { homeFile, keys } from '../env.js'
import { veniceFetch } from './venice.js'
import { writeFileSync } from 'node:fs'

const cfg = GatewayConfig.parse(JSON.parse(readFileSync(process.env.GATEWAY_CONFIG ?? '/etc/gremlin/gateway.json', 'utf8')))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ledger = new Ledger(homeFile('inference-ledger.jsonl'))
// Wallet-signed providers sign with the gremlin's EVM key; the last reported balance is kept for the runway.
const fetchers = Object.fromEntries(cfg.providers.filter((p) => p.kind === 'venice-x402').map((p) => [p.id, veniceFetch(p, keys().evm.privateKey, (b) =>
  writeFileSync(homeFile(`balance-${p.id}.json`), JSON.stringify(b), { mode: 0o600 }))]))
createGateway(cfg, { log, fetchers, onCall: (r, t) => ledger.record(r, t), refuse: () => ledger.refuse(cfg.budget?.dailyUsd) }).listen(cfg.port, cfg.host, () => log(`gateway on http://${cfg.host}:${cfg.port}/v1 (${Object.keys(cfg.routes).join(', ')})`))
