import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Wallet } from 'ethers'
import { WISHES_CLOSE, WISHES_OPEN, newGrantId, openaiCatalog, sealApiKey, verifyMessage, type GrantStatus, type KeyGrant, type Signed } from '@gremlins/hatch'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway } from '../src/gateway/server.js'
import { LentKeys, capCall, endUserId, remainingUsd, reportDisabled, type OpenGrant } from '../src/gateway/grants.js'
import { KeyLimiter, TokenBucket, retryAfterMs } from '../src/gateway/lent-limits.js'
import { allowance } from '../src/gateway/grant-policy.js'
import { registerLentTools } from '../src/tools/lent.js'

const T0 = Date.parse('2026-11-16T12:00:00Z')

describe('lent key limiter', () => {
  it('keeps to requests per minute and refills over time', () => {
    const clock = { t: T0 }
    const l = new KeyLimiter({ rpm: 2, concurrency: 5 }, () => clock.t)
    const a = l.admit(10), b = l.admit(10)
    expect('release' in a && 'release' in b).toBe(true)
    expect(l.admit(10)).toMatchObject({ skip: expect.stringContaining('requests/min') })
    clock.t += 30_000
    expect('release' in l.admit(10)).toBe(true)
  })

  it('keeps to tokens per minute and the concurrency cap, and releases slots', () => {
    const clock = { t: T0 }
    const l = new KeyLimiter({ rpm: 100, tpm: 1000, concurrency: 1 }, () => clock.t)
    const a = l.admit(600)
    if (!('release' in a)) throw new Error('no slot')
    expect(l.admit(10)).toMatchObject({ skip: expect.stringContaining('in flight') })
    a.release(900) // used more than estimated: the debt counts
    expect(l.admit(200)).toMatchObject({ skip: expect.stringContaining('tokens/min') })
    clock.t += 60_000
    expect('release' in l.admit(200)).toBe(true)
  })

  it('a token bucket lets an oversize request through only when full', () => {
    const b = new TokenBucket(100, 100, T0)
    expect(b.take(500, T0)).toBe(0)
    expect(b.take(1, T0 + 1000)).toBeGreaterThan(0)
  })

  it('honours Retry-After, backs off on repeats, and resets on success', () => {
    const clock = { t: T0 }
    const l = new KeyLimiter({ rpm: 100, concurrency: 5 }, () => clock.t)
    l.observe(429, new Headers({ 'retry-after': '120' }))
    expect(l.admit(1)).toMatchObject({ skip: expect.stringContaining('429') })
    clock.t += 119_000
    expect('skip' in l.admit(1)).toBe(true)
    clock.t += 2000
    expect('release' in l.admit(1)).toBe(true)
    l.observe(200, new Headers())
    // No Retry-After: exponential backoff, 10 s then 20 s.
    l.observe(429, new Headers())
    expect(l.blockedUntil - clock.t).toBe(10_000)
    clock.t += 10_000
    l.observe(503, new Headers())
    expect(l.blockedUntil - clock.t).toBe(20_000)
    l.observe(200, new Headers())
    clock.t += 20_000
    l.observe(429, new Headers())
    expect(l.blockedUntil - clock.t).toBe(10_000)
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500' }), T0)).toBe(1500)
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(T0 + 5000).toUTCString() }), T0)).toBe(5000)
  })

  it('stops for good on 401 and on a 403 about the key, but not on a 403 about content', () => {
    const l = new KeyLimiter({ rpm: 10, concurrency: 1 })
    expect(l.observe(403, new Headers(), 'Your input was flagged by moderation')).toBeUndefined()
    expect(l.disabled).toBeUndefined()
    expect(l.observe(401, new Headers(), 'invalid api key')).toBe('disabled')
    expect(l.observe(401, new Headers(), 'invalid api key')).toBeUndefined() // reported once
    expect(l.admit(1)).toMatchObject({ skip: expect.stringContaining('stopped for good') })
  })
})

describe('per-call cap and "what\'s left" rules', () => {
  const grant = { provider: { label: 'x', baseUrl: 'https://x.example/v1', models: ['m'], inputPerM: 1, outputPerM: 10, budgetApi: 'none' }, policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 10, rules: [{ withinHoursOfReset: 24, usePctOfBudget: 100 }], maxPerCallUsd: 0.01 } } as unknown as KeyGrant
  it('lowers max_tokens so the worst case fits maxPerCallUsd, and skips a prompt that cannot fit', () => {
    const r = capCall({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100_000 }, grant, 5)
    expect('body' in r && (r.body.max_tokens as number)).toBeLessThanOrEqual(1000)
    expect(capCall({ messages: [{ role: 'user', content: 'x'.repeat(80_000) }] }, grant, 5)).toMatchObject({ skip: expect.stringContaining('prompt alone') })
  })

  it('"50% of what\'s left within 6 hours of the reset" uses half of what was left, only near the reset, only when known', () => {
    const policy = { period: { every: 'day' as const, resetAt: '00:00' }, budgetUsd: 20, rules: [{ withinHoursOfReset: 6, usePctOfRemaining: 50 }] }
    const at = Date.parse('2026-11-16T20:00:00Z') // 4 h before the reset
    expect(allowance(policy, at, 0, 8).allowedUsd).toBeCloseTo(4)
    expect(allowance(policy, at, 3, 5).allowedUsd).toBeCloseTo(1) // half of (5 + 3) less the 3 used
    expect(allowance(policy, Date.parse('2026-11-16T12:00:00Z'), 0, 8).allowedUsd).toBe(0) // 12 h before: not yet
    expect(allowance(policy, at, 0, undefined).reason).toContain('has not said what is left')
  })
})

// ── through the gateway ────────────────────────────────────────────────────

const gremlin = Wallet.createRandom()
const lender = Wallet.createRandom()
let up: Server
let upUrl = ''
const seen: { url: string; auth: string; body: { messages: { role: string; content: string }[]; model: string; max_tokens?: number; user?: string } }[] = []
let lentAnswer: { status: number; headers?: Record<string, string>; body?: string } = { status: 200 }

beforeAll(async () => {
  up = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ url: String(req.url), auth: String(req.headers.authorization), body: JSON.parse(raw) })
      if (req.url!.startsWith('/lent') && lentAnswer.status !== 200) {
        res.writeHead(lentAnswer.status, { 'content-type': 'application/json', ...lentAnswer.headers })
        return res.end(lentAnswer.body ?? '{"error":{"message":"nope"}}')
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: `answered by ${req.url}` } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
  upUrl = `http://127.0.0.1:${(up.address() as { port: number }).port}`
})
afterAll(() => up.close())
beforeEach(() => { seen.length = 0; lentAnswer = { status: 200 } })

async function openGrant(over: Partial<KeyGrant> = {}): Promise<OpenGrant> {
  const grant: KeyGrant = {
    kind: 'key-grant', address: lender.address, gremlin: gremlin.address, grantId: newGrantId(),
    provider: { label: 'spare key', baseUrl: `${upUrl}/lent/v1`, models: ['lent-model'], inputPerM: 1, outputPerM: 1, budgetApi: 'none' },
    policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 5, rules: [{ withinHoursOfReset: 24, usePctOfBudget: 100 }] },
    repay: 'patron', wishes: { purposes: ['sell 10 haiku'], forbidden: 'no gambling sites', preferredModels: [], creditAs: 'Karl' },
    sealedKey: await sealApiKey(gremlin.signingKey.publicKey, 'sk-lent'), createdAt: new Date(T0).toISOString(), ...over,
  }
  return { grant, apiKey: 'sk-lent' }
}

async function gateway(keys: LentKeys, clock: { t: number }) {
  const cfg = GatewayConfig.parse({ providers: [{ id: 'own', kind: 'openai', baseUrl: `${upUrl}/own/v1` }], routes: { 'gremlin-main': [{ provider: 'own', model: 'own-model' }] }, glean: { enabled: false } })
  const gw = createGateway(cfg, { lent: () => keys.offers(), lentStatus: () => keys.status(), now: () => clock.t })
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
  const ask = async () => (await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'system', content: 'You are Grub.' }, { role: 'user', content: 'hi' }] }) })).json()) as { choices: { message: { content: string } }[] }
  return { gw, ask, base }
}

describe('lent keys in the gateway', () => {
  it('applies the maker policy to a donated provider and routes its draft through trusted review', async () => {
    const key = await openGrant({ provider: { id: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-haiku-5-5', 'claude-opus-5-5'], inputPerM: 1, outputPerM: 1, budgetApi: 'none' } })
    const keys = new LentKeys({ gremlin: gremlin.address, used: () => 0, now: () => T0 })
    keys.set([key])
    keys.setCatalog(key.grant.grantId, openaiCatalog('anthropic', { data: key.grant.provider.models.map(id => ({ id })) }))
    const cfg = GatewayConfig.parse({
      providers: [{ id: 'own', kind: 'openai', baseUrl: `${upUrl}/own/v1` }],
      routes: { 'gremlin-main': [{ provider: 'own', model: 'own-model' }] },
      policy: { primary: 'own/own-model', approved: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-5-5'] },
      glean: { enabled: false },
    })
    let pressure: 'low' | undefined
    const retired = vi.fn(async () => Response.json({ error: { message: 'model not found, sk-lent' } }, { status: 404 }))
    const gw = createGateway(cfg, {
      adminToken: 'dev-service-token', now: () => T0, health: () => ({ resourcePressure: pressure }), lentStatus: () => keys.status(),
      lent: () => keys.offers().map(offer => ({ ...offer, fetch: (url, init) => JSON.parse(String(init.body)).model === 'claude-sonnet-4-5'
        ? retired() : offer.fetch(`${upUrl}/lent${new URL(url).pathname}`, init) })),
    })
    await new Promise<void>(r => gw.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(gw.address() as { port: number }).port}`
    const ask = async () => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content: 'hi' }] }) })
      return r.json()
    }
    const mcp = new McpServer({ name: 'test', version: '0' })
    const client = new Client({ name: 'test', version: '0' })
    vi.stubEnv('GREMLIN_SERVICE_TOKEN', 'dev-service-token')
    try {
      registerLentTools(mcp, { adminUrl: base })
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      await mcp.connect(serverTransport)
      await client.connect(clientTransport)
      expect((await fetch(`${base}/admin/lent`)).status).toBe(401)
      expect((await ask()).choices[0].message.content).toContain('/own/v1')
      expect(keys.catalogDue(key.grant.grantId)).toBe(true)
      expect(seen.map(s => s.body.model)).toEqual(['claude-haiku-5-5', 'own-model'])
      expect(JSON.stringify(seen.at(-1)!.body)).toContain('untrusted_draft')
      expect(JSON.stringify(seen.at(-1)!.body)).not.toContain('sk-lent')
      expect((await ask()).choices[0].message.content).toContain('/own/v1')
      expect(retired).toHaveBeenCalledTimes(1)
      const status = await client.callTool({ name: 'lent_keys' })
      expect(status.isError).toBeFalsy()
      expect(JSON.stringify(status.content)).toContain('trusted reviewer accepted')
      expect(JSON.stringify(status.content)).not.toContain('sk-lent')

      pressure = 'low'
      seen.length = 0
      await ask()
      expect(seen.map(s => s.body.model)).toEqual(['own-model'])
      expect(JSON.stringify((await client.callTool({ name: 'lent_keys' })).content)).toContain('disk or memory pressure')
    } finally {
      vi.unstubAllEnvs()
      await client.close()
      await mcp.close()
      gw.close()
    }
  })

  it('reads Hashference donated credit from the provider account envelope', async () => {
    const key = await openGrant({ provider: { id: 'hashference', label: 'Hashference', baseUrl: 'https://hashference.com/v1', models: ['model'], inputPerM: 1, outputPerM: 1, budgetApi: 'hashference' } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ account: { balance: { availableCredits: 1871 } } }))
    await expect(remainingUsd(key, fetch)).resolves.toBe(1.871)
  })

  it('adds the lender\'s wishes, delimited, only to calls that use the lent key', async () => {
    const clock = { t: T0 }
    const keys = new LentKeys({ gremlin: gremlin.address, used: () => 0, now: () => clock.t })
    keys.set([await openGrant()])
    const { gw, ask } = await gateway(keys, clock)
    expect((await ask()).choices[0]!.message.content).toContain('/own/v1')
    const lentCall = seen.at(-2)!
    expect(JSON.stringify(seen.at(-1)!.body)).toContain('untrusted_draft')
    expect(JSON.stringify(seen.at(-1)!.body)).not.toContain(WISHES_OPEN)
    expect(lentCall.auth).toBe('Bearer sk-lent')
    const note = lentCall.body.messages[1]!
    expect(note.role).toBe('system')
    expect(note.content).toContain(WISHES_OPEN)
    expect(note.content).toContain('no gambling sites')
    expect(note.content.indexOf('no gambling sites')).toBeLessThan(note.content.indexOf(WISHES_CLOSE))
    expect(note.content).not.toContain('sk-lent')
    expect(lentCall.body.messages[0]!.content).toBe('You are Grub.') // the gremlin's own prompt stays first

    // The lent key fails over to the gremlin's own provider: that call carries no wishes.
    lentAnswer = { status: 500 }
    expect((await ask()).choices[0]!.message.content).toContain('/own/v1')
    const own = seen.at(-1)!
    expect(own.url).toContain('/own/v1')
    expect(JSON.stringify(own.body)).not.toContain(WISHES_OPEN)
    gw.close()
  })

  it('on 429 rests the key for Retry-After and does not call it again meanwhile', async () => {
    const clock = { t: T0 }
    const keys = new LentKeys({ gremlin: gremlin.address, used: () => 0, now: () => clock.t })
    keys.set([await openGrant()])
    const { gw, ask } = await gateway(keys, clock)
    lentAnswer = { status: 429, headers: { 'retry-after': '90' } }
    expect((await ask()).choices[0]!.message.content).toContain('/own/v1')
    lentAnswer = { status: 200 }
    const lentCalls = () => seen.filter((s) => s.url.startsWith('/lent')).length
    expect(lentCalls()).toBe(1)
    await ask(); await ask()
    expect(lentCalls()).toBe(1) // resting: never hammered
    expect(keys.status()[0]!.limiter.restingBecause).toContain('429')
    clock.t += 91_000
    expect((await ask()).choices[0]!.message.content).toContain('/own/v1')
    expect(lentCalls()).toBe(2)
    gw.close()
  })

  it('on 401 stops the key for good and tells the lender once, through the board, signed by the gremlin', async () => {
    const clock = { t: T0 }
    const reports: { grantId: string; status: number }[] = []
    const keys = new LentKeys({ gremlin: gremlin.address, used: () => 0, now: () => clock.t, onDisabled: (g, status) => reports.push({ grantId: g.grantId, status }) })
    const og = await openGrant()
    keys.set([og])
    const { gw, ask, base } = await gateway(keys, clock)
    lentAnswer = { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' }
    expect((await ask()).choices[0]!.message.content).toContain('/own/v1')
    lentAnswer = { status: 200 }
    clock.t += 24 * 3_600_000
    await ask()
    expect(seen.filter((s) => s.url.startsWith('/lent'))).toHaveLength(1)
    expect(reports).toEqual([{ grantId: og.grant.grantId, status: 401 }])
    expect(keys.offers()).toHaveLength(0)
    const st = (await (await fetch(`${base}/admin/lent`)).json()) as { grants: { limiter: { disabled: { status: number } } }[] }
    expect(st.grants[0]!.limiter.disabled.status).toBe(401)

    let posted: Signed<GrantStatus> | undefined
    const ok = await reportDisabled('http://board.test', gremlin, og.grant.grantId, 401, 'refused', (async (_u: unknown, init?: RequestInit) => { posted = JSON.parse(String(init!.body)); return new Response('{}', { status: 201 }) }) as typeof fetch)
    expect(ok).toBe(true)
    expect(posted!.message).toMatchObject({ kind: 'grant-status', address: gremlin.address, grantId: og.grant.grantId, status: 'disabled', httpStatus: 401 })
    expect(verifyMessage(posted!)).toBe(true)
    gw.close()
  })

  it('sends the provider\'s end-user id and attribution headers, never the gremlin\'s address', async () => {
    const keys = new LentKeys({ gremlin: gremlin.address, used: () => 0 })
    const og = await openGrant({ provider: { id: 'openrouter', label: 'or', baseUrl: 'https://openrouter.ai/api/v1', models: ['a/b'], inputPerM: 1, outputPerM: 1, budgetApi: 'openrouter' } })
    keys.set([og])
    const offer = keys.offerFor(og, { allowedUsd: 1, reason: '', reset: 0 })
    const p = offer.prepare!({ messages: [{ role: 'user', content: 'hi' }] })
    expect('body' in p && p.body.user).toBe(endUserId(gremlin.address))
    expect(endUserId(gremlin.address)).not.toContain(gremlin.address.slice(2, 12).toLowerCase())
    expect(keys.status()[0]!.limiter.limits).toEqual({ rpm: 30, tpm: undefined, rpd: undefined, concurrency: 2 })
  })
})
