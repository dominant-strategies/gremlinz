import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Wallet, verifyMessage } from 'ethers'
import { veniceFetch } from '../src/gateway/venice.js'

let up: Server
let base: string
let seen: Record<string, string | undefined> = {}

beforeAll(async () => {
  up = createServer((req, res) => {
    seen = { siwx: req.headers['x-sign-in-with-x'] as string | undefined, auth: req.headers.authorization }
    res.setHeader('x-balance-remaining', '4.25')
    res.end('{}')
  })
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(up.address() as { port: number }).port}/api/v1`
})
afterAll(() => up.close())

describe('venice provider', () => {
  it('signs every request with the gremlin wallet (SIWX), sends no API key, and reports the balance', async () => {
    const w = Wallet.createRandom()
    const balances: number[] = []
    const f = veniceFetch({ id: 'venice', kind: 'venice-x402', baseUrl: base, timeoutMs: 1000 }, w.privateKey, (b) => balances.push(b.usd!))
    await f(`${base}/chat/completions`, { method: 'POST', body: '{}' })
    const header = JSON.parse(Buffer.from(seen.siwx!, 'base64').toString('utf8'))
    expect(header.address).toBe(w.address)
    expect(verifyMessage(header.message, header.signature)).toBe(w.address)
    expect(header.message).toContain(`${base}/chat/completions`)
    expect(seen.auth).toBeUndefined()
    expect(balances).toEqual([4.25])
  })
})
