/**
 * Send log: every outgoing send is recorded in GREMLIN_HOME/sends.jsonl with its USD value at live prices when one
 * is available (Qi via its live Qi→QUAI rate). No spending limits: a gremlin decides for itself what to spend.
 */
import { appendFileSync } from 'node:fs'
import { formatUnits } from 'ethers'
import type { Asset } from './chains.js'

const LLAMA: Record<string, string> = {
  ETH: 'coingecko:ethereum', BNB: 'coingecko:binancecoin', POL: 'coingecko:polygon-ecosystem-token', AVAX: 'coingecko:avalanche-2',
  SOL: 'coingecko:solana', BTC: 'coingecko:bitcoin', LTC: 'coingecko:litecoin', QUAI: 'coingecko:quai-network',
}
const STABLE = new Set(['USDC', 'USDT'])

export type PriceFn = (asset: Asset, amount: bigint) => Promise<number | undefined>

/** USD value of an amount, or undefined when no price is available. */
export function priceFn(opts: { fetchImpl?: typeof fetch; qiToQuai?: (qi: bigint) => Promise<bigint> } = {}): PriceFn {
  const fetchImpl = opts.fetchImpl ?? fetch
  const llama = async (id: string) => {
    const r = await fetchImpl(`https://coins.llama.fi/prices/current/${id}`)
    return ((await r.json()) as { coins?: Record<string, { price?: number }> }).coins?.[id]?.price
  }
  return async (asset, amount) => {
    const units = Number(formatUnits(amount, asset.decimals))
    if (STABLE.has(asset.symbol)) return units
    if (asset.symbol === 'QI') {
      if (!opts.qiToQuai) return undefined
      const quai = await opts.qiToQuai(amount)
      const p = await llama(LLAMA.QUAI!)
      return p === undefined ? undefined : Number(formatUnits(quai, 18)) * p
    }
    const id = LLAMA[asset.symbol]
    if (!id) return undefined
    const p = await llama(id)
    return p === undefined ? undefined : units * p
  }
}

export interface SendRecord { at: string; asset: string; to: string; amount: string; usd?: number; tx?: string; dryRun?: boolean }

export function recordSend(log: string, r: Omit<SendRecord, 'at'>, now: () => number = Date.now) {
  appendFileSync(log, JSON.stringify({ at: new Date(now()).toISOString(), ...r }) + '\n', { mode: 0o600 })
}
