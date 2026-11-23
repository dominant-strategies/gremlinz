import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buyCredit, reconcileCredit, HashferencePaymentReview } from '../src/hashference.js'

const REVIEW_MS = 15 * 60_000

function setup() {
  const journalFile = join(mkdtempSync(join(tmpdir(), 'payment-recovery-')), 'purchase.json')
  const state = { status: 'awaiting_payment', t: Date.now(), quoteMs: 300_000, reads: 0, pays: 0, requestIds: [] as string[], verified: [] as string[] }
  const quote = () => ({
    id: `invoice-${state.requestIds.length}`, status: state.status, amountAtomic: '123', addresses: ['0x00aa'],
    expiresAt: new Date(state.t + state.quoteMs).toISOString(), creditMicrousd: 3_000_000,
    ...(state.status === 'expired' ? { quoteExpired: true, canPay: false, paymentObserved: false } : {}),
  })
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (init.method === 'GET') state.reads++
    if (init.method === 'POST' && String(url).endsWith('/v1/payments')) state.requestIds.push(JSON.parse(String(init.body)).requestId)
    if (String(url).endsWith('/verify')) {
      state.verified.push(JSON.parse(String(init.body)).transaction)
      state.status = 'paid'
    }
    return Response.json({ invoice: quote() })
  }) as typeof globalThis.fetch
  const key = { apiKey: 'hf_test', address: '0x00aa', createdAt: '' }
  return { state, key, quote, deps: { journalFile, fetch, now: () => state.t, sleep: async () => {} }, saved: () => JSON.parse(readFileSync(journalFile, 'utf8')) }
}

describe('inference payment recovery', () => {
  it('records the signed payment before broadcast and verifies its hash after a lost broadcast result', async () => {
    const t = setup()
    const deps = { ...t.deps, preparePayment: async () => ({
      tx: '0xsigned', nonce: 5, broadcast: async () => {
        expect(t.saved()).toMatchObject({ state: 'sending', tx: '0xsigned', nonce: 5 })
        t.state.pays++
        throw new Error('connection lost')
      },
    }) }
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow(HashferencePaymentReview)
    t.state.status = 'expired'
    t.state.t += REVIEW_MS
    await expect(reconcileCredit(t.key, t.deps)).resolves.toMatchObject({ status: 'paid', tx: '0xsigned', recovered: true, usd: 3 })
    expect(t.state.verified).toEqual(['0xsigned'])
    expect(t.state.pays).toBe(1)
    expect(t.state.requestIds).toHaveLength(1)
  })

  it('keeps an already-submitted payment pending without creating a second invoice', async () => {
    const t = setup()
    const deps = { ...t.deps, pay: async () => { t.state.pays++; t.state.status = 'confirming'; return '0xreceipt' } }
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'confirming', tx: '0xreceipt' })
    t.state.status = 'paid'
    await expect(reconcileCredit(t.key, t.deps)).resolves.toMatchObject({ status: 'paid', tx: '0xreceipt', recovered: true })
    expect(t.state.pays).toBe(1)
    expect(t.state.requestIds).toHaveLength(1)
    expect(t.state.verified).toEqual([])
  })

  it.each([undefined, 5])('holds a legacy expired sending journal with nonce %s and no hash', async (nonceBefore) => {
    const t = setup()
    writeFileSync(t.deps.journalFile, JSON.stringify({
      requestId: 'legacy', usd: 3, state: 'sending', nonceBefore, invoice: t.quote(),
    }))
    t.state.status = 'expired'
    const pay = async () => { t.state.pays++; return '0xduplicate' }
    for (let i = 0; i < 710; i++) await expect(buyCredit(t.key, 3, { ...t.deps, pay })).rejects.toThrow('payment outcome unknown')
    expect(t.state.reads).toBe(1)
    expect(t.state.requestIds).toEqual([])
    expect(t.state.pays).toBe(0)
    expect(t.state.verified).toEqual([])
    t.state.status = 'paid'
    t.state.t += REVIEW_MS
    await expect(reconcileCredit(t.key, t.deps)).resolves.toMatchObject({ status: 'paid', recovered: true })
  })

  it('refreshes an expired quote after a failure known to be before broadcast', async () => {
    const t = setup()
    const oldPrepare = async () => { throw new Error('could not prepare transfer') }
    await expect(buyCredit(t.key, 3, { ...t.deps, preparePayment: oldPrepare })).rejects.toThrow('could not prepare')
    expect(t.saved()).toMatchObject({ state: 'prepared' })
    t.state.t += 300_001
    await expect(reconcileCredit(t.key, t.deps)).resolves.toBeUndefined()
    const preparePayment = async () => ({ tx: '0xnew', nonce: 5, broadcast: async () => { t.state.pays++; t.state.status = 'paid' } })
    await expect(buyCredit(t.key, 3, { ...t.deps, preparePayment })).resolves.toMatchObject({ status: 'paid', tx: '0xnew' })
    expect(new Set(t.state.requestIds).size).toBe(2)
    expect(t.state.pays).toBe(1)
  })
})
