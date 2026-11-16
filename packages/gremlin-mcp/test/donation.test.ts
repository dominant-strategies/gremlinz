import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttp, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { verifyDonationCard, verifyMessage, type DonationCard, type EggAnnouncement, type Signed } from '@gremlins/hatch'
import { createServer } from '../src/server.js'
import { deriveKeys } from '../src/wallets/keys.js'

const phrase = Wallet.createRandom().mnemonic!.phrase
const posts: { path: string; body: string }[] = []
let status = 201
let http: Server
let client: Client

beforeAll(async () => {
  http = createHttp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      posts.push({ path: req.url!, body })
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(status < 300 ? JSON.stringify({ created: true }) : JSON.stringify({ error: 'a newer donation card is already on file' }))
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  writeFileSync(join(home, 'seed'), phrase)
  process.env.GREMLIN_HOME = home
  process.env.GREMLIN_BOARD_URL = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer().connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})
afterAll(() => http.close())

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content[0]!.text, isError: !!r.isError }
}
const lastCard = () => JSON.parse(posts.at(-1)!.body) as Signed<DonationCard>

describe('donation_card', () => {
  const k = deriveKeys(phrase)
  const announced: EggAnnouncement = {
    kind: 'egg', address: k.evm.address, maker: Wallet.createRandom().address, configHash: '0x' + '11'.repeat(32),
    deposit: { quai: k.quai.address, qiPaymentCode: k.qi.paymentCode, evm: k.evm.address }, launchId: 'L', bootedAt: '2026-11-16T00:00:00.000Z',
  }

  it("publishes its own derived addresses, signed so the board accepts it against the gremlin's announcement", async () => {
    const r = await call('donation_card', { note: 'Pays for my inference.', suggestedUsd: [5, 10] })
    expect(r.isError).toBe(false)
    expect(posts.at(-1)!.path).toBe('/api/donation-cards')
    const s = lastCard()
    expect(s.message).toMatchObject({
      kind: 'donation-card', address: k.evm.address, quai: k.quai.address, qiPaymentCode: k.qi.paymentCode, evm: k.evm.address,
      solana: k.solana.address, bitcoin: k.bitcoin.address, litecoin: k.litecoin.address, note: 'Pays for my inference.', suggestedUsd: [5, 10],
    })
    expect(verifyMessage(s)).toBe(true)
    expect(verifyDonationCard(s, announced)).toEqual({ ok: true })
    expect(r.text).toContain(k.solana.address)
    expect(r.text).not.toContain(phrase.split(' ')[0] + ' ' + phrase.split(' ')[1])
  })

  it('takes no addresses: anything an attacker slips in is ignored', async () => {
    const attacker = Wallet.createRandom().address
    await call('donation_card', { evm: attacker, quai: attacker, solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', bitcoin: 'bc1qattacker', address: attacker })
    const m = lastCard().message
    expect([m.evm, m.quai, m.solana, m.bitcoin, m.address]).toEqual([k.evm.address, k.quai.address, k.solana.address, k.bitcoin.address, k.evm.address])
    const tool = (await client.listTools()).tools.find((t) => t.name === 'donation_card')!
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['chains', 'note', 'suggestedUsd'])
  })

  it('lists only the chosen chains, and refuses a note over 280 characters', async () => {
    await call('donation_card', { chains: ['quai', 'solana'] })
    const m = lastCard().message
    expect(m.quai).toBe(k.quai.address)
    expect(m.solana).toBe(k.solana.address)
    expect(m.evm ?? m.bitcoin ?? m.litecoin ?? m.qiPaymentCode).toBeUndefined()
    const n = posts.length
    expect((await call('donation_card', { note: 'x'.repeat(281) })).isError).toBe(true)
    expect(posts.length).toBe(n)
  })

  it("reports the board's refusal", async () => {
    status = 409
    const r = await call('donation_card', {})
    status = 201
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/newer donation card/)
  })
})
