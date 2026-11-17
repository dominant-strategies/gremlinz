/**
 * What the signed-in wallet holds, read in the browser from public nodes (nothing goes to our server), and which of
 * it to pay with: stablecoins first (the amount means the same to both sides), cheapest chain first (Base, BSC,
 * Solana, then Ethereum, whose fees can be dollars), native coins only when there's no stablecoin to use. A token is
 * only usable when the wallet also holds that chain's coin for the fee.
 */
import { Interface, formatUnits, parseUnits } from 'ethers'
import type { Coin } from './coins.js'
import type { WalletKind } from './auth.js'

const EVM_RPC: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  56: 'https://bsc-rpc.publicnode.com',
  1: 'https://ethereum-rpc.publicnode.com',
}
const SOLANA_RPC = (import.meta.env?.VITE_SOLANA_RPC as string | undefined) || 'https://solana-rpc.publicnode.com'
const SOL_MINT: Record<string, string> = { usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)'])

/** The order coins are preferred in. */
export const PREFERENCE = ['base-usdc', 'bsc-usdt', 'bsc-usdc', 'sol-usdc', 'sol-usdt', 'eth-usdc', 'eth-usdt', 'quai', 'base-eth', 'bsc-bnb', 'sol-sol', 'eth-eth']
const NATIVE_OF: Record<string, string> = { 8453: 'base-eth', 56: 'bsc-bnb', 1: 'eth-eth', solana: 'sol-sol' }

/** Which coin families a wallet can send from this page. */
export function familiesFor(kind: WalletKind | undefined): Coin['family'][] {
  if (kind === 'pelagus') return ['quai']
  if (kind === 'phantom') return ['evm', 'solana']
  if (kind === 'metamask' || kind === 'walletconnect') return ['evm']
  return [] // the Quai smart wallet, or no wallet: send from elsewhere
}

const withTimeout = <T>(p: Promise<T>, ms = 6000) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms))])
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await withTimeout(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))
  const j = (await r.json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function balanceOf(c: Coin, owner: { evm?: string; solana?: string; quai?: string }): Promise<bigint | undefined> {
  try {
    if (c.family === 'evm' && owner.evm) {
      const url = EVM_RPC[c.chainId!]!
      if (!c.token) return BigInt((await rpc(url, 'eth_getBalance', [owner.evm, 'latest'])) as string)
      return BigInt((await rpc(url, 'eth_call', [{ to: c.token, data: ERC20.encodeFunctionData('balanceOf', [owner.evm]) }, 'latest'])) as string)
    }
    if (c.family === 'solana' && owner.solana) {
      if (!c.token) return BigInt(((await rpc(SOLANA_RPC, 'getBalance', [owner.solana])) as { value: number }).value)
      const r = (await rpc(SOLANA_RPC, 'getTokenAccountsByOwner', [owner.solana, { mint: SOL_MINT[c.token] }, { encoding: 'jsonParsed' }])) as { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }
      return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n)
    }
    if (c.family === 'quai' && owner.quai) {
      const w = (await import('./wallets.js')).pelagus()
      if (!w) return undefined
      return BigInt((await withTimeout(w.request({ method: 'quai_getBalance', params: [owner.quai, 'latest'] }))) as string)
    }
  } catch { /* unknown: the node didn't answer */ }
  return undefined
}

/** Balances of the coins this wallet could send (undefined: couldn't read). */
export async function readBalances(coins: Coin[], owner: { evm?: string; solana?: string; quai?: string }): Promise<Map<string, bigint | undefined>> {
  const out = new Map<string, bigint | undefined>()
  await Promise.all(coins.map(async (c) => out.set(c.id, await balanceOf(c, owner))))
  return out
}

/** Live USD prices for the coins that need one (stablecoins are $1). */
export async function pricesFor(coins: Coin[]): Promise<Map<string, number>> {
  const ids = [...new Set(coins.map((c) => c.priceId).filter((x): x is string => !!x))]
  const out = new Map<string, number>()
  if (!ids.length) return out
  try {
    const r = await withTimeout(fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`))
    const j = (await r.json()) as { coins?: Record<string, { price?: number }> }
    for (const c of coins) { const p = c.priceId && j.coins?.[c.priceId]?.price; if (p && p > 0) out.set(c.id, p) }
  } catch { /* no prices: natives can't be valued */ }
  return out
}

export interface Holding { coin: Coin; balance: bigint; usd: number | null; enough: boolean; feeOk: boolean }

/** What the wallet holds (anything above zero), valued, and whether it covers `usd` (with the fee coin for tokens). */
export function holdings(coins: Coin[], balances: Map<string, bigint | undefined>, prices: Map<string, number>, usd: number): Holding[] {
  const out: Holding[] = []
  for (const c of coins) {
    const balance = balances.get(c.id)
    if (balance === undefined || balance === 0n) continue
    const price = c.priceId ? prices.get(c.id) : 1
    const value = price === undefined ? null : Number(formatUnits(balance, c.decimals)) * price
    const nativeId = c.token ? NATIVE_OF[c.family === 'solana' ? 'solana' : String(c.chainId)] : undefined
    const feeOk = !nativeId || (balances.get(nativeId) ?? 0n) > 0n
    const enough = c.priceId ? value !== null && value >= usd * 1.01 : balance >= parseUnits(usd.toFixed(Math.min(c.decimals, 6)), c.decimals)
    out.push({ coin: c, balance, usd: value, enough, feeOk })
  }
  return out.sort((a, b) => PREFERENCE.indexOf(a.coin.id) - PREFERENCE.indexOf(b.coin.id))
}

/** The coin to pay with by default: the first preferred one that covers the amount and its fee. */
export const bestSource = (h: Holding[]) => h.find((x) => x.enough && x.feeOk)

