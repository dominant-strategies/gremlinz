import { describe, expect, it } from 'vitest'
import { Wallet, verifyMessage } from 'ethers'
import { TopUpUnderReview, eggVmName, fluence } from '../src/fluence.js'
import { localSigner } from '../src/signer.js'

/** Fake Fluence API: SIWE login, resources, prices, images and VM creation. */
function fakeApi() {
  const calls: { method: string; path: string; body?: any; headers: Record<string, string> }[] = []
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init.method ?? 'GET', path: u.pathname, body, headers })
    switch (u.pathname) {
      case '/v1/auth/siwe/nonce': return json({ nonce: 'abcdefgh12345678' })
      case '/v1/auth/siwe': return body?.message?.includes('api.fluence.dev') ? json({ accessToken: 'tok' }) : json({}, 401)
      case '/v1/clusters/resources': return json({ resources: {
        full: { availableConfigurations: [{ id: 'cheap', vcpu: 1, ramGb: 2 }], availablePublicIps: { V4: 0 } },
        a: { availableConfigurations: [{ id: 'small', vcpu: 1, ramGb: 2 }, { id: 'tiny', vcpu: 1, ramGb: 1 }, { id: 'big', vcpu: 4, ramGb: 8 }], availablePublicIps: { V4: 3 } },
        b: { availableConfigurations: [{ id: 'small-b', vcpu: 2, ramGb: 2 }], availablePublicIps: { V4: 1 } },
      } })
      case '/v3/prices/vm': return json({ items: [
        { vmTypeId: { clusterId: 'full', vmConfigurationId: 'cheap' }, priceInfo: { pricePerHourPerQty: '0.001' } },
        { vmTypeId: { clusterId: 'a', vmConfigurationId: 'small' }, priceInfo: { pricePerHourPerQty: '0.006' } },
        { vmTypeId: { clusterId: 'a', vmConfigurationId: 'tiny' }, priceInfo: { pricePerHourPerQty: '0.002' } },
        { vmTypeId: { clusterId: 'a', vmConfigurationId: 'big' }, priceInfo: { pricePerHourPerQty: '0.05' } },
        { vmTypeId: { clusterId: 'b', vmConfigurationId: 'small-b' }, priceInfo: { pricePerHourPerQty: '0.004' } },
      ] })
      case '/v1/storages/default_images': return json({ items: [
        { id: 'deb', distribution: 'debian', slug: 'debian-12', name: 'Debian 12', isDefault: true },
        { id: 'u22', distribution: 'ubuntu', slug: 'ubuntu-22-04', name: 'Ubuntu 22.04', isDefault: false },
        { id: 'u24', distribution: 'ubuntu', slug: 'ubuntu-24-04', name: 'Ubuntu 24.04', isDefault: false },
      ] })
      case '/v3/vms': return json({ id: 'vm1', status: 'draft' })
      default: return json({ error: 'unexpected ' + u.pathname }, 404)
    }
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('fluence egg hosting', () => {
  it('signs in with a SIWE message for api.fluence.dev and sends the bearer token', async () => {
    const api = fakeApi()
    const fl = fluence({ signer: localSigner(Wallet.createRandom().privateKey as `0x${string}`), fetchImpl: api.fetchImpl })
    await fl.login()
    await fl.cheapestPlan()
    expect(api.calls.find((c) => c.path === '/v1/clusters/resources')!.headers.authorization).toBe('Bearer tok')
  })

  it('picks the cheapest config that meets the size and still has a public IPv4', async () => {
    const api = fakeApi()
    const fl = fluence({ signer: localSigner(Wallet.createRandom().privateKey as `0x${string}`), fetchImpl: api.fetchImpl })
    await fl.login()
    expect(await fl.cheapestPlan(1, 2)).toMatchObject({ clusterId: 'b', configurationId: 'small-b', hourlyUsd: 0.004 })
    expect(await fl.ubuntuImageId()).toBe('u24')
  })

  it('creates eggs with no SSH keys, a public IPv4 and private cloud-init', async () => {
    const api = fakeApi()
    const fl = fluence({ signer: localSigner(Wallet.createRandom().privateKey as `0x${string}`), fetchImpl: api.fetchImpl })
    await fl.login()
    const plan = await fl.cheapestPlan()
    await fl.createDraft({ name: eggVmName('AbC-123_xyz'), plan, imageId: 'u24', cloudInit: '#cloud-config\n', idempotencyKey: 'egg-1' })
    const c = api.calls.find((x) => x.path === '/v3/vms')!
    expect(c.body.sshKeyIds).toEqual([])
    expect(c.body.cloudInit).toBe('#cloud-config\n')
    expect(c.body.interfaces).toEqual([{ kind: 'public', addressType: 'V4', default: true }])
    expect(c.body.bootDisk).toEqual({ kind: 'new', volumeGb: 25, source: { type: 'catalog', imageId: 'u24' } })
    expect(c.headers['idempotency-key']).toBe('egg-1')
    expect(c.body.name).toMatch(/^[a-z0-9-]{1,25}$/)
  })

  it('refuses top-ups below the minimum before touching the network', async () => {
    const fl = fluence({ signer: localSigner(Wallet.createRandom().privateKey as `0x${string}`), fetchImpl: (() => { throw new Error('no network') }) as never })
    await expect(fl.topUp(5)).rejects.toThrow(/start at \$10/)
  })

  it('hands the payment authorization to the caller before signing it, and turns 409 into TopUpUnderReview', async () => {
    const x402 = (settle: number) => (async (input: Request) => {
      if (!input.headers.get('payment-signature')) {
        const req = { x402Version: 2, resource: { url: input.url, description: 'top-up', mimeType: 'application/json' }, accepts: [{
          scheme: 'exact', network: 'eip155:8453', amount: '10000000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
        }] }
        return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(req)).toString('base64') } })
      }
      return new Response(JSON.stringify(settle === 200 ? { transaction: '0xtx', amountUsd: '10.00' } : { error: 'review' }), { status: settle })
    }) as unknown as typeof fetch
    const order: string[] = []
    const inner = localSigner(Wallet.createRandom().privateKey as `0x${string}`)
    const signer = { ...inner, signTypedData: async (td: any) => { order.push(`sign ${td.primaryType}`); return inner.signTypedData(td) } }
    const auths: any[] = []
    const before = Math.floor(Date.now() / 1000)
    const paid = await fluence({ signer, fetchImpl: x402(200) }).topUp(10, { onAuthorization: async (a) => { order.push('record'); auths.push(a) } })
    expect(paid.transaction).toBe('0xtx')
    expect(order).toEqual(['record', 'sign TransferWithAuthorization'])
    expect(auths[0].nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(auths[0].validBefore).toBeGreaterThanOrEqual(before + 300)
    expect(auths[0].value).toBe('10000000')
    await expect(fluence({ signer, fetchImpl: x402(409) }).topUp(10)).rejects.toBeInstanceOf(TopUpUnderReview)
  })

  it('signs in through the HostingSigner interface only (a personal message from its address)', async () => {
    const api = fakeApi()
    const key = Wallet.createRandom()
    const inner = localSigner(key.privateKey as `0x${string}`)
    const seen: string[] = []
    const signer = { address: inner.address, signMessage: (m: string) => { seen.push(m); return inner.signMessage(m) }, signTypedData: inner.signTypedData }
    await fluence({ signer, fetchImpl: api.fetchImpl }).login()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain(key.address)
    const sent = api.calls.find((c) => c.path === '/v1/auth/siwe')!.body
    expect(verifyMessage(sent.message, sent.signature)).toBe(key.address)
  })
})
