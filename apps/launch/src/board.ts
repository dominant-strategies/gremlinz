/** The few board endpoints the launch page needs. */
import type { EggAnnouncement, Sealed, SignedConfig } from '@gremlins/hatch'

export interface EggRecord {
  announcement: EggAnnouncement
  status: 'announced' | 'configured' | 'hatched' | string
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

/** A Fluence hatch on the board (apps/board hatch.ts): it holds the egg's hosting account until the egg takes it. */
export interface HatchJobView {
  jobId: string
  channel?: 'stable' | 'canary'
  image?: string | null
  status: 'keygen' | 'funding' | 'paying' | 'topped-up' | 'launching' | 'launched' | 'handed-off' | 'done' | 'failed'
  /** 'mpc': the account key is split between the board and this browser (hatch-mpc.ts). */
  custody?: 'local' | 'mpc'
  /** null until 2-of-2 key generation has finished. */
  hostingAddress: string | null
  minUsd: number
  funds: { usdc: string; quai: string; at: string } | null
  swaps: { uid: string; status: string }[]
  topUp: { transaction: string | null; underReview: boolean; paidAt: string | null } | null
  vmId: string | null
  eggAddress: string | null
  eggPublicKey?: string | null
  /** 2-of-2: this browser's shard is sealed to the egg. */
  browserHandoff?: boolean
  mpcAborted?: boolean
  keyDeleted: boolean
  error: string | null
  /** Fluence hasn't credited the top-up yet, so the server waits (normal for a few minutes; not an error). */
  awaitingCredit?: boolean
}

export function boardApi(baseUrl: string) {
  const u = (p: string) => new URL(p, baseUrl).toString()
  return {
    async createHatch(launch: { maker: string; configHash: string; launchId: string; boardUrl: string; mpcAuth?: string }): Promise<{ jobId: string; custody?: 'local' | 'mpc'; hostingAddress: string | null; minUsd: number }> {
      // The browser may reach the board through localhost while the egg needs its public callback URL.
      // Read it at job creation so changing a tunnel does not require rebuilding the frontend.
      const configRes = await fetch(u('/api/hatch/config'), { cache: 'no-store' })
      if (!configRes.ok) throw new Error(`could not read hatch configuration: ${configRes.status}`)
      const { fluence } = await configRes.json() as { fluence: { boardUrl: string; canary?: boolean } | null }
      if (!fluence) throw new Error('hatching on Fluence is not configured here')
      const body = { ...launch, boardUrl: fluence.boardUrl }
      const canary = typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('canary') === '1'
      let res: Response
      if (canary) {
        if (!fluence.canary) throw new Error('canary hatching is not enabled on this board')
        if (new URL(baseUrl, window.location.href).origin !== window.location.origin) throw new Error('canary launch must use this website’s own board')
        const { signedPost } = await import('./auth.js')
        res = await signedPost('/api/hatch/fluence/canary', body)
      } else res = await fetch(u('/api/hatch/fluence'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`the hatch service refused: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
      return res.json()
    },
    async hatchJob(jobId: string, options: { allowOtherChannel?: boolean; signal?: AbortSignal } = {}): Promise<HatchJobView> {
      const res = await fetch(u(`/api/hatch/${encodeURIComponent(jobId)}`), options.signal ? { signal: options.signal } : undefined)
      if (!res.ok) throw new Error(`hatch status ${res.status}`)
      const job = ((await res.json()) as { job: HatchJobView }).job
      const canary = typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('canary') === '1'
      if (!options.allowOtherChannel && (job.channel === 'canary') !== canary) throw new Error('Resume this hatch through its original stable or canary URL')
      return job
    },
    /** 2-of-2: our key shard, sealed to the egg (only it can open it). */
    async handOverShard(jobId: string, secret: string, sealed: Sealed): Promise<void> {
      const res = await fetch(u(`/api/hatch/${encodeURIComponent(jobId)}/mpc/handoff`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hatch-auth': secret }, body: JSON.stringify({ sealed }) })
      if (!res.ok) throw new Error(`hand-over refused: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
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
