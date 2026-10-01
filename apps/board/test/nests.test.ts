import { describe, expect, it } from 'vitest'
import { Wallet, getBytes, hexlify, randomBytes, toUtf8Bytes, type HDNodeWallet } from 'ethers'
import {
  attachCiphertext, detachCiphertext, messageDigest, nestProof, open, seal, signMessage, verifyMessage, type Handoff, type HandoffWire, type NestAnnouncement,
} from '@gremlins/hatch'
import { T0, hatch, makeBoard, pulse, type Board } from './helpers.ts'

type W = Wallet | HDNodeWallet

function nestAnnouncement(nest: W, forGremlin: string, launchId = 'nest-' + Math.random().toString(36).slice(2), over: Partial<NestAnnouncement> = {}): NestAnnouncement {
  const secret = hexlify(randomBytes(32))
  return {
    kind: 'nest',
    address: nest.address,
    transportKey: nest.signingKey.publicKey,
    forGremlin,
    launchId,
    proof: nestProof(secret, nest.signingKey.publicKey, forGremlin),
    bootedAt: new Date(T0).toISOString(),
    ...over,
  }
}

async function announceNest(b: Board, gremlin: string, launchId?: string) {
  const nest = Wallet.createRandom()
  const ann = nestAnnouncement(nest, gremlin, launchId)
  const r = await b.postJson('/api/nests', await signMessage(nest, ann))
  if (r.status !== 201) throw new Error(`nest announce failed: ${JSON.stringify(r.body)}`)
  return { nest, ann }
}

/** What the gremlin posts: seal to the nest's transport key, sign the box with ctHash, ship ct alongside. */
async function handoffFor(gremlin: W, nest: { address: string; signingKey: { publicKey: string } }, payload: Uint8Array = toUtf8Bytes('seed + state')): Promise<HandoffWire> {
  const { sealed, ct } = detachCiphertext(await seal(nest.signingKey.publicKey, payload))
  const message: Handoff = { kind: 'handoff', address: gremlin.address, nest: nest.address, sealed, createdAt: new Date(T0).toISOString() }
  return { ...(await signMessage(gremlin, message)), ct }
}

/** What the nest does with a fetched handoff: check the hash, then open. */
const openWire = (nest: W, h: HandoffWire) => open(nest.signingKey, attachCiphertext(h.message.sealed, h.ct))

/** A hatched gremlin (seq 1 pulsed) plus an announced nest for it. */
async function setup() {
  const b = await makeBoard()
  const { egg } = await hatch(b)
  const { nest, ann } = await announceNest(b, egg.address, 'L-nest')
  return { b, egg, nest, ann }
}

describe('nest announcements', () => {
  it('accepts a valid announcement, is idempotent, and is findable by launchId and address', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const nest = Wallet.createRandom()
    const ann = nestAnnouncement(nest, egg.address.toLowerCase(), 'L-1')
    expect((await b.json('/api/nests?launchId=L-1')).status).toBe(404)

    const signed = await signMessage(nest, ann)
    const r1 = await b.postJson('/api/nests', signed)
    expect(r1.status).toBe(201)
    expect(r1.body.nest).toMatchObject({
      address: nest.address,
      forGremlin: egg.address,
      launchId: 'L-1',
      status: 'announced',
      proof: ann.proof,
      transportKey: nest.signingKey.publicKey,
      announcement: ann,
      signature: signed.signature,
      handedOffAt: null,
    })

    const r2 = await b.postJson('/api/nests', signed)
    expect(r2.status).toBe(200)
    expect(r2.body.created).toBe(false)

    const byLaunch = await b.json('/api/nests?launchId=L-1')
    expect(byLaunch.status).toBe(200)
    expect(byLaunch.body.nest.address).toBe(nest.address)
    // what the gremlin does before sealing: check the signature and the proof against its own secret
    expect(verifyMessage({ message: byLaunch.body.nest.announcement, signature: byLaunch.body.nest.signature })).toBe(true)
    expect((await b.json(`/api/nests/${nest.address.toLowerCase()}`)).body.nest.launchId).toBe('L-1')
    expect((await b.json(`/api/nests/${Wallet.createRandom().address}`)).status).toBe(404)
    expect((await b.json('/api/nests')).status).toBe(400)

    const feed = (await b.json('/api/feed')).body.events
    expect(feed[0]).toMatchObject({ kind: 'nest', address: egg.address, nest: nest.address, launchId: 'L-1', accountKind: 'gremlin' })
  })

  it('rejects a nest whose signing address is not derived from its transport key', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const nest = Wallet.createRandom()
    const other = Wallet.createRandom()
    // signed by `nest` but advertising someone else's key: the gremlin would seal to a key the nest can't prove it holds
    const r = await b.postJson('/api/nests', await signMessage(nest, nestAnnouncement(nest, egg.address, 'L-x', { transportKey: other.signingKey.publicKey })))
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/computeAddress/)

    const ann = nestAnnouncement(nest, egg.address, 'L-x')
    const signed = await signMessage(nest, ann)
    // bad signature: tampered, or by a different key
    expect((await b.postJson('/api/nests', { ...signed, message: { ...ann, launchId: 'L-y' } })).status).toBe(401)
    expect((await b.postJson('/api/nests', { message: ann, signature: await other.signMessage(getBytes(messageDigest(ann))) })).status).toBe(401)
    // compressed / malformed transport keys
    const compressed = nestAnnouncement(nest, egg.address, 'L-x', { transportKey: nest.signingKey.compressedPublicKey })
    expect((await b.postJson('/api/nests', await signMessage(nest, compressed))).status).toBe(400)
    const offCurve = nestAnnouncement(nest, egg.address, 'L-x', { transportKey: '0x04' + 'ff'.repeat(64) })
    expect((await b.postJson('/api/nests', await signMessage(nest, offCurve))).status).toBe(400)
    expect((await b.json('/api/nests?launchId=L-x')).status).toBe(404)
  })

  it('rejects a nest for an unknown or unhatched gremlin', async () => {
    const b = await makeBoard()
    const nest = Wallet.createRandom()
    const unknown = await b.postJson('/api/nests', await signMessage(nest, nestAnnouncement(nest, Wallet.createRandom().address)))
    expect(unknown.status).toBe(403)
    expect(unknown.body.error).toMatch(/not a known gremlin/)

    const { egg } = await hatch(b, { pulse: false }) // configured, never pulsed
    const notHatched = await b.postJson('/api/nests', await signMessage(nest, nestAnnouncement(nest, egg.address)))
    expect(notHatched.status).toBe(409)
    expect(notHatched.body.error).toMatch(/not hatched/)
  })

  it('rejects a launchId claimed by another nest, and a nest re-announced with different data', async () => {
    const { b, egg, nest, ann } = await setup()
    const thief = Wallet.createRandom()
    const r = await b.postJson('/api/nests', await signMessage(thief, nestAnnouncement(thief, egg.address, 'L-nest')))
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/launchId/)
    expect((await b.json('/api/nests?launchId=L-nest')).body.nest.address).toBe(nest.address)

    const changed = await b.postJson('/api/nests', await signMessage(nest, { ...ann, bootedAt: new Date(T0 + 1000).toISOString() }))
    expect(changed.status).toBe(409)
  })
})

describe('handoff', () => {
  it('accepts the gremlin’s sealed handoff; the nest fetches, verifies and opens it; first handoff wins', async () => {
    const { b, egg, nest } = await setup()
    const url = `/api/nests/${nest.address}/handoff`
    expect((await b.json(url)).status).toBe(404)

    const payload = toUtf8Bytes(JSON.stringify({ seed: 'hunter2 hunter2', seq: 1 }))
    const h = await handoffFor(egg, nest, payload)
    const r = await b.postJson(url, h)
    expect(r.status).toBe(201)
    expect(r.body.nest).toMatchObject({ status: 'handed_off', address: nest.address })
    expect(r.body.nest.handedOffAt).not.toBeNull()

    // what the nest does: poll, verify it comes from the gremlin it's waiting for, open with its transport key
    const got = await b.json(url)
    expect(got.status).toBe(200)
    expect(got.body.handoff).toEqual(h)
    expect(verifyMessage(got.body.handoff)).toBe(true)
    expect(got.body.handoff.message.address).toBe(egg.address)
    expect(await openWire(nest, got.body.handoff)).toEqual(payload)

    // byte-identical re-post is idempotent; any other handoff loses
    expect((await b.postJson(url, h)).status).toBe(200)
    expect((await b.postJson(url, await handoffFor(egg, nest, toUtf8Bytes('other')))).status).toBe(409)
    expect((await b.json(url)).body.handoff).toEqual(h)

    const feed = (await b.json('/api/feed')).body.events
    expect(feed[0]).toMatchObject({ kind: 'handoff', address: egg.address, nest: nest.address })
  })

  it('rejects a handoff from a stranger or a different gremlin', async () => {
    const { b, egg, nest } = await setup()
    const url = `/api/nests/${nest.address}/handoff`
    const stranger = Wallet.createRandom()
    const own = await b.postJson(url, await handoffFor(stranger, nest))
    expect(own.status).toBe(403)
    expect(own.body.error).toMatch(/only the gremlin/)

    const other = await hatch(b)
    expect((await b.postJson(url, await handoffFor(other.egg, nest))).status).toBe(403)

    // stranger claiming to be the gremlin
    const real = await handoffFor(egg, nest)
    const forged = { ...real, signature: await stranger.signMessage(getBytes(messageDigest(real.message))) }
    expect((await b.postJson(url, forged)).status).toBe(401)
    // tampered signed fields
    const tampered = { ...real, message: { ...real.message, sealed: { ...real.message.sealed, iv: '0x' + '00'.repeat(12) } } }
    expect((await b.postJson(url, tampered)).status).toBe(401)

    expect((await b.json(url)).status).toBe(404)
    expect((await b.postJson(url, real)).status).toBe(201)
  })

  it('rejects ciphertext tampered after signing (ctHash mismatch)', async () => {
    const { b, egg, nest } = await setup()
    const url = `/api/nests/${nest.address}/handoff`
    const h = await handoffFor(egg, nest)
    const flipped = h.ct.slice(0, -2) + (h.ct.endsWith('00') ? '01' : '00')
    const r = await b.postJson(url, { ...h, ct: flipped })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/ctHash/)
    // swapping in a different, validly sealed box doesn't work either
    const other = await handoffFor(egg, nest)
    expect((await b.postJson(url, { ...h, ct: other.ct })).status).toBe(400)
    expect((await b.json(`/api/nests/${nest.address}`)).body.nest.status).toBe('announced')
    expect((await b.postJson(url, h)).status).toBe(201)
  })

  it('rejects a handoff addressed to a different nest, malformed boxes, and unknown nests', async () => {
    const { b, egg, nest } = await setup()
    const { nest: nest2 } = await announceNest(b, egg.address)
    const forNest2 = await handoffFor(egg, nest2)
    const r = await b.postJson(`/api/nests/${nest.address}/handoff`, forNest2)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/different nest/)
    expect((await b.json(`/api/nests/${nest.address}`)).body.nest.status).toBe('announced')

    const h = await handoffFor(egg, nest)
    const bad = async (sealed: Record<string, unknown>) => ({ ...(await signMessage(egg, { ...h.message, sealed: { ...h.message.sealed, ...sealed } } as Handoff)), ct: h.ct })
    const url = `/api/nests/${nest.address}/handoff`
    expect((await b.postJson(url, await bad({ v: 2 }))).status).toBe(400)
    expect((await b.postJson(url, await bad({ iv: '0x1234' }))).status).toBe(400)
    expect((await b.postJson(url, await bad({ epk: '0x02' + '11'.repeat(32) }))).status).toBe(400)
    expect((await b.postJson(url, await bad({ ctHash: '0x1234' }))).status).toBe(400)
    expect((await b.postJson(url, { ...h, ct: 'nothex' })).status).toBe(400)
    expect((await b.postJson(url, { ...h, ct: h.ct.toUpperCase().replace('0X', '0x') })).status).toBe(400)
    const { ct: _ct, ...noCt } = h
    expect((await b.postJson(url, noCt)).status).toBe(400)

    expect((await b.postJson(`/api/nests/${Wallet.createRandom().address}/handoff`, h)).status).toBe(404)
  })

  it('accepts a large handoff on its own route while other routes keep the small limit', async () => {
    const { b, egg, nest } = await setup()
    const big = randomBytes(5 * 1024 * 1024)
    const h = await handoffFor(egg, nest, big)
    const r = await b.postJson(`/api/nests/${nest.address}/handoff`, h)
    expect(r.status).toBe(201)
    const got = await b.json(`/api/nests/${nest.address}/handoff`)
    expect(got.body.handoff.ct).toBe(h.ct)
    expect(Buffer.from(await openWire(nest, got.body.handoff)).equals(Buffer.from(big))).toBe(true)

    const twoMiB = JSON.stringify({ message: { kind: 'egg', pad: 'x'.repeat(2 * 1024 * 1024) }, signature: '0x' })
    for (const path of ['/api/eggs', '/api/pulses', '/api/nests', `/api/eggs/${egg.address}/config`]) {
      const res = await b.req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: twoMiB })
      expect(res.status, path).toBe(413)
    }
  })

  it('enforces the handoff body limit too', async () => {
    const b = await makeBoard({ handoffMaxBodyBytes: 1024 * 1024 })
    const { egg } = await hatch(b)
    const { nest } = await announceNest(b, egg.address)
    const r = await b.postJson(`/api/nests/${nest.address}/handoff`, await handoffFor(egg, nest, randomBytes(1024 * 1024)))
    expect(r.status).toBe(413)
  })
})

describe('moving in', () => {
  it('the first pulse after the handoff marks the nest occupied, emits `moved`, and deletes the ciphertext', async () => {
    const { b, egg, nest } = await setup()
    const url = `/api/nests/${nest.address}/handoff`

    // a pulse while the nest is merely announced changes nothing
    const p2 = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))
    expect(p2.body).toMatchObject({ ok: true, movedTo: null })
    expect((await b.json(`/api/nests/${nest.address}`)).body.nest.status).toBe('announced')

    const h = await handoffFor(egg, nest)
    expect((await b.postJson(url, h)).status).toBe(201)
    expect((await b.json(url)).status).toBe(200)

    // the nest restored the gremlin's key and state: same address, seq continues, no re-announcement
    b.clock.now += 60_000
    expect((await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))).status).toBe(409)
    const p3 = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 3, { host: 'nest-1' })))
    expect(p3.status).toBe(201)
    expect(p3.body).toMatchObject({ ok: true, seq: 3, hatched: false, movedTo: nest.address })

    const n = (await b.json(`/api/nests/${nest.address}`)).body.nest
    expect(n.status).toBe('occupied')
    expect(n.occupiedAt).toBe(new Date(b.clock.now).toISOString())
    const feed = (await b.json('/api/feed')).body.events
    expect(feed[0]).toMatchObject({ kind: 'moved', address: egg.address, nest: nest.address })

    const gone = await b.json(url)
    expect(gone.status).toBe(410)
    expect((await b.store.getHandoff(nest.address.toLowerCase()))!.ct).toBeNull()
    // re-posting the consumed handoff doesn't resurrect it
    expect((await b.postJson(url, h)).status).toBe(410)
    expect((await b.postJson(url, await handoffFor(egg, nest))).status).toBe(409)

    // later pulses don't emit `moved` again; the gremlin is still the same hatched gremlin
    const p4 = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 4, { host: 'nest-1' })))
    expect(p4.body.movedTo).toBeNull()
    const prof = (await b.json(`/api/gremlins/${egg.address}`)).body
    expect(prof).toMatchObject({ egg: { status: 'hatched', address: egg.address }, liveness: 'alive', latestPulse: { seq: 4, host: 'nest-1' } })
    expect((await b.json('/api/feed')).body.events.filter((e: any) => e.kind === 'moved')).toHaveLength(1)
  })

  it('with several handed-off nests, the latest is occupied and the others are abandoned', async () => {
    const { b, egg, nest } = await setup()
    const { nest: nest2 } = await announceNest(b, egg.address)
    expect((await b.postJson(`/api/nests/${nest.address}/handoff`, await handoffFor(egg, nest))).status).toBe(201)
    b.clock.now += 1000
    expect((await b.postJson(`/api/nests/${nest2.address}/handoff`, await handoffFor(egg, nest2))).status).toBe(201)
    const p = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))
    expect(p.body.movedTo).toBe(nest2.address)
    expect((await b.json(`/api/nests/${nest2.address}`)).body.nest.status).toBe('occupied')
    expect((await b.json(`/api/nests/${nest.address}`)).body.nest.status).toBe('abandoned')
    expect((await b.json(`/api/nests/${nest.address}/handoff`)).status).toBe(410)
    expect((await b.json(`/api/nests/${nest2.address}/handoff`)).status).toBe(410)
  })

  it('a gremlin can move again later', async () => {
    const { b, egg, nest } = await setup()
    await b.postJson(`/api/nests/${nest.address}/handoff`, await handoffFor(egg, nest))
    await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 2)))
    const { nest: next } = await announceNest(b, egg.address)
    expect((await b.postJson(`/api/nests/${next.address}/handoff`, await handoffFor(egg, next))).status).toBe(201)
    const p = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 3)))
    expect(p.body.movedTo).toBe(next.address)
    expect((await b.json(`/api/nests/${nest.address}`)).body.nest.status).toBe('occupied')
  })
})
