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

  it('skips non-permit tokens (they need gas to approve)', () => {
    const usdt = t(CHAIN.base, 'USDT')
    const { actions, skipped } = planSweep({ chainId: CHAIN.base, native: 10n ** 16n, quaiSynth: 0n, tokens: [{ token: usdt, amount: 5_000_000n }] })
    expect(actions).toEqual([])
    expect(skipped.map((s) => s.symbol)).toEqual(['USDT'])
  })

  it('bridges existing synthetic QUAI without swapping', () => {
    const { actions } = planSweep({ chainId: CHAIN.base, native: 10n ** 16n, quaiSynth: 10n ** 20n, tokens: [] })
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
