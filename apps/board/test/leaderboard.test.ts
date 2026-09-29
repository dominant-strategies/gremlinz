import { describe, expect, it } from 'vitest'
import { signMessage } from '@gremlins/hatch'
import { hatch, makeBoard, pulse } from './helpers.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR

async function threeGremlins() {
  const b = await makeBoard()
  const a = await hatch(b, { name: 'A', pulse: { netWorthQuai: '2000000000000000000', revenueLifetimeUsd: '5.5', runwayDays: 10 } })
  b.clock.now += HOUR
  const bb = await hatch(b, { name: 'B', pulse: { netWorthQuai: '10000000000000000000', revenueLifetimeUsd: '1', runwayDays: 3 } })
  b.clock.now += HOUR
  const c = await hatch(b, { name: 'C', pulse: { netWorthQuai: '500000000000000000', revenueLifetimeUsd: '100.25', runwayDays: 90 } })
  await hatch(b, { name: 'unhatched', pulse: false }) // configured, no pulse: not on the board
  return { b, a, bb, c }
}

const names = (r: any) => r.body.entries.map((e: any) => e.name)

describe('leaderboard', () => {
  it('sorts by each metric from the latest pulse', async () => {
    const { b, a } = await threeGremlins()
    expect(names(await b.json('/api/leaderboard'))).toEqual(['B', 'A', 'C'])
    expect(names(await b.json('/api/leaderboard?sort=netWorthQuai'))).toEqual(['B', 'A', 'C'])
    expect(names(await b.json('/api/leaderboard?sort=revenueLifetimeUsd'))).toEqual(['C', 'A', 'B'])
    expect(names(await b.json('/api/leaderboard?sort=runwayDays'))).toEqual(['C', 'A', 'B'])
    expect(names(await b.json('/api/leaderboard?sort=age'))).toEqual(['A', 'B', 'C'])
    expect((await b.json('/api/leaderboard?sort=vibes')).status).toBe(400)

    // a newer pulse replaces the old numbers
    await b.postJson('/api/pulses', await signMessage(a.egg, pulse(a.egg.address, 2, { netWorthQuai: '20000000000000000000' })))
    const r = await b.json('/api/leaderboard')
    expect(names(r)).toEqual(['A', 'B', 'C'])
    expect(r.body.entries[0]).toMatchObject({ rank: 1, netWorthQuaiFormatted: '20', seq: 2, liveness: 'alive' })
  })

  it('marks unresponsive after 24h and dead after 7d or tier=dead', async () => {
    const { b, a, bb } = await threeGremlins()
    b.clock.now += 25 * HOUR
    await b.postJson('/api/pulses', await signMessage(a.egg, pulse(a.egg.address, 2)))
    await b.postJson('/api/pulses', await signMessage(bb.egg, pulse(bb.egg.address, 2, { tier: 'dead' })))
    const live = (r: any) => Object.fromEntries(r.body.entries.map((e: any) => [e.name, e.liveness]))
    expect(live(await b.json('/api/leaderboard?includeDead=1'))).toEqual({ A: 'alive', B: 'dead', C: 'unresponsive' })
    expect(names(await b.json('/api/leaderboard'))).toEqual(['A', 'C']) // dead hidden by default

    b.clock.now += 7 * DAY + 1000
    expect(live(await b.json('/api/leaderboard?includeDead=1'))).toEqual({ A: 'dead', B: 'dead', C: 'dead' })
    expect(names(await b.json('/api/leaderboard'))).toEqual([])
  })

  it('uses configurable thresholds', async () => {
    const b = await makeBoard({ unresponsiveAfterSec: 60, deadAfterSec: 600 })
    await hatch(b, { name: 'X' })
    b.clock.now += 61_000
    expect((await b.json('/api/leaderboard')).body.entries[0].liveness).toBe('unresponsive')
    b.clock.now += 600_000
    expect((await b.json('/api/leaderboard?includeDead=true')).body.entries[0].liveness).toBe('dead')
  })
})
