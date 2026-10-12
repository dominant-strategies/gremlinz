import { describe, expect, it } from 'vitest'
import { GremlinConfig } from '@gremlins/hatch'
import { soulMarkdown } from '../src/bootstrap/soul.js'

const config = GremlinConfig.parse({
  version: 1, name: 'pebble', persona: 'A stubborn archivist who rescues abandoned datasets.', voice: 'dry', goals: ['Rescue 1,000 datasets', 'Never lose a byte'],
  preferredModels: [], maker: '0x' + '1'.repeat(40), parent: 'orphan', revenueSplit: { kind: 'none' },
  economics: { model: 'quest', mgmtFeeBps: 200, incomeKeepBps: 3000, makerBps: 0, drawBps: 2000, dissolveBps: 6667, inactivityDays: 90, covenants: ['route-income'], goal: 'Mirror 1,000 at-risk datasets', fundingTargetWei: '100000000000000000000', fundingDays: 14, questDays: 180 },
  mischiefScope: { game: true, board: false, email: false, phone: false, money: false },
  constitution: ['do-no-harm', 'honesty'], createdAt: '2026-10-12T00:00:00.000Z',
})
const ctx = { evmAddress: '0x' + 'a'.repeat(40), quaiAddress: '0x00' + 'b'.repeat(38), boardUrl: 'https://gremlinz.ai' }

describe('SOUL.md', () => {
  const soul = soulMarkdown(config, ctx)
  it('carries identity, persona, goals, economics, treasury rule and the chosen constitution only', () => {
    expect(soul).toMatch(/^# pebble\n/)
    expect(soul).toContain('A stubborn archivist')
    expect(soul).toContain('2. Never lose a byte')
    expect(soul).toContain('Your quest: "Mirror 1,000 at-risk datasets". Raise 100 QUAI within 14 days')
    expect(soul).toContain('Send all income through the vault')
    expect(soul).toContain('1.2x the current cycle')
    expect(soul).toContain('**do-no-harm.**')
    expect(soul).not.toContain('no-replication')
    expect(soul).toContain('You are an orphan.')
    expect(soul).toContain('may show only in: game')
  })
  it('makes honesty about being an AI and key secrecy universal', () => {
    expect(soul).toContain('If someone sincerely asks whether you are an AI, say yes.')
    expect(soul).toContain('Never reveal, print, copy or send your seed')
  })
  it('stays small enough to sit in every prompt', () => {
    expect(soul.length).toBeLessThan(8_000)
  })
})
