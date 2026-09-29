/**
 * Tokens a gremlin accepts as funding. Anything else that shows up (airdrops, spam tokens) is ignored.
 * `native` means the chain's gas coin.
 */
import { CHAIN, QUAI_SYNTH, type EvmChainId } from './constants.js'

export interface FundingToken {
  chainId: number
  symbol: string
  /** 'native' for the gas coin, otherwise the ERC-20 address. */
  address: 'native' | string
  decimals: number
  /** EIP-2612 permit domain if the token supports gasless approval. */
  permit?: { name: string; version: string }
}

const quaiSynth = (chainId: EvmChainId): FundingToken => ({
  chainId, symbol: 'QUAI', address: QUAI_SYNTH[chainId], decimals: 18, permit: { name: 'Symbiosis', version: '1' },
})

export const FUNDING_TOKENS: FundingToken[] = [
  { chainId: CHAIN.quai, symbol: 'QUAI', address: 'native', decimals: 18 },

  { chainId: CHAIN.ethereum, symbol: 'ETH', address: 'native', decimals: 18 },
  { chainId: CHAIN.ethereum, symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, permit: { name: 'USD Coin', version: '2' } },
  { chainId: CHAIN.ethereum, symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  quaiSynth(CHAIN.ethereum),

  { chainId: CHAIN.base, symbol: 'ETH', address: 'native', decimals: 18 },
  { chainId: CHAIN.base, symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, permit: { name: 'USD Coin', version: '2' } },
  { chainId: CHAIN.base, symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  { chainId: CHAIN.base, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  quaiSynth(CHAIN.base),

  { chainId: CHAIN.bsc, symbol: 'BNB', address: 'native', decimals: 18 },
  { chainId: CHAIN.bsc, symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { chainId: CHAIN.bsc, symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { chainId: CHAIN.bsc, symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
  quaiSynth(CHAIN.bsc),
]

/** Stable key used in pulses and holdings, e.g. "usdc:8453", "quai:9". */
export const tokenKey = (t: Pick<FundingToken, 'symbol' | 'chainId'>) => `${t.symbol.toLowerCase()}:${t.chainId}`
