import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { createServer } from '../src/server.js'
import { makerApproval } from '../src/tools/approval.js'

it('binds a move approval to the maker, action and parameters before queuing it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gremlin-approvals-'))
  vi.stubEnv('GREMLIN_HOME', home)
  const maker = Wallet.createRandom()
  const gremlin = Wallet.createRandom().address
  const attacker = Wallet.createRandom()
  const journal = join(home, 'maker-approvals')
  const request = join(home, 'moveout-request.json')
  const approve = makerApproval(journal, maker.address, gremlin)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const server = createServer({ approve })
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(a)
  await client.connect(b)
  const token = 'ss_t_' + 'a'.repeat(27)
  const exact = { host: 'sporestack', sporestackToken: token, days: 30 }
  const move = (args: Record<string, unknown>) => client.callTool({ name: 'move_out', arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>
  try {
    const blocked = await move(exact)
    const response = blocked.content[0]!.text
    expect(blocked.isError).toBe(true)
    expect(response).not.toContain(token)
    expect(existsSync(request)).toBe(false)
    const message = response.slice(response.indexOf('Gremlinz maker approval v1'))
    const nonce = /^Nonce: (.+)$/m.exec(message)![1]!
    const expiresAt = Date.parse(/^Expires at: (.+)$/m.exec(message)![1]!)
    const authorization = { nonce, expiresAt, signature: await maker.signMessage(message) }
    expect((await move({ ...exact, approval: { ...authorization, signature: await attacker.signMessage(message) } })).isError).toBe(true)
    expect((await move({ ...exact, days: 90, approval: authorization })).isError).toBe(true)
    expect(existsSync(request)).toBe(false)
    expect(approve('wallet_send', { amount: '1' }, authorization)).toMatch(/does not approve/)
    expect((await move({ ...exact, approval: authorization })).isError).toBeFalsy()
    expect(JSON.parse(readFileSync(request, 'utf8'))).toMatchObject({ authorizationVersion: 1, days: 30 })
    const fields = { host: 'sporestack', days: '30', image: 'current image', accountFingerprint: /^accountFingerprint: "(.+)"$/m.exec(message)![1]! }
    expect(approve('move_out', fields, authorization)).toMatch(/already been used/)
    expect(makerApproval(journal, maker.address, gremlin, () => expiresAt)('move_out', fields, authorization)).toMatch(/expired/)
  } finally {
    await client.close()
    await server.close()
    vi.unstubAllEnvs()
  }
})
