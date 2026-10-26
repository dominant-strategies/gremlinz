/**
 * The chains and assets a gremlin can hold, and where to read them. Public endpoints by default; every one can be
 * overridden with an env var (GREMLIN_RPC_<CHAIN>, e.g. GREMLIN_RPC_SOLANA, GREMLIN_ESPLORA_BITCOIN).
 */
export type Family = 'evm' | 'quai' | 'qi' | 'solana' | 'utxo'

export interface Asset {
  /** Stable id used by tools, e.g. "usdc:base", "sol:solana", "btc:bitcoin". */
  id: string
  symbol: string
  chain: string
  family: Family
  decimals: number
  /** Token contract (EVM) or mint (Solana); absent for the chain's native coin. */
  token?: string
}

export interface EvmChain { name: string; chainId: number; rpc: string; native: string; explorer: string }

export const EVM_CHAINS: EvmChain[] = [
  { name: 'ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', native: 'ETH', explorer: 'https://etherscan.io/tx/' },
  { name: 'base', chainId: 8453, rpc: 'https://mainnet.base.org', native: 'ETH', explorer: 'https://basescan.org/tx/' },
  { name: 'bsc', chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', native: 'BNB', explorer: 'https://bscscan.com/tx/' },
  { name: 'arbitrum', chainId: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com', native: 'ETH', explorer: 'https://arbiscan.io/tx/' },
  { name: 'optimism', chainId: 10, rpc: 'https://optimism-rpc.publicnode.com', native: 'ETH', explorer: 'https://optimistic.etherscan.io/tx/' },
  { name: 'polygon', chainId: 137, rpc: 'https://polygon-bor-rpc.publicnode.com', native: 'POL', explorer: 'https://polygonscan.com/tx/' },
  { name: 'avalanche', chainId: 43114, rpc: 'https://avalanche-c-chain-rpc.publicnode.com', native: 'AVAX', explorer: 'https://snowtrace.io/tx/' },
]

const STABLES: Record<string, { usdc?: [string, number]; usdt?: [string, number] }> = {
  ethereum: { usdc: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6], usdt: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 6] },
  base: { usdc: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6], usdt: ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6] },
  bsc: { usdc: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18], usdt: ['0x55d398326f99059fF775485246999027B3197955', 18] },
  arbitrum: { usdc: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6], usdt: ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6] },
  optimism: { usdc: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6], usdt: ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6] },
  polygon: { usdc: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6], usdt: ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6] },
  avalanche: { usdc: ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6], usdt: ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6] },
}

export const SOLANA = {
  rpc: 'https://api.mainnet-beta.solana.com',
  explorer: 'https://solscan.io/tx/',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

export const UTXO_CHAINS = {
  bitcoin: { symbol: 'BTC', esplora: 'https://mempool.space/api', explorer: 'https://mempool.space/tx/' },
  litecoin: { symbol: 'LTC', esplora: 'https://litecoinspace.org/api', explorer: 'https://litecoinspace.org/tx/' },
} as const

export const QUAI = { rpc: 'https://rpc.quai.network', explorer: 'https://quaiscan.io/tx/' }

export const ASSETS: Asset[] = [
  { id: 'quai:quai', symbol: 'QUAI', chain: 'quai', family: 'quai', decimals: 18 },
  { id: 'qi:quai', symbol: 'QI', chain: 'quai', family: 'qi', decimals: 3 },
  ...EVM_CHAINS.flatMap((c): Asset[] => [
    { id: `${c.native.toLowerCase()}:${c.name}`, symbol: c.native, chain: c.name, family: 'evm', decimals: 18 },
    ...(['usdc', 'usdt'] as const).flatMap((s): Asset[] => {
      const t = STABLES[c.name]?.[s]
      return t ? [{ id: `${s}:${c.name}`, symbol: s.toUpperCase(), chain: c.name, family: 'evm', decimals: t[1], token: t[0] }] : []
    }),
  ]),
  { id: 'sol:solana', symbol: 'SOL', chain: 'solana', family: 'solana', decimals: 9 },
  { id: 'usdc:solana', symbol: 'USDC', chain: 'solana', family: 'solana', decimals: 6, token: SOLANA.usdc },
  { id: 'usdt:solana', symbol: 'USDT', chain: 'solana', family: 'solana', decimals: 6, token: SOLANA.usdt },
  { id: 'btc:bitcoin', symbol: 'BTC', chain: 'bitcoin', family: 'utxo', decimals: 8 },
  { id: 'ltc:litecoin', symbol: 'LTC', chain: 'litecoin', family: 'utxo', decimals: 8 },
]

export const asset = (id: string) => ASSETS.find((a) => a.id === id.toLowerCase())
export const evmChain = (name: string) => EVM_CHAINS.find((c) => c.name === name)

const envKey = (chain: string) => chain.toUpperCase().replace(/[^A-Z0-9]/g, '_')
export const rpcFor = (chain: string, fallback: string, env: NodeJS.ProcessEnv = process.env) => env[`GREMLIN_RPC_${envKey(chain)}`] ?? fallback
export const esploraFor = (chain: keyof typeof UTXO_CHAINS, env: NodeJS.ProcessEnv = process.env) => env[`GREMLIN_ESPLORA_${envKey(chain)}`] ?? UTXO_CHAINS[chain].esplora
