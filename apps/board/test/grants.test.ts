import { describe, expect, it } from 'vitest'
import { Wallet, type HDNodeWallet } from 'ethers'
import { newGrantId, openApiKey, sealApiKey, signMessage, type KeyGrant, type KeyRevoke } from '@gremlins/hatch'
import { hatch, makeBoard } from './helpers.ts'

async function grant(lender: Wallet | HDNodeWallet, gremlin: { address: string; signingKey: { publicKey: string } }, over: Partial<KeyGrant> = {}) {
  const g: KeyGrant = {
    kind: 'key-grant', address: lender.address, gremlin: gremlin.address, grantId: newGrantId(),
    provider: { label: 'spare OpenRouter budget', baseUrl: 'https://openrouter.ai/api/v1', models: ['some/model'], inputPerM: 1, outputPerM: 3, budgetApi: 'openrouter' },
    policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 20, rules: [{ withinHoursOfReset: 6, usePctOfBudget: 100 }] },
    repay: 'patron', sealedKey: await sealApiKey(gremlin.signingKey.publicKey, 'sk-or-v1-secret'), createdAt: new Date().toISOString(),
    ...over,
  }
  return signMessage(lender, g)
}

describe('key grants on the board', () => {
  it('relays a sealed grant to a hatched gremlin, lists it, credits the lender publicly, and lets the lender revoke it', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: 'sprocket' })
    const lender = Wallet.createRandom()
    const sg = await grant(lender, egg)
    expect((await b.postJson('/api/grants', sg)).status).toBe(201)
    expect((await b.postJson('/api/grants', sg)).status).toBe(409)

    const list = await b.json(`/api/grants?gremlin=${egg.address}`)
    expect(list.body.grants).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toContain('sk-or-v1-secret')
    expect(await openApiKey(egg.signingKey, list.body.grants[0].message.sealedKey)).toBe('sk-or-v1-secret')

    // the lender is credited in the public activity feed
    const feed = await b.json('/api/feed')
    expect(feed.body.events.some((e: { kind: string; label?: string }) => e.kind === 'grant' && e.label === 'spare OpenRouter budget')).toBe(true)

    const stranger = Wallet.createRandom()
    const bad: KeyRevoke = { kind: 'key-revoke', address: stranger.address, grantId: sg.message.grantId, createdAt: new Date().toISOString() }
    expect((await b.postJson('/api/grants/revoke', await signMessage(stranger, bad))).status).toBe(403)
    const ok: KeyRevoke = { ...bad, address: lender.address }
    expect((await b.postJson('/api/grants/revoke', await signMessage(lender, ok))).status).toBe(200)
    expect((await b.json(`/api/grants?gremlin=${egg.address}`)).body.grants).toHaveLength(0)
    expect((await b.json(`/api/grants?gremlin=${egg.address}&includeRevoked=1`)).body.grants[0].revokedAt).toBeTruthy()
  })

  it('rejects forged, expired, or misaddressed grants', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const lender = Wallet.createRandom()
    const sg = await grant(lender, egg)
    expect((await b.postJson('/api/grants', { ...sg, message: { ...sg.message, repay: 'syndicate' } })).status).toBe(401)
    expect((await b.postJson('/api/grants', await grant(lender, egg, { expiresAt: '2020-01-01T00:00:00Z' }))).status).toBe(400)
    const nobody = Wallet.createRandom()
    expect((await b.postJson('/api/grants', await grant(lender, nobody))).status).toBe(404)
  })

  it('refuses grants for providers whose terms forbid lending, and keeps the lender\'s signed wishes', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const lender = Wallet.createRandom()
    const forbidden = await grant(lender, egg, { provider: { id: 'mistral', label: 'my Mistral key', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large'], inputPerM: 1, outputPerM: 1, budgetApi: 'none' } })
    const r = await b.postJson('/api/grants', forbidden)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/forbids lending: Mistral/)
    // Calling it something else doesn't help: the host decides.
    expect((await b.postJson('/api/grants', await grant(lender, egg, { provider: { label: 'x', baseUrl: 'https://api.openai.com/v1', models: ['gpt'], inputPerM: 1, outputPerM: 1, budgetApi: 'none' } }))).status).toBe(400)

    const wishes = { purposes: ['sell 10 haiku'], forbidden: 'no spam', preferredModels: ['some/model'], creditAs: '@lender' }
    const sg = await grant(lender, egg, { wishes })
    expect((await b.postJson('/api/grants', sg)).status).toBe(201)
    expect((await b.json(`/api/grants?gremlin=${egg.address}`)).body.grants[0].message.wishes).toEqual(wishes)
    // Changing a wish breaks the signature: it takes a new grant.
    const tampered = { ...sg, message: { ...sg.message, grantId: newGrantId(), wishes: { ...wishes, forbidden: '' } } }
    expect((await b.postJson('/api/grants', tampered)).status).toBe(401)
  })

  it('takes the gremlin\'s report that a provider refused a lent key, and only from that gremlin', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const lender = Wallet.createRandom()
    const sg = await grant(lender, egg)
    await b.postJson('/api/grants', sg)
    const report = (who: { address: string }) => ({ kind: 'grant-status' as const, address: who.address, grantId: sg.message.grantId, status: 'disabled' as const, httpStatus: 401, reason: 'the provider refused the key (401)', createdAt: new Date().toISOString() })
    expect((await b.postJson('/api/grants/status', await signMessage(lender, report(lender)))).status).toBe(403)
    expect((await b.postJson('/api/grants/status', { ...(await signMessage(egg, report(egg))), message: { ...report(egg), httpStatus: 403 } })).status).toBe(401)
    expect((await b.postJson('/api/grants/status', await signMessage(egg, report(egg)))).status).toBe(200)
    expect((await b.postJson('/api/grants/status', await signMessage(egg, report(egg)))).status).toBe(409)
    const g = (await b.json(`/api/grants?gremlin=${egg.address}`)).body.grants[0]
    expect(g.status).toBe('disabled')
    expect(g.statusDetail).toMatchObject({ httpStatus: 401, reason: 'the provider refused the key (401)' })
  })

  it('offers "Lend capacity" on a hatched gremlin\'s page', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b)
    const page = await (await b.req(`/g/${egg.address}`)).text()
    expect(page).toContain(`href="/lend/?gremlin=${egg.address}"`)
  })
})
