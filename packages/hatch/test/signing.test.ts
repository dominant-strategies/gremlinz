import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { canonicalJson, type GremlinConfig } from '../src/config.js'
import { configHash, signConfig, verifySignedConfig } from '../src/signing.js'

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
})
