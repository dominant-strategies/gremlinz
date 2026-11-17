import { describe, expect, it } from 'vitest'
import { parseUnits } from 'ethers'
import { bestSource, familiesFor, holdings } from '../src/balances.js'
import { coinsFor } from '../src/coins.js'

const coins = coinsFor({ name: 'ron', quai: '0x00' + '1'.repeat(38), evm: '0x' + '2'.repeat(40), solana: 'So1ana' })
const prices = new Map([['base-eth', 3000], ['eth-eth', 3000], ['bsc-bnb', 600], ['sol-sol', 150], ['quai', 0.05]])

describe('paying from what the wallet holds', () => {
  it('prefers a stablecoin on a cheap chain, needs the fee coin for tokens, and skips what does not cover the amount', () => {
    const b = new Map<string, bigint | undefined>([
      ['eth-usdc', parseUnits('500', 6)], ['eth-eth', parseUnits('0.01', 18)],
      ['base-usdc', parseUnits('40', 6)], // no ETH on Base for the fee
      ['bsc-usdt', parseUnits('3', 18)], ['bsc-bnb', parseUnits('0.01', 18)], // not enough for $10
      ['base-eth', 0n],
    ])
    const h = holdings(coins.filter((c) => c.family === 'evm'), b, prices, 10)
    expect(h.map((x) => x.coin.id)).toEqual(['base-usdc', 'bsc-usdt', 'eth-usdc', 'bsc-bnb', 'eth-eth'])
    expect(h[0]).toMatchObject({ enough: true, feeOk: false })
    expect(bestSource(h)!.coin.id).toBe('eth-usdc')
    // with gas on Base, Base USDC wins
    b.set('base-eth', parseUnits('0.001', 18))
    expect(bestSource(holdings(coins.filter((c) => c.family === 'evm'), b, prices, 10))!.coin.id).toBe('base-usdc')
  })
  it('uses native coins when there is no stablecoin, valued at live prices', () => {
    const h = holdings(coins.filter((c) => c.family === 'quai'), new Map([['quai', parseUnits('1000', 18)]]), prices, 10)
    expect(bestSource(h)!.coin.id).toBe('quai') // 1000 QUAI ≈ $50
    expect(bestSource(holdings(coins.filter((c) => c.family === 'quai'), new Map([['quai', parseUnits('100', 18)]]), prices, 10))).toBeUndefined() // ≈ $5
  })
  it('knows which wallets can send from the page', () => {
    expect(familiesFor('pelagus')).toEqual(['quai'])
    expect(familiesFor('phantom')).toEqual(['evm', 'solana'])
    expect(familiesFor('smartwallet')).toEqual([])
    expect(familiesFor(undefined)).toEqual([])
  })
})
