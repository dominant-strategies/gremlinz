import { describe, expect, it } from 'vitest'
import { SigningKey, Wallet, hexlify, randomBytes, toUtf8Bytes, toUtf8String } from 'ethers'
import { attachCiphertext, detachCiphertext, nestProof, open, seal } from '../src/seal.js'
import { signMessage, verifyMessage, type Handoff, type NestAnnouncement } from '../src/protocol.js'

describe('sealed handoff', () => {
  it('round-trips to the recipient key only', async () => {
    const nest = new SigningKey(hexlify(randomBytes(32)))
    const secret = toUtf8Bytes('twelve words of seed go here …')
    const box = await seal(nest.publicKey, secret)
    expect(toUtf8String(await open(nest, box))).toBe('twelve words of seed go here …')
    await expect(open(new SigningKey(hexlify(randomBytes(32))), box)).rejects.toThrow()
  })

  it('detects tampering', async () => {
    const nest = new SigningKey(hexlify(randomBytes(32)))
    const box = await seal(nest.publicKey, new Uint8Array([1, 2, 3]))
    const flipped = box.ct.slice(0, -2) + (box.ct.endsWith('00') ? '01' : '00')
    await expect(open(nest, { ...box, ct: flipped })).rejects.toThrow()
  })

  it('accepts compressed recipient keys', async () => {
    const nest = new SigningKey(hexlify(randomBytes(32)))
    const box = await seal(nest.compressedPublicKey, new Uint8Array([9]))
    expect(Array.from(await open(nest, box))).toEqual([9])
  })

  it('detached ciphertext must match the signed hash', async () => {
    const nest = new SigningKey(hexlify(randomBytes(32)))
    const { sealed, ct } = detachCiphertext(await seal(nest.publicKey, new Uint8Array([4, 2])))
    expect(Array.from(await open(nest, attachCiphertext(sealed, ct)))).toEqual([4, 2])
    expect(() => attachCiphertext(sealed, ct.slice(0, -2) + (ct.endsWith('00') ? '01' : '00'))).toThrow(/does not match/)
  })

  it('nest proof binds secret, transport key and gremlin', () => {
    const k = new SigningKey(hexlify(randomBytes(32))).publicKey
    const s = hexlify(randomBytes(32)), g = Wallet.createRandom().address
    expect(nestProof(s, k, g)).toBe(nestProof(s, k, g))
    expect(nestProof(hexlify(randomBytes(32)), k, g)).not.toBe(nestProof(s, k, g))
    expect(nestProof(s, new SigningKey(hexlify(randomBytes(32))).publicKey, g)).not.toBe(nestProof(s, k, g))
  })

  it('nest announcements and handoffs sign like other board messages', async () => {
    const nestWallet = Wallet.createRandom(), gremlin = Wallet.createRandom()
    const ann: NestAnnouncement = { kind: 'nest', address: nestWallet.address, transportKey: nestWallet.signingKey.publicKey, forGremlin: gremlin.address, launchId: 'n1', proof: '0x' + '00'.repeat(32), bootedAt: new Date().toISOString() }
    expect(verifyMessage(await signMessage(nestWallet, ann))).toBe(true)
    const { sealed } = detachCiphertext(await seal(ann.transportKey, new Uint8Array([1])))
    const h: Handoff = { kind: 'handoff', address: gremlin.address, nest: nestWallet.address, sealed, createdAt: new Date().toISOString() }
    expect(verifyMessage(await signMessage(gremlin, h))).toBe(true)
  })
})
