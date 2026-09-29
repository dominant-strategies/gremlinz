/** The few board endpoints the launch page needs. */
import type { EggAnnouncement, SignedConfig } from '@gremlins/hatch'

export interface EggRecord {
  announcement: EggAnnouncement
  status: 'announced' | 'configured' | 'hatched' | string
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export function boardApi(baseUrl: string) {
  const u = (p: string) => new URL(p, baseUrl).toString()
  return {
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
