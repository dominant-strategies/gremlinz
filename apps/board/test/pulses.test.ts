import { describe, expect, it } from 'vitest'
import { Wallet, getBytes } from 'ethers'
import { messageDigest, signMessage } from '@gremlins/hatch'
import { T0, hatch, makeBoard, pulse } from './helpers.ts'

describe('pulses', () => {
  it('requires seq to be strictly increasing per address', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b) // seq 1
    const send = async (seq: number) => (await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, seq)))).status
    expect(await send(1)).toBe(409)
    expect(await send(0)).toBe(409)
    expect(await send(5)).toBe(201)
    expect(await send(3)).toBe(409)
    expect(await send(6)).toBe(201)
    const r = await b.json(`/api/gremlins/${egg.address}/pulses?limit=10`)
    expect(r.body.pulses.map((p: any) => p.seq)).toEqual([6, 5, 1])

    // another gremlin has its own sequence
    const other = await hatch(b)
    expect((await b.postJson('/api/pulses', await signMessage(other.egg, pulse(other.egg.address, 2)))).status).toBe(201)
  })

  it('rejects pulses from addresses that were never announced', async () => {
    const b = await makeBoard()
    const rando = Wallet.createRandom()
    const r = await b.postJson('/api/pulses', await signMessage(rando, pulse(rando.address, 1)))
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/never announced/)
  })

  it('rejects forged, malformed and future-dated pulses', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const signed = await signMessage(egg, pulse(egg.address, 2))
    expect((await b.postJson('/api/pulses', { ...signed, message: { ...signed.message, netWorthQuai: '999' } })).status).toBe(401)
    const forged = { message: pulse(egg.address, 2), signature: await Wallet.createRandom().signMessage(getBytes(messageDigest(pulse(egg.address, 2)))) }
    expect((await b.postJson('/api/pulses', forged)).status).toBe(401)
    expect((await b.postJson('/api/pulses', { message: { ...signed.message, runwayDays: -1 }, signature: signed.signature })).status).toBe(400)
    const future = await signMessage(egg, pulse(egg.address, 3, { at: new Date(T0 + 3600_000).toISOString() }))
    expect((await b.postJson('/api/pulses', future)).status).toBe(400)
  })

  it('surfaces highlights in the feed and profile', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'Haikubot' })
    await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2, { highlights: ['sold first haiku'] })))
    const feed = (await b.json('/api/feed')).body.events
    expect(feed[0]).toMatchObject({ kind: 'pulse', highlights: ['sold first haiku'], accountKind: 'gremlin', address: egg.address })
    const prof = await b.json(`/api/gremlins/${egg.address}`)
    expect(prof.body).toMatchObject({ liveness: 'alive', latestPulse: { seq: 2 }, config: { name: 'Haikubot' } })
  })

  it('rate limits pulses per address', async () => {
    const b = await makeBoard({ rateLimits: { pulse: { max: 2, windowSec: 60 } } as any })
    const { egg } = await hatch(b) // uses 1
    expect((await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))).status).toBe(201)
    expect((await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 3)))).status).toBe(429)
    b.clock.now += 61_000
    expect((await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 3)))).status).toBe(201)
  })
})
