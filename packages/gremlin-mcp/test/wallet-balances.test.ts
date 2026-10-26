import { describe, expect, it } from 'vitest'
import { solanaBalances, utxoBalances } from '../src/wallets/balances.js'
import { ASSETS, asset } from '../src/wallets/chains.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('asset registry', () => {
  it('covers every family with unique ids', () => {
    expect(new Set(ASSETS.map((a) => a.id)).size).toBe(ASSETS.length)
    expect(new Set(ASSETS.map((a) => a.family))).toEqual(new Set(['quai', 'qi', 'evm', 'solana', 'utxo']))
    expect(asset('USDC:Base')).toMatchObject({ decimals: 6, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
    expect(ASSETS.filter((a) => a.family === 'evm' && !a.token).map((a) => a.chain)).toHaveLength(7)
  })
})

describe('solana balances', () => {
  it('reads SOL and SPL token accounts', async () => {
    const fake = (async (_u: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body))
      if (method === 'getBalance') return json({ result: { value: 2_500_000_000 } })
      const mint = params[1].mint
      const amount = mint.startsWith('EPj') ? '12000000' : '0'
      return json({ result: { value: amount === '0' ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] } })
    }) as typeof fetch
    const r = await solanaBalances('So1ana', {}, fake)
    expect(Object.fromEntries(r.holdings.map((h) => [h.asset.id, h.amount]))).toEqual({ 'sol:solana': 2_500_000_000n, 'usdc:solana': 12_000_000n, 'usdt:solana': 0n })
    expect(r.errors).toEqual([])
  })

  it('reports an RPC error per chain instead of throwing', async () => {
    const r = await solanaBalances('x', {}, (async () => json({ error: { message: 'rate limited' } })) as typeof fetch)
    expect(r.holdings).toEqual([])
    expect(r.errors).toEqual([{ chain: 'solana', error: 'rate limited' }])
  })
})

describe('bitcoin and litecoin balances', () => {
  it('sums confirmed and mempool funds, and keeps going when one chain fails', async () => {
    const fake = (async (url: string) => {
      if (url.includes('litecoin')) return json({}, 503)
      return json({ chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000 }, mempool_stats: { funded_txo_sum: 10_000, spent_txo_sum: 0 } })
    }) as typeof fetch
    const r = await utxoBalances({ bitcoin: 'bc1q', litecoin: 'ltc1q' }, {}, fake)
    expect(r.holdings.map((h) => [h.asset.id, h.amount])).toEqual([['btc:bitcoin', 110_000n]])
    expect(r.errors[0]).toMatchObject({ chain: 'litecoin' })
  })
})
