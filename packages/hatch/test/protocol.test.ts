import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { signMessage, verifyMessage, type EggAnnouncement } from '../src/protocol.js'

const egg = Wallet.createRandom()
const announcement = (): EggAnnouncement => ({
  kind: 'egg', address: egg.address, maker: Wallet.createRandom().address,
  configHash: '0x' + '11'.repeat(32), deposit: { quai: '0x00' + '22'.repeat(19), evm: egg.address },
  launchId: 'L1', bootedAt: '2026-09-29T00:00:00.000Z',
})

describe('board protocol', () => {
  it('round-trips a signed announcement', async () => {
    expect(verifyMessage(await signMessage(egg, announcement()))).toBe(true)
  })
  it('rejects tampering', async () => {
    const s = await signMessage(egg, announcement())
    expect(verifyMessage({ ...s, message: { ...s.message, deposit: { ...s.message.deposit, evm: Wallet.createRandom().address } } })).toBe(false)
  })
  it('refuses to sign for another address', async () => {
    await expect(signMessage(Wallet.createRandom(), announcement())).rejects.toThrow()
  })
})
