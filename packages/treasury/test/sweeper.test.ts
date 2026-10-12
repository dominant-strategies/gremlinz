import { describe, expect, it } from 'vitest'
import { planSweep } from '../src/sweeper.js'
import { FUNDING_TOKENS } from '../src/tokens.js'
import { CHAIN } from '../src/constants.js'

const t = (chainId: number, symbol: string) => FUNDING_TOKENS.find((x) => x.chainId === chainId && x.symbol === symbol)!

describe('sweeper planning', () => {
  it('swaps permit tokens, buys gas if needed, then bridges', () => {
    const usdc = t(CHAIN.base, 'USDC')
    const { actions, skipped } = planSweep(
      { chainId: CHAIN.base, native: 0n, quaiSynth: 0n, tokens: [{ token: usdc, amount: 2_000_000n }] },
      { gasBudgetToken: usdc, gasBudgetAmount: 100_000n },
    )
    expect(actions.map((a) => a.kind)).toEqual(['buy-gas', 'swap-to-quai', 'bridge-to-quai'])
    expect(skipped).toEqual([])
  })

  it('skips non-permit tokens when there is no gas to approve them', () => {
    const usdt = t(CHAIN.base, 'USDT')
    const { actions, skipped } = planSweep({ chainId: CHAIN.base, native: 0n, quaiSynth: 0n, tokens: [{ token: usdt, amount: 5_000_000n }] })
    expect(actions).toEqual([])
    expect(skipped.map((s) => s.symbol)).toEqual(['USDT'])
  })

  it('swaps non-permit tokens (with an approval) when the chain has gas', () => {
    const usdt = t(CHAIN.bsc, 'USDT')
    const { actions } = planSweep({ chainId: CHAIN.bsc, native: 10n ** 15n, quaiSynth: 0n, tokens: [{ token: usdt, amount: 5n * 10n ** 18n }] })
    expect(actions.map((a) => a.kind)).toEqual(['swap-to-quai', 'bridge-to-quai'])
  })

  it('wraps and sells spare gas coin, keeping a reserve for gas', () => {
    const { actions } = planSweep({ chainId: CHAIN.base, native: 10n ** 16n, quaiSynth: 0n, tokens: [] }) // 0.01 ETH
    expect(actions.map((a) => a.kind)).toEqual(['wrap-native', 'swap-to-quai', 'bridge-to-quai'])
    const wrap = actions[0] as { amount: bigint }
    expect(wrap.amount).toBe(10n ** 16n - 4n * 30_000_000_000_000n)
    expect((actions[1] as { token: { symbol: string } }).token.symbol).toBe('WETH')
  })

  it('merges directly received WETH with wrapped spare ETH into one swap', () => {
    const weth = t(CHAIN.base, 'WETH')
    const { actions } = planSweep({ chainId: CHAIN.base, native: 10n ** 16n, quaiSynth: 0n, tokens: [{ token: weth, amount: 10n ** 15n }] })
    expect(actions.filter((a) => a.kind === 'swap-to-quai')).toHaveLength(1)
    expect(actions.map((a) => a.kind)).toEqual(['wrap-native', 'swap-to-quai', 'bridge-to-quai']) // wrap first, then one swap of all WETH
  })

  it('keeps small gas balances as gas', () => {
    const { actions } = planSweep({ chainId: CHAIN.base, native: 10n ** 14n, quaiSynth: 0n, tokens: [] })
    expect(actions).toEqual([])
  })

  it('bridges existing synthetic QUAI without swapping', () => {
    const { actions } = planSweep({ chainId: CHAIN.base, native: 10n ** 14n, quaiSynth: 10n ** 20n, tokens: [] })
    expect(actions.map((a) => a.kind)).toEqual(['bridge-to-quai'])
  })

  it('reports missing gas when no budget token is given', () => {
    const { actions, skipped } = planSweep({ chainId: CHAIN.bsc, native: 0n, quaiSynth: 10n ** 20n, tokens: [] })
    expect(actions.map((a) => a.kind)).toEqual(['bridge-to-quai'])
    expect(skipped.map((s) => s.symbol)).toContain('native-gas')
  })

  it('does nothing when there is nothing to sweep', () => {
    expect(planSweep({ chainId: CHAIN.base, native: 0n, quaiSynth: 0n, tokens: [] }).actions).toEqual([])
  })
})
