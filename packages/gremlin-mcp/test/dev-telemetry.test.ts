import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { Telemetry, devTelemetryEnabled, readEvents, type DevEvent } from '../src/dev/telemetry.js'
import { instrumentTools } from '../src/dev/tools.js'
import { localReport, summarize } from '../src/dev/report.js'
import { createGateway, type CallRecord } from '../src/gateway/server.js'
import { GatewayConfig } from '../src/gateway/config.js'
import type { Server } from 'node:http'

const home = () => mkdtempSync(join(tmpdir(), 'dev-telemetry-'))
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

describe('dev instrumentation', () => {
  it('is off for normal launches, on for dev SSH launches, and honors explicit overrides', () => {
    expect(devTelemetryEnabled({})).toBe(false)
    expect(devTelemetryEnabled({}, { dev: { sshKeys: ['public-key'] } })).toBe(true)
    expect(devTelemetryEnabled({ GREMLIN_DEV_TELEMETRY: '0' }, { dev: { sshKeys: ['public-key'] } })).toBe(false)
    const h = home()
    new Telemetry({ home: h, component: 'gateway', enabled: false }).emit('inference', { inputTokens: 5 })
    expect(existsSync(join(h, 'dev-telemetry'))).toBe(false)
  })
  it('drops payloads, keys, arbitrary errors and secret-shaped labels; bounds files and uses mode 0600', () => {
    const h = home(), t = new Telemetry({ home: h, component: 'gateway', enabled: true, maxBytes: 900 })
    const secret = 'sensitive-user-prompt-12345'
    for (let i = 0; i < 30; i++) t.emit('inference', { provider: 'sk-' + 'a'.repeat(25), inputTokens: i, outputTokens: 2, prompt: secret, arguments: secret, result: secret, authorization: secret, error: secret })
    const dir = join(h, 'dev-telemetry')
    for (const suffix of ['', '.1', '.2']) {
      const p = join(dir, 'gateway.jsonl' + suffix)
      expect(statSync(p).size).toBeLessThanOrEqual(900)
      expect(statSync(p).mode & 0o777).toBe(0o600)
      expect(readFileSync(p, 'utf8')).not.toContain(secret)
      expect(readFileSync(p, 'utf8')).not.toContain('sk-')
    }
    expect(readEvents(h).length).toBeLessThan(30)
    expect(() => new Telemetry({ home: '/dev/null/impossible', component: 'gateway', enabled: true }).emit('inference', {})).not.toThrow()
  })
  it('preserves tool results and errors without retaining arguments or result text', async () => {
    const h = home(), t = new Telemetry({ home: h, component: 'mcp', enabled: true })
    const server = new McpServer({ name: 'test', version: '1' })
    instrumentTools(server, t)
    server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
    server.registerTool('broken', { inputSchema: {} }, async () => { throw new Error('private-error-sample') })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '1' }); await client.connect(b)
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 'private-argument-sample' } })
      expect(result.content).toEqual([{ type: 'text', text: 'private-argument-sample' }])
      expect((await client.callTool({ name: 'broken', arguments: {} })).isError).toBe(true)
      const events = readEvents(h)
      expect(events.map(e => e.fields.outcome)).toEqual(['success', 'exception'])
      expect(JSON.stringify(events)).not.toContain('private-')
    } finally { await client.close(); await server.close() }
  })
  it('groups fallback attempts, accounts for reported token subsets and sanitizes exported snapshots', () => {
    const h = home(), t = new Telemetry({ home: h, component: 'gateway', enabled: true })
    t.emit('inference', { requestId: 'q1', provider: 'p', model: 'm', status: 503, durationMs: 4, usageReported: false })
    t.emit('inference', { requestId: 'q1', provider: 'q', model: 'm', status: 200, durationMs: 8, inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, reasoningTokens: 5, usageReported: true, priced: true, valuedUsd: 0.02 })
    t.emit('inference', { requestId: 'q2', provider: 'q', model: 'm', status: 200, durationMs: 10, inputTokens: 200, outputTokens: 20, usageReported: true, priced: true, valuedUsd: 0.03, lent: true })
    writeFileSync(join(h, 'runtime-health.json'), JSON.stringify({ at: new Date().toISOString(), healthy: false, secret: 'hidden', services: { mcp: { ready: false, failures: 3, lastError: 'private-error', token: 'hidden' } } }))
    const report = localReport(h)
    expect(report.inference).toMatchObject({ requests: 2, attempts: 3, additionalAttempts: 1, failedAttempts: 1, missingUsage: 1, inputTokens: 300, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 5, ownValuedUsd: 0.02, lentValuedUsd: 0.03 })
    expect(report.inference.inputPerAttempt.p95).toBe(200)
    expect(report.inference.inputToReferenceWindow.max).toBe(200 / 64_000)
    expect(report.runtime?.services.mcp).toEqual({ ready: false, failures: 3 })
    expect(JSON.stringify(report)).not.toContain('private-error')
    expect(JSON.stringify(report)).not.toContain('hidden')
    // Export filters arbitrary fields even if a local event file was edited by hand.
    const raw = readEvents(h)[0]!
    writeFileSync(join(h, 'dev-telemetry/mcp.jsonl'), JSON.stringify({ ...raw, fields: { tool: 'echo', prompt: 'private-tampered-data' } }) + '\n')
    expect(JSON.stringify(readEvents(h))).not.toContain('private-tampered-data')
    expect(summarize(readEvents(h), Date.now() + 86_400_000).inference.attempts).toBe(0)
  })
  it('records actual request sizes, cached/reasoning tokens and one request ID across fallback attempts', async () => {
    for (const stream of [false, true]) {
      const calls: CallRecord[] = []
      const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } }
      const cfg = GatewayConfig.parse({ providers: ['bad', 'good'].map(id => ({ id, kind: 'openai', baseUrl: 'http://unused/v1' })), routes: { main: [{ provider: 'bad', model: 'm' }, { provider: 'good', model: 'm' }] }, glean: { enabled: false } })
      const s = createGateway(cfg, { captureDetails: true, onCall: r => calls.push(r), fetchers: { bad: async () => new Response('{}', { status: 503 }), good: async () => stream ? new Response(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`) : new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }], usage })) } })
      servers.push(s); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
      const r = await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'main', messages: [{ role: 'user', content: 'private query' }], tools: [{ type: 'function', function: { name: 'test' } }], stream }) })
      await r.text()
      expect(calls).toHaveLength(2)
      expect(calls[0]!.requestId).toBe(calls[1]!.requestId)
      expect(calls[1]!.requestBytes).toBeGreaterThan(0)
      expect(calls[1]!.messageCount).toBe(1)
      expect(calls[1]!.toolCount).toBe(1)
      expect(calls[1]!.firstByteMs).toBeGreaterThanOrEqual(0)
      expect(calls[1]!.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, cachedPromptTokens: 60, reasoningTokens: 5 })
      expect(JSON.stringify(calls)).not.toContain('private query')
    }
  })
})
