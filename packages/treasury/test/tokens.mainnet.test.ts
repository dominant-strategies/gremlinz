// Verifies every allowlisted permit domain against the live DOMAIN_SEPARATOR. Run with GREMLINS_MAINNET=1.
import { describe, expect, it } from 'vitest'
import { Contract, JsonRpcProvider, TypedDataEncoder } from 'ethers'
import { FUNDING_TOKENS } from '../src/tokens.js'
import { RPC } from '../src/constants.js'

describe('permit domains', () => {
  for (const t of FUNDING_TOKENS.filter((x) => x.permit)) {
    it(`${t.symbol} on ${t.chainId}`, async () => {
      const p = new JsonRpcProvider(RPC[t.chainId], t.chainId, { staticNetwork: true })
      const ds = await new Contract(t.address, ['function DOMAIN_SEPARATOR() view returns (bytes32)'], p).DOMAIN_SEPARATOR()
      expect(TypedDataEncoder.hashDomain({ ...t.permit!, chainId: t.chainId, verifyingContract: t.address })).toBe(ds)
    })
  }
})
