import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { configHash, signConfig, signMessage, verifyGremlinIdentity, type EggAnnouncement, type GremlinConfig } from '../src/index.js'

const config = (maker: string, name = 'kiln'): GremlinConfig => ({
  version: 1, name, persona: 'a maker of small tools', voice: 'gruff', goals: ['build one tool'], preferredModels: [],
  maker, parent: 'maker', revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: false, email: false, phone: false, money: false },
  constitution: ['honesty'], createdAt: '2026-11-04T00:00:00.000Z',
})

async function hatched(name = 'kiln') {
  const egg = Wallet.createRandom(), maker = Wallet.createRandom()
  const cfg = config(maker.address, name)
  const quai = '0x00' + egg.address.slice(4).toLowerCase()
  const msg: EggAnnouncement = { kind: 'egg', address: egg.address, maker: maker.address, configHash: configHash(cfg), deposit: { quai, evm: egg.address } as never, launchId: 'l1', bootedAt: '2026-11-04T00:00:00.000Z' }
  const announcement = await signMessage(egg, msg)
  const signed = await signConfig(maker, cfg, quai)
  const wire = { ...signed, message: { ...signed.message, issuedAt: signed.message.issuedAt.toString() } }
  return { egg, maker, announcement, config: wire }
}

describe('gremlin identity', () => {
  it('proves a name and maker from the egg and maker signatures alone', async () => {
    const h = await hatched()
    expect(verifyGremlinIdentity(h.egg.address, h)).toMatchObject({ ok: true, name: 'kiln', maker: h.maker.address })
    const unnamed = verifyGremlinIdentity(h.egg.address, { announcement: h.announcement })
    expect(unnamed.ok && unnamed.name).toBeFalsy()
    expect(unnamed.ok).toBe(true)
  })

  it('rejects a renamed config, another gremlin\'s proof, a forged announcement and a missing proof', async () => {
    const h = await hatched(), other = await hatched('moth')
    const renamed = { ...h, config: { ...h.config, config: { ...h.config.config, name: 'impostor' } } }
    expect(verifyGremlinIdentity(h.egg.address, renamed)).toMatchObject({ ok: false, reason: expect.stringMatching(/^config:/) })
    expect(verifyGremlinIdentity(h.egg.address, other)).toMatchObject({ ok: false, reason: 'announcement is for another address' })
    const forged = { ...h, announcement: { ...h.announcement, message: { ...h.announcement.message, maker: Wallet.createRandom().address } } }
    expect(verifyGremlinIdentity(h.egg.address, forged)).toMatchObject({ ok: false, reason: "announcement is not signed by the gremlin's key" })
    expect(verifyGremlinIdentity(h.egg.address, { ...h, config: other.config })).toMatchObject({ ok: false })
    expect(verifyGremlinIdentity(h.egg.address, null)).toMatchObject({ ok: false, reason: 'no identity proof' })
  })
})
