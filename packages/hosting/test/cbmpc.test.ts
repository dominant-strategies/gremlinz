import { describe, expect, it } from 'vitest'
import { SigningKey, computeAddress, hexlify, keccak256, toUtf8Bytes } from 'ethers'
import { CbmpcRun, cbmpcPrivateShare, cbmpcPublicKey, type StepResult } from '../src/cbmpc.js'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const names = { p1: 'test-board:job', p2: 'test-maker:job' }

/** Relay two runs to completion, party 1 first. */
async function relay<A, B>(a: CbmpcRun<A>, b: CbmpcRun<B>, tap?: (from: 1 | 2, msgs: Uint8Array[]) => Uint8Array[]): Promise<[A, B]> {
  let ra: StepResult<A> = await a.step([])
  let rb: StepResult<B> | undefined
  for (let i = 0; i < 50; i++) {
    if (!rb?.done) rb = await b.step(tap ? tap(1, ra.out) : ra.out)
    if (ra.done && rb.done) return [ra.result, rb.result]
    if (!ra.done) ra = await a.step(tap ? tap(2, rb.out) : rb.out)
    if (ra.done && rb.done) return [ra.result, rb.result]
  }
  throw new Error('protocol did not finish')
}

const hex = (b: Uint8Array) => hexlify(b)

describe('cb-mpc 2-party ECDSA (WebAssembly)', () => {
  it('key generation, signing, and the two shares add up to the key', async () => {
    const [k1, k2] = await relay(CbmpcRun.dkg({ self: 0, ...names }), CbmpcRun.dkg({ self: 1, ...names }))
    const pub = await cbmpcPublicKey(k1)
    expect(hex(await cbmpcPublicKey(k2))).toBe(hex(pub))
    const address = computeAddress(SigningKey.computePublicKey(pub, false))

    const hash = keccak256(toUtf8Bytes('hello'))
    const [der, none] = await relay(CbmpcRun.sign({ self: 0, ...names }, k1, Uint8Array.from(Buffer.from(hash.slice(2), 'hex'))), CbmpcRun.sign({ self: 1, ...names }, k2, Uint8Array.from(Buffer.from(hash.slice(2), 'hex'))))
    expect(none).toBeNull()
    expect(der!.length).toBeGreaterThan(60)

    const x1 = BigInt(hex(await cbmpcPrivateShare(k1))), x2 = BigInt(hex(await cbmpcPrivateShare(k2)))
    const x = `0x${((x1 + x2) % N).toString(16).padStart(64, '0')}`
    expect(computeAddress(x)).toBe(address)
    expect(computeAddress(`0x${(x1 % N).toString(16).padStart(64, '0')}`)).not.toBe(address)
  }, 120_000)
})
