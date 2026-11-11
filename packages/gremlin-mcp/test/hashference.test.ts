import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Wallet, verifyMessage } from 'quais'
import { Wallet as EvmWallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { balance, createQuaiInvoice, readKey, setupKey } from '../src/hashference.js'
import { hashferenceFetch } from '../src/gateway/providers.js'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway } from '../src/gateway/server.js'
import { createServer as createMcp } from '../src/server.js'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A fake Hashference: wallet sign-in (checks the signature and Origin), keys, account and QUAI invoices. */
function fakeHashference() {
  const seen: { path: string; origin?: string; auth?: string; body?: unknown }[] = []
  let challenge = { nonce: 'n1', message: 'Sign in to Hashference\nnonce: n1' }
  let address = ''
  const invoices = new Map<string, { status: string }>()
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const h = new Headers(init.headers)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ path: `${init.method ?? 'GET'} ${u.pathname}`, origin: h.get('origin') ?? undefined, auth: h.get('authorization') ?? undefined, body })
    if (u.pathname === '/v1/auth/wallet/challenge') { address = body.address; return json(200, { ...challenge, expiresAt: 'x' }) }
    if (u.pathname === '/v1/auth/wallet') {
      if (h.get('origin') !== 'https://hashference.com') return json(403, { error: { message: 'origin' } })
      if (verifyMessage(challenge.message, body.signature) !== address) return json(401, { error: { message: 'bad signature' } })
      return json(200, { profile: { id: 'p1', username: 'g' }, session: { token: 'sess', expiresAt: 'x' } })
    }
    if (u.pathname === '/v1/profile/api-keys') return h.get('authorization') === 'Bearer sess' ? json(201, { apiKey: { id: 'k1', apiKey: 'hf_secret' } }) : json(401, {})
    if (u.pathname === '/v1/account') return json(200, { account: { balance: { availableCredits: 2500, reservedCredits: 100, pendingCredits: 0 } } })
    if (u.pathname === '/v1/payments' && init.method === 'POST') {
      invoices.set('inv1', { status: 'awaiting_payment' })
      return json(201, { invoice: { id: 'inv1', status: 'awaiting_payment', amountAtomic: '1234500000000000000000', addresses: ['0x00aa00000000000000000000000000000000aaaa'], expiresAt: new Date(Date.now() + 300_000).toISOString(), creditMicrousd: body.creditMicrousd } })
    }
    if (u.pathname === '/v1/payments/inv1') return json(200, { invoice: { id: 'inv1', ...invoices.get('inv1'), amountAtomic: '1', addresses: ['x'], expiresAt: 'x', creditMicrousd: 1 } })
    return json(404, {})
  }) as typeof fetch
  return { f, seen, invoices, setChallenge: (c: typeof challenge) => (challenge = c) }
}

const quaiSigner = () => {
  // A cyprus1 address (0x00…): grind a random key until one lands there, as Quai HD wallets do by derivation.
  for (;;) { const w = new Wallet(EvmWallet.createRandom().privateKey); if (w.address.startsWith('0x00')) return { address: w.address, signMessage: (m: string) => w.signMessage(m) } }
}

describe('hashference client', () => {
  it('signs in with the gremlin\'s Quai wallet, makes a key, and stores it 0600; a second setup reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-'))
    const file = join(dir, 'hashference.json')
    const h = fakeHashference()
    const s = quaiSigner()
    const k = await setupKey(s, file, { fetch: h.f })
    expect(k.apiKey).toBe('hf_secret')
    expect(k.address).toBe(s.address)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(h.seen.every((x) => x.origin === 'https://hashference.com')).toBe(true)
    const n = h.seen.length
    expect((await setupKey(s, file, { fetch: h.f })).apiKey).toBe('hf_secret')
    expect(h.seen.length).toBe(n) // no new sign-in
  })

  it('refuses a non-cyprus1 address before calling out', async () => {
    const h = fakeHashference()
    await expect(setupKey({ address: '0x1100000000000000000000000000000000000000', signMessage: async () => '0x' }, join(mkdtempSync(join(tmpdir(), 'hf-')), 'k.json'), { fetch: h.f })).rejects.toThrow(/cyprus1/)
    expect(h.seen).toEqual([])
  })

  it('reads the balance in dollars and makes a QUAI invoice in micro-dollars', async () => {
    const h = fakeHashference()
    const key = { apiKey: 'hf_secret', address: '0x00', createdAt: '' }
    expect(await balance(key, { fetch: h.f })).toEqual({ availableUsd: 2.5, reservedUsd: 0.1, pendingUsd: 0 })
    const inv = await createQuaiInvoice(key, 5, { fetch: h.f })
    expect(inv.amountAtomic).toBe('1234500000000000000000')
    expect((h.seen.at(-1)!.body as { creditMicrousd: number; asset: string })).toMatchObject({ asset: 'QUAI', creditMicrousd: 5_000_000 })
    await expect(createQuaiInvoice(key, 0.5, { fetch: h.f })).rejects.toThrow(/\$1 to \$500/)
  })
})

describe('hashference provider', () => {
  it('answers 402 locally without a key, and sends the key and records the balance once there is one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-'))
    const keyFile = join(dir, 'hashference.json')
    const p = GatewayConfig.shape.providers.element.parse({ id: 'hashference', kind: 'hashference', baseUrl: 'https://hashference.com/v1', keyFile })
    const balances: { usd: number }[] = []
    const f = hashferenceFetch(p, (b) => balances.push(b))
    const none = await f('https://hashference.com/v1/chat/completions', { method: 'POST' })
    expect(none.status).toBe(402)
    writeFileSync(keyFile, JSON.stringify({ apiKey: 'hf_k', address: '0x00', createdAt: '' }))
    const realFetch = globalThis.fetch
    let auth = ''
    globalThis.fetch = (async (_u: string, init: RequestInit) => { auth = new Headers(init.headers).get('authorization') ?? ''; return json(200, {}, { 'x-hashference-balance-credits': '1750' }) }) as typeof fetch
    try { await f('https://hashference.com/v1/chat/completions', { method: 'POST' }) } finally { globalThis.fetch = realFetch }
    expect(auth).toBe('Bearer hf_k')
    expect(balances).toEqual([expect.objectContaining({ usd: 1.75 })])
    expect(readKey(keyFile)?.apiKey).toBe('hf_k')
  })
})

describe('free endpoints as the last resort', () => {
  let up: Server
  let gw: Server
  let base: string
  const hits: Record<string, number> = {}
  beforeAll(async () => {
    up = createServer((req, res) => {
      const id = req.url!.split('/')[1]!
      hits[id] = (hits[id] ?? 0) + 1
      req.resume()
      req.on('end', () => {
        if (id === 'unpaid') { res.statusCode = 402; return res.end('{"error":"payment required"}') }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `from ${id}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(up.address() as { port: number }).port}`
    gw = createGateway(GatewayConfig.parse({
      providers: [{ id: 'unpaid', kind: 'openai', baseUrl: `${u}/unpaid/v1` }, { id: 'free', kind: 'openai', baseUrl: `${u}/free/v1`, free: true, minIntervalMs: 300 }],
      routes: { 'gremlin-main': [{ provider: 'unpaid', model: 'big' }], 'gremlin-glean': [{ provider: 'free', model: 'small' }] },
    }))
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
  })
  afterAll(() => { gw.close(); up.close() })
  const chat = (content: string) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content }] }) })

  it('answers gremlin-main from a free endpoint when the paid providers want payment, waiting out its short interval', async () => {
    const a = await chat('hello')
    expect(a.status).toBe(200)
    expect((await a.json()).choices[0].message.content).toBe('from free')
    const started = Date.now()
    const b = await chat('again') // within the free provider's 300 ms interval: waited, not failed
    expect(b.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('never sends something that looks like a secret to a free endpoint', async () => {
    const before = hits.free ?? 0
    const r = await chat('my seed phrase is abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about, private key 0x' + 'ab'.repeat(32))
    expect(r.status).not.toBe(200)
    expect(hits.free ?? 0).toBe(before)
  })
})

describe('hashference tools', () => {
  it('top-up pays exactly the invoiced QUAI to the invoice address and reports the credit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
    process.env.GREMLIN_HOME = home
    writeFileSync(join(home, 'hashference.json'), JSON.stringify({ apiKey: 'hf_k', address: '0x00', createdAt: '' }), { mode: 0o600 })
    const h = fakeHashference()
    const paid: [string, bigint][] = []
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcp({ balances: { read: async () => ({}) }, hashference: { fetch: h.f, sleep: async () => { h.invoices.set('inv1', { status: 'paid' }) }, pay: async (to, amt) => { paid.push([to, amt]); return '0xtx' } } }).connect(a)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(b)
    const r = (await client.callTool({ name: 'hashference_topup', arguments: { usd: 5 } })) as { content: { text: string }[]; isError?: boolean }
    expect(r.isError).toBeFalsy()
    expect(paid).toEqual([['0x00aa00000000000000000000000000000000aaaa', 1234500000000000000000n]])
    expect(r.content[0]!.text).toContain('credited $5')
    const bal = (await client.callTool({ name: 'hashference_balance', arguments: {} })) as { content: { text: string }[] }
    expect(bal.content[0]!.text).toContain('$2.500 available')
    expect(JSON.stringify(await client.listTools())).not.toContain('hf_k')
  })
})

describe('size-capped targets', () => {
  it('skips a target whose size cap the request exceeds, without calling it, and uses the next', async () => {
    const seen: string[] = []
    const up = createServer((req, res) => {
      seen.push(req.url!.split('/')[1]!)
      req.resume()
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })) })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${(up.address() as { port: number }).port}`
    const gw = createGateway(GatewayConfig.parse({
      providers: [{ id: 'capped', kind: 'openai', baseUrl: `${u}/capped/v1` }, { id: 'roomy', kind: 'openai', baseUrl: `${u}/roomy/v1` }],
      routes: { 'gremlin-main': [{ provider: 'capped', model: 'small', maxRequestBytes: 2_000 }, { provider: 'roomy', model: 'big' }] },
      glean: { enabled: false },
    }))
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}/v1`
    const ask = (content: string) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content }] }) })
    try {
      expect((await ask('short')).status).toBe(200)
      expect((await ask('x'.repeat(5_000))).status).toBe(200)
      expect(seen).toEqual(['capped', 'roomy'])
    } finally { gw.close(); up.close() }
  })
})
