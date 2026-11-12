import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renewHosting } from '../src/health/hosting.js'

function setup() {
  const state = { pays: 0, deposits: 10, drop: false, used: false, usdc: 20_000_000n, primaryType: 'TransferWithAuthorization' }
  let now = Date.now()
  const deps = {
    file: join(mkdtempSync(join(tmpdir(), 'renewal-')), 'renewal.json'), now: () => now,
    account: { hostingKey: '0x' + '1'.repeat(64), vmId: 'owned-vm' },
    usdc: async () => state.usdc, used: async () => state.used,
    client: {
      login: async () => {}, totalDeposited: async () => state.deposits,
      topUp: async (_usd: number, opts: { onAuthorization?: (a: { primaryType: string; nonce: string; validBefore: number }) => unknown } = {}) => {
        await opts.onAuthorization?.({ primaryType: state.primaryType, nonce: '0xnonce', validBefore: Math.floor(now / 1000) + 3600 })
        state.pays++
        if (state.drop) throw new Error('payment response lost')
        state.deposits += 10
        return { transaction: '0xtx', amountUsd: '10' }
      },
    },
  }
  return { state, deps, advance: (ms: number) => { now += ms } }
}

describe('deterministic hosting renewal', () => {
  const low = { provider: 'fluence' as const, daysLeft: 1, balanceUsd: 1, hourlyUsd: 0.05 }
  it('renews from existing USDC and caps repeated checks at one $10 purchase per day', async () => {
    const t = setup()
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'paid', usd: 10 })
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'skipped' })
    expect(t.state.pays).toBe(1)
  })
  it('does not repeat an uncertain payment, and reconciles later chain confirmation', async () => {
    const t = setup(); t.state.drop = true
    await expect(renewHosting(low, t.deps)).rejects.toThrow('response lost')
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'pending' })
    t.state.used = true
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'paid' })
    expect(t.state.pays).toBe(1)
  })
  it('does not spend when hosting is healthy or the hosting wallet lacks USDC', async () => {
    const t = setup()
    await expect(renewHosting({ ...low, daysLeft: 30 }, t.deps)).resolves.toMatchObject({ state: 'skipped' })
    t.state.usdc = 0n
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'skipped' })
    expect(t.state.pays).toBe(0)
  })
  it('retries only after all earlier authorizations are confirmed unused and expired', async () => {
    const t = setup(); t.state.drop = true
    await expect(renewHosting(low, t.deps)).rejects.toThrow('response lost')
    t.advance(2 * 3_600_000); t.state.drop = false
    await expect(renewHosting(low, t.deps)).resolves.toMatchObject({ state: 'paid' })
    expect(t.state.pays).toBe(2)
  })
  it('rejects unsupported payment authorization types before signing or spending', async () => {
    const t = setup(); t.state.primaryType = 'PermitWitnessTransferFrom'
    await expect(renewHosting(low, t.deps)).rejects.toThrow('EIP-3009')
    expect(t.state.pays).toBe(0)
  })
})
