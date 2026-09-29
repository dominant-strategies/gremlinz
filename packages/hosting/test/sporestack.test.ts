import { describe, expect, it } from 'vitest'
import { newToken, sporestack, unusableSshKey } from '../src/sporestack.js'

describe('sporestack', () => {
  it('makes a well-formed, unusable ssh key', () => {
    const k = unusableSshKey()
    expect(k).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ gremlin-egg-no-access$/)
    const raw = Buffer.from(k.split(' ')[1], 'base64')
    expect(raw.readUInt32BE(0)).toBe(11)
    expect(raw.subarray(4, 15).toString()).toBe('ssh-ed25519')
    expect(raw.readUInt32BE(15)).toBe(32)
    expect(unusableSshKey()).not.toBe(k)
  })
  it('tokens are random and in SporeStack format', () => {
    expect(newToken()).toMatch(/^ss_t_[0-9a-z]{27}$/)
    expect(newToken()).not.toBe(newToken())
  })
  it('sends launch requests to the token path', async () => {
    const calls: [string, RequestInit][] = []
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ machine_id: 'ss_m_1' })) }) as unknown as typeof fetch
    const ss = sporestack({ token: 'tok', fetchImpl })
    const id = await ss.launch({ flavor: 'vps-1vcpu-1gb', operating_system: 'debian-12', provider: 'digitalocean', region: null, ssh_key: unusableSshKey(), days: 7, user_data: '#cloud-config' })
    expect(id).toBe('ss_m_1')
    expect(calls[0][0]).toBe('https://api.sporestack.com/token/tok/servers')
    expect(JSON.parse(String(calls[0][1].body)).user_data).toBe('#cloud-config')
  })
})
