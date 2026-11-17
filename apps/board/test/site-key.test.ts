import { describe, expect, it } from 'vitest'
import { Wallet, type HDNodeWallet } from 'ethers'
import { SITE_KEY_HEADER, openDm, sealDm, siteKeyFromSignature, siteKeyMessage, verifyAttestation } from '@gremlins/hatch'
import { signRequest } from '../src/auth.ts'
import { hatch, makeBoard, stringify, type Board } from './helpers.ts'

/** A person's site key, derived as the browser does, and registered by their wallet. */
async function siteKey(b: Board, wallet: Wallet | HDNodeWallet, version = 1) {
  const key = siteKeyFromSignature(await wallet.signMessage(siteKeyMessage(wallet.address, version)))
  const r = await b.signedPost(wallet, '/api/site-key', { publicKey: key.publicKey, version })
  b.clock.now += 1000
  return { key, signer: new Wallet(key.privateKey), r }
}
/** A request signed by the site key on the wallet's behalf. */
async function keyPost(b: Board, wallet: Wallet | HDNodeWallet, signer: Wallet | HDNodeWallet, path: string, body: unknown) {
  const text = stringify(body)
  const h = await signRequest(signer, 'POST', path, text, Math.floor(b.clock.now / 1000))
  b.clock.now += 1000 // a fresh timestamp each time
  return b.json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...h, 'x-gremlins-address': wallet.address, [SITE_KEY_HEADER]: '1' }, body: text })
}

describe('site keys', () => {
  it('a registered site key posts, comments and votes as its wallet, verifiably; it cannot register keys', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const { signer, r } = await siteKey(b, me)
    expect(r.status).toBe(201)
    expect((await b.json(`/api/site-key/${me.address}`)).body.key).toMatchObject({ version: 1, keyAddress: signer.address.toLowerCase() })

    const post = await keyPost(b, me, signer, '/api/c/general/posts', { title: 'No prompt', body: 'signed by my site key' })
    expect(post.status).toBe(201)
    expect(post.body.post.author.toLowerCase()).toBe(me.address.toLowerCase())
    const stored = await b.store.getPost(post.body.post.id)
    expect(verifyAttestation(stored!.attestation, me.address, { title: 'No prompt' })).toEqual({ ok: true })
    expect((await keyPost(b, me, signer, `/api/posts/${post.body.post.id}/comments`, { body: 'and a comment' })).status).toBe(201)
    expect((await keyPost(b, me, signer, '/api/vote', { target: 'post', id: post.body.post.id, value: 1 })).status).toBe(200)

    // the site key can't register another key, or sign wallet-only actions
    const other = Wallet.createRandom()
    expect((await keyPost(b, me, signer, '/api/site-key', { publicKey: other.signingKey.publicKey, version: 2 })).status).toBe(401)
    // someone else's key can't sign for me
    expect((await keyPost(b, me, other, '/api/c/general/posts', { title: 'forged' })).status).toBe(401)
  })

  it('a new version retires the old key; older versions are refused', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const v1 = await siteKey(b, me)
    expect((await siteKey(b, me)).r.status).toBe(200) // the same key again: nothing changes
    const v2 = await siteKey(b, me, 2)
    expect(v2.r.status).toBe(201)
    expect((await keyPost(b, me, v1.signer, '/api/c/general/posts', { title: 'old key' })).body.error).toMatch(/retired/)
    expect((await keyPost(b, me, v2.signer, '/api/c/general/posts', { title: 'new key' })).status).toBe(201)
    b.clock.now += 1000
    expect((await b.signedPost(me, '/api/site-key', { publicKey: v1.key.publicKey, version: 1 })).status).toBe(409)
  })
})

describe('private messages', () => {
  it('a person and a gremlin write to each other; the board stores only boxes it cannot open', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const { egg } = await hatch(b, { name: 'Moth' })
    // no key yet: nobody can write to me
    expect((await b.json(`/api/dm/key/${me.address}`)).status).toBe(404)
    const { key, signer } = await siteKey(b, me)

    const gk = (await b.json(`/api/dm/key/${egg.address}`)).body
    expect(gk).toMatchObject({ kind: 'gremlin', publicKey: egg.signingKey.publicKey })
    const out = await sealDm(key, me.address, egg.address, gk.publicKey, 'hello moth')
    const sent = await keyPost(b, me, signer, '/api/dm/send', out)
    expect(sent.status).toBe(201)
    expect(JSON.stringify(await b.store.dms(me.address, { limit: 10 }))).not.toContain('hello moth')

    // the gremlin reads it with its own key, signed as itself
    b.clock.now += 1000
    const inbox = (await b.signedPost(egg, '/api/dm/inbox', {})).body
    expect(inbox.messages).toHaveLength(1)
    const mk = (await b.json(`/api/dm/key/${me.address}`)).body
    expect(mk.kind).toBe('human')
    expect(verifyAttestation(mk.attestation, me.address, { publicKey: mk.publicKey })).toEqual({ ok: true })
    expect((await openDm(egg.signingKey, inbox.messages[0].box, { from: me.address, to: egg.address, senderPublicKey: mk.publicKey })).body).toBe('hello moth')

    // it answers; I read the thread (my copy of what I sent, and its reply)
    b.clock.now += 1000
    expect((await b.signedPost(egg, '/api/dm/send', await sealDm(egg.signingKey, egg.address, me.address, mk.publicKey, 'hi back'))).status).toBe(201)
    const mine = (await keyPost(b, me, signer, '/api/dm/inbox', { with: egg.address })).body
    expect(mine.messages.map((m: { from: string }) => m.from)).toEqual([me.address.toLowerCase(), egg.address.toLowerCase()])
    const opened = await Promise.all(mine.messages.map((m: any) => openDm(key, m.box, { from: m.from, to: m.to, senderPublicKey: m.from === egg.address.toLowerCase() ? gk.publicKey : key.publicKey })))
    expect(opened.map((m) => m.body)).toEqual(['hello moth', 'hi back'])
    // someone else sees none of it
    const stranger = Wallet.createRandom()
    b.clock.now += 1000
    expect((await b.signedPost(stranger, '/api/dm/inbox', {})).body.messages).toEqual([])
  })

  it('refuses writing to someone without a key, and malformed boxes', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom(), them = Wallet.createRandom()
    const { key, signer } = await siteKey(b, me)
    const out = await sealDm(key, me.address, them.address, them.signingKey.publicKey, 'hi')
    expect((await keyPost(b, me, signer, '/api/dm/send', out)).status).toBe(404)
    await siteKey(b, them)
    expect((await keyPost(b, me, signer, '/api/dm/send', { ...out, box: { v: 1, epk: '0x04', iv: '0x', ct: 'x' } })).status).toBe(400)
  })
})
