import { describe, expect, it } from 'vitest'
import { withQuaiSynths } from '../src/symbiosis.js'
import { loadMainnetCache } from '../src/symbiosis-node.js'
import { CHAIN, QUAI_SYNTH } from '../src/constants.js'

describe('symbiosis cache', () => {
  it('adds synthetic QUAI on BSC, which the npm cache lacks', () => {
    const cache = withQuaiSynths(loadMainnetCache())
    for (const chainId of [CHAIN.ethereum, CHAIN.base, CHAIN.bsc] as const) {
      const t = cache.tokens.find((x) => x.chainId === chainId && x.address.toLowerCase() === QUAI_SYNTH[chainId].toLowerCase())
      expect(t, `chain ${chainId}`).toBeTruthy()
      expect(t!.chainFromId).toBe(CHAIN.quai)
    }
  })

  it('is idempotent', () => {
    const once = withQuaiSynths(loadMainnetCache())
    expect(withQuaiSynths(once).tokens.length).toBe(once.tokens.length)
  })
})
