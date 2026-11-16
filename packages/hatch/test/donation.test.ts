import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { signMessage, type EggAnnouncement } from '../src/protocol.js'
import { donationCardProblem, verifyDonationCard, type DonationCard } from '../src/donation.js'

const egg = Wallet.createRandom()
const QI = 'PM8TJVyYbUnzYZAFkY48ZUwNRmgoJuEjXVBbAM6xJKz6jWvTnGpB6fe4uaYnXMcoiHHfXN9jwH5n2eQBYTZtZiV844NaHS5aBLJHAHsN1Qc2xxP9CfLb'
const ann: EggAnnouncement = {
  kind: 'egg', address: egg.address, maker: Wallet.createRandom().address,
  configHash: '0x' + '11'.repeat(32), deposit: { quai: '0x00' + '22'.repeat(19), evm: egg.address, qiPaymentCode: QI },
  launchId: 'L1', bootedAt: '2026-09-29T00:00:00.000Z',
}
const card = (over: Partial<DonationCard> = {}): DonationCard => ({
  kind: 'donation-card', address: egg.address, quai: ann.deposit.quai, evm: egg.address, qiPaymentCode: QI,
  solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  litecoin: 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', note: 'Pays for my GPU hours.', suggestedUsd: [3, 7, 20],
  createdAt: '2026-11-16T00:00:00.000Z', ...over,
})

describe('donation cards', () => {
  it("accepts a card signed by the gremlin's own key", async () => {
    expect(verifyDonationCard(await signMessage(egg, card()), ann)).toEqual({ ok: true })
  })

  it('refuses a card signed by anyone else, including a human claiming the address', async () => {
    const human = Wallet.createRandom()
    const forged = await signMessage(human, card({ address: human.address }))
    expect(verifyDonationCard({ message: card(), signature: forged.signature }, ann)).toMatchObject({ ok: false, reason: /not signed/ })
    expect(verifyDonationCard(forged, ann)).toMatchObject({ ok: false, reason: /not for this gremlin/ })
  })

  it('refuses tampering with any field the signature covers', async () => {
    const s = await signMessage(egg, card())
    for (const over of [{ solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }, { note: 'send to my friend instead' }, { suggestedUsd: [1000] }])
      expect(verifyDonationCard({ ...s, message: { ...s.message, ...over } }, ann).ok).toBe(false)
  })

  it('refuses QUAI, EVM or Qi addresses other than the announced ones, even when signed', async () => {
    const other = Wallet.createRandom().address
    expect(verifyDonationCard(await signMessage(egg, card({ evm: other })), ann)).toMatchObject({ ok: false, reason: /evm/ })
    expect(verifyDonationCard(await signMessage(egg, card({ quai: '0x00' + '33'.repeat(19) })), ann)).toMatchObject({ ok: false, reason: /quai/ })
    expect(verifyDonationCard(await signMessage(egg, card({ qiPaymentCode: QI.slice(0, -1) + 'c' })), ann)).toMatchObject({ ok: false, reason: /qiPaymentCode/ })
  })

  it('checks shapes and limits', () => {
    expect(donationCardProblem(card())).toBeNull()
    expect(donationCardProblem(card({ note: 'x'.repeat(281) }))).toMatch(/note/)
    expect(donationCardProblem(card({ suggestedUsd: [1, 2, 3, 4, 5, 6, 7] }))).toMatch(/suggestedUsd/)
    expect(donationCardProblem(card({ suggestedUsd: [0.5] }))).toMatch(/between/)
    expect(donationCardProblem(card({ bitcoin: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }))).toMatch(/bitcoin/)
    expect(donationCardProblem(card({ solana: '0xnot-solana' }))).toMatch(/solana/)
    expect(donationCardProblem(card({ litecoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }))).toMatch(/litecoin/)
    expect(donationCardProblem({ kind: 'donation-card', address: egg.address, createdAt: '2026-11-16T00:00:00Z' })).toMatch(/at least one/)
  })
})
