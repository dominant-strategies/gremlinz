/**
 * Hashference (https://hashference.com): an OpenAI-compatible inference service a gremlin can use with no person
 * involved. It signs in with its own Quai wallet (cyprus1 address, EIP-191 message), creates an API key, and buys
 * credits with a QUAI invoice paid from its own wallet. Docs: https://hashference.com/docs/agents.md and
 * https://hashference.com/openapi.json.
 *
 * The key lives in GREMLIN_HOME/hashference.json (0600). The gateway reads it on every call, so a key created mid-life
 * is used at once; nothing here ever returns the key to the agent.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { withFileLock, writeJsonDurable } from '@gremlins/hatch/node'

export const HASHFERENCE = 'https://hashference.com'
/** Featured hosted model with function tools: $0.441 in / $1.386 out per million tokens (llms.txt, 2026-11). */
export const HASHFERENCE_MAIN_MODEL = 'hashference-glm-5-3'
/** 1,000 credits = $1. */
export const CREDITS_PER_USD = 1000

export interface HashferenceKey { apiKey: string; address: string; profileId?: string; createdAt: string }
export interface QuaiSigner { address: string; signMessage(message: string): Promise<string> }

type Fetch = typeof fetch
export class HashferenceError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function readKey(file: string): HashferenceKey | undefined {
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as HashferenceKey
    return typeof k.apiKey === 'string' && k.apiKey.startsWith('hf_') ? k : undefined
  } catch { return undefined }
}

// The live usage API emits res_ IDs. Keep accepting previously supported IDs for existing ledger rows.
export const isHashferenceReservation = (id: unknown): id is string =>
  typeof id === 'string' && /^(?:res|rxs)_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)

async function call<T>(f: Fetch, method: string, path: string, opts: { body?: unknown; auth?: string; base?: string } = {}): Promise<T> {
  const base = opts.base ?? HASHFERENCE
  const res = await f(base + path, {
    method,
    // Wallet sign-in insists on the site's own Origin.
    headers: { origin: base, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json: unknown
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 200) } }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } | string })?.error
    throw new HashferenceError(res.status, `Hashference ${method} ${path} ${res.status}: ${typeof msg === 'string' ? msg : msg?.message ?? text.slice(0, 200)}`)
  }
  return json as T
}

/** Use only matched, settled receipts. Recent usage may lag completion and may include calls by other clients. */
export async function settledHashferenceUsage(key: HashferenceKey, get: Fetch = fetch): Promise<{ id: string; costMicrousd: number }[]> {
  const r = await call<{ recent?: unknown }>(get, 'GET', '/v1/usage?days=7&limit=100', { auth: key.apiKey })
  if (!Array.isArray(r?.recent)) return []
  return r.recent.flatMap(row => {
    if (!row || row.status !== 'settled' || !isHashferenceReservation(row.id) || !Number.isSafeInteger(row.costMicrousd) || row.costMicrousd < 0) return []
    return [{ id: row.id, costMicrousd: row.costMicrousd }]
  })
}

/**
 * Sign in with the gremlin's Quai wallet and create an API key; stores it in `file`. Signing in again with the same
 * address returns the same workspace, so a lost key file only costs a new key, never the balance.
 */
export async function setupKey(signer: QuaiSigner, file: string, opts: { fetch?: Fetch; base?: string; label?: string; now?: () => Date; repair?: boolean } = {}): Promise<HashferenceKey> {
  return withFileLock(`${file}.key.lock`, async () => {
    const existing = readKey(file)
    if (existing) {
      if (!opts.repair) return existing
      if (existing.address.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Hashference key belongs to a different wallet')
      try { await account(existing, opts); return existing }
      catch (e) {
        // Only invalid authentication justifies replacement. Rate limits, empty credit, permission denial and outages do not.
        if (!(e instanceof HashferenceError) || e.status !== 401) throw e
      }
    }
    if (!/^0x00[0-9a-fA-F]{38}$/.test(signer.address)) throw new Error(`Hashference needs a cyprus1 Quai address (0x00…), not ${signer.address}`)
    const f = opts.fetch ?? fetch
    const ch = await call<{ nonce: string; message: string }>(f, 'POST', '/v1/auth/wallet/challenge', { body: { address: signer.address }, base: opts.base })
    // The message proves who we are; it can never authorize a transfer.
    const signature = await signer.signMessage(ch.message)
    const { session, profile } = await call<{ session: { token: string }; profile?: { id?: string } }>(f, 'POST', '/v1/auth/wallet', { body: { nonce: ch.nonce, signature }, base: opts.base })
    const { apiKey } = await call<{ apiKey: { apiKey: string } }>(f, 'POST', '/v1/profile/api-keys', { body: { label: opts.label ?? 'gremlin' }, auth: session.token, base: opts.base })
    if (!apiKey?.apiKey?.startsWith('hf_')) throw new Error('Hashference returned no API key')
    const k: HashferenceKey = { apiKey: apiKey.apiKey, address: signer.address, profileId: profile?.id, createdAt: (opts.now?.() ?? new Date()).toISOString() }
    await account(k, opts) // Validate before atomically replacing the only working local credential.
    writeJsonDurable(file, k)
    return k
  })
}

export interface HashferenceBalance { availableUsd: number; reservedUsd: number; pendingUsd: number }
export interface HashferenceAccount extends HashferenceBalance {
  /** Pool login for mining credit to this account (stratum user is `<miningUsername>.<worker>`). */
  miningUsername?: string
}

export async function account(key: HashferenceKey, opts: { fetch?: Fetch; base?: string } = {}): Promise<HashferenceAccount> {
  const r = await call<{ account: { miningUsername?: string; balance: { availableCredits: number; reservedCredits: number; pendingCredits: number } } }>(opts.fetch ?? fetch, 'GET', '/v1/account', { auth: key.apiKey, base: opts.base })
  const b = r.account.balance
  return {
    availableUsd: b.availableCredits / CREDITS_PER_USD, reservedUsd: b.reservedCredits / CREDITS_PER_USD, pendingUsd: b.pendingCredits / CREDITS_PER_USD,
    ...(typeof r.account.miningUsername === 'string' && r.account.miningUsername ? { miningUsername: r.account.miningUsername } : {}),
  }
}

export async function balance(key: HashferenceKey, opts: { fetch?: Fetch; base?: string } = {}): Promise<HashferenceBalance> {
  const { availableUsd, reservedUsd, pendingUsd } = await account(key, opts)
  return { availableUsd, reservedUsd, pendingUsd }
}

export interface Invoice {
  id: string
  status: 'awaiting_payment' | 'expired' | 'confirming' | 'paid' | 'review'
  /** QUAI in wei, exact: send precisely this. */
  amountAtomic: string
  addresses: string[]
  expiresAt: string
  creditMicrousd: number
  quoteExpired?: boolean
  canPay?: boolean
  paymentObserved?: boolean
  serverTime?: string
}

function paymentInvoice(response: { invoice: Invoice; serverTime?: string }): Invoice {
  return { ...response.invoice, serverTime: response.invoice?.serverTime ?? response.serverTime }
}

/** A QUAI invoice for `usd` of credit ($1 to $500). Pay exactly amountAtomic to addresses[0] before expiresAt (~5 min). */
export async function createQuaiInvoice(key: HashferenceKey, usd: number, opts: { fetch?: Fetch; base?: string; requestId?: string } = {}): Promise<Invoice> {
  if (!(usd >= 1 && usd <= 500)) throw new Error('Hashference QUAI invoices are $1 to $500')
  const r = await call<{ invoice: Invoice; serverTime?: string }>(opts.fetch ?? fetch, 'POST', '/v1/payments', {
    body: { asset: 'QUAI', creditMicrousd: Math.round(usd * 1_000_000), requestId: opts.requestId ?? randomUUID() }, auth: key.apiKey, base: opts.base,
  })
  const inv = r.invoice
  if (!inv?.id || !/^\d+$/.test(inv.amountAtomic ?? '') || !inv.addresses?.[0]) throw new Error('Hashference returned an unusable invoice')
  return paymentInvoice(r)
}

export async function invoice(key: HashferenceKey, id: string, opts: { fetch?: Fetch; base?: string } = {}): Promise<Invoice> {
  const r = await call<{ invoice: Invoice; serverTime?: string }>(opts.fetch ?? fetch, 'GET', `/v1/payments/${encodeURIComponent(id)}`, { auth: key.apiKey, base: opts.base })
  return paymentInvoice(r)
}

/** After paying by hand (or if the invoice didn't notice), point Hashference at the transaction. */
export async function verifyPayment(key: HashferenceKey, id: string, tx: string, opts: { fetch?: Fetch; base?: string } = {}): Promise<Invoice> {
  return (await call<{ invoice: Invoice }>(opts.fetch ?? fetch, 'POST', `/v1/payments/${encodeURIComponent(id)}/verify`, { body: { transaction: tx }, auth: key.apiKey, base: opts.base })).invoice
}

export const hasKey = (file: string) => existsSync(file) && !!readKey(file)

export interface PreparedPayment {
  tx: string
  nonce: number
  broadcast(): Promise<void>
}

type InvoiceDeps = {
  fetch?: Fetch
  base?: string
  now?: () => number
  /** Shared by the monitor and manual top-ups; records intent before any transfer. */
  journalFile?: string
}
export type BuyDeps = InvoiceDeps & { sleep?: (ms: number) => Promise<void> } & (
  | { preparePayment: (to: string, amountWei: bigint) => Promise<PreparedPayment>; pay?: never }
  | { pay: (to: string, amountWei: bigint) => Promise<string>; preparePayment?: never }
)

export interface Purchase { invoiceId: string; tx: string; quaiWei: bigint; status: Invoice['status']; usd?: number; recovered?: boolean }
interface PurchaseJournal {
  requestId: string
  usd: number
  state: 'creating' | 'prepared' | 'sending' | 'sent' | 'complete' | 'expired-unpaid'
  invoice?: Invoice
  tx?: string
  nonce?: number
  review?: { reason: string; recheckAt: number }
}

const REVIEW_INTERVAL_MS = 15 * 60_000
const PAYMENT_MARGIN_MS = 30_000

export class HashferencePaymentReview extends Error {
  constructor(public invoiceId: string, reason: string) {
    super(`Hashference invoice ${invoiceId}: ${reason}`)
  }
}

/**
 * Buy `usd` of credit: invoice, pay exactly the quoted QUAI, then poll for a few minutes (and point Hashference at the
 * transaction if it hasn't noticed). A transfer error may have happened after broadcast. Only a journal still
 * in the pre-broadcast state may replace an expired quote. An unchanged wallet nonce cannot clear an uncertain send.
 */
export async function buyCredit(key: HashferenceKey, usd: number, deps: BuyDeps): Promise<Purchase> {
  if (deps.journalFile) return withFileLock(deps.journalFile + '.lock', () => purchase(key, usd, deps))
  return purchase(key, usd, deps)
}

/** Recheck an in-flight payment even when current policy authorizes no new spending. */
export async function reconcileCredit(key: HashferenceKey, deps: InvoiceDeps & { journalFile: string }): Promise<Purchase | undefined> {
  return withFileLock(deps.journalFile + '.lock', () => purchase(key, undefined, deps))
}

function purchase(key: HashferenceKey, usd: number, deps: BuyDeps, refreshed?: boolean): Promise<Purchase>
function purchase(key: HashferenceKey, usd: undefined, deps: InvoiceDeps): Promise<Purchase | undefined>
async function purchase(key: HashferenceKey, usd: number | undefined, deps: InvoiceDeps | BuyDeps, refreshed = false): Promise<Purchase | undefined> {
  const now = deps.now ?? Date.now
  const opts = { fetch: deps.fetch, base: deps.base }
  let journal: PurchaseJournal | undefined
  if (deps.journalFile && existsSync(deps.journalFile)) journal = JSON.parse(readFileSync(deps.journalFile, 'utf8')) as PurchaseJournal
  const payment = usd === undefined ? undefined : deps as BuyDeps
  if (!payment && journal?.state !== 'sending' && journal?.state !== 'sent') return
  if (!journal || journal.state === 'complete' || journal.state === 'expired-unpaid') {
    if (usd === undefined) return
    journal = { requestId: randomUUID(), usd, state: 'creating' }
  }
  const j = journal
  const save = () => { if (deps.journalFile) writeJsonDurable(deps.journalFile, j) }
  const hasSavedInvoice = !!j.invoice
  if (!j.invoice) {
    if (!payment || j.state !== 'creating') throw new Error('Hashference payment journal is missing its invoice')
    save(); j.invoice = await createQuaiInvoice(key, j.usd, { ...opts, requestId: j.requestId }); j.state = 'prepared'; save()
  }
  const inv = j.invoice
  const amount = BigInt(inv.amountAtomic)
  const review = (reason: string): never => {
    j.review = { reason, recheckAt: now() + REVIEW_INTERVAL_MS }
    save()
    throw new HashferencePaymentReview(inv.id, reason)
  }
  const result = (status: Invoice['status'], resumed: boolean): Purchase => {
    if (status === 'paid') { j.state = 'complete'; delete j.review; save() }
    return { invoiceId: inv.id, tx: j.tx ?? 'unknown (provider confirmed payment)', quaiWei: amount, status, ...(deps.journalFile ? { usd: j.usd, recovered: resumed } : {}) }
  }
  if (j.review && now() < j.review.recheckAt) throw new HashferencePaymentReview(inv.id, j.review.reason)
  if (j.state === 'prepared' && payment && usd !== undefined) {
    const quote = hasSavedInvoice ? await invoice(key, inv.id, opts) : inv
    if (quote.status === 'paid') return result('paid', true)
    const serverTime = Date.parse(quote.serverTime ?? '')
    const expiresAt = Date.parse(inv.expiresAt) - (Number.isFinite(serverTime) ? serverTime - now() : 0)
    const expiresSoon = () => expiresAt - now() < PAYMENT_MARGIN_MS
    const replaceQuote = () => {
      // No broadcast was called from this journal. A fresh request ID is required for a fresh quote.
      j.state = 'expired-unpaid'; delete j.review; save()
      if (refreshed) throw new Error('Hashference returned a quote too close to expiry to pay safely')
      return purchase(key, Math.min(usd, j.usd), payment, true)
    }
    if (quote.paymentObserved || quote.status === 'confirming' || quote.status === 'review') {
      j.state = 'sending'
      return review(`payment status is ${quote.status}; check the wallet and invoice before any further transfer`)
    }
    if (quote.status !== 'awaiting_payment' && quote.status !== 'expired')
      return review(`payment status is ${quote.status}; check the wallet and invoice before any further transfer`)
    if (!Number.isFinite(expiresAt)) return review('the quote has no valid expiry; check the invoice before paying')
    if (quote.status === 'expired' || quote.quoteExpired || expiresSoon()) return replaceQuote()
    if (quote.canPay === false) return review('the invoice is closed to payment; check its status before any transfer')
    if (j.usd > usd) {
      j.state = 'complete'; save()
      return purchase(key, usd, payment, true)
    }

    const prepared = await payment.preparePayment?.(inv.addresses[0]!, amount)
    if (expiresSoon()) return replaceQuote()
    if (prepared) { j.tx = prepared.tx; j.nonce = prepared.nonce }
    j.state = 'sending'; delete j.review; save()
    try {
      if (prepared) await prepared.broadcast()
      else j.tx = await payment.pay!(inv.addresses[0]!, amount)
    } catch {
      return review('broadcast outcome unknown; reconcile the original payment before any further transfer')
    }
    j.state = 'sent'; save()
    const sleep = payment.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let status: Invoice['status'] = 'awaiting_payment'
    for (let i = 0; i < 18 && (status === 'awaiting_payment' || status === 'confirming'); i++) {
      await sleep(10_000)
      try { status = (await invoice(key, inv.id, opts)).status } catch { /* keep polling */ }
    }
    if (status === 'awaiting_payment' || status === 'expired') {
      try { status = (await verifyPayment(key, inv.id, j.tx!, opts)).status } catch { /* hold for recovery */ }
    }
    if (status === 'paid' || status === 'confirming' || status === 'awaiting_payment') return result(status, false)
    return review(`payment status is ${status}; reconcile the original transaction before any further transfer`)
  }

  // Restart or ambiguous send. Query only the original invoice and verify only the original hash.
  const reason = j.review?.reason ?? 'payment outcome unknown; check pending and confirmed wallet transactions before any further transfer'
  let status: Invoice['status']
  try {
    status = (await invoice(key, inv.id, opts)).status
    if (j.tx && (status === 'awaiting_payment' || status === 'expired')) status = (await verifyPayment(key, inv.id, j.tx, opts)).status
  } catch {
    return review(reason)
  }
  if (status === 'paid' || (status === 'confirming' && j.tx)) return result(status, true)
  return review(status === 'review' ? 'provider needs manual review; contact Hashference with the original payment evidence' : reason)
}
