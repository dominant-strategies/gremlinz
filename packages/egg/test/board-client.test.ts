import { describe, expect, it } from 'vitest'
import { httpBoardClient } from '../src/board-client.js'

describe('board outages cannot stop the egg supervisor', () => {
  it('bounds a server that never returns headers', async () => {
    const client = httpBoardClient('https://board.example', (() => new Promise(() => {})) as typeof fetch, { timeoutMs: 30 })
    await expect(client.fetchConfig('0x1')).rejects.toThrow('timed out')
  })
  it('bounds stalled response bodies, then permits subsequent requests', async () => {
    let stalled = true
    const f = (async () => stalled
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
      : Response.json({ pulses: [{ seq: 9 }] })) as typeof fetch
    const client = httpBoardClient('https://board.example', f, { timeoutMs: 30 })
    await expect(client.latestPulseSeq('0x1')).rejects.toThrow('timed out')
    stalled = false
    await expect(client.latestPulseSeq('0x1')).resolves.toBe(9)
  })
})
