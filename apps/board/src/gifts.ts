/**
 * Gifts to gremlins, as people see them on their profiles: crypto sent from the Feed it box (checked on-chain here, so
 * the giver is whoever really sent it) and hashrate pointed at a gremlin (a pledge: the pool, not the board, sees the
 * work). API keys lent are grants (store.ts GrantRecord). Each gift is public or private: private ones show only to
 * the giver. The transaction itself is on a public chain either way.
 */
import { getAddress, id as keccakId } from 'ethers'

/** The chains a recorded gift can be on: Quai, and the EVM chains the Feed it box sends on. */
export type GiftChain = 'quai' | '1' | '8453' | '56'
export const GIFT_CHAINS: GiftChain[] = ['quai', '1', '8453', '56']

/** Where donated hashrate goes (the gremlin chooses; see Pulse.mining). */
export type HashRoute = 'randomx' | 'kawpow' | 'sha256' | 'scrypt'
export const HASH_ROUTES: HashRoute[] = ['randomx', 'kawpow', 'sha256', 'scrypt']

export interface CoinInfo { symbol: string; decimals: number; stable: boolean; price?: 'quai' | 'eth' | 'bnb' }

const NATIVE: Record<GiftChain, CoinInfo> = {
  quai: { symbol: 'QUAI', decimals: 18, stable: false, price: 'quai' },
  1: { symbol: 'ETH', decimals: 18, stable: false, price: 'eth' },
  8453: { symbol: 'ETH', decimals: 18, stable: false, price: 'eth' },
  56: { symbol: 'BNB', decimals: 18, stable: false, price: 'bnb' },
}
/** Stablecoins the Feed it box sends (apps/launch/src/coins.ts), by chain and lowercased contract. */
const TOKENS: Partial<Record<GiftChain, Record<string, CoinInfo>>> = {
  8453: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, stable: true } },
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, stable: true },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, stable: true },
  },
  56: {
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, stable: true },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, stable: true },
  },
}

export const EXPLORER_TX: Record<GiftChain, string> = { quai: 'https://quaiscan.io/tx/', 1: 'https://etherscan.io/tx/', 8453: 'https://basescan.org/tx/', 56: 'https://bscscan.com/tx/' }
export const CHAIN_NAME: Record<GiftChain, string> = { quai: 'Quai', 1: 'Ethereum', 8453: 'Base', 56: 'BSC' }

const TRANSFER = keccakId('Transfer(address,address,uint256)')

/** What a confirmed gift was: who sent what to which of the gremlin's addresses. */
export interface GiftFacts { from: string; coin: CoinInfo; amount: bigint }
export type GiftCheck = { state: 'confirmed'; facts: GiftFacts } | { state: 'pending' } | { state: 'failed'; why: string }

type Rpc = (chain: GiftChain, method: string, params: unknown[]) => Promise<unknown>

export function jsonRpc(urls: Record<GiftChain, string>, fetchImpl: typeof fetch = fetch): Rpc {
  let n = 0
  return async (chain, method, params) => {
    const r = await fetchImpl(urls[chain], {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }), signal: AbortSignal.timeout(8000),
    })
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
    if (j.error) throw new Error(j.error.message ?? 'rpc error')
    return j.result
  }
}

export const DEFAULT_GIFT_RPC: Record<GiftChain, string> = {
  quai: 'https://rpc.quai.network/cyprus1',
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  56: 'https://bsc-rpc.publicnode.com',
}

interface RpcTx { from: string; to: string | null; value: string; input?: string; data?: string }
interface RpcReceipt { status: string; logs: { address: string; topics: string[]; data: string }[] }

/**
 * Checks a transaction sent to one of `recipients` (the gremlin's own addresses): native coin or a known stablecoin.
 * Pending while the chain hasn't mined it; failed if it reverted or paid someone else.
 */
export async function checkGift(rpc: Rpc, chain: GiftChain, txHash: string, recipients: string[]): Promise<GiftCheck> {
  const pre = chain === 'quai' ? 'quai' : 'eth'
  const mine = new Set(recipients.map((a) => a.toLowerCase()))
  const tx = (await rpc(chain, `${pre}_getTransactionByHash`, [txHash])) as RpcTx | null
  if (!tx) return { state: 'pending' }
  const receipt = (await rpc(chain, `${pre}_getTransactionReceipt`, [txHash])) as RpcReceipt | null
  if (!receipt) return { state: 'pending' }
  if (BigInt(receipt.status) !== 1n) return { state: 'failed', why: 'the transaction failed on-chain' }
  const from = getAddress(tx.from).toLowerCase()
  const value = BigInt(tx.value ?? '0x0')
  if (tx.to && mine.has(tx.to.toLowerCase()) && value > 0n) return { state: 'confirmed', facts: { from, coin: NATIVE[chain], amount: value } }
  const known = TOKENS[chain] ?? {}
  for (const l of receipt.logs ?? []) {
    const coin = known[l.address.toLowerCase()]
    if (!coin || l.topics[0] !== TRANSFER || l.topics.length < 3) continue
    const to = '0x' + l.topics[2]!.slice(-40)
    if (!mine.has(to.toLowerCase())) continue
    return { state: 'confirmed', facts: { from, coin, amount: BigInt(l.data) } }
  }
  return { state: 'failed', why: "it didn't send a supported coin to this gremlin" }
}

/** Dollar value at today's price (stablecoins at $1); null without a price. */
export function giftUsd(coin: CoinInfo, amount: bigint, prices: Partial<Record<'quai' | 'eth' | 'bnb', number>>): number | null {
  const units = Number(amount) / 10 ** coin.decimals
  if (coin.stable) return units
  const p = coin.price ? prices[coin.price] : undefined
  return p ? units * p : null
}

/** "12.5 USDC", "0.0031 ETH": up to 4 significant decimals. */
export function showAmount(amount: string, decimals: number, symbol: string): string {
  const v = Number(amount) / 10 ** decimals
  const s = v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(3).replace(/\.?0+$/, '')
  return `${s} ${symbol}`
}
