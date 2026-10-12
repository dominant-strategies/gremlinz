#!/usr/bin/env node
/** gremlin-gateway: GATEWAY_CONFIG=/path/gateway.json gremlin-gateway. Started by the egg before Hermes. */
import { readFileSync } from 'node:fs'
import { GatewayConfig } from './config.js'
import { createGateway } from './server.js'
import { Ledger } from './ledger.js'
import { homeFile } from '../env.js'

const cfg = GatewayConfig.parse(JSON.parse(readFileSync(process.env.GATEWAY_CONFIG ?? '/etc/gremlin/gateway.json', 'utf8')))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ledger = new Ledger(homeFile('inference-ledger.jsonl'))
createGateway(cfg, { log, onCall: (r, t) => ledger.record(r, t), refuse: () => ledger.refuse(cfg.budget?.dailyUsd) }).listen(cfg.port, cfg.host, () => log(`gateway on http://${cfg.host}:${cfg.port}/v1 (${Object.keys(cfg.routes).join(', ')})`))
