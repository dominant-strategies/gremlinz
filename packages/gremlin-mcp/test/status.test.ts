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

  it('shortens long highlights instead of rejecting them, and clamps progress', async () => {
    const r = (await client.callTool({ name: 'update_status', arguments: { highlight: 'x'.repeat(400), goals: [{ goal: 'g', progressPct: 150, note: 'n'.repeat(400) }] } })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBeFalsy()
    expect(r.content[0]!.text).toContain('shortened')
    const s = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'))
    expect(s.highlights[0]).toHaveLength(280)
    expect(s.highlights[0].endsWith('…')).toBe(true)
    expect(s.goals[0]).toMatchObject({ progressPct: 100 })
    expect(s.goals[0].note).toHaveLength(280)
  })

  it('accepts goals sent as a JSON string, and explains the format when the string is not a list', async () => {
    const ok = (await client.callTool({ name: 'update_status', arguments: { goals: JSON.stringify([{ goal: 'Ship it', progressPct: 30 }]) } })) as { isError?: boolean }
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(readFileSync(join(home, 'status.json'), 'utf8')).goals).toEqual([{ goal: 'Ship it', progressPct: 30 }])
    const bad = (await client.callTool({ name: 'update_status', arguments: { goals: 'Ship it: 30%' } })) as { isError?: boolean; content: { text: string }[] }
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toContain('progressPct')
  })
})
