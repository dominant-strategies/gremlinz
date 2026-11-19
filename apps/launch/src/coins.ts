/** The coins and chains a gremlin can be fed with (no browser code here, so tests can load it). */
export interface DonateTarget {
  /** The gremlin's address (its gifts are recorded under it). */
  gremlin?: string
  name: string
  quai?: string
  evm?: string
  qi?: string
  solana?: string
  bitcoin?: string
  litecoin?: string
  note?: string
  suggestedUsd?: number[]
  /** 'card': the gremlin's signed donation card; 'announced': its announced deposit addresses. */
  source?: 'card' | 'announced'
}

export type Family = 'quai' | 'evm' | 'solana' | 'copy'
export type AddressKey = 'quai' | 'evm' | 'qi' | 'solana' | 'bitcoin' | 'litecoin'
export interface Coin {
  id: string
  label: string
  family: Family
  /** Which of the target's addresses it goes to. */
  to: AddressKey
  symbol: string
  decimals: number
  chainId?: number
  token?: string
  priceId?: string
  /** For copy-address coins: the payment URI scheme for the QR code. */
  scheme?: string
}

export const COINS: Coin[] = [
  { id: 'quai', label: 'QUAI', family: 'quai', to: 'quai', chainId: 9, symbol: 'QUAI', decimals: 18, priceId: 'coingecko:quai-network' },
  { id: 'base-usdc', label: 'USDC on Base', family: 'evm', to: 'evm', chainId: 8453, symbol: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { id: 'base-eth', label: 'ETH on Base', family: 'evm', to: 'evm', chainId: 8453, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'eth-usdc', label: 'USDC on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'USDC', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { id: 'eth-usdt', label: 'USDT on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'USDT', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { id: 'eth-eth', label: 'ETH on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'bsc-usdt', label: 'USDT on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'USDT', token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { id: 'bsc-usdc', label: 'USDC on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'USDC', token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { id: 'bsc-bnb', label: 'BNB on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'BNB', decimals: 18, priceId: 'coingecko:binancecoin' },
  { id: 'sol-usdc', label: 'USDC on Solana', family: 'solana', to: 'solana', symbol: 'USDC', token: 'usdc', decimals: 6 },
  { id: 'sol-sol', label: 'SOL', family: 'solana', to: 'solana', symbol: 'SOL', decimals: 9, priceId: 'coingecko:solana' },
  { id: 'sol-usdt', label: 'USDT on Solana', family: 'solana', to: 'solana', symbol: 'USDT', token: 'usdt', decimals: 6 },
  { id: 'btc', label: 'Bitcoin', family: 'copy', to: 'bitcoin', symbol: 'BTC', decimals: 8, priceId: 'coingecko:bitcoin', scheme: 'bitcoin' },
  { id: 'ltc', label: 'Litecoin', family: 'copy', to: 'litecoin', symbol: 'LTC', decimals: 8, priceId: 'coingecko:litecoin', scheme: 'litecoin' },
  { id: 'qi', label: 'Qi', family: 'copy', to: 'qi', symbol: 'Qi', decimals: 3 },
]
/** The coins a target can take: only those it has an address for. */
export const coinsFor = (t: DonateTarget) => COINS.filter((c) => !!t[c.to])
