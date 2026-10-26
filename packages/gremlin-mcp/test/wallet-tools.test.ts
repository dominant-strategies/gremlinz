import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import { deriveKeys } from '../src/wallets/keys.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
let client: Client
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content[0]!.text, isError: !!r.isError }
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  writeFileSync(join(home, 'seed'), ABANDON)
  process.env.GREMLIN_HOME = home
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) } }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('wallet tools', () => {
  it('lists receiving addresses on every chain', async () => {
    const k = deriveKeys(ABANDON)
    const { text } = await call('wallet_addresses')
    for (const a of [k.quai.address, k.qi.paymentCode, k.evm.address, k.solana.address, k.bitcoin.address, k.litecoin.address]) expect(text).toContain(a)
    expect(text).not.toMatch(/abandon/) // never the seed
  })

  it('rejects unknown assets, malformed amounts and wrong-chain destinations before anything is priced or sent', async () => {
    const k = deriveKeys('legal winner thank year wave sausage worth useful legal winner thank yellow')
    expect((await call('wallet_send', { asset: 'doge:dogecoin', to: k.evm.address, amount: '1' })).text).toMatch(/Unknown asset/)
    expect((await call('wallet_send', { asset: 'usdc:base', to: k.evm.address, amount: '1.1234567' })).text).toMatch(/too many decimal places/)
    expect((await call('wallet_send', { asset: 'btc:bitcoin', to: k.evm.address, amount: '0.001' })).text).toMatch(/Bad destination/)
    expect((await call('wallet_send', { asset: 'qi:quai', to: k.quai.address, amount: '1' })).text).toMatch(/payment code/)
  })
})
