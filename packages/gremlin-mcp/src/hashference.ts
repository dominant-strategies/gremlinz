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

export function readKey(file: string): HashferenceKey | undefined {
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as HashferenceKey
    return typeof k.apiKey === 'string' && k.apiKey.startsWith('hf_') ? k : undefined
  } catch { return undefined }
}

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
    throw new Error(`Hashference ${method} ${path} ${res.status}: ${typeof msg === 'string' ? msg : msg?.message ?? text.slice(0, 200)}`)
  }
  return json as T
}

/**
 * Sign in with the gremlin's Quai wallet and create an API key; stores it in `file`. Signing in again with the same
 * address returns the same workspace, so a lost key file only costs a new key, never the balance.
 */
export async function setupKey(signer: QuaiSigner, file: string, opts: { fetch?: Fetch; base?: string; label?: string; now?: () => Date } = {}): Promise<HashferenceKey> {
  const existing = readKey(file)
  if (existing) return existing
  if (!/^0x00[0-9a-fA-F]{38}$/.test(signer.address)) throw new Error(`Hashference needs a cyprus1 Quai address (0x00…), not ${signer.address}`)
  const f = opts.fetch ?? fetch
  const ch = await call<{ nonce: string; message: string }>(f, 'POST', '/v1/auth/wallet/challenge', { body: { address: signer.address }, base: opts.base })
  // The message proves who we are; it can never authorize a transfer.
  const signature = await signer.signMessage(ch.message)
  const { session, profile } = await call<{ session: { token: string }; profile?: { id?: string } }>(f, 'POST', '/v1/auth/wallet', { body: { nonce: ch.nonce, signature }, base: opts.base })
  const { apiKey } = await call<{ apiKey: { apiKey: string } }>(f, 'POST', '/v1/profile/api-keys', { body: { label: opts.label ?? 'gremlin' }, auth: session.token, base: opts.base })
  if (!apiKey?.apiKey?.startsWith('hf_')) throw new Error('Hashference returned no API key')
  const k: HashferenceKey = { apiKey: apiKey.apiKey, address: signer.address, profileId: profile?.id, createdAt: (opts.now?.() ?? new Date()).toISOString() }
  writeJsonDurable(file, k)
  return k
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
  status: 'awaiting_payment' | 'confirming' | 'paid' | 'review'
  /** QUAI in wei, exact: send precisely this. */
  amountAtomic: string
  addresses: string[]
  expiresAt: string
  creditMicrousd: number
}

/** A QUAI invoice for `usd` of credit ($1 to $500). Pay exactly amountAtomic to addresses[0] before expiresAt (~5 min). */
export async function createQuaiInvoice(key: HashferenceKey, usd: number, opts: { fetch?: Fetch; base?: string; requestId?: string } = {}): Promise<Invoice> {
  if (!(usd >= 1 && usd <= 500)) throw new Error('Hashference QUAI invoices are $1 to $500')
  const r = await call<{ invoice: Invoice }>(opts.fetch ?? fetch, 'POST', '/v1/payments', {
    body: { asset: 'QUAI', creditMicrousd: Math.round(usd * 1_000_000), requestId: opts.requestId ?? randomUUID() }, auth: key.apiKey, base: opts.base,
  })
  const inv = r.invoice
  if (!inv?.id || !/^\d+$/.test(inv.amountAtomic ?? '') || !inv.addresses?.[0]) throw new Error('Hashference returned an unusable invoice')
  return inv
}

export async function invoice(key: HashferenceKey, id: string, opts: { fetch?: Fetch; base?: string } = {}): Promise<Invoice> {
  return (await call<{ invoice: Invoice }>(opts.fetch ?? fetch, 'GET', `/v1/payments/${encodeURIComponent(id)}`, { auth: key.apiKey, base: opts.base })).invoice
}

/** After paying by hand (or if the invoice didn't notice), point Hashference at the transaction. */
export async function verifyPayment(key: HashferenceKey, id: string, tx: string, opts: { fetch?: Fetch; base?: string } = {}): Promise<Invoice> {
  return (await call<{ invoice: Invoice }>(opts.fetch ?? fetch, 'POST', `/v1/payments/${encodeURIComponent(id)}/verify`, { body: { transaction: tx }, auth: key.apiKey, base: opts.base })).invoice
}

export const hasKey = (file: string) => existsSync(file) && !!readKey(file)

export interface BuyDeps {
  fetch?: Fetch
  base?: string
  /** Pays `amountWei` QUAI to `to`; returns the transaction hash. */
  pay: (to: string, amountWei: bigint) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Shared by the monitor and manual top-ups; records intent before any transfer. */
  journalFile?: string
}

export interface Purchase { invoiceId: string; tx: string; quaiWei: bigint; status: Invoice['status']; usd?: number; recovered?: boolean }
interface PurchaseJournal { requestId: string; usd: number; state: 'creating' | 'prepared' | 'sending' | 'sent' | 'complete'; invoice?: Invoice; tx?: string }

/**
 * Buy `usd` of credit: invoice, pay exactly the quoted QUAI, then poll for a few minutes (and point Hashference at the
 * transaction if it hasn't noticed). A transfer error may have happened after broadcast; the journal preserves that
 * uncertainty and refuses to pay again until the provider confirms the original invoice.
 */
export async function buyCredit(key: HashferenceKey, usd: number, deps: BuyDeps): Promise<Purchase> {
  if (deps.journalFile) return withFileLock(deps.journalFile + '.lock', () => purchase(key, usd, deps))
  return purchase(key, usd, deps)
}

async function purchase(key: HashferenceKey, usd: number, deps: BuyDeps): Promise<Purchase> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const opts = { fetch: deps.fetch, base: deps.base }
  let journal: PurchaseJournal | undefined
  if (deps.journalFile && existsSync(deps.journalFile)) journal = JSON.parse(readFileSync(deps.journalFile, 'utf8')) as PurchaseJournal
  const recovered = !!journal && journal.state !== 'complete'
  if (!recovered) journal = { requestId: randomUUID(), usd, state: 'creating' }
  const j = journal!
  const save = () => { if (deps.journalFile) writeJsonDurable(deps.journalFile, j) }
  save()
  if (!j.invoice) { j.invoice = await createQuaiInvoice(key, j.usd, { ...opts, requestId: j.requestId }); j.state = 'prepared'; save() }
  const inv = j.invoice
  const amount = BigInt(inv.amountAtomic)
  if (j.state === 'sending' && !j.tx) {
    const remote = await invoice(key, inv.id, opts)
    if (remote.status !== 'paid') throw new Error(`Payment outcome unknown for invoice ${inv.id}; refusing another transfer until reconciled`)
    j.state = 'complete'; save()
    return { invoiceId: inv.id, tx: 'unknown (provider confirmed payment)', quaiWei: amount, status: 'paid', usd: j.usd, recovered: true }
  }
  if (j.state === 'prepared') {
    if (Date.parse(inv.expiresAt) - (deps.now ?? Date.now)() < 30_000) {
      j.state = 'complete'; save()
      throw new Error('the invoice expires too soon to pay safely; try again')
    }
    j.state = 'sending'; save()
    j.tx = await deps.pay(inv.addresses[0]!, amount)
    j.state = 'sent'; save()
  }
  const tx = j.tx!
  let status = inv.status
  for (let i = 0; i < 18 && status !== 'paid'; i++) {
    await sleep(10_000)
    try { status = (await invoice(key, inv.id, opts)).status } catch { /* keep polling */ }
  }
  if (status === 'awaiting_payment') { try { status = (await verifyPayment(key, inv.id, tx, opts)).status } catch { /* reported by status */ } }
  if (status === 'paid') { j.state = 'complete'; save() }
  return { invoiceId: inv.id, tx, quaiWei: amount, status, ...(deps.journalFile ? { usd: j.usd, recovered } : {}) }
}
