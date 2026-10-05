// Live quotes only (no funds move). Run with GREMLINS_MAINNET=1 npm test
import { describe, expect, it } from 'vitest'
import { quoteBridge } from '../src/symbiosis.js'
import { createSymbiosisNode } from '../src/symbiosis-node.js'
import { CHAIN } from '../src/constants.js'

const ADDR = '0x003c6127A9A32E1cc722225824d593714c32Eb96'
const sym = createSymbiosisNode({ clientId: 'gremlins-tests' })
const ONE_K = 1000n * 10n ** 18n

describe('symbiosis mainnet quotes', () => {
  it('Quai → Base', async () => {
    const q = await quoteBridge({ symbiosis: sym, direction: { from: 'quai', to: CHAIN.base }, amount: ONE_K, sender: ADDR, receiver: ADDR })
    expect(Number(q.tokenAmountOut.toSignificant(6))).toBeGreaterThan(990)
  })
  for (const chain of [CHAIN.ethereum, CHAIN.base, CHAIN.bsc] as const) {
    it(`chain ${chain} → Quai`, async () => {
      const q = await quoteBridge({ symbiosis: sym, direction: { from: chain, to: 'quai' }, amount: ONE_K, sender: ADDR, receiver: ADDR })
      // Inbound fees are flat and change over time (10 QUAI in Sept 2026, 20 in Oct); this checks the route exists.
      expect(Number(q.tokenAmountOut.toSignificant(6))).toBeGreaterThan(900)
    })
  }
})
