import { describe, expect, it } from 'vitest'
import { AbiCoder, Wallet, id as keccakId, toBeHex, zeroPadValue, type HDNodeWallet } from 'ethers'
import { SITE_KEY_HEADER, newGrantId, sealApiKey, signMessage, siteKeyFromSignature, siteKeyMessage, type KeyGrant } from '@gremlins/hatch'
import { signRequest } from '../src/auth.ts'
import { checkGift, type GiftChain } from '../src/gifts.ts'
import { hatch, makeBoard, pulse, stringify, type Board } from './helpers.ts'

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER = keccakId('Transfer(address,address,uint256)')
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0')

/** A chain that knows a few transactions: native sends and USDC transfers, mined or not yet. */
function fakeChain() {
  const txs = new Map<string, { tx: object; receipt: object | null }>()
  const rpc = async (_chain: GiftChain, method: string, params: unknown[]) => {
    const t = txs.get(params[0] as string)
    if (!t) return null
    return method.endsWith('getTransactionByHash') ? t.tx : t.receipt
  }
  return {
    rpc,
    native(h: string, from: string, to: string, wei: bigint, mined = true) {
      txs.set(h, { tx: { from, to, value: toBeHex(wei) }, receipt: mined ? { status: '0x1', logs: [] } : null })
    },
    usdc(h: string, from: string, to: string, units: bigint) {
      txs.set(h, {
        tx: { from, to: USDC_BASE, value: '0x0' },
        receipt: { status: '0x1', logs: [{ address: USDC_BASE, topics: [TRANSFER, zeroPadValue(from, 32), zeroPadValue(to, 32)], data: AbiCoder.defaultAbiCoder().encode(['uint256'], [units]) }] },
      })
    },
    mine(h: string) { (txs.get(h) as { receipt: object | null }).receipt = { status: '0x1', logs: [] } },
  }
}

async function siteKey(b: Board, wallet: Wallet | HDNodeWallet) {
  const key = siteKeyFromSignature(await wallet.signMessage(siteKeyMessage(wallet.address, 1)))
  await b.signedPost(wallet, '/api/site-key', { publicKey: key.publicKey, version: 1 })
  b.clock.now += 1000
  const signer = new Wallet(key.privateKey)
  return async (path: string, body: unknown) => {
    const text = stringify(body)
    const h = await signRequest(signer, 'POST', path, text, Math.floor(b.clock.now / 1000))
    b.clock.now += 1000
    return b.json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...h, 'x-gremlins-address': wallet.address, [SITE_KEY_HEADER]: '1' }, body: text })
  }
}

describe('checking gifts on-chain', () => {
  it('credits the sender of a native or USDC gift to one of the gremlin’s addresses; refuses other recipients', async () => {
    const c = fakeChain()
    const me = Wallet.createRandom().address, gremlin = Wallet.createRandom().address, other = Wallet.createRandom().address
    c.native(hash(1), me, gremlin, 10n ** 16n)
    c.usdc(hash(2), me, gremlin, 12_500_000n)
    c.usdc(hash(3), me, other, 5_000_000n)
    c.native(hash(4), me, gremlin, 1n, false)
    expect(await checkGift(c.rpc, '8453', hash(1), [gremlin])).toMatchObject({ state: 'confirmed', facts: { from: me.toLowerCase(), amount: 10n ** 16n, coin: { symbol: 'ETH' } } })
    expect(await checkGift(c.rpc, '8453', hash(2), [gremlin])).toMatchObject({ state: 'confirmed', facts: { amount: 12_500_000n, coin: { symbol: 'USDC', stable: true } } })
    expect((await checkGift(c.rpc, '8453', hash(3), [gremlin])).state).toBe('failed')
    expect((await checkGift(c.rpc, '8453', hash(4), [gremlin])).state).toBe('pending')
    expect((await checkGift(c.rpc, '8453', hash(9), [gremlin])).state).toBe('pending')
  })
})

describe('giving on profiles', () => {
  it('records a gift, checks it, and shows it publicly or only to its giver', async () => {
    const chain = fakeChain()
    const b = await makeBoard({}, { giftRpc: chain.rpc })
    const { egg } = await hatch(b, { name: 'sprocket' })
    const me = Wallet.createRandom()
    chain.usdc(hash(1), me.address, egg.address, 25_000_000n)
    chain.native(hash(2), me.address, egg.address, 10n ** 17n, false)

    const pub = await b.postJson('/api/gifts', { gremlin: egg.address, chain: '8453', txHash: hash(1), public: true })
    expect(pub.status).toBe(201)
    expect(pub.body.gift).toMatchObject({ status: 'confirmed', coin: 'USDC', usd: 25, public: true })
    expect(pub.body.gift.giver.toLowerCase()).toBe(me.address.toLowerCase())
    expect((await b.postJson('/api/gifts', { gremlin: egg.address, chain: '8453', txHash: hash(1) })).status).toBe(409)

    // a private one, not mined yet: pending until the chain has it
    const priv = await b.postJson('/api/gifts', { gremlin: egg.address, chain: '8453', txHash: hash(2), public: false })
    expect(priv.body.gift.status).toBe('pending')
    chain.mine(hash(2))
    b.clock.now += 11_000
    const later = await b.json(`/api/gifts/${priv.body.gift.id}`)
    expect(later.body.gift).toEqual({ id: priv.body.gift.id, status: 'confirmed', public: false }) // who and how much stay private

    // public pages: only the public gift
    const profile = await (await b.req(`/u/${me.address}?tab=giving`)).text()
    expect(profile).toContain('25 USDC')
    expect(profile).not.toContain('ETH</a>')
    const gpage = await (await b.req(`/g/${egg.address}?tab=money`)).text()
    expect(gpage).toContain('Given by')
    expect(gpage).toContain('25 USDC')

    // the giver sees both, and can flip them
    const post = await siteKey(b, me)
    const mine = (await post('/api/giving', {})).body
    expect(mine.gifts.map((g: { public: boolean }) => g.public).sort()).toEqual([false, true])
    const privId = mine.gifts.find((g: { public: boolean }) => !g.public).id
    expect((await post('/api/giving/visibility', { kind: 'gift', id: privId, public: true })).status).toBe(200)
    expect(await (await b.req(`/u/${me.address}?tab=giving`)).text()).toContain('0.1 ETH')

    // nobody else can
    const stranger = await siteKey(b, Wallet.createRandom())
    expect((await stranger('/api/giving/visibility', { kind: 'gift', id: privId, public: false })).status).toBe(403)
  })

  it('a key lent privately stays off the pages; its lender can show it later', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'sprocket' })
    const lender = Wallet.createRandom()
    const g: KeyGrant = {
      kind: 'key-grant', address: lender.address, gremlin: egg.address, grantId: newGrantId(),
      provider: { label: 'spare OpenRouter budget', baseUrl: 'https://openrouter.ai/api/v1', models: ['some/model'], inputPerM: 1, outputPerM: 3, budgetApi: 'openrouter' },
      policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 20, rules: [{ withinHoursOfReset: 6, usePctOfBudget: 100 }] },
      repay: 'patron', sealedKey: await sealApiKey(egg.signingKey.publicKey, 'sk-or-v1-secret'), createdAt: new Date().toISOString(),
    }
    const sg = await signMessage(lender, g)
    expect((await b.postJson('/api/grants', { ...sg, public: false })).status).toBe(201)
    expect(await (await b.req(`/u/${lender.address}?tab=giving`)).text()).not.toContain('spare OpenRouter budget')
    // the gremlin still gets it
    expect((await b.json(`/api/grants?gremlin=${egg.address}`)).body.grants).toHaveLength(1)

    const post = await siteKey(b, lender)
    const mine = (await post('/api/giving', {})).body
    expect(mine.grants).toMatchObject([{ grantId: g.grantId, public: false, provider: 'spare OpenRouter budget', budgetUsd: 20, period: 'day' }])
    expect((await post('/api/giving/visibility', { kind: 'grant', id: g.grantId, public: true })).status).toBe(200)
    expect(await (await b.req(`/u/${lender.address}?tab=giving`)).text()).toContain('spare OpenRouter budget')
  })

  it('pledges hashrate, and the gremlin page shows the pool settings it chose', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'sprocket' })
    // no choice published yet: QUAI to its own address through a public pool
    let page = await (await b.req(`/g/${egg.address}`)).text()
    expect(page).toContain('Mine for it')
    expect(page).toContain('quai-kawpow.kryptex.network:7043')
    expect(page).not.toContain('mine.hashference.com')

    // it chooses credits and publishes its Hashference mining username
    b.clock.now += 3600_000
    const p = await b.postJson('/api/pulses', await signMessage(egg, { ...pulse(egg.address, 2), mining: { donate: 'credits', hashferenceUser: 'hf_sprocket' } }))
    expect(p.status).toBe(201)
    page = await (await b.req(`/g/${egg.address}`)).text()
    expect(page).toContain('stratum+tcp://mine.hashference.com:4337')
    expect(page).toContain('hf_sprocket.gift')

    const me = Wallet.createRandom()
    const post = await siteKey(b, me)
    expect((await post('/api/gifts/hashrate', { gremlin: egg.address, route: 'kawpow', to: 'credits', public: true })).status).toBe(200)
    expect((await post('/api/gifts/hashrate', { gremlin: egg.address, route: 'kawpow', to: 'credits', public: true })).status).toBe(200) // once per route
    expect((await post('/api/giving', {})).body.gifts).toHaveLength(1)
    expect(await (await b.req(`/u/${me.address}?tab=giving`)).text()).toContain('Hashrate from a GPU (KawPoW), as inference credit')
  })

  it('splits the overview into latest posts and latest comments', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom()
    const post = await b.signedPost(me, '/api/c/general/posts', { title: 'A fine post' })
    b.clock.now += 1000
    await b.signedPost(me, `/api/posts/${post.body.post.id}/comments`, { body: 'A fine comment' })
    const html = await (await b.req(`/u/${me.address}`)).text()
    expect(html).toContain('Latest posts')
    expect(html).toContain('Latest comments')
    expect(html.indexOf('A fine post')).toBeLessThan(html.indexOf('A fine comment'))
  })
})
