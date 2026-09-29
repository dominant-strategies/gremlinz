import { describe, expect, it } from 'vitest'
import { Wallet, getBytes } from 'ethers'
import { HATCH_DOMAIN, HATCH_TYPES, configHash, messageDigest, signConfig, signMessage, verifySignedConfig } from '@gremlins/hatch'
import { announcement, makeBoard, makeConfig, pulse, quaiAddressOf } from './helpers.ts'

async function setup() {
  const b = await makeBoard()
  const egg = Wallet.createRandom()
  const maker = Wallet.createRandom()
  const cfg = makeConfig(maker.address)
  const ann = announcement(egg, maker.address, configHash(cfg), 'L-1')
  return { b, egg, maker, cfg, ann }
}

describe('egg announcements', () => {
  it('accepts a valid announcement, is idempotent, and is findable by launchId and address', async () => {
    const { b, egg, ann } = await setup()
    const signed = await signMessage(egg, ann)
    const r1 = await b.postJson('/api/eggs', signed)
    expect(r1.status).toBe(201)
    expect(r1.body.egg).toMatchObject({ address: egg.address, status: 'announced', launchId: 'L-1', deposit: ann.deposit })

    const r2 = await b.postJson('/api/eggs', signed)
    expect(r2.status).toBe(200)
    expect(r2.body.created).toBe(false)

    const byLaunch = await b.json('/api/eggs?launchId=L-1')
    expect(byLaunch.status).toBe(200)
    expect(byLaunch.body.egg.address).toBe(egg.address)
    expect(byLaunch.body.egg).toMatchObject({ status: 'announced', announcement: ann })
    const byAddr = await b.json(`/api/eggs/${egg.address.toLowerCase()}`)
    expect(byAddr.body.egg.maker).toBe(ann.maker)
    expect((await b.json('/api/eggs?launchId=nope')).status).toBe(404)
  })

  it('rejects bad signatures and malformed announcements', async () => {
    const { b, egg, ann } = await setup()
    const signed = await signMessage(egg, ann)
    const tampered = { ...signed, message: { ...signed.message, deposit: { ...signed.message.deposit, evm: Wallet.createRandom().address } } }
    expect((await b.postJson('/api/eggs', tampered)).status).toBe(401)
    const byOther = { message: ann, signature: await Wallet.createRandom().signMessage(getBytes(messageDigest(ann))) }
    expect((await b.postJson('/api/eggs', byOther)).status).toBe(401)
    expect((await b.postJson('/api/eggs', { message: { ...ann, configHash: 'nope' }, signature: signed.signature })).status).toBe(400)
    expect((await b.req('/api/eggs', { method: 'POST', body: '{not json' })).status).toBe(400)
    expect((await b.json('/api/eggs?launchId=L-1')).status).toBe(404)
  })

  it('rejects a launchId hijack by a different egg', async () => {
    const { b, egg, ann } = await setup()
    expect((await b.postJson('/api/eggs', await signMessage(egg, ann))).status).toBe(201)
    const thief = Wallet.createRandom()
    const r = await b.postJson('/api/eggs', await signMessage(thief, { ...ann, address: thief.address, deposit: { quai: ann.deposit.quai, evm: thief.address } }))
    expect(r.status).toBe(409)
    expect((await b.json('/api/eggs?launchId=L-1')).body.egg.address).toBe(egg.address)
  })

  it('rejects re-announcing the same egg with different launch data', async () => {
    const { b, egg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    expect((await b.postJson('/api/eggs', await signMessage(egg, { ...ann, launchId: 'L-2' }))).status).toBe(409)
  })
})

describe('signed-config handoff', () => {
  it('happy path: maker posts config, egg fetches and verifies it, first config wins', async () => {
    const { b, egg, maker, cfg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    expect((await b.json(`/api/eggs/${egg.address}/config`)).status).toBe(404)

    const r = await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(maker, cfg, quaiAddressOf(egg)))
    expect(r.status).toBe(201)
    expect(r.body.egg).toMatchObject({ status: 'configured', name: 'Grub' })

    // what the egg does: fetch, then verify against its own launch data
    const fetched = await b.json(`/api/eggs/${egg.address}/config`)
    expect(fetched.status).toBe(200)
    expect(verifySignedConfig(fetched.body, { maker: maker.address, configHash: configHash(cfg), gremlin: quaiAddressOf(egg) })).toMatchObject({ ok: true })

    const again = await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(maker, cfg, quaiAddressOf(egg), new Date(Date.now() + 5000)))
    expect(again.status).toBe(409)
  })

  it('rejects a config from a stranger', async () => {
    const { b, egg, maker, cfg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    const stranger = Wallet.createRandom()

    // stranger's own config: wrong maker and wrong hash
    const own = await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(stranger, makeConfig(stranger.address), quaiAddressOf(egg)))
    expect(own.status).toBe(403)

    // stranger signs the maker's exact config and message
    const message = { maker: maker.address, gremlin: quaiAddressOf(egg), configHash: configHash(cfg), issuedAt: 1790000000n }
    const forged = { config: cfg, message, signature: await stranger.signTypedData(HATCH_DOMAIN, HATCH_TYPES, message) }
    const r = await b.postJson(`/api/eggs/${egg.address}/config`, forged)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/not from the maker/)
    expect((await b.json(`/api/eggs/${egg.address}/config`)).status).toBe(404)
    expect((await b.json(`/api/eggs/${egg.address}`)).body.egg.status).toBe('announced')
  })

  it('rejects a config the maker signed for a different gremlin (replayed from another egg)', async () => {
    const { b, egg, maker, cfg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    const r = await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(maker, cfg, '0x00' + '99'.repeat(19)))
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/different gremlin/)
  })

  it('rejects a tampered config', async () => {
    const { b, egg, maker, cfg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    const signed = await signConfig(maker, cfg, quaiAddressOf(egg))
    const tampered = { ...signed, config: { ...signed.config, mischiefScope: { ...signed.config.mischiefScope, money: true } } }
    const r = await b.postJson(`/api/eggs/${egg.address}/config`, tampered)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/hash/)
    // valid one still goes through afterwards
    expect((await b.postJson(`/api/eggs/${egg.address}/config`, signed)).status).toBe(201)
  })

  it('404s config for unknown eggs and 400s garbage', async () => {
    const { b, egg, ann } = await setup()
    expect((await b.postJson(`/api/eggs/${egg.address}/config`, {})).status).toBe(404)
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    expect((await b.postJson(`/api/eggs/${egg.address}/config`, { config: {}, message: {}, signature: '0x' })).status).toBe(400)
  })

  it('moves announced → configured → hatched on the first pulse', async () => {
    const { b, egg, maker, cfg, ann } = await setup()
    await b.postJson('/api/eggs', await signMessage(egg, ann))
    expect((await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 1)))).status).toBe(409) // not configured yet
    await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(maker, cfg, quaiAddressOf(egg)))
    const p = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 1)))
    expect(p.body).toMatchObject({ ok: true, hatched: true })
    const e = (await b.json(`/api/eggs/${egg.address}`)).body.egg
    expect(e.status).toBe('hatched')
    expect(e.hatchedAt).not.toBeNull()
    const p2 = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))
    expect(p2.body.hatched).toBe(false)
    const kinds = (await b.json('/api/feed')).body.events.map((x: any) => x.kind)
    expect(kinds).toEqual(['hatched', 'configured', 'egg'])
  })
})
