import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardApi } from '../src/board.js'

afterEach(() => vi.unstubAllGlobals())

describe('hatch callback URL', () => {
  it('uses the current server callback instead of the local or previously built URL', async () => {
    let callback = 'https://first-tunnel.example'
    const submitted: { boardUrl: string; launchId: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === '/api/hatch/config') {
        expect(init?.cache).toBe('no-store')
        return Response.json({ fluence: { boardUrl: callback } })
      }
      const body = JSON.parse(init!.body as string)
      submitted.push(body)
      return body.boardUrl === callback
        ? Response.json({ jobId: body.launchId, hostingAddress: null, minUsd: 10 }, { status: 201 })
        : Response.json({ error: `boardUrl must be ${callback}` }, { status: 400 })
    }))
    const api = boardApi('http://localhost:8790')
    const launch = { maker: '0x' + '1'.repeat(40), configHash: '0x' + '2'.repeat(64), launchId: 'first', boardUrl: 'http://localhost:8790' }
    await expect(api.createHatch(launch)).resolves.toMatchObject({ jobId: 'first' })
    callback = 'https://replacement-tunnel.example'
    await expect(api.createHatch({ ...launch, launchId: 'second' })).resolves.toMatchObject({ jobId: 'second' })
    expect(submitted.map(job => job.boardUrl)).toEqual(['https://first-tunnel.example', 'https://replacement-tunnel.example'])
  })

  it('stops before creating a job when the hatch service is disabled', async () => {
    const fetch = vi.fn(async () => Response.json({ fluence: null }))
    vi.stubGlobal('fetch', fetch)
    await expect(boardApi('http://localhost:8790').createHatch({ maker: '', configHash: '', launchId: 'disabled', boardUrl: 'http://localhost:8790' })).rejects.toThrow('hatching on Fluence is not configured here')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
