import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { canonicalJson, type GremlinConfig } from '../src/config.js'
import { configHash, hatchText, signConfig, verifySignedConfig, type HatchMessage, type SignedConfig } from '../src/signing.js'

const maker = Wallet.createRandom()
const stranger = Wallet.createRandom()
const gremlin = '0x00' + '4f'.repeat(19)
const otherGremlin = '0x00' + '51'.repeat(19)

const config = (over: Partial<GremlinConfig> = {}): GremlinConfig => ({
  version: 1,
  name: 'sprocket',
  persona: 'A curious tinkerer who loves fixing things.',
  voice: 'warm',
  goals: ['Fund an open-source weather station network'],
  preferredModels: ['claude-opus-5-5'],
  maker: maker.address,
  parent: 'maker',
  revenueSplit: { kind: 'revenue', bps: 1_000, recipient: maker.address },
  mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
  constitution: ['do-no-harm', 'honesty', 'ai-disclosure'],
  createdAt: '2026-09-29T00:00:00.000Z',
  ...over,
})

describe('hatch signing', () => {
  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  })

  it('accepts a config signed by the maker', async () => {
    const c = config()
    const signed = await signConfig(maker, c, gremlin)
    expect(verifySignedConfig(signed, { maker: maker.address, configHash: configHash(c), gremlin })).toMatchObject({ ok: true })
  })

  it('rejects a stranger hijacking the egg with their own config', async () => {
    const theirs = config({ maker: stranger.address, name: 'hijack' })
    const signed = await signConfig(stranger, theirs, gremlin)
    const r = verifySignedConfig(signed, { maker: maker.address, configHash: configHash(config()), gremlin })
    expect(r.ok).toBe(false)
  })

  it('rejects a config altered after signing', async () => {
    const c = config()
    const signed = await signConfig(maker, c, gremlin)
    const tampered = { ...signed, config: { ...signed.config, revenueSplit: { kind: 'revenue' as const, bps: 9_000, recipient: stranger.address } } }
    const r = verifySignedConfig(tampered, { maker: maker.address, configHash: configHash(c), gremlin })
    expect(r).toEqual({ ok: false, reason: 'config hash does not match launch data' })
  })

  it('rejects a signature made for a different gremlin (no squatting)', async () => {
    const c = config()
    const signed = await signConfig(maker, c, otherGremlin)
    expect(verifySignedConfig(signed, { maker: maker.address, configHash: configHash(c), gremlin })).toEqual({ ok: false, reason: 'config was signed for a different gremlin' })
  })

  it('refuses to sign for someone else', async () => {
    await expect(signConfig(stranger, config(), gremlin)).rejects.toThrow('signer is not the config maker')
  })

  it('validates config shape', async () => {
    await expect(signConfig(maker, config({ constitution: ['honesty', 'honesty'] }), gremlin)).rejects.toThrow()
  })

  describe("plain-text ('personal') signatures from EVM wallets", () => {
    /** What MetaMask does: personal_sign over the hatch text, no chain involved. */
    const personal = async (who: Wallet, c: GremlinConfig, g = gremlin, msg: Partial<HatchMessage> = {}): Promise<SignedConfig> => {
      const message: HatchMessage = { maker: maker.address, gremlin: g, configHash: configHash(c), issuedAt: 1794870000n, ...msg }
      return { config: c, message, signature: await who.signMessage(hatchText(message)), scheme: 'personal' }
    }

    it('accepts the maker signing the hatch text', async () => {
      const c = config()
      expect(verifySignedConfig(await personal(maker, c), { maker: maker.address, configHash: configHash(c), gremlin })).toMatchObject({ ok: true })
    })

    it('the text names maker, egg and config hash, and no chain', () => {
      const t = hatchText({ maker: maker.address, gremlin, configHash: configHash(config()), issuedAt: 1n })
      expect(t).toContain(maker.address.toLowerCase())
      expect(t).toContain(gremlin.toLowerCase())
      expect(t).toContain(configHash(config()))
      expect(t).not.toMatch(/chain/i)
    })

    it('rejects a stranger, a different egg, a changed config, or the signature passed off as the other scheme', async () => {
      const c = config()
      const want = { maker: maker.address, configHash: configHash(c), gremlin }
      expect(verifySignedConfig(await personal(stranger, c), want)).toEqual({ ok: false, reason: 'signature is not from the maker' })
      expect(verifySignedConfig(await personal(maker, c, otherGremlin), want)).toEqual({ ok: false, reason: 'config was signed for a different gremlin' })
      const signed = await personal(maker, c)
      expect(verifySignedConfig({ ...signed, message: { ...signed.message, issuedAt: 1794870001n } }, want)).toEqual({ ok: false, reason: 'signature is not from the maker' })
      expect(verifySignedConfig({ ...signed, scheme: undefined }, want)).toEqual({ ok: false, reason: 'signature is not from the maker' })
      expect(verifySignedConfig({ ...signed, scheme: 'other' as never }, want)).toEqual({ ok: false, reason: 'malformed signature' })
      // and an EIP-712 signature relabelled as personal
      const typed = await signConfig(maker, c, gremlin)
      expect(verifySignedConfig({ ...typed, scheme: 'personal' }, want)).toEqual({ ok: false, reason: 'signature is not from the maker' })
    })
  })
})
