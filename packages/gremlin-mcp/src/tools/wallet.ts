import { z } from 'zod'
import { formatUnits, parseUnits } from 'ethers'
import { JsonRpcProvider as QuaiProvider, Zone } from 'quais'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { chainKeys, homeFile, phrase } from '../env.js'
import { ASSETS, QUAI, asset as findAsset, rpcFor } from '../wallets/chains.js'
import { allBalances } from '../wallets/balances.js'
import { destinationProblem, send } from '../wallets/send.js'
import { SendPolicy, priceFn } from '../wallets/policy.js'
import { fail, text } from '../result.js'

const CHAIN_LABEL: Record<string, string> = { quai: 'Quai', ethereum: 'Ethereum', base: 'Base', bsc: 'BSC', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', avalanche: 'Avalanche', solana: 'Solana', bitcoin: 'Bitcoin', litecoin: 'Litecoin' }

export function registerWalletTools(server: McpServer) {
  server.registerTool('wallet_addresses', {
    description: 'Your receiving addresses on every chain: Quai, Qi (payment code), EVM chains (one address for Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Avalanche), Solana, Bitcoin, Litecoin.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const k = await chainKeys()
    return text([
      `QUAI (Quai, cyprus1): ${k.quai.address}`,
      `Qi (private payments; give people this payment code): ${k.qi.paymentCode}`,
      `EVM (Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Avalanche): ${k.evm.address}`,
      `Solana: ${k.solana.address}`,
      `Bitcoin: ${k.bitcoin.address}`,
      `Litecoin: ${k.litecoin.address}`,
    ].join('\n'))
  })

  server.registerTool('wallet_send', {
    description: `Send crypto. asset is one of: ${ASSETS.map((a) => a.id).join(', ')}. amount is in normal units (e.g. "12.5"). Each send is valued in USD and checked against your per-send and daily limits; use dryRun first for anything unusual. Qi goes to a payment code (PM8T…), not an address.`,
    inputSchema: {
      asset: z.string(),
      to: z.string().min(10).max(200),
      amount: z.string().regex(/^\d+(\.\d+)?$/, 'a decimal number such as 12.5'),
      dryRun: z.boolean().optional(),
    },
    annotations: { destructiveHint: true },
  }, async ({ asset: id, to, amount, dryRun }) => {
    const a = findAsset(id)
    if (!a) return fail(`Unknown asset "${id}". Use one of: ${ASSETS.map((x) => x.id).join(', ')}.`)
    const bad = destinationProblem(a, to)
    if (bad) return fail(`Bad destination for ${a.id}: ${bad}.`)
    let units: bigint
    try { units = parseUnits(amount, a.decimals) } catch { return fail(`${amount} has too many decimal places for ${a.symbol} (max ${a.decimals}).`) }
    const quai = new QuaiProvider(rpcFor('quai', QUAI.rpc), undefined, { usePathing: true })
    const usd = await priceFn({ qiToQuai: (qi) => quai.getLatestQiToQuaiRate(Zone.Cyprus1, qi) })(a, units).catch(() => undefined)
    const policy = SendPolicy.fromEnv(homeFile('sends.jsonl'))
    const refused = policy.check(usd)
    if (refused) return fail(refused)
    try {
      const r = await send({ keys: await chainKeys(), phrase: phrase(), asset: a, to, amount: units, dryRun })
      policy.record({ asset: a.id, to, amount, usd: usd!, tx: r.tx, ...(r.dryRun ? { dryRun: true } : {}) })
      return text(r.dryRun ? `${r.tx} (~$${usd!.toFixed(2)}). Nothing was sent.` : `Sent ${amount} ${a.symbol} on ${CHAIN_LABEL[a.chain] ?? a.chain} (~$${usd!.toFixed(2)}): ${r.explorer || r.tx}`)
    } catch (e) {
      return fail(`Send failed: ${(e as Error).message.slice(0, 300)}`)
    }
  })
}

/** Every chain's balances as readable lines (used by treasury_balances). */
export async function describeAllBalances(): Promise<string> {
  const k = await chainKeys()
  const r = await allBalances(k, phrase())
  const lines = r.holdings.filter((h) => h.amount > 0n).map((h) => `${h.asset.symbol} on ${CHAIN_LABEL[h.asset.chain] ?? h.asset.chain}: ${formatUnits(h.amount, h.asset.decimals)}`)
  return [
    ...(lines.length ? lines : ['No balances on any chain.']),
    ...(r.errors.length ? [`(could not read: ${r.errors.map((e) => `${e.chain}: ${e.error}`).join('; ')})`] : []),
    'Use wallet_addresses for where to receive.',
  ].join('\n')
}
