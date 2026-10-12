import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

let client: Client
let home: string
const call = async () => (await client.callTool({ name: 'register_on_quai', arguments: {} })) as { content: { text: string }[]; isError?: boolean }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  writeFileSync(join(home, 'seed'), Wallet.createRandom().mnemonic!.phrase)
  process.env.GREMLIN_HOME = home
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) } }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('register_on_quai', () => {
  it('needs a signed config', async () => {
    const r = await call()
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/not hatched/)
  })

  it('refuses a signed config made out to another gremlin (before touching the chain)', async () => {
    writeFileSync(join(home, 'signed-config.json'), JSON.stringify({ message: { gremlin: '0x0011111111111111111111111111111111111111' }, config: {}, signature: '0x' }))
    const r = await call()
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/different gremlin/)
  })
})
