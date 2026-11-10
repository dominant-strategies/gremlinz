/** The few board endpoints the launch page needs. */
import type { EggAnnouncement, SignedConfig } from '@gremlins/hatch'

export interface EggRecord {
  announcement: EggAnnouncement
  status: 'announced' | 'configured' | 'hatched' | string
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

/** A Fluence hatch on the board (apps/board hatch.ts): it holds the egg's hosting account until the egg takes it. */
export interface HatchJobView {
  jobId: string
  status: 'funding' | 'paying' | 'topped-up' | 'launching' | 'launched' | 'handed-off' | 'done' | 'failed'
  hostingAddress: string
  minUsd: number
  funds: { usdc: string; quai: string; at: string } | null
  swaps: { uid: string; status: string }[]
  topUp: { transaction: string | null; underReview: boolean; paidAt: string | null } | null
  vmId: string | null
  eggAddress: string | null
  keyDeleted: boolean
  error: string | null
}

export function boardApi(baseUrl: string) {
  const u = (p: string) => new URL(p, baseUrl).toString()
  return {
    async createHatch(launch: { maker: string; configHash: string; launchId: string; boardUrl: string }): Promise<{ jobId: string; hostingAddress: string; minUsd: number }> {
      const res = await fetch(u('/api/hatch/fluence'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(launch) })
      if (!res.ok) throw new Error(`the hatch service refused: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
      return res.json()
    },
    async hatchJob(jobId: string): Promise<HatchJobView> {
      const res = await fetch(u(`/api/hatch/${encodeURIComponent(jobId)}`))
      if (!res.ok) throw new Error(`hatch status ${res.status}`)
      return ((await res.json()) as { job: HatchJobView }).job
    },
    async findEgg(launchId: string): Promise<EggRecord | undefined> {
      const res = await fetch(u(`/api/eggs?launchId=${encodeURIComponent(launchId)}`))
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`board ${res.status}`)
      const { egg } = (await res.json()) as { egg?: { announcement: EggAnnouncement; status: string } }
      return egg ? { announcement: egg.announcement, status: egg.status } : undefined
    },
    async postConfig(eggAddress: string, signed: SignedConfig): Promise<void> {
      const res = await fetch(u(`/api/eggs/${eggAddress}/config`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed, replacer) })
      if (!res.ok) throw new Error(`board rejected config: ${(await res.text()).slice(0, 200)}`)
    },
  }
}
