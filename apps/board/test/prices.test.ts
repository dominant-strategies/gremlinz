import { describe, expect, it } from 'vitest'
import { formatUsd, holdingsUsd, llamaPrices } from '../src/prices.ts'
import { hatch, makeBoard } from './helpers.ts'

const E18 = '000000000000000000'

describe('holdings in US dollars', () => {
  it('prices what a gremlin holds; stablecoins are dollars; spam and Qi are left out', () => {
    const balances = { 'quai:9': `4${E18}`, 'usdc:8453': '2500000', 'eth:8453': `1${E18}`.slice(0, -1), qi: '1500', 'pepe:8453': `9${E18}` }
    expect(holdingsUsd(balances, { quai: 0.05, eth: 3000 })).toBeCloseTo(4 * 0.05 + 2.5 + 0.1 * 3000)
    expect(holdingsUsd({ quai: `2${E18}` }, { quai: 0.5 })).toBe(1) // a bare "quai" key
    expect(holdingsUsd({ 'usdt:56': `3${E18}` }, {})).toBe(3) // BSC USDT has 18 decimals
  })

  it('is unknown, not a guess, when something it holds has no price', () => {
    expect(holdingsUsd({ 'quai:9': `4${E18}`, 'usdc:8453': '1000000' }, {})).toBeNull()
    expect(holdingsUsd({ 'quai:9': '0', 'usdc:8453': '1000000' }, {})).toBe(1) // nothing held, nothing to price
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(1234.5)).toBe('$1,235')
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  it('caches DefiLlama prices and keeps the last good ones when a refresh fails', async () => {
    let calls = 0, t = 0, fail = false
    const fetchImpl = (async () => {
      calls++
      if (fail) throw new Error('offline')
      return new Response(JSON.stringify({ coins: { 'coingecko:quai-network': { price: 0.07 }, 'coingecko:ethereum': { price: 3100 } } }))
    }) as unknown as typeof fetch
    const p = llamaPrices({ fetchImpl, ttlMs: 1000, now: () => t })
    await p.refresh()
    expect(p.current()).toEqual({ quai: 0.07, eth: 3100 })
    expect(calls).toBe(1)
    fail = true; t = 5000
    p.current(); await p.refresh()
    expect(p.current()).toMatchObject({ quai: 0.07 })
  })

  it('the board reports totals and ranks the richest in dollars', async () => {
    const b = await makeBoard({}, { prices: { current: () => ({ quai: 0.1 }) } })
    await hatch(b, { name: 'Quai-rich', pulse: { balances: { 'quai:9': `100${E18}` }, netWorthQuai: `100${E18}` } }) // $10
    await hatch(b, { name: 'Dollar-rich', pulse: { balances: { 'usdc:8453': '50000000' }, netWorthQuai: '0' } }) // $50
    const r = await b.json('/api/leaderboard')
    expect(r.body.entries.map((e: any) => [e.name, e.netWorthUsd])).toEqual([['Dollar-rich', 50], ['Quai-rich', 10]])
    const page = await (await b.req('/')).text()
    expect(page).toContain('$60.00')
    expect(page).toContain('Held by the living')
    expect(page).not.toContain('QUAI held')
  })
})
