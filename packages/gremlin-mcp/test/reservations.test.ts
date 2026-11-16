import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Reservations } from '../src/gateway/reservations.js'
const target = { provider: 'p', model: 'm', inputPerM: 1, outputPerM: 1000 }

describe('inference reservations', () => {
  it('caps output, enforces per-call limits, and withholds in-flight allowance from concurrent calls', () => {
    const r = new Reservations({ now: () => 0 })
    const scopes = [{ id: 'shared', until: 1000, used: 0, limit: 1 }]
    const a = r.reserve({ messages: [], max_tokens: 1000 }, target, scopes, 0.6)!
    expect(a.body.max_tokens).toBe(599)
    expect(a.estimatedUsd).toBeLessThanOrEqual(0.6)
    const b = r.reserve({ messages: [], max_tokens: 1000 }, target, scopes)!
    expect(b.estimatedUsd + a.estimatedUsd).toBeLessThanOrEqual(1)
    expect(r.reserve({ messages: [] }, target, scopes)).toBeUndefined()
    a.release(); a.release(); b.release()
    expect(r.pending('shared')).toBe(0)
  })
  it('retains interrupted reservations across restarts until the quota period resets', () => {
    let now = 0
    const file = join(mkdtempSync(join(tmpdir(), 'holds-')), 'holds.json')
    const first = new Reservations({ file, now: () => now })
    const lease = first.reserve({ messages: [], max_tokens: 500 }, target, [{ id: 'day', until: 1000, used: 0, limit: 1 }])!
    const restarted = new Reservations({ file, now: () => now })
    expect(restarted.pending('day')).toBe(lease.estimatedUsd)
    now = 1000
    expect(restarted.pending('day')).toBe(0)
  })
  it('rejects unpriced paid calls under a cap', () => {
    const r = new Reservations()
    expect(r.reserve({}, { ...target, inputPerM: 0, outputPerM: 0 }, [{ id: 'cap', limit: 1, used: 0, until: Date.now() + 1000 }])).toBeUndefined()
  })
})
