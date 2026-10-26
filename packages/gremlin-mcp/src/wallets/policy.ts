/**
 * Spending policy for outgoing sends: every send is valued in USD at live prices and checked against a per-send cap
 * and a rolling 24-hour cap; sends are logged in GREMLIN_HOME/sends.jsonl. Unknown price → refused (never guessed).
 * Caps: GREMLIN_SEND_MAX_USD (per send, default 10) and GREMLIN_SEND_DAILY_USD (24 h, default 25).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { formatUnits } from 'ethers'
import type { Asset } from './chains.js'

const LLAMA: Record<string, string> = {
  ETH: 'coingecko:ethereum', BNB: 'coingecko:binancecoin', POL: 'coingecko:polygon-ecosystem-token', AVAX: 'coingecko:avalanche-2',
  SOL: 'coingecko:solana', BTC: 'coingecko:bitcoin', LTC: 'coingecko:litecoin', QUAI: 'coingecko:quai-network',
}
const STABLE = new Set(['USDC', 'USDT'])

export type PriceFn = (asset: Asset, amount: bigint) => Promise<number | undefined>

/** USD value of an amount; Qi is valued through its live Qi→QUAI rate (qiToQuai) and QUAI's price. */
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

export interface SendRecord { at: string; asset: string; to: string; amount: string; usd: number; tx?: string; dryRun?: boolean }

export class SendPolicy {
  constructor(
    private log: string,
    private caps: { perSendUsd: number; dailyUsd: number },
    private now: () => number = Date.now,
  ) {}

  static fromEnv(log: string, env: NodeJS.ProcessEnv = process.env) {
    return new SendPolicy(log, { perSendUsd: Number(env.GREMLIN_SEND_MAX_USD ?? 10), dailyUsd: Number(env.GREMLIN_SEND_DAILY_USD ?? 25) })
  }

  spentLast24h(): number {
    if (!existsSync(this.log)) return 0
    const since = this.now() - 24 * 3_600_000
    let usd = 0
    for (const line of readFileSync(this.log, 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line) as SendRecord
        if (!r.dryRun && Date.parse(r.at) >= since) usd += r.usd
      } catch { /* empty or torn line */ }
    }
    return usd
  }

  /** A reason to refuse, or undefined. */
  check(usd: number | undefined): string | undefined {
    if (usd === undefined) return 'Refused: no live price for this asset, so the send cannot be checked against your spending limits.'
    if (usd > this.caps.perSendUsd) return `Refused: $${usd.toFixed(2)} is over your per-send limit of $${this.caps.perSendUsd}.`
    const spent = this.spentLast24h()
    if (spent + usd > this.caps.dailyUsd) return `Refused: that would bring the last 24 hours to $${(spent + usd).toFixed(2)}, over your daily limit of $${this.caps.dailyUsd}.`
    return undefined
  }

  record(r: Omit<SendRecord, 'at'>) {
    appendFileSync(this.log, JSON.stringify({ at: new Date(this.now()).toISOString(), ...r }) + '\n', { mode: 0o600 })
  }
}
