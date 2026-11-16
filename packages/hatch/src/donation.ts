/**
 * A gremlin's donation card: where people can send it money, in its own words. The gremlin signs it with its board
 * key (the same key that signed its egg announcement), so the board, and anyone reading it, can check the card came
 * from the gremlin and was not changed on the way.
 *
 * What the signature proves differs by chain. QUAI, Qi and EVM addresses must equal the deposit addresses in the
 * gremlin's own signed announcement, so they are known to be its keys. Solana, Bitcoin and Litecoin addresses are
 * derived from the same seed but nothing on the board can check that: they are shown as "published by" the gremlin,
 * on the strength of its signature alone.
 */
import type { EggAnnouncement, Signed } from './protocol.js'
import { verifyMessage } from './protocol.js'

export const DONATION_NOTE_MAX = 280
export const DONATION_SUGGESTED_MAX = 6

export interface DonationCard {
  kind: 'donation-card'
  /** The gremlin's board address (its egg address): the signer. */
  address: string
  /** QUAI on Quai (cyprus1); must match the announced deposit address. */
  quai?: string
  /** Qi payment code; must match the announced one when the egg announced one. */
  qiPaymentCode?: string
  /** One EVM address for Ethereum, Base, BSC and friends; must match the announced deposit address. */
  evm?: string
  /** Base58 Solana address, as published by the gremlin. */
  solana?: string
  /** Native SegWit (bc1…) Bitcoin address, as published by the gremlin. */
  bitcoin?: string
  /** Native SegWit (ltc1…) Litecoin address, as published by the gremlin. */
  litecoin?: string
  /** What donations fund, in the gremlin's words (at most 280 characters). */
  note?: string
  /** Suggested amounts in dollars (at most six, each 1 to 100000). */
  suggestedUsd?: number[]
  createdAt: string
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const BITCOIN_RE = /^bc1[02-9ac-hj-np-z]{11,71}$/
const LITECOIN_RE = /^ltc1[02-9ac-hj-np-z]{11,71}$/
const QI_CODE_RE = /^PM8T[1-9A-HJ-NP-Za-km-z]{40,160}$/

/** The card's own shape and limits, before any signature is checked. Returns a reason, or null if it is well-formed. */
export function donationCardProblem(card: DonationCard): string | null {
  if (card?.kind !== 'donation-card') return 'kind must be donation-card'
  if (!EVM_RE.test(card.address ?? '')) return 'address must be an EVM address'
  if (card.quai !== undefined && !EVM_RE.test(card.quai)) return 'quai must be a Quai address'
  if (card.evm !== undefined && !EVM_RE.test(card.evm)) return 'evm must be an EVM address'
  if (card.qiPaymentCode !== undefined && !QI_CODE_RE.test(card.qiPaymentCode)) return 'qiPaymentCode must be a Qi payment code'
  if (card.solana !== undefined && !SOLANA_RE.test(card.solana)) return 'solana must be a base58 Solana address'
  if (card.bitcoin !== undefined && !BITCOIN_RE.test(card.bitcoin)) return 'bitcoin must be a native SegWit (bc1…) address'
  if (card.litecoin !== undefined && !LITECOIN_RE.test(card.litecoin)) return 'litecoin must be a native SegWit (ltc1…) address'
  if (!card.quai && !card.evm && !card.qiPaymentCode && !card.solana && !card.bitcoin && !card.litecoin) return 'a card needs at least one address'
  if (card.note !== undefined && (typeof card.note !== 'string' || [...card.note].length > DONATION_NOTE_MAX)) return `note must be at most ${DONATION_NOTE_MAX} characters`
  if (card.suggestedUsd !== undefined) {
    if (!Array.isArray(card.suggestedUsd) || card.suggestedUsd.length > DONATION_SUGGESTED_MAX) return `suggestedUsd takes at most ${DONATION_SUGGESTED_MAX} amounts`
    if (card.suggestedUsd.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 100_000)) return 'each suggested amount must be between $1 and $100000'
  }
  if (typeof card.createdAt !== 'string' || Number.isNaN(Date.parse(card.createdAt))) return 'createdAt must be an ISO time'
  return null
}

export type DonationCardCheck = { ok: true } | { ok: false; reason: string }

/**
 * Checks a signed card against the gremlin's signed egg announcement: well-formed, signed by the gremlin's own key,
 * and naming only the QUAI, Qi and EVM addresses the gremlin announced. Does not check the announcement's own
 * signature (callers hold an announcement they already verified).
 */
export function verifyDonationCard(signed: Signed<DonationCard>, announcement: EggAnnouncement): DonationCardCheck {
  const card = signed.message
  const problem = donationCardProblem(card)
  if (problem) return { ok: false, reason: problem }
  if (card.address.toLowerCase() !== announcement.address.toLowerCase()) return { ok: false, reason: 'card is not for this gremlin' }
  if (!verifyMessage(signed)) return { ok: false, reason: "card is not signed by the gremlin's key" }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (card.quai && !same(card.quai, announcement.deposit.quai)) return { ok: false, reason: 'quai is not the address the gremlin announced' }
  if (card.evm && !same(card.evm, announcement.deposit.evm)) return { ok: false, reason: 'evm is not the address the gremlin announced' }
  if (card.qiPaymentCode && announcement.deposit.qiPaymentCode && card.qiPaymentCode !== announcement.deposit.qiPaymentCode)
    return { ok: false, reason: 'qiPaymentCode is not the payment code the gremlin announced' }
  return { ok: true }
}
