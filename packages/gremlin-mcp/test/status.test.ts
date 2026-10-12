import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

let client: Client
let home: string

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  process.env.GREMLIN_HOME = home
  writeFileSync(join(home, 'status.json'), JSON.stringify({ tier: 'normal', host: 'fluence' }))
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) } }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('update_status', () => {
  it('merges goals and keeps the five newest highlights for the egg to pulse', async () => {
    for (let i = 1; i <= 6; i++) await client.callTool({ name: 'update_status', arguments: { highlight: `h${i}` } })
    await client.callTool({ name: 'update_status', arguments: { goals: [{ goal: 'Build stations', progressPct: 20 }] } })
    const s = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'))
    expect(s.highlights).toEqual(['h6', 'h5', 'h4', 'h3', 'h2'])
    expect(s.goals).toEqual([{ goal: 'Build stations', progressPct: 20 }])
    expect(s.host).toBe('fluence') // fields written by others survive
    expect(Date.parse(s.updatedAt)).toBeGreaterThan(0)
  })

  it('rejects out-of-range progress', async () => {
    const r = (await client.callTool({ name: 'update_status', arguments: { goals: [{ goal: 'x', progressPct: 150 }] } })) as { isError?: boolean }
    expect(r.isError).toBe(true)
  })
})
