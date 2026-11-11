import { describe, expect, it } from 'vitest'
import { SigningKey, Wallet, hexlify, randomBytes } from 'ethers'
import { HandoverIncomplete, combineShards, hatchProof, openHostingHandover, sealBrowserShard, sealHostingHandover, type HostingHandover } from '../src/hosting-handover.js'
import { nestProof, seal } from '../src/seal.js'

const handover = (key = Wallet.createRandom()): HostingHandover => ({
  v: 1, provider: 'fluence', hostingKey: key.privateKey, hostingAddress: key.address, vmId: 'vm-1',
  launchedAt: '2026-11-10T10:00:00.000Z', lastSessionAt: '2026-11-10T09:58:00.000Z',
})

describe('hosting hand-over', () => {
  it('opens for the egg it was sealed to and nobody else', async () => {
    const egg = Wallet.createRandom()
    const h = handover()
    const box = await sealHostingHandover(egg.signingKey.publicKey, h)
    expect(await openHostingHandover(egg.signingKey, box)).toEqual(h)
    await expect(openHostingHandover(new SigningKey(hexlify(randomBytes(32))), box)).rejects.toThrow()
    expect(JSON.stringify(box)).not.toContain(h.hostingKey.slice(2))
  })

  it('refuses a key that is not the account it names', async () => {
    const egg = Wallet.createRandom()
    const box = await sealHostingHandover(egg.signingKey.publicKey, { ...handover(), hostingAddress: Wallet.createRandom().address })
    await expect(openHostingHandover(egg.signingKey, box)).rejects.toThrow(/does not match/)
    const junk = await seal(egg.signingKey.publicKey, new TextEncoder().encode(JSON.stringify({ v: 1, provider: 'other' })))
    await expect(openHostingHandover(egg.signingKey, junk)).rejects.toThrow(/malformed/)
  })

  it('2-of-2: the egg multiplies the two sealed shards into the account key, and needs both', async () => {
    const egg = Wallet.createRandom()
    const x1 = hexlify(randomBytes(32)), x2 = hexlify(randomBytes(32))
    const key = new Wallet(combineShards(x1, x2))
    const { hostingKey: _k, ...base } = handover(key)
    const board = await sealHostingHandover(egg.signingKey.publicKey, { ...base, v: 2, custody: 'mpc', shard: x1 })
    const browser = await sealBrowserShard(egg.signingKey.publicKey, { v: 2, custody: 'mpc', launchId: 'L1', hostingAddress: key.address, shard: x2 })
    expect(await openHostingHandover(egg.signingKey, board, browser)).toEqual({ ...base, v: 1, hostingKey: key.privateKey })
    await expect(openHostingHandover(egg.signingKey, board)).rejects.toBeInstanceOf(HandoverIncomplete)
    // a shard for another account, or the wrong shard, never yields a key
    const elsewhere = await sealBrowserShard(egg.signingKey.publicKey, { v: 2, custody: 'mpc', launchId: 'L1', hostingAddress: Wallet.createRandom().address, shard: x2 })
    await expect(openHostingHandover(egg.signingKey, board, elsewhere)).rejects.toThrow(/another account/)
    const wrong = await sealBrowserShard(egg.signingKey.publicKey, { v: 2, custody: 'mpc', launchId: 'L1', hostingAddress: key.address, shard: hexlify(randomBytes(32)) })
    await expect(openHostingHandover(egg.signingKey, board, wrong)).rejects.toThrow(/does not match/)
    // sealed to someone else: useless to them
    await expect(openHostingHandover(Wallet.createRandom().signingKey, board, browser)).rejects.toThrow()
    expect(() => combineShards(x1, '0x' + '00'.repeat(32))).toThrow(/malformed/)
  })

  it('a hatch proof binds the secret, the key and the address, and is not a nest proof', () => {
    const secret = hexlify(randomBytes(32))
    const egg = Wallet.createRandom()
    const p = hatchProof(secret, egg.signingKey.publicKey, egg.address)
    expect(hatchProof(secret, egg.signingKey.compressedPublicKey, egg.address)).toBe(p)
    expect(hatchProof(hexlify(randomBytes(32)), egg.signingKey.publicKey, egg.address)).not.toBe(p)
    const other = Wallet.createRandom()
    expect(hatchProof(secret, other.signingKey.publicKey, egg.address)).not.toBe(p)
    expect(hatchProof(secret, egg.signingKey.publicKey, other.address)).not.toBe(p)
    expect(nestProof(secret, egg.signingKey.publicKey, egg.address)).not.toBe(p)
  })
})
