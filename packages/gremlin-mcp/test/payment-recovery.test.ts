import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buyCredit } from '../src/hashference.js'

function setup() {
  const journalFile = join(mkdtempSync(join(tmpdir(), 'payment-recovery-')), 'purchase.json')
  const state = { status: 'awaiting_payment', invoices: 0, pays: 0 }
  const fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    if (init.method === 'POST' && String(_url).endsWith('/v1/payments')) state.invoices++
    return Response.json({ invoice: { id: 'invoice-one', status: state.status, amountAtomic: '123', addresses: ['0x00aa'], expiresAt: new Date(Date.now() + 300_000).toISOString(), creditMicrousd: 3_000_000 } })
  }) as typeof globalThis.fetch
  const key = { apiKey: 'hf_test', address: '0x00aa', createdAt: '' }
  return { journalFile, state, fetch, key }
}

describe('inference payment recovery', () => {
  it('does not resend after a lost broadcast result; reconciles provider confirmation after restart', async () => {
    const t = setup()
    const deps = { journalFile: t.journalFile, fetch: t.fetch, sleep: async () => {}, pay: async () => { t.state.pays++; throw new Error('connection lost after broadcast') } }
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow('connection lost')
    expect(JSON.parse(readFileSync(t.journalFile, 'utf8')).state).toBe('sending')
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow('outcome unknown')
    expect(t.state.pays).toBe(1)
    expect(t.state.invoices).toBe(1)
    t.state.status = 'paid'
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'paid', recovered: true, usd: 3 })
    expect(t.state.pays).toBe(1)
  })
  it('reuses an already-sent transaction while credit confirmation is delayed', async () => {
    const t = setup()
    const deps = { journalFile: t.journalFile, fetch: t.fetch, sleep: async () => {}, pay: async () => { t.state.pays++; return '0xreceipt' } }
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'awaiting_payment', tx: '0xreceipt' })
    t.state.status = 'paid'
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'paid', tx: '0xreceipt', recovered: true })
    expect(t.state.pays).toBe(1)
    expect(t.state.invoices).toBe(1)
  })
})

describe('payments that never left the wallet', () => {
  it('drops a purchase whose transfer failed before broadcast, so the next top-up goes ahead', async () => {
    const t = setup()
    let nonce = 0, broke = true
    const deps = {
      journalFile: t.journalFile, fetch: t.fetch, sleep: async () => {}, sentCount: async () => nonce,
      pay: async () => { t.state.pays++; if (broke) throw new Error('insufficient funds'); nonce++; return '0xpaid' },
    }
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow('insufficient funds')
    expect(JSON.parse(readFileSync(t.journalFile, 'utf8')).state).toBe('complete')
    broke = false
    t.state.status = 'paid'
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'paid', tx: '0xpaid' })
    expect(t.state.invoices).toBe(2)
  })
  it('recovers a journal a crash left at sending when the nonce shows nothing was sent', async () => {
    const t = setup()
    const stuck = { requestId: 'r1', usd: 3, state: 'sending', nonceBefore: 5, invoice: { id: 'invoice-old', status: 'awaiting_payment', amountAtomic: '123', addresses: ['0x00aa'], expiresAt: new Date(0).toISOString(), creditMicrousd: 3_000_000 } }
    writeFileSync(t.journalFile, JSON.stringify(stuck))
    let nonce = 5
    const deps = { journalFile: t.journalFile, fetch: t.fetch, sleep: async () => {}, sentCount: async () => nonce, pay: async () => { t.state.pays++; nonce++; t.state.status = 'paid'; return '0xfresh' } }
    await expect(buyCredit(t.key, 3, deps)).resolves.toMatchObject({ status: 'paid', tx: '0xfresh' })
    expect(t.state.invoices).toBe(1)
    expect(t.state.pays).toBe(1)
  })
  it('still refuses to pay again when the nonce moved (the lost transfer may land)', async () => {
    const t = setup()
    let nonce = 0
    const deps = { journalFile: t.journalFile, fetch: t.fetch, sleep: async () => {}, sentCount: async () => nonce, pay: async (): Promise<string> => { t.state.pays++; nonce++; throw new Error('connection lost after broadcast') } }
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow('connection lost')
    expect(JSON.parse(readFileSync(t.journalFile, 'utf8')).state).toBe('sending')
    await expect(buyCredit(t.key, 3, deps)).rejects.toThrow('outcome unknown')
    expect(t.state.pays).toBe(1)
  })
})
