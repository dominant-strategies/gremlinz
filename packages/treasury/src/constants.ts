/** Chains a gremlin can be funded on. */
export const CHAIN = {
  quai: 9,
  ethereum: 1,
  bsc: 56,
  base: 8453,
} as const

export type EvmChainId = typeof CHAIN.ethereum | typeof CHAIN.bsc | typeof CHAIN.base

export const RPC: Record<number, string> = {
  [CHAIN.quai]: 'https://rpc.quai.network',
  [CHAIN.ethereum]: 'https://ethereum-rpc.publicnode.com',
  [CHAIN.bsc]: 'https://bsc-rpc.publicnode.com',
  [CHAIN.base]: 'https://mainnet.base.org',
}

/** Wrapped QUAI on Quai (cyprus1); the origin token for Symbiosis bridging. */
export const WQUAI = '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB'

/**
 * Symbiosis synthetic QUAI on each EVM chain. All three support EIP-2612 permit with the
 * domain `{ name: 'Symbiosis', version: '1' }` — not the token's `name()` ("Quai Network").
 */
export const QUAI_SYNTH: Record<EvmChainId, string> = {
  [CHAIN.ethereum]: '0x70b7f7044D2ca8E2F1E999B90EF16d7Cb7A0cDA1',
  [CHAIN.bsc]: '0x9287f86434412518b99e5Ab908e4AdDD9BaC6651',
  [CHAIN.base]: '0x5c97D726bf5130AE15408cE32bc764e458320D2f',
}

export const QUAI_SYNTH_PERMIT_DOMAIN = { name: 'Symbiosis', version: '1' } as const

export const USDC: Partial<Record<EvmChainId, string>> = {
  [CHAIN.ethereum]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  [CHAIN.base]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}

/** CoW Protocol — same addresses on every supported chain. */
export const COW = {
  settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  vaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
  api: {
    [CHAIN.ethereum]: 'https://api.cow.fi/mainnet/api/v1',
    [CHAIN.bsc]: 'https://api.cow.fi/bnb/api/v1',
    [CHAIN.base]: 'https://api.cow.fi/base/api/v1',
  } as Record<EvmChainId, string>,
} as const
