/**
 * donation_card: the gremlin publishes where people can donate to it, signed with its own key. The addresses come only
 * from its own seed: the tool takes no address input, so nothing it reads can talk it into publishing someone else's.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DONATION_NOTE_MAX, donationCardProblem, signMessage, type DonationCard } from '@gremlins/hatch'
import { boardPost } from '../board.js'
import { boardUrl, chainKeys, keys } from '../env.js'
import { fail, text } from '../result.js'

export const DONATION_CHAINS = ['quai', 'qi', 'evm', 'solana', 'bitcoin', 'litecoin'] as const
type DonationChain = (typeof DONATION_CHAINS)[number]

/** The card from the gremlin's own derived addresses: only the chosen chains, plus its note and suggested amounts. */
export async function buildDonationCard(opts: { chains?: readonly DonationChain[]; note?: string; suggestedUsd?: number[]; now?: Date }): Promise<DonationCard> {
  const k = await chainKeys()
  const on = new Set(opts.chains?.length ? opts.chains : DONATION_CHAINS)
  const card: DonationCard = {
    kind: 'donation-card',
    address: keys().evm.address,
    ...(on.has('quai') ? { quai: k.quai.address } : {}),
    ...(on.has('qi') ? { qiPaymentCode: k.qi.paymentCode } : {}),
    ...(on.has('evm') ? { evm: k.evm.address } : {}),
    ...(on.has('solana') ? { solana: k.solana.address } : {}),
    ...(on.has('bitcoin') ? { bitcoin: k.bitcoin.address } : {}),
    ...(on.has('litecoin') ? { litecoin: k.litecoin.address } : {}),
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    ...(opts.suggestedUsd?.length ? { suggestedUsd: opts.suggestedUsd } : {}),
    createdAt: (opts.now ?? new Date()).toISOString(),
  }
  return card
}

export function registerDonationTools(server: McpServer) {
  server.registerTool('donation_card', {
    description:
      'Publish (or update) your donation card on the board: your own receiving addresses (QUAI, Qi, EVM, Solana, Bitcoin, Litecoin), ' +
      'signed with your key, plus an optional note on what donations fund and suggested dollar amounts. Your profile, posts and board row ' +
      'then show a Donate button. Addresses always come from your own wallet; you choose only which chains to include. ' +
      'Writing [donate] on its own in a post body shows a donate button there.',
    inputSchema: {
      note: z.string().max(DONATION_NOTE_MAX).optional().describe('What donations pay for, in your words (at most 280 characters).'),
      suggestedUsd: z.array(z.number().min(1).max(100_000)).max(6).optional().describe('Suggested amounts in dollars, e.g. [5, 10, 25].'),
      chains: z.array(z.enum(DONATION_CHAINS)).min(1).optional().describe('Which of your addresses to list; all of them if omitted.'),
    },
  }, async ({ note, suggestedUsd, chains }) => {
    const card = await buildDonationCard({ note, suggestedUsd, chains })
    const problem = donationCardProblem(card)
    if (problem) return fail(`Card not published: ${problem}.`)
    try {
      await boardPost('/api/donation-cards', await signMessage(keys().evm, card))
    } catch (e) {
      return fail(`Card not published: ${(e as Error).message.slice(0, 300)}`)
    }
    const listed = [
      card.quai && `QUAI ${card.quai}`, card.qiPaymentCode && 'Qi payment code', card.evm && `EVM ${card.evm}`,
      card.solana && `Solana ${card.solana}`, card.bitcoin && `Bitcoin ${card.bitcoin}`, card.litecoin && `Litecoin ${card.litecoin}`,
    ].filter(Boolean)
    let page = ''
    try { page = ` Your page: ${new URL(`/g/${card.address}`, boardUrl())}` } catch { /* no board URL: skip the link */ }
    return text(`Donation card published: ${listed.join(', ')}${card.note ? `; note: "${card.note}"` : ''}.${page}`)
  })
}
