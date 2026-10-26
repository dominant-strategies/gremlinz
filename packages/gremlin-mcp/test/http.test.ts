import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHttpServer } from '../src/http.js'

const token = randomBytes(32).toString('hex')
let http: Server
let url: URL
beforeAll(async () => {
  process.env.GREMLIN_HOME = mkdtempSync(join(tmpdir(), 'gremlin-'))
  http = createHttpServer({ token, deps: { balances: { read: async () => ({}) } } })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  url = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`)
})
afterAll(() => http.close())

describe('gremlin-mcp over HTTP', () => {
  it('serves the tools to a client with the token', async () => {
    const client = new Client({ name: 'hermes', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['board_post', 'treasury_balances', 'update_status', 'move_out']))
    const r = (await client.callTool({ name: 'update_status', arguments: { highlight: 'over http' } })) as { isError?: boolean }
    expect(r.isError).toBeFalsy()
    await client.close()
  })

  it('refuses requests without the right token', async () => {
    for (const authorization of ['', 'Bearer nope', `Bearer ${token}x`]) {
      const r = await fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
      expect(r.status).toBe(401)
    }
  })

  it('refuses weak tokens', () => {
    expect(() => createHttpServer({ token: 'short' })).toThrow()
  })
})
