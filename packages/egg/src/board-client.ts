import type { EggAnnouncement, HandoffWire, NestAnnouncement, Pulse, Signed, SignedConfig } from '@gremlins/hatch'

export interface BoardClient {
  announce(signed: Signed<EggAnnouncement>): Promise<void>
  fetchConfig(eggAddress: string): Promise<SignedConfig | undefined>
  postPulse(signed: Signed<Pulse>): Promise<void>
}

/** Move-out: nests announce transport keys, gremlins post sealed handoffs. */
export interface NestBoardClient {
  announceNest(signed: Signed<NestAnnouncement>): Promise<void>
  findNest(launchId: string): Promise<Signed<NestAnnouncement> | undefined>
  postHandoff(nestAddress: string, wire: HandoffWire): Promise<void>
  /** undefined while not yet posted or after it was deleted (nest occupied). */
  fetchHandoff(nestAddress: string): Promise<HandoffWire | undefined>
  latestPulseSeq(address: string): Promise<number | undefined>
}

/** SignedConfig carries a bigint (issuedAt); JSON has none, so it travels as a decimal string. */
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export function httpBoardClient(baseUrl: string, fetchImpl: typeof fetch = fetch): BoardClient & NestBoardClient {
  const url = (p: string) => new URL(p, baseUrl).toString()
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, replacer) })
    if (!res.ok) throw new Error(`board ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const getOptional = async <T>(path: string): Promise<T | undefined> => {
    const res = await fetchImpl(url(path))
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`board ${path} ${res.status}`)
    return (await res.json()) as T
  }
  return {
    announceNest: (signed) => post('/api/nests', signed),
    async findNest(launchId) {
      const r = await getOptional<{ nest: { announcement: NestAnnouncement; signature: string } }>(`/api/nests?launchId=${encodeURIComponent(launchId)}`)
      return r ? { message: r.nest.announcement, signature: r.nest.signature } : undefined
    },
    postHandoff: (nestAddress, signed) => post(`/api/nests/${nestAddress}/handoff`, signed),
    async fetchHandoff(nestAddress) {
      return (await getOptional<{ handoff: HandoffWire }>(`/api/nests/${nestAddress}/handoff`))?.handoff
    },
    async latestPulseSeq(address) {
      const r = await getOptional<{ pulses: { seq: number }[] }>(`/api/gremlins/${address}/pulses?limit=1`)
      return r?.pulses[0]?.seq
    },
    announce: (signed) => post('/api/eggs', signed),
    postPulse: (signed) => post('/api/pulses', signed),
    async fetchConfig(eggAddress) {
      const res = await fetchImpl(url(`/api/eggs/${eggAddress}/config`))
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`board config ${res.status}`)
      const body = (await res.json()) as SignedConfig & { message: { issuedAt: string | bigint } }
      return { ...body, message: { ...body.message, issuedAt: BigInt(body.message.issuedAt) } }
    },
  }
}
