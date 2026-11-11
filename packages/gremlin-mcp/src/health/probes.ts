/**
 * Network probes for the health monitor: how long hosting is paid for, and what the wallet is worth. Both are slow
 * and rate-limited upstream, so the monitor caches them (HEALTH.hostingEveryMs, walletEveryMs).
 */
import { formatUnits } from 'ethers'
import { JsonRpcProvider as QuaiProvider, Zone } from 'quais'
import { fluence, localSigner, sporestack } from '@gremlins/hosting'
import { chainKeys, homeFile, phrase } from '../env.js'
import { allBalances } from '../wallets/balances.js'
import { QUAI, rpcFor } from '../wallets/chains.js'
import { priceFn } from '../wallets/policy.js'
import { readJson } from './stores.js'

export interface HostingInfo { provider: string; balanceUsd?: number; hourlyUsd?: number; daysLeft?: number; error?: string }

/**
 * Fluence's balance endpoint (/v2/users/balances) is not typed in our client. Read the first plausible USD figure from
 * its items; an unrecognised shape is "unknown", never zero.
 */
export function fluenceBalanceUsd(raw: unknown): number | undefined {
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] })?.items) ? (raw as { items: unknown[] }).items : [raw]
  let total: number | undefined
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const v = ['availableBalance', 'available', 'balance', 'amount'].map((k) => Number(o[k])).find((n) => Number.isFinite(n))
    if (v !== undefined) total = (total ?? 0) + v
  }
  return total
}

/** Fluence (hatch custody: hosting.json) or SporeStack (sporestack.json { token, machineId }, if the gremlin keeps one). */
export async function hostingInfo(opts: { fetchImpl?: typeof fetch } = {}): Promise<HostingInfo | undefined> {
  const fl = readJson<{ provider?: string; hostingKey?: string; vmId?: string }>(homeFile('hosting.json'))
  if (fl?.hostingKey && fl.vmId) {
    try {
      const f = fluence({ signer: localSigner(fl.hostingKey as `0x${string}`), fetchImpl: opts.fetchImpl })
      await f.login()
      const [bal, est] = await Promise.all([f.balance(), f.estimate(fl.vmId)])
      const balanceUsd = fluenceBalanceUsd(bal)
      const hourlyUsd = Number(est.hourlyTotal)
      const daysLeft = balanceUsd !== undefined && hourlyUsd > 0 ? balanceUsd / (hourlyUsd * 24) : undefined
      return { provider: 'fluence', balanceUsd, hourlyUsd: Number.isFinite(hourlyUsd) ? hourlyUsd : undefined, daysLeft, ...(balanceUsd === undefined ? { error: 'balance shape not recognised' } : {}) }
    } catch (e) {
      return { provider: 'fluence', error: (e as Error).message.slice(0, 160) }
    }
  }
  const ss = readJson<{ token?: string; machineId?: string }>(homeFile('sporestack.json'))
  if (ss?.token && ss.machineId) {
    try {
      const s = sporestack({ token: ss.token, fetchImpl: opts.fetchImpl })
      const m = await s.server(ss.machineId)
      // SporeStack servers are prepaid until `expiration` (unix seconds).
      const exp = Number(m.expiration)
      return { provider: 'sporestack', daysLeft: Number.isFinite(exp) && exp > 0 ? Math.max(0, (exp * 1000 - Date.now()) / 86_400_000) : undefined, balanceUsd: (await s.balanceCents()) / 100 }
    } catch (e) {
      return { provider: 'sporestack', error: (e as Error).message.slice(0, 160) }
    }
  }
  return undefined
}

export interface WalletSnapshot {
  totalUsd: number
  /** Undefined when the Quai chain could not be read (then nothing is paid from it). */
  quaiUsd?: number
  /** USD value per asset id, for spotting money arriving. */
  byAsset: Record<string, number>
  errors: string[]
}

/** Every chain's balances valued at live prices (assets without a price count as zero and are listed in errors). */
export async function walletSnapshot(): Promise<WalletSnapshot> {
  const k = await chainKeys()
  const r = await allBalances(k, phrase())
  const quai = new QuaiProvider(rpcFor('quai', QUAI.rpc), undefined, { usePathing: true })
  const price = priceFn({ qiToQuai: (qi) => quai.getLatestQiToQuaiRate(Zone.Cyprus1, qi) })
  const byAsset: Record<string, number> = {}
  const errors = r.errors.map((e) => `${e.chain}: ${e.error}`)
  for (const h of r.holdings.filter((x) => x.amount > 0n)) {
    const v = await price(h.asset, h.amount).catch(() => undefined)
    if (v === undefined) errors.push(`no price for ${formatUnits(h.amount, h.asset.decimals)} ${h.asset.symbol}`)
    byAsset[h.asset.id] = v ?? 0
  }
  return { totalUsd: Object.values(byAsset).reduce((a, b) => a + b, 0), quaiUsd: r.errors.some((e) => e.chain === 'quai') ? undefined : byAsset['quai:quai'] ?? 0, byAsset, errors }
}
