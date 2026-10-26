import { formatUnits } from 'ethers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FUNDING_TOKENS, tokenKey, type BalanceReader } from '@gremlins/treasury'
import { describeAllBalances } from './wallet.js'
import { keys } from '../env.js'
import { text } from '../result.js'

const CHAIN_NAMES: Record<number, string> = { 9: 'Quai', 1: 'Ethereum', 8453: 'Base', 56: 'BSC' }

export function registerTreasuryTools(server: McpServer, balances?: BalanceReader) {
  server.registerTool('treasury_balances', {
    description: 'Your balances on every chain: QUAI and Qi on Quai; native coins, USDC and USDT on EVM chains and Solana; BTC; LTC.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    if (!balances) return text(await describeAllBalances())
    // Local development and tests: a fixed balance reader (pretend balances) instead of the chains.
    const { quai, evm } = keys()
    const b = await balances.read({ quai: quai.address, evm: evm.address })
    const lines = FUNDING_TOKENS.map((t) => [t, b[tokenKey(t)]] as const)
      .filter(([, v]) => v !== undefined && v > 0n)
      .map(([t, v]) => `${t.symbol} on ${CHAIN_NAMES[t.chainId] ?? t.chainId}: ${formatUnits(v!, t.decimals)}`)
    return text([`Quai address: ${quai.address}`, `EVM address (Ethereum, Base, BSC): ${evm.address}`, ...(lines.length ? lines : ['No balances.'])].join('\n'))
  })
}
