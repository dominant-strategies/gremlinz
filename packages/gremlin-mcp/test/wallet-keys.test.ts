import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519.js'
import { deriveKeys, slip10Ed25519 } from '../src/wallets/keys.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('multi-chain keys', () => {
  it('matches published vectors: EVM m/44\'/60\'/0\'/0/0 and BIP84 Bitcoin', () => {
    const k = deriveKeys(ABANDON)
    expect(k.evm.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    expect(k.bitcoin.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu') // BIP84 test vector
  })

  it('implements SLIP-10 ed25519 (official test vector 1)', () => {
    const seed = hex.decode('000102030405060708090a0b0c0d0e0f')
    const m = slip10Ed25519(seed, 'm')
    expect(hex.encode(m.key)).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7')
    expect(hex.encode(m.chainCode)).toBe('90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb')
    const c = slip10Ed25519(seed, "m/0'")
    expect(hex.encode(c.key)).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3')
    expect(hex.encode(ed25519.getPublicKey(c.key))).toBe('8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c')
  })

  it('gives each family a well-formed address', () => {
    const k = deriveKeys(ABANDON)
    expect(k.quai.address).toMatch(/^0x00[0-7]/) // cyprus1, Quai ledger
    expect(k.qi.paymentCode).toMatch(/^PM8T/)
    expect(k.solana.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(k.solana.secretKey).toHaveLength(64)
    expect(k.litecoin.address).toMatch(/^ltc1q/)
  })

  it('is deterministic and different for different seeds', () => {
    const a = deriveKeys(ABANDON)
    expect(deriveKeys(ABANDON).solana.address).toBe(a.solana.address)
    const b = deriveKeys('legal winner thank year wave sausage worth useful legal winner thank yellow')
    expect(b.solana.address).not.toBe(a.solana.address)
    expect(b.bitcoin.address).not.toBe(a.bitcoin.address)
  })
})
