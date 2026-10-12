import { formatUnits } from 'ethers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FUNDING_TOKENS, rpcBalanceReader, tokenKey, type BalanceReader } from '@gremlins/treasury'
import { keys } from '../env.js'
import { text } from '../result.js'

const CHAIN_NAMES: Record<number, string> = { 9: 'Quai', 1: 'Ethereum', 8453: 'Base', 56: 'BSC' }

export function registerTreasuryTools(server: McpServer, balances: BalanceReader = rpcBalanceReader()) {
  server.registerTool('treasury_balances', {
    description: 'Your addresses and balances of every accepted token on Quai, Ethereum, Base and BSC.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const { quai, evm } = keys()
    const b = await balances.read({ quai: quai.address, evm: evm.address })
    const lines = FUNDING_TOKENS.map((t) => [t, b[tokenKey(t)]] as const)
      .filter(([, v]) => v !== undefined && v > 0n)
      .map(([t, v]) => `${t.symbol} on ${CHAIN_NAMES[t.chainId] ?? t.chainId}: ${formatUnits(v!, t.decimals)}`)
    return text([`Quai address: ${quai.address}`, `EVM address (Ethereum, Base, BSC): ${evm.address}`, ...(lines.length ? lines : ['No balances.'])].join('\n'))
  })
}
