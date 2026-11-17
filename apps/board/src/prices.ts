/**
 * What gremlins hold, in US dollars. Pulses report raw balances per token (base units, keyed like "quai:9",
 * "usdc:8453"); this prices them with DefiLlama's current prices (the same source the donate widget uses), cached and
 * refreshed in the background so a page never waits on it. Without a price for something a gremlin holds, its total is
 * unknown (null) rather than a guess.
 */
import { formatUnits } from 'ethers'
import { FUNDING_TOKENS, tokenKey } from '@gremlins/treasury'

export type Coin = 'quai' | 'eth' | 'bnb'
export type UsdPrices = Partial<Record<Coin, number>>

export interface PriceSource {
  /** The latest prices known (possibly none yet). Never blocks; may start a refresh. */
  current(): UsdPrices
}

const LLAMA_ID: Record<Coin, string> = { quai: 'coingecko:quai-network', eth: 'coingecko:ethereum', bnb: 'coingecko:binancecoin' }

export function llamaPrices(opts: { fetchImpl?: typeof fetch; ttlMs?: number; now?: () => number } = {}): PriceSource & { refresh(): Promise<void> } {
  const fetchImpl = opts.fetchImpl ?? fetch
  const ttl = opts.ttlMs ?? 10 * 60_000
  const now = opts.now ?? Date.now
  let prices: UsdPrices = {}
  let at = 0
  let inflight: Promise<void> | null = null
  const refresh = () => (inflight ??= (async () => {
    try {
      const ids = Object.values(LLAMA_ID).join(',')
      const r = await fetchImpl(`https://coins.llama.fi/prices/current/${ids}`, { signal: AbortSignal.timeout(8000) })
      const coins = ((await r.json()) as { coins?: Record<string, { price?: number }> }).coins ?? {}
      const next: UsdPrices = {}
      for (const [k, id] of Object.entries(LLAMA_ID) as [Coin, string][]) {
        const p = coins[id]?.price
        if (typeof p === 'number' && p > 0) next[k] = p
      }
      prices = { ...prices, ...next } // keep the last good price for anything this answer missed
      at = now()
    } catch { /* offline or rate-limited: keep what we had, try again next time */ }
    finally { inflight = null }
  })())
  return {
    current() { if (now() - at > ttl) void refresh(); return prices },
    refresh,
  }
}

/** No prices at all (tests, or a board run offline). */
export const noPrices: PriceSource = { current: () => ({}) }

const DECIMALS = new Map(FUNDING_TOKENS.map((t) => [tokenKey(t), t.decimals]))
const COIN_OF: Record<string, Coin | 'usd'> = { quai: 'quai', usdc: 'usd', usdt: 'usd', eth: 'eth', weth: 'eth', bnb: 'bnb', wbnb: 'bnb' }

/**
 * A gremlin's balances in USD, or null if it holds something with no known price. Tokens it doesn't accept as funding
 * (spam, airdrops) don't count; neither does private Qi, which pulses don't value.
 */
export function holdingsUsd(balances: Record<string, string> | undefined, prices: UsdPrices): number | null {
  let total = 0
  for (const [key, raw] of Object.entries(balances ?? {})) {
    const decimals = DECIMALS.get(key) ?? (key === 'quai' ? 18 : undefined) // older pulses: a bare quai key
    const coin = COIN_OF[key.split(':')[0]!]
    if (decimals === undefined || !coin) continue
    let amount: number
    try { amount = Number(formatUnits(BigInt(raw), decimals)) } catch { continue }
    if (!(amount > 0)) continue
    const price = coin === 'usd' ? 1 : prices[coin]
    if (price === undefined) return null
    total += amount * price
  }
  return total
}

/** "$1,234" for whole dollars, "$12.34" under $100, "—" when unknown. */
export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
  return usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`
}
