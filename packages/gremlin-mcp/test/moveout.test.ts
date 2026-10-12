import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'

let client: Client
let home: string
let clock = Date.parse('2026-10-12T00:00:00Z')
const token = 'ss_t_' + 'a'.repeat(27)
const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'move_out', arguments: args })) as { content: { text: string }[]; isError?: boolean }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gremlin-'))
  process.env.GREMLIN_HOME = home
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createServer({ balances: { read: async () => ({}) }, now: () => clock }).connect(a)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
})

describe('move_out', () => {
  it('writes the request file the egg watches', async () => {
    expect((await call({ host: 'sporestack', sporestackToken: token })).isError).toBeFalsy()
    expect(JSON.parse(readFileSync(join(home, 'moveout-request.json'), 'utf8'))).toEqual({ host: 'sporestack', token, days: 30 })
  })

  it('refuses a second move within a day, even after the first request is consumed', async () => {
    rmSync(join(home, 'moveout-request.json'))
    clock += 60 * 60_000
    const r = await call({ host: 'sporestack', sporestackToken: token })
    expect(r.isError).toBe(true)
    expect(existsSync(join(home, 'moveout-request.json'))).toBe(false)
    clock += 24 * 60 * 60_000
    expect((await call({ host: 'sporestack', sporestackToken: token, days: 60 })).isError).toBeFalsy()
  })

  it('rejects Conway (discontinued) and malformed tokens', async () => {
    expect((await call({ host: 'conway' })).isError).toBe(true)
    expect((await call({ host: 'sporestack', sporestackToken: 'nope' })).isError).toBe(true)
  })
})
