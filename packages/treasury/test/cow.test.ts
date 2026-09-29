import { describe, expect, it } from 'vitest'
import { TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers'
import { buildAppData, orderFromQuote } from '../src/cow.js'
import { CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN } from '../src/constants.js'

describe('cow', () => {
  it('permit domain for synthetic QUAI on Base matches the on-chain DOMAIN_SEPARATOR', () => {
    const ds = TypedDataEncoder.hashDomain({ ...QUAI_SYNTH_PERMIT_DOMAIN, chainId: CHAIN.base, verifyingContract: QUAI_SYNTH[CHAIN.base] })
    // read from 0x5c97…2D2f on 2026-09-29
    expect(ds).toBe('0x627539e446614b05a79503d8d66a3372824a73195ba999724e9ea02355a71e37')
  })

  it('appData hash is keccak of the exact JSON string', () => {
    const app = buildAppData({ appCode: 'gremlins', preHooks: [{ target: '0x01', callData: '0x02', gasLimit: '100000' }] })
    expect(app.appDataHash).toBe(keccak256(toUtf8Bytes(app.appData)))
    expect(JSON.parse(app.appData).metadata.hooks.pre).toHaveLength(1)
  })

  it('folds the fee into sellAmount and applies slippage to buyAmount', () => {
    const o = orderFromQuote({
      quote: { id: 1, sellAmount: 198_450_000n, feeAmount: 550_000n, buyAmount: 2_244_536n, validTo: 123 },
      sellToken: '0xa', buyToken: '0xb', receiver: '0xc', appDataHash: '0xd', slippageBps: 100,
    })
    expect(o.sellAmount).toBe('199000000')
    expect(o.feeAmount).toBe('0')
    expect(o.buyAmount).toBe('2222090')
  })
})
