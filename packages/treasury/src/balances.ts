/** Read the egg's balances of every allowlisted funding token across Quai, Ethereum, Base and BSC. */
import { Contract, JsonRpcProvider } from 'ethers'
import { CHAIN, RPC } from './constants.js'
import { quaiProvider } from './quai.js'
import { FUNDING_TOKENS, tokenKey, type FundingToken } from './tokens.js'

export type Balances = Record<string, bigint>

export interface BalanceReader {
  read(addresses: { quai: string; evm: string }): Promise<Balances>
}

const ERC20 = ['function balanceOf(address) view returns (uint256)']

export function rpcBalanceReader(opts: { tokens?: FundingToken[]; rpc?: Record<number, string> } = {}): BalanceReader {
  const tokens = opts.tokens ?? FUNDING_TOKENS
  const rpc = { ...RPC, ...opts.rpc }
  const evmProviders = new Map<number, JsonRpcProvider>()
  const evm = (chainId: number) => {
    if (!evmProviders.has(chainId)) evmProviders.set(chainId, new JsonRpcProvider(rpc[chainId], chainId, { staticNetwork: true }))
    return evmProviders.get(chainId)!
  }
  const quai = quaiProvider(rpc[CHAIN.quai])

  return {
    async read(addresses) {
      const entries = await Promise.all(
        tokens.map(async (t): Promise<[string, bigint]> => {
          try {
            if (t.chainId === CHAIN.quai) return [tokenKey(t), await quai.getBalance(addresses.quai)]
            const p = evm(t.chainId)
            if (t.address === 'native') return [tokenKey(t), await p.getBalance(addresses.evm)]
            return [tokenKey(t), (await new Contract(t.address, ERC20, p).balanceOf(addresses.evm)) as bigint]
          } catch {
            // An unreachable RPC must not look like an empty wallet; callers treat missing keys as unknown.
            return [tokenKey(t), -1n]
          }
        }),
      )
      return Object.fromEntries(entries.filter(([, v]) => v >= 0n))
    },
  }
}

export function hasFunds(b: Balances): boolean {
  return Object.values(b).some((v) => v > 0n)
}
