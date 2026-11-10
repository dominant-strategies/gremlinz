import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { fluence } from '../src/fluence.js'
import { localSigner } from '../src/signer.js'
import { FOREIGN_TOKEN_TTL_MS, cleanupFluenceAccount, nextCleanupAt } from '../src/fluence-cleanup.js'

/** A Fluence account someone else had a token for: extra API keys, SSH keys, a stray VM and a draft. */
function account(over: { vms?: { id: string; status: string; sshKeyIds?: string[] }[]; failDelete?: string } = {}) {
  const state = {
    apiKeys: [{ id: 'k1', name: 'backdoor', scopes: ['*'], createdAt: '' }, { id: 'k2', name: 'other', scopes: [], createdAt: '' }],
    sshKeys: [{ id: 's1', name: 'x', fingerprint: 'f', managedService: null }, { id: 's2', name: 'm', fingerprint: 'g', managedService: { id: 'm', name: 'managed' } }],
    vms: over.vms ?? [
      { id: 'own', status: 'launched', sshKeyIds: ['s1'] },
      { id: 'stray', status: 'launched', sshKeyIds: [] },
      { id: 'draft', status: 'draft', sshKeyIds: [] },
      { id: 'old', status: 'terminated', sshKeyIds: [] },
    ],
  }
  const calls: { method: string; path: string; body?: any; headers: Record<string, string> }[] = []
  const json = (v: unknown, status = 200) => new Response(v === undefined ? null : JSON.stringify(v), { status })
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body, headers })
    const p = u.pathname
    if (p === '/v1/auth/siwe/nonce') return json({ nonce: 'abcdefgh12345678' })
    if (p === '/v1/auth/siwe') return json({ accessToken: 'tok' })
    if (headers.authorization !== 'Bearer tok') return json({}, 401)
    if (over.failDelete && method === 'DELETE' && p.endsWith(over.failDelete)) return json({ detail: 'nope' }, 500)
    if (p === '/v3/api-keys' && method === 'GET') return json({ items: state.apiKeys })
    if (p.startsWith('/v3/api-keys/') && method === 'DELETE') { state.apiKeys = state.apiKeys.filter((k) => k.id !== p.split('/').pop()); return json(undefined, 204) }
    if (p === '/v3/vms' && method === 'GET') return json({ items: state.vms, pagination: { totalPages: 1, currentPage: 1 } })
    if (p === '/v3/ssh-keys' && method === 'GET') return json({ items: state.sshKeys, pagination: { totalPages: 1, currentPage: 1 } })
    if (p.startsWith('/v3/ssh-keys/') && method === 'DELETE') { state.sshKeys = state.sshKeys.filter((k) => k.id !== p.split('/').pop()); return json({}) }
    const m = /^\/v3\/vms\/([^/]+)(\/.*)?$/.exec(p)
    if (m) {
      const vm = state.vms.find((v) => v.id === m[1])!
      if (m[2] === '/terminate' && method === 'POST') { vm.status = 'terminating'; return json({ id: vm.id, acceptedStatus: 'terminating' }, 202) }
      if (m[2] === '/ssh-keys' && method === 'PUT') { vm.sshKeyIds = body.sshKeys; return json(vm) }
      if (!m[2] && method === 'DELETE') { state.vms = state.vms.filter((v) => v !== vm); return json(undefined, 204) }
    }
    return json({ error: `unexpected ${method} ${p}` }, 404)
  }) as unknown as typeof fetch
  const fl = fluence({ signer: localSigner(Wallet.createRandom().privateKey as `0x${string}`), fetchImpl })
  return { state, calls, fl }
}

describe('fluence account cleanup', () => {
  it('deletes every API key, stops strays, discards drafts, clears SSH keys and keeps its own VM', async () => {
    const a = account()
    const r = await cleanupFluenceAccount(a.fl, { vmId: 'own' })
    expect(r.errors).toEqual([])
    expect(r.apiKeysDeleted).toEqual(['k1', 'k2'])
    expect(a.state.apiKeys).toEqual([])
    expect(r.vmsTerminated).toEqual(['stray'])
    expect(r.draftsDiscarded).toEqual(['draft'])
    expect(a.state.vms.find((v) => v.id === 'own')).toMatchObject({ status: 'launched', sshKeyIds: [] })
    expect(r.vmSshKeysCleared).toBe(true)
    // managed-service keys are read-only for the account
    expect(r.accountSshKeysDeleted).toEqual(['s1'])
    const term = a.calls.find((c) => c.path === '/v3/vms/stray/terminate')!
    expect(term.headers['idempotency-key']).toBe('gremlin-cleanup-stray')
    expect(a.calls.some((c) => c.path.startsWith('/v3/vms/own') && c.method !== 'PUT')).toBe(false)
    expect(a.calls.find((c) => c.method === 'PUT')!.body).toEqual({ sshKeys: [] })
  })

  it('keeps VMs the gremlin chose to keep', async () => {
    const a = account()
    const r = await cleanupFluenceAccount(a.fl, { vmId: 'own', keepVmIds: ['stray'] })
    expect(r.vmsTerminated).toEqual([])
    expect(a.state.vms.find((v) => v.id === 'stray')!.status).toBe('launched')
  })

  it('stops no VM at all when its own VM is not in the account', async () => {
    for (const vms of [[{ id: 'stray', status: 'launched' }], [{ id: 'own', status: 'terminated' }, { id: 'stray', status: 'launched' }]]) {
      const a = account({ vms })
      await expect(cleanupFluenceAccount(a.fl, { vmId: 'own' })).rejects.toThrow(/refusing to stop any VM/)
      expect(a.calls.some((c) => c.path.endsWith('/terminate'))).toBe(false)
    }
  })

  it('carries on past a failed deletion and reports it', async () => {
    const a = account({ failDelete: '/api-keys/k1' })
    const r = await cleanupFluenceAccount(a.fl, { vmId: 'own' })
    expect(r.apiKeysDeleted).toEqual(['k2'])
    expect(r.errors).toEqual([expect.stringMatching(/delete API key k1/)])
    expect(r.vmsTerminated).toEqual(['stray'])
  })

  it('sweeps again after the last foreign token expires, then daily, and soon after a failure', () => {
    const session = Date.parse('2026-11-10T10:00:00Z')
    const first = session + 5 * 60_000
    expect(nextCleanupAt({ ranAt: first, ok: true, lastForeignSessionAt: session })).toBe(session + FOREIGN_TOKEN_TTL_MS)
    expect(FOREIGN_TOKEN_TTL_MS).toBeGreaterThanOrEqual(2 * 60 * 60_000 + 15 * 60_000)
    const second = session + FOREIGN_TOKEN_TTL_MS
    expect(nextCleanupAt({ ranAt: second, ok: true, lastForeignSessionAt: session })).toBe(second + 24 * 60 * 60_000)
    expect(nextCleanupAt({ ranAt: first, ok: false, lastForeignSessionAt: session })).toBe(first + 15 * 60_000)
  })
})
