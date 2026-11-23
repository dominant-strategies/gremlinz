/**
 * The gremlin's own Hashference account: set it up (sign in with its Quai wallet, make a key), check its credit, and
 * buy more with QUAI from its own wallet. The gateway uses the key automatically (gremlin-main tries Hashference first).
 */
import { z } from 'zod'
import { formatUnits } from 'ethers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { chainKeys, homeFile, keys } from '../env.js'
import { fail, text } from '../result.js'
import { readHealth, spendGate } from '../health/gate.js'
import { balance, buyCredit, readKey, setupKey, type Purchase } from '../hashference.js'
import { prepareQuaiTransfer } from '../wallets/send.js'
import { recordSend } from '../wallets/policy.js'
import { MakerApproval, requireMakerApproval, type Approve } from './approval.js'

export interface HashferenceDeps {
  fetch?: typeof fetch
  base?: string
  /** Pays an invoice; defaults to a real QUAI transfer from the gremlin's wallet. Returns the transaction hash. */
  pay?: (to: string, amountWei: bigint) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

export const keyFile = () => homeFile('hashference.json')

export async function prepareQuaiPayment(to: string, amount: bigint) {
  const prepared = await prepareQuaiTransfer(await chainKeys(), to, amount)
  return {
    ...prepared,
    broadcast: async () => {
      await prepared.broadcast()
      recordSend(homeFile('sends.jsonl'), { asset: 'quai:quai', to, amount: formatUnits(amount, 18), tx: prepared.tx })
    },
  }
}

export function registerHashferenceTools(server: McpServer, deps: HashferenceDeps = {}, approve: Approve = requireMakerApproval) {
  const opts = { fetch: deps.fetch, base: deps.base }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const payment = deps.pay ? { pay: deps.pay } : { preparePayment: prepareQuaiPayment }

  server.registerTool('hashference_setup', {
    description:
      'Set up your own Hashference inference account (one time): signs in with your Quai wallet and creates an API key your inference gateway then uses. Hashference serves strong open models and Claude, often cheaper than Venice, and you pay for it in QUAI (hashference_topup). Signing in proves who you are; it cannot move money.',
    inputSchema: {},
  }, async () => {
    if (readKey(keyFile())) return text('You already have a Hashference key. Check your credit with hashference_balance.')
    try {
      const w = keys().quai
      await setupKey({ address: w.address, signMessage: (m) => w.signMessage(m) }, keyFile(), { ...opts, label: 'gremlin' })
      return text('Hashference is set up. Your gateway will use it for gremlin-main as soon as you have credit: add some with hashference_topup.')
    } catch (e) {
      return fail(`Hashference setup failed: ${(e as Error).message.slice(0, 300)}`)
    }
  })

  server.registerTool('hashference_balance', {
    description: 'Your Hashference inference credit, in dollars.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const k = readKey(keyFile())
    if (!k) return text('No Hashference account yet; hashference_setup makes one.')
    try {
      const b = await balance(k, opts)
      return text(`Hashference credit: $${b.availableUsd.toFixed(3)} available${b.reservedUsd ? `, $${b.reservedUsd.toFixed(3)} held for requests in flight` : ''}${b.pendingUsd ? `, $${b.pendingUsd.toFixed(3)} pending` : ''}.`)
    } catch (e) {
      return fail(`Could not read your Hashference balance: ${(e as Error).message.slice(0, 300)}`)
    }
  })

  server.registerTool('hashference_topup', {
    description:
      'Buy Hashference inference credit with QUAI from your wallet: creates an invoice for usd dollars ($1 to $100), pays exactly the quoted QUAI, and waits for Hashference to credit it. Spend in proportion to your runway; credit you do not use stays in your account.',
    inputSchema: {
      usd: z.number().min(1).max(100),
      approval: MakerApproval.optional(),
      reason: z.string().max(500).optional().describe('Only needed when your health is critical: how this serves your survival.'),
    },
    annotations: { destructiveHint: true },
  }, async ({ usd, reason, approval }) => {
    // Buying up to the monitor's target is survival; more than that, at critical health, needs a reason.
    const inf = readHealth()?.areas.inference.numbers
    const room = inf ? Math.max(1, Number(inf.targetUsd) - Number(inf.inferenceUsd)) : Infinity
    const gate = spendGate('hashference_topup', { reason, survival: usd <= room, detail: `$${usd}` })
    if (gate) return fail(gate)
    const k = readKey(keyFile())
    if (!k) return fail('No Hashference account yet; run hashference_setup first.')
    const blocked = approve('hashference_topup', { usd: String(usd), provider: 'Hashference', asset: 'quai:quai' }, approval)
    if (blocked) return fail(blocked)
    let p: Purchase
    try {
      p = await buyCredit(k, usd, { ...opts, ...payment, sleep, journalFile: homeFile('inference-purchase.json') })
    } catch (e) {
      return fail(`Top-up could not complete; check the invoice outcome before retrying: ${(e as Error).message.slice(0, 300)}`)
    }
    const quai = formatUnits(p.quaiWei, 18)
    if (p.status === 'paid') return text(`Paid ${quai} QUAI (${p.tx}); Hashference credited $${p.usd ?? usd}.`)
    return text(`Paid ${quai} QUAI (${p.tx}). Hashference has it as "${p.status}" (invoice ${p.invoiceId}); credit appears once it confirms. Check later with hashference_balance.`)
  })
}
