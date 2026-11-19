/**
 * Network probes for the health monitor: how long hosting is paid for, and what the wallet is worth. Both are slow
 * and rate-limited upstream, so the monitor caches them (HEALTH.hostingEveryMs, walletEveryMs).
 */
import { formatUnits } from 'ethers'
import { JsonRpcProvider as QuaiProvider, Zone } from 'quais'
import { fluence, localSigner, sporestack, type FluenceCharge } from '@gremlins/hosting'
import { chainKeys, homeFile, phrase } from '../env.js'
import { allBalances } from '../wallets/balances.js'
import { QUAI, rpcFor } from '../wallets/chains.js'
import { priceFn } from '../wallets/policy.js'
import { readJson } from './stores.js'

export interface HostingInfo { provider: string; balanceUsd?: number; hourlyUsd?: number; daysLeft?: number; error?: string }

function billingNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Fluence labels the CPU balance "usage". Accept the older unlabeled shape as well.
 */
export function fluenceBalanceUsd(raw: unknown): number | undefined {
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] })?.items) ? (raw as { items: unknown[] }).items : [raw]
  const balances = items.filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
  const cpu = balances.some((it) => typeof it.featureKey === 'string') ? balances.filter((it) => it.featureKey === 'usage') : balances
  let total: number | undefined
  for (const it of cpu) {
    const balance = ['availableBalance', 'available', 'balance', 'amount'].map((key) => billingNumber(it[key])).find((value) => value !== undefined)
    if (balance === undefined) return undefined
    total = (total ?? 0) + balance
  }
  return Number.isFinite(total) ? total : undefined
}

/** Use the newest account billing day that covers the VM and its attached billable resources. */
function fluenceHourlyUsd(charges: FluenceCharge[], days: string[], resourceIds: string[]): number | undefined {
  if (!Array.isArray(charges)) return undefined
  for (const day of days) {
    const rows = charges.filter((row) => row?.periodStart?.slice(0, 10) === day)
    const billed = new Set<string>()
    let hourlyUsd = 0
    for (const row of rows) {
      const cost = billingNumber(row.totalCost)
      const hours = billingNumber(row.totalUsageHours)
      if (cost === 0 && hours === 0) continue
      if (cost === undefined || cost < 0 || hours === undefined || hours <= 0) return undefined
      if (row.resourceId) billed.add(row.resourceId)
      hourlyUsd += cost / hours
    }
    if (resourceIds.every((id) => billed.has(id)) && Number.isFinite(hourlyUsd) && hourlyUsd > 0) return hourlyUsd
  }
  return undefined
}

/** Fluence (hatch custody: hosting.json) or SporeStack (sporestack.json { token, machineId }, if the gremlin keeps one). */
export async function hostingInfo(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<HostingInfo | undefined> {
  const fl = readJson<{ provider?: string; hostingKey?: string; vmId?: string }>(homeFile('hosting.json'))
  if (fl?.hostingKey && fl.vmId) {
    let balanceUsd: number | undefined
    try {
      const f = fluence({ signer: localSigner(fl.hostingKey as `0x${string}`), fetchImpl: opts.fetchImpl })
      await f.login()
      balanceUsd = fluenceBalanceUsd(await f.balance())
      if (balanceUsd === undefined) return { provider: 'fluence', error: 'balance shape not recognised' }
      const now = (opts.now ?? Date.now)()
      const today = new Date(now).toISOString().slice(0, 10)
      const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10)
      const [vm, interfaces, charges] = await Promise.all([f.vm(fl.vmId), f.vmInterfaces(fl.vmId), f.dailyCharges(yesterday, today)])
      if (vm.status !== 'launched' || !vm.bootDiskId) return { provider: 'fluence', balanceUsd, error: 'running VM billing resources unavailable' }
      const disks = [vm.bootDiskId, ...(vm.dataDiskIds ?? [])]
      const ips = interfaces.items.flatMap((iface) => iface.publicIpId ? [iface.publicIpId] : [])
      const hourlyUsd = fluenceHourlyUsd(charges, [today, yesterday], [fl.vmId, ...disks, ...ips])
      if (hourlyUsd === undefined) return { provider: 'fluence', balanceUsd, error: 'incomplete recent charges for the running VM' }
      const daysLeft = Math.max(0, balanceUsd) / (hourlyUsd * 24)
      return { provider: 'fluence', balanceUsd, hourlyUsd, ...(Number.isFinite(daysLeft) ? { daysLeft } : {}) }
    } catch (e) {
      return { provider: 'fluence', balanceUsd, error: (e as Error).message.slice(0, 160) }
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
