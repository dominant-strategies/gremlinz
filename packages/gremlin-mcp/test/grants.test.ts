import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { newGrantId, sealApiKey, signMessage, type KeyGrant } from '@gremlins/hatch'
import { GatewayConfig } from '../src/gateway/config.js'
import { createGateway } from '../src/gateway/server.js'
import { Ledger } from '../src/gateway/ledger.js'
import { allowance, fetchGrants, lentOffers, period } from '../src/gateway/grants.js'

const gremlin = Wallet.createRandom()
const lender = Wallet.createRandom()
let board: Server
let up: Server
let boardUrl: string
let upUrl: string
const keysSeen: string[] = []
const bodiesSeen: Record<string, unknown>[] = []

beforeAll(async () => {
  up = createServer((req, res) => {
    keysSeen.push(String(req.headers.authorization))
    let raw = ''
    req.on('data', (part) => { raw += part })
    req.on('end', () => {
      const body = JSON.parse(raw)
      bodiesSeen.push(body)
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream')
        return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `answered by ${req.url}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: `answered by ${req.url}` } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }))
    })
  })
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
  upUrl = `http://127.0.0.1:${(up.address() as { port: number }).port}`

  const mk = async (to: { address: string; signingKey: { publicKey: string } }, model: string) => signMessage(lender, {
    kind: 'key-grant', address: lender.address, gremlin: to.address, grantId: newGrantId(),
    provider: { label: 'spare key', baseUrl: `${upUrl}/lent/v1`, models: [model], inputPerM: 2, outputPerM: 2, budgetApi: 'none' },
    policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 5, rules: [{ withinHoursOfReset: 24, usePctOfBudget: 100 }] },
    repay: 'patron', sealedKey: await sealApiKey(to.signingKey.publicKey, 'sk-lent-123'), createdAt: new Date().toISOString(),
  } as KeyGrant)
  const grants = [await mk(gremlin, 'lent-model'), await mk(Wallet.createRandom(), 'someone-elses')]
  board = createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ grants })) })
  await new Promise<void>((r) => board.listen(0, '127.0.0.1', r))
  boardUrl = `http://127.0.0.1:${(board.address() as { port: number }).port}`
})
afterAll(() => { board.close(); up.close() })

describe('lent keys in the gateway', () => {
  it('opens only grants made out to this gremlin, verifying the lender', async () => {
    const gs = await fetchGrants(boardUrl, gremlin)
    expect(gs).toHaveLength(1)
    expect(gs[0]!.apiKey).toBe('sk-lent-123')
  })

  it('uses lent inference as a draft and charges review to the gremlin separately', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grants-'))
    const ledger = new Ledger(join(home, 'ledger.jsonl'))
    const gs = await fetchGrants(boardUrl, gremlin)
    const lent = () => lentOffers(gs.map((g) => ({ g, allow: allowance(g.grant.policy, Date.now(), ledger.grantUsed(g.grant.grantId, period(g.grant.policy.period, Date.now()).start)) })))
    const cfg = GatewayConfig.parse({ providers: [{ id: 'own', kind: 'openai', baseUrl: `${upUrl}/own/v1` }], routes: { 'gremlin-main': [{ provider: 'own', model: 'own-model', inputPerM: 1, outputPerM: 1 }] }, glean: { enabled: false }, budget: { dailyUsd: 3.5 } })
    const gw = createGateway(cfg, { lent, onCall: (r, t) => ledger.record(r, t), refuse: () => ledger.refuse(cfg.budget?.dailyUsd) })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const ask = () => fetch(`http://127.0.0.1:${(gw.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content: 'hi' }] }) })

    const r1 = await (await ask()).json()
    expect(r1.choices[0].message.content).toContain('/own/v1')
    expect(keysSeen.at(-2)).toBe('Bearer sk-lent-123')
    expect(JSON.stringify(bodiesSeen.at(-1))).toContain('untrusted_draft')
    expect(JSON.stringify(bodiesSeen.at(-1))).toContain('answered by /lent/v1')
    expect(ledger.grantUsed(gs[0]!.grant.grantId)).toBeCloseTo(2) // 1M input tokens at the lender's $2/M
    expect(ledger.spent()).toBe(1) // only the review uses its own money

    // The allowance is checked before each call and a call's cost is only known after it, so the last lent call can
    // overshoot by one call's cost ($6 used of $5 here). Lenders should use a sub-key with a hard provider-side limit.
    await ask()
    const r3 = await (await ask()).json()
    expect(r3.choices[0].message.content).toContain('/own/v1')
    const r4 = await ask()
    expect((await r4.json()).choices[0].message.content).toContain('/own/v1') // lender allowance used up
    expect(JSON.stringify(bodiesSeen.at(-1))).not.toContain('untrusted_draft')
    expect(ledger.spent()).toBeCloseTo(4)
    expect((await ask()).status).toBe(429)
    gw.close()
  })

  it('streams only the reviewer output and skips lending for secret-shaped input', async () => {
    const gs = await fetchGrants(boardUrl, gremlin)
    const lent = () => lentOffers(gs.map(g => ({ g, allow: allowance(g.grant.policy, Date.now(), 0) })))
    const cfg = GatewayConfig.parse({
      providers: [{ id: 'own', kind: 'openai', baseUrl: `${upUrl}/own/v1` }],
      routes: { 'gremlin-main': [{ provider: 'own', model: 'own-model' }] },
      glean: { enabled: false },
    })
    const gw = createGateway(cfg, { lent })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    const ask = (content: string) => fetch(`http://127.0.0.1:${(gw.address() as { port: number }).port}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'gremlin-main', stream: true, messages: [{ role: 'user', content }] }),
    }).then(r => r.text())
    try {
      const first = await ask('Share a short greeting.')
      expect(first).toContain('answered by /own/v1')
      expect(first).not.toContain('answered by /lent/v1')
      expect(bodiesSeen.at(-2)?.stream).toBe(false)
      expect(bodiesSeen.at(-1)?.stream).toBe(true)
      expect(JSON.stringify(bodiesSeen.at(-1))).toContain('untrusted_draft')
      const count = bodiesSeen.length
      await ask('My API key is sk-1234567890abcdefghijk.')
      expect(bodiesSeen).toHaveLength(count + 1)
      expect(JSON.stringify(bodiesSeen.at(-1))).not.toContain('untrusted_draft')
    } finally { gw.close() }
  })

  it('uses an independent fallback when the reviewer fails, keeping the draft out of that fallback', async () => {
    const gs = await fetchGrants(boardUrl, gremlin)
    const lent = () => lentOffers(gs.map(g => ({ g, allow: allowance(g.grant.policy, Date.now(), 0) })))
    const cfg = GatewayConfig.parse({
      providers: [
        { id: 'own', kind: 'openai', baseUrl: `${upUrl}/own/v1` },
        { id: 'free', kind: 'openai', baseUrl: `${upUrl}/free/v1`, free: true },
      ],
      routes: { 'gremlin-main': [{ provider: 'own', model: 'own-model' }], 'gremlin-glean': [{ provider: 'free', model: 'free-model' }] },
      glean: { enabled: false },
    })
    const gw = createGateway(cfg, {
      lent,
      fetchers: { own: async (_url, init) => {
        bodiesSeen.push(JSON.parse(String(init.body)))
        return new Response('{}', { status: 503 })
      } },
    })
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r))
    try {
      const response = await fetch(`http://127.0.0.1:${(gw.address() as { port: number }).port}/v1/chat/completions`, {
        method: 'POST', body: JSON.stringify({ model: 'gremlin-main', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'answered by /free/v1/chat/completions' } }] })
      expect(JSON.stringify(bodiesSeen.at(-2))).toContain('untrusted_draft')
      expect(bodiesSeen.at(-1)?.messages).toEqual([{ role: 'user', content: 'hi' }])
    } finally { gw.close() }
  })
})
