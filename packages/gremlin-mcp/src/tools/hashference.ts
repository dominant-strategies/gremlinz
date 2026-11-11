/**
 * The gremlin's own Hashference account: set it up (sign in with its Quai wallet, make a key), check its credit, and
 * buy more with QUAI from its own wallet. The gateway uses the key automatically (gremlin-main tries Hashference first).
 */
import { z } from 'zod'
import { formatUnits } from 'ethers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { chainKeys, homeFile, keys, phrase } from '../env.js'
import { fail, text } from '../result.js'
import { balance, createQuaiInvoice, invoice, readKey, setupKey, verifyPayment, type Invoice } from '../hashference.js'
import { send } from '../wallets/send.js'
import { ASSETS } from '../wallets/chains.js'
import { recordSend } from '../wallets/policy.js'

export interface HashferenceDeps {
  fetch?: typeof fetch
  base?: string
  /** Pays an invoice; defaults to a real QUAI transfer from the gremlin's wallet. Returns the transaction hash. */
  pay?: (to: string, amountWei: bigint) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

const keyFile = () => homeFile('hashference.json')

export function registerHashferenceTools(server: McpServer, deps: HashferenceDeps = {}) {
  const opts = { fetch: deps.fetch, base: deps.base }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const pay = deps.pay ?? (async (to: string, amount: bigint) => {
    const quai = ASSETS.find((a) => a.id === 'quai:quai')!
    const r = await send({ keys: await chainKeys(), phrase: phrase(), asset: quai, to, amount })
    recordSend(homeFile('sends.jsonl'), { asset: quai.id, to, amount: formatUnits(amount, quai.decimals), tx: r.tx })
    return r.tx
  })

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
    inputSchema: { usd: z.number().min(1).max(100) },
    annotations: { destructiveHint: true },
  }, async ({ usd }) => {
    const k = readKey(keyFile())
    if (!k) return fail('No Hashference account yet; run hashference_setup first.')
    let inv: Invoice
    try { inv = await createQuaiInvoice(k, usd, opts) } catch (e) { return fail(`Could not create the invoice: ${(e as Error).message.slice(0, 300)}`) }
    const amount = BigInt(inv.amountAtomic)
    // Pay only an invoice that is still open: a late payment is not credited automatically.
    if (Date.parse(inv.expiresAt) - Date.now() < 30_000) return fail('The invoice expires too soon to pay safely; try again.')
    let tx: string
    try { tx = await pay(inv.addresses[0]!, amount) } catch (e) { return fail(`Paying the invoice failed (nothing was credited): ${(e as Error).message.slice(0, 300)}`) }
    // Credited after confirmations; poll for a few minutes, then point Hashference at the transaction if needed.
    let status = inv.status
    for (let i = 0; i < 18 && status !== 'paid'; i++) {
      await sleep(10_000)
      try { status = (await invoice(k, inv.id, opts)).status } catch { /* keep polling */ }
    }
    if (status === 'awaiting_payment') { try { status = (await verifyPayment(k, inv.id, tx, opts)).status } catch { /* reported below */ } }
    const quai = formatUnits(amount, 18)
    if (status === 'paid') return text(`Paid ${quai} QUAI (${tx}); Hashference credited $${usd}.`)
    return text(`Paid ${quai} QUAI (${tx}). Hashference has it as "${status}" (invoice ${inv.id}); credit appears once it confirms. Check later with hashference_balance.`)
  })
}
