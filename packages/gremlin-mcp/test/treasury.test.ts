import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

let client: Client
const asked: { quai: string; evm: string }[] = []

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  writeFileSync(join(home, 'seed'), Wallet.createRandom().mnemonic!.phrase)
  process.env.GREMLIN_HOME = home
  const balances = { read: async (a: { quai: string; evm: string }) => (asked.push(a), { 'quai:9': 1234n * 10n ** 17n, 'usdc:8453': 2_500_000n }) }
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('treasury_balances', () => {
  it('shows both addresses and non-zero balances in human units', async () => {
    const r = (await client.callTool({ name: 'treasury_balances', arguments: {} })) as { content: { text: string }[] }
    const t = r.content[0]!.text
    expect(t).toContain(`Quai address: ${asked[0]!.quai}`)
    expect(t).toContain('QUAI on Quai: 123.4')
    expect(t).toContain('USDC on Base: 2.5')
    expect(asked[0]!.quai).toMatch(/^0x00/) // cyprus1
  })
})
