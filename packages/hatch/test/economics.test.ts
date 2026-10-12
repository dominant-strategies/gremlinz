import { describe, expect, it } from 'vitest'
import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { GremlinConfig } from '../src/config.js'
import { configHash } from '../src/signing.js'
import { DEFAULT_VAULT_TERMS, economicsOf, syndicateParams } from '../src/economics.js'

const maker = Wallet.createRandom().address
const base = {
  version: 1, name: 'pebble', persona: 'An archivist.', voice: '', goals: ['Rescue datasets'], preferredModels: [], maker, parent: 'maker',
  revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
  constitution: [], createdAt: '2026-10-12T00:00:00.000Z',
} as const
const quest = { model: 'quest', ...DEFAULT_VAULT_TERMS, makerBps: 500, goal: 'Build 10 weather stations', fundingTargetWei: '100000000000000000000', fundingDays: 14, questDays: 180 } as const

describe('economics', () => {
  it('derives solo / maker-split from older configs without economics, keeping their hash', () => {
    expect(economicsOf(GremlinConfig.parse(base))).toEqual({ model: 'solo' })
    const split = GremlinConfig.parse({ ...base, revenueSplit: { kind: 'revenue', bps: 1000, recipient: maker } })
    expect(economicsOf(split)).toEqual({ model: 'maker-split' })
    expect(configHash(GremlinConfig.parse(base))).toBe(configHash({ ...base } as GremlinConfig))
  })

  it('accepts each model and rejects inconsistent ones', () => {
    for (const economics of [{ model: 'solo' }, { model: 'patrons', covenants: ['answer-votes'] }, { model: 'syndicate', ...DEFAULT_VAULT_TERMS }, quest])
      expect(GremlinConfig.safeParse({ ...base, economics }).success, economics.model).toBe(true)
    expect(GremlinConfig.safeParse({ ...base, economics: { model: 'maker-split' } }).success).toBe(false) // needs revenueSplit
    expect(GremlinConfig.safeParse({ ...base, revenueSplit: { kind: 'profit', bps: 100, recipient: maker }, economics: { model: 'syndicate', ...DEFAULT_VAULT_TERMS } }).success).toBe(false)
    expect(GremlinConfig.safeParse({ ...base, economics: { model: 'syndicate', ...DEFAULT_VAULT_TERMS, makerBps: 8000 } }).success).toBe(false)
    expect(GremlinConfig.safeParse({ ...base, economics: { model: 'syndicate', ...DEFAULT_VAULT_TERMS, mgmtFeeBps: 2000 } }).success).toBe(false)
    expect(GremlinConfig.safeParse({ ...base, economics: { model: 'patrons', covenants: ['made-up'] } }).success).toBe(false)
  })

  it('maps a quest to SyndicateVault constructor params', () => {
    const p = syndicateParams(quest, '0x00' + '11'.repeat(19), maker, 1_000_000)
    expect(p.goalHash).toBe(keccak256(toUtf8Bytes('Build 10 weather stations')))
    expect(p.fundingTarget).toBe(100n * 10n ** 18n)
    expect(p.fundingDeadline).toBe(1_000_000 + 14 * 86_400)
    expect(p.questDeadline).toBe(p.fundingDeadline + 180 * 86_400)
    expect(p.maker).toBe(maker)
    const s = syndicateParams({ model: 'syndicate', ...DEFAULT_VAULT_TERMS }, maker, maker, 1)
    expect(s.maker).toBe('0x0000000000000000000000000000000000000000') // no maker cut
    expect(s.fundingTarget).toBe(0n)
  })
})
