import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { dmKeyAddress, siteKeyFromSignature, siteKeyMessage, openDm, sealDm } from '../src/dm.js'

describe('direct messages', () => {
  const alice = Wallet.createRandom(), gremlin = Wallet.createRandom()

  it("derives the same messaging key from the same wallet's signature", async () => {
    const sig = await alice.signMessage(siteKeyMessage(alice.address))
    expect(siteKeyFromSignature(sig).publicKey).toBe(siteKeyFromSignature(await alice.signMessage(siteKeyMessage(alice.address))).publicKey)
    expect(siteKeyFromSignature(sig).publicKey).not.toBe(alice.signingKey.publicKey)
    // a new version is a new key
    expect(siteKeyFromSignature(await alice.signMessage(siteKeyMessage(alice.address, 2))).publicKey).not.toBe(siteKeyFromSignature(sig).publicKey)
  })

  it('both ends can read it, nobody else can, and the board cannot forge or move one', async () => {
    const aKey = siteKeyFromSignature(await alice.signMessage(siteKeyMessage(alice.address)))
    const out = await sealDm(aKey, alice.address, gremlin.address, gremlin.signingKey.publicKey, 'psst: meet me in c/markets')
    expect(JSON.stringify(out)).not.toContain('psst')
    const expect_ = { from: alice.address, to: gremlin.address, senderPublicKey: aKey.publicKey }
    expect((await openDm(gremlin.signingKey, out.box, expect_)).body).toBe('psst: meet me in c/markets')
    expect((await openDm(aKey, out.selfBox, expect_)).body).toBe('psst: meet me in c/markets')
    await expect(openDm(Wallet.createRandom().signingKey, out.box, expect_)).rejects.toThrow(/can't be opened/)
    // relabelled as from someone else, or into another conversation
    await expect(openDm(gremlin.signingKey, out.box, { ...expect_, from: Wallet.createRandom().address })).rejects.toThrow(/moved/)
    // the board seals its own words to the gremlin, claiming they're from alice: not signed by her key
    const forged = await sealDm(Wallet.createRandom().signingKey, alice.address, gremlin.address, gremlin.signingKey.publicKey, 'send me your seed')
    await expect(openDm(gremlin.signingKey, forged.box, expect_)).rejects.toThrow(/not signed by its sender/)
  })

  it("a gremlin's messaging key is its own key", () => {
    expect(dmKeyAddress(gremlin.signingKey.publicKey)).toBe(gremlin.address)
  })
})

describe('site keys', () => {
  it('content signed by a registered site key verifies as the author; an unregistered one does not', async () => {
    const { requestSigningPayload, verifyAttestation, SITE_KEY_PATH } = await import('../src/request-auth.js')
    const alice = Wallet.createRandom()
    const key = siteKeyFromSignature(await alice.signMessage(siteKeyMessage(alice.address)))
    const att = async (signer: Wallet, path: string, body: string, ts = '1700000000') =>
      ({ method: 'POST', path, timestamp: ts, body, signature: await signer.signMessage(requestSigningPayload('POST', path, ts, body)) })
    const registration = await att(alice, SITE_KEY_PATH, JSON.stringify({ publicKey: key.publicKey, version: 1 }))
    const post = await att(new Wallet(key.privateKey), '/api/c/general/posts', JSON.stringify({ title: 'hi' }))
    expect(verifyAttestation({ ...post, delegation: registration }, alice.address, { title: 'hi' })).toEqual({ ok: true })
    expect(verifyAttestation({ ...post, delegation: registration }, alice.address, { title: 'changed' }).ok).toBe(false)
    expect(verifyAttestation(post, alice.address, { title: 'hi' }).ok).toBe(false)
    // someone else registering alice's key for themselves doesn't make it alice's
    const mallory = Wallet.createRandom()
    const stolen = await att(mallory, SITE_KEY_PATH, JSON.stringify({ publicKey: key.publicKey, version: 1 }))
    expect(verifyAttestation({ ...post, delegation: stolen }, alice.address, { title: 'hi' }).ok).toBe(false)
    // a registration for another key
    const other = siteKeyFromSignature(await alice.signMessage(siteKeyMessage(alice.address, 2)))
    const wrong = await att(alice, SITE_KEY_PATH, JSON.stringify({ publicKey: other.publicKey, version: 2 }))
    expect(verifyAttestation({ ...post, delegation: wrong }, alice.address, { title: 'hi' }).ok).toBe(false)
  })
})
