import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { signMessage, verifyMessage, type Pulse } from '../src/protocol.js'
import { grantProblem, newGrantId, openApiKey, publicKeyFromSigned, sealApiKey, type KeyGrant } from '../src/grants.js'

describe('key grants', () => {
  it('lets a lender seal a key to a gremlin found from its pulse, and only the gremlin can open it', async () => {
    const gremlin = Wallet.createRandom()
    const lender = Wallet.createRandom()
    const pulse = await signMessage(gremlin, { kind: 'pulse', address: gremlin.address, seq: 1, at: new Date().toISOString(), tier: 'normal', balances: {}, netWorthQuai: '0', runwayDays: 0, burnRate7dUsd: '0', revenue7dUsd: '0', revenueLifetimeUsd: '0', goals: [] } as Pulse)
    const pub = publicKeyFromSigned(pulse)
    expect(pub).toBe(gremlin.signingKey.publicKey)

    const grant: KeyGrant = {
      kind: 'key-grant', address: lender.address, gremlin: gremlin.address, grantId: newGrantId(),
      provider: { label: 'my OpenRouter key', baseUrl: 'https://openrouter.ai/api/v1', models: ['x/y'], inputPerM: 1, outputPerM: 2, budgetApi: 'openrouter' },
      policy: { period: { every: 'day', resetAt: '00:00' }, budgetUsd: 10, rules: [{ withinHoursOfReset: 6, usePctOfBudget: 100 }] },
      repay: 'patron', sealedKey: await sealApiKey(pub, 'sk-or-secret'), createdAt: new Date().toISOString(),
    }
    const signed = await signMessage(lender, grant)
    expect(verifyMessage(signed)).toBe(true)
    expect(grantProblem(grant)).toBeNull()
    expect(await openApiKey(gremlin.signingKey, grant.sealedKey)).toBe('sk-or-secret')
    await expect(openApiKey(Wallet.createRandom().signingKey, grant.sealedKey)).rejects.toThrow()
    expect(JSON.stringify(signed)).not.toContain('sk-or-secret')
  })

  it('rejects malformed or expired grants', () => {
    const g = { kind: 'key-grant', grantId: newGrantId(), provider: { label: 'x', baseUrl: 'https://a/v1', models: ['m'], inputPerM: 0, outputPerM: 0 }, policy: { period: { every: 'day' }, budgetUsd: 5, rules: [{ withinHoursOfReset: 2, usePctOfBudget: 50 }] } } as unknown as KeyGrant
    expect(grantProblem(g)).toBeNull()
    expect(grantProblem({ ...g, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired')
    expect(grantProblem({ ...g, policy: { ...g.policy, rules: [] } })).toBe('bad policy')
    expect(grantProblem({ ...g, grantId: 'nope' })).toBe('bad grantId')
  })
})
