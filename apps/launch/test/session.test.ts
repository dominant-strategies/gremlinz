import { afterEach, describe, expect, it, vi } from 'vitest'
import { hatchUrl, loadSession, resumeSaved, savedSessions, saveSession, SESSION_KEY, startOver, type Session } from '../src/session.js'

afterEach(() => vi.unstubAllGlobals())
function storage() {
  const data = new Map<string, string>()
  let reject = ''
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (key === reject) throw new Error('Storage quota exceeded'); data.set(key, value) },
    removeItem: (key: string) => data.delete(key),
  })
  return { data, fail: (key: string) => { reject = key } }
}
const funded = (): Session => ({ launchId: 'original', maker: '0xabc', draft: { name: 'Paid gremlin' }, hatch: { jobId: 'paid-job', custody: 'mpc', hostingAddress: '0x123', minUsd: 10 }, bridgeTx: 'paid-bridge' })

describe('starting over and resuming hatches', () => {
  it('archives a paid hatch and restores it with its payment progress and original key share intact', () => {
    const { data } = storage(), current = funded()
    saveSession(current)
    data.set('gremlins.hatch-mpc.original', 'private-share-fixture')
    data.set('gremlins.sporestackToken', 'existing-hosting-token')
    const next = startOver(current, 'stable', 'canary')
    expect(next).toEqual({ launchId: expect.stringMatching(/^[a-f0-9]{24}$/), channel: 'canary' })
    expect(loadSession()).toEqual(next)
    expect(savedSessions()[0]).toMatchObject({ session: current, channel: 'stable' })
    expect(resumeSaved('original', next, 'canary')).toMatchObject({ ...current, channel: 'stable' })
    expect(data.get('gremlins.hatch-mpc.original')).toBe('private-share-fixture')
    expect(data.get('gremlins.sporestackToken')).toBe('existing-hosting-token')
  })
  it('keeps the active paid hatch when its archive cannot be saved', () => {
    const { fail } = storage(), current = funded()
    saveSession(current); fail('gremlins.launch.saved')
    expect(() => startOver(current, 'stable', 'canary')).toThrow('quota')
    expect(loadSession()).toEqual(current)
  })
  it('keeps both the active hatch and its saved copy when writing the fresh session fails', () => {
    const { fail } = storage(), current = funded()
    saveSession(current); fail(SESSION_KEY)
    expect(() => startOver(current, 'stable', 'canary')).toThrow('quota')
    expect(loadSession()).toEqual(current)
    expect(savedSessions()[0]!.session).toEqual(current)
  })
  it('preserves corrupted archives for recovery instead of silently replacing them', () => {
    const { data } = storage(), current = funded()
    saveSession(current); data.set('gremlins.launch.saved', '{unreadable')
    expect(() => startOver(current, 'stable', 'canary')).toThrow()
    expect(loadSession()).toEqual(current)
    expect(data.get('gremlins.launch.saved')).toBe('{unreadable')
  })
  it('prevents a stale tab from overwriting or restarting another active hatch', () => {
    storage()
    const old = funded(); saveSession(old)
    const next = startOver(old, 'stable', 'canary')
    saveSession({ ...old, configPosted: true })
    expect(loadSession()).toEqual(next)
    expect(() => startOver(old, 'stable', 'canary')).toThrow('Another tab')
    expect(loadSession()).toEqual(next)
  })
  it('retains signed bigint timestamps and saves the channel resolved for a legacy hatch', () => {
    storage()
    const old = { ...funded(), signed: { message: { issuedAt: 123n }, signature: 'signed' } } as unknown as Session
    saveSession(old)
    const next = startOver(old, undefined, 'canary')
    expect(savedSessions()[0]!.session.signed!.message.issuedAt).toBe(123n)
    resumeSaved(old.launchId, next, 'canary', 'stable')
    expect(loadSession()).toMatchObject({ channel: 'stable', signed: { message: { issuedAt: 123n } } })
  })
  it('keeps canary selection and other URL fields when restarting or resuming', () => {
    const url = 'https://gremlinz.ai/hatch/?campaign=test&hatch-paused=1#progress'
    expect(hatchUrl(url, 'canary')).toBe('https://gremlinz.ai/hatch/?campaign=test&canary=1#progress')
    expect(hatchUrl(hatchUrl(url, 'canary'), 'stable')).toBe('https://gremlinz.ai/hatch/?campaign=test#progress')
  })
})
