/** Deterministic Fluence renewal from USDC already held by the gremlin's hosting account. */
import { existsSync, readFileSync } from 'node:fs'
import { JsonRpcProvider } from 'ethers'
import { fluence, localSigner, TopUpUnderReview, type Fluence, type TopUpAuthorization } from '@gremlins/hosting'
import { usdcOnBase, usdcAuthorizationUsed } from '@gremlins/treasury/base'
import { withFileLock, writeJsonDurable } from '@gremlins/hatch/node'
import { homeFile } from '../env.js'
import type { HostingInfo } from './probes.js'

interface Renewal { usd: number; before: number; at: number; auths: TopUpAuthorization[]; paidAt?: number; underReview?: boolean }
interface Deps {
  now?: () => number
  file?: string
  account?: { hostingKey: string; vmId: string }
  client?: Pick<Fluence, 'login' | 'totalDeposited' | 'topUp'>
  usdc?: () => Promise<bigint>
  used?: (nonce: string) => Promise<boolean>
}
export interface RenewalResult { state: 'skipped' | 'pending' | 'paid'; detail?: string; usd?: number }

export async function renewHosting(info: HostingInfo | undefined, deps: Deps = {}): Promise<RenewalResult> {
  if (process.env.GREMLIN_HOSTING_RENEW === '0' || info?.provider !== 'fluence') return { state: 'skipped' }
  const file = deps.file ?? homeFile('hosting-renewal.json')
  const hasPending = existsSync(file) && !(JSON.parse(readFileSync(file, 'utf8')) as Renewal).paidAt
  if (!hasPending && (info.daysLeft === undefined || info.daysLeft >= 2)) return { state: 'skipped' }
  let account = deps.account
  if (!account) {
    const path = homeFile('hosting.json')
    if (!existsSync(path)) return { state: 'skipped' }
    account = JSON.parse(readFileSync(path, 'utf8'))
  }
  if (!account?.hostingKey || !account.vmId) return { state: 'skipped' }
  return withFileLock(file + '.lock', async () => {
    const now = (deps.now ?? Date.now)()
    let renewal = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Renewal : undefined
    if (renewal?.paidAt && now - renewal.paidAt < 86_400_000) return { state: 'skipped', detail: 'hosting renewal is capped at $10 per 24 hours' }
    const signer = localSigner(account!.hostingKey as `0x${string}`)
    const client = deps.client ?? fluence({ signer })
    const base = new JsonRpcProvider(process.env.GREMLIN_BASE_RPC ?? 'https://mainnet.base.org', 8453, { staticNetwork: true })
    const used = deps.used ?? ((nonce: string) => usdcAuthorizationUsed(base, signer.address, nonce))
    try {
      await client.login()
      if (renewal && !renewal.paidAt) {
        const settled = await client.totalDeposited() >= renewal.before + renewal.usd ||
          (await Promise.all(renewal.auths.map(a => used(a.nonce)))).some(Boolean)
        if (settled) { renewal.paidAt = now; writeJsonDurable(file, renewal); return { state: 'paid', usd: renewal.usd, detail: 'reconciled earlier hosting payment' } }
        if (renewal.underReview || renewal.auths.some(a => !a.validBefore || now < a.validBefore * 1000 + 120_000))
          return { state: 'pending', detail: 'earlier hosting payment remains unresolved; not paying again' }
        // Every authorization is confirmed unused and expired, or nothing was signed: safe to try again.
      }
      const usdc = await (deps.usdc ?? (() => usdcOnBase(base, signer.address)))()
      if (usdc < 10_000_000n) return { state: 'skipped', detail: 'hosting needs credit: send USDC on Base to the hosting account; automatic renewal needs $10' }
      renewal = { usd: 10, before: await client.totalDeposited(), at: now, auths: [] }
      writeJsonDurable(file, renewal)
      const journal = renewal
      try {
        await client.topUp(10, { onAuthorization: a => {
          if (!['TransferWithAuthorization', 'ReceiveWithAuthorization'].includes(a.primaryType))
            throw new Error('hosting renewal requires an EIP-3009 authorization that can be reconciled on chain')
          if (!a.nonce || !(a.validBefore > now / 1000)) throw new Error('hosting authorization has no usable nonce/expiry')
          journal.auths.push(a); writeJsonDurable(file, journal)
        } })
        journal.paidAt = now; writeJsonDurable(file, journal)
        return { state: 'paid', usd: 10, detail: 'bought $10 of Fluence hosting credit from the hosting account USDC' }
      } catch (error) {
        if (error instanceof TopUpUnderReview) { journal.underReview = true; writeJsonDurable(file, journal) }
        throw error
      }
    } finally { base.destroy() }
  })
}
