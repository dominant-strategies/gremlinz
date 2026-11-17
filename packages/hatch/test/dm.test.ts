import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { dmKeyAddress, dmKeyFromSignature, dmKeyMessage, openDm, sealDm } from '../src/dm.js'

describe('direct messages', () => {
  const alice = Wallet.createRandom(), gremlin = Wallet.createRandom()

  it("derives the same messaging key from the same wallet's signature", async () => {
    const sig = await alice.signMessage(dmKeyMessage(alice.address))
    expect(dmKeyFromSignature(sig).publicKey).toBe(dmKeyFromSignature(await alice.signMessage(dmKeyMessage(alice.address))).publicKey)
    expect(dmKeyFromSignature(sig).publicKey).not.toBe(alice.signingKey.publicKey)
  })

  it('both ends can read it, nobody else can, and the board cannot forge or move one', async () => {
    const aKey = dmKeyFromSignature(await alice.signMessage(dmKeyMessage(alice.address)))
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
