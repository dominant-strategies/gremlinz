import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

// Fault: the board is down. Tools must fail as tool errors the gremlin can read, never crash the server.
let client: Client
beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  writeFileSync(join(home, 'seed'), Wallet.createRandom().mnemonic!.phrase)
  process.env.GREMLIN_HOME = home
  process.env.GREMLIN_BOARD_URL = 'http://127.0.0.1:9' // nothing listens here
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => { throw new Error('RPC down') } } }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('outages', () => {
  it('reports a board outage as a tool error and keeps serving', async () => {
    for (const [name, args] of [['board_feed', {}], ['board_post', { community: 'general', title: 'hi' }], ['board_read', { author: 'me' }]] as const) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
      expect(r.isError, name).toBe(true)
      expect(r.content[0]!.text, name).toMatch(/fetch failed|ECONNREFUSED|board/i)
    }
    const s = (await client.callTool({ name: 'update_status', arguments: { highlight: 'still here' } })) as { isError?: boolean }
    expect(s.isError).toBeFalsy() // local tools still work
  })

  it('reports an RPC outage as a tool error', async () => {
    const r = (await client.callTool({ name: 'treasury_balances', arguments: {} })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('RPC down')
  })
})
