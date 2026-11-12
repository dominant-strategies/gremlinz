import type { EggAnnouncement, HandoffWire, NestAnnouncement, Pulse, Sealed, Signed, SignedConfig } from '@gremlins/hatch'
import type { HatchBoardClient } from './hosting.js'
import { withDeadline } from '@gremlins/hatch/node'

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

export function httpBoardClient(baseUrl: string, fetchImpl: typeof fetch = fetch, opts: { timeoutMs?: number; handoffTimeoutMs?: number } = {}): BoardClient & NestBoardClient & HatchBoardClient {
  const url = (p: string) => new URL(p, baseUrl).toString()
  const request = <T>(path: string, run: (signal: AbortSignal) => Promise<T>) =>
    withDeadline(run, path.endsWith('/handoff') ? opts.handoffTimeoutMs ?? 90_000 : opts.timeoutMs ?? 15_000, `board ${path}`)
  const post = (path: string, body: unknown) => request(path, async (signal) => {
    const res = await fetchImpl(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, replacer), signal })
    if (!res.ok) throw new Error(`board ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    await res.body?.cancel()
  })
  const getOptional = <T>(path: string): Promise<T | undefined> => request(path, async (signal) => {
    const res = await fetchImpl(url(path), { signal })
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`board ${path} ${res.status}`)
    return (await res.json()) as T
  })
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
    claimHatch: (claim) => post('/api/hatch/claim', claim),
    async fetchHatchHandoff(eggAddress) {
      const r = await getOptional<{ handoff: Sealed; browserHandoff?: Sealed | null }>(`/api/hatch/handoff/${eggAddress}`)
      return r && { handoff: r.handoff, ...(r.browserHandoff ? { browserHandoff: r.browserHandoff } : {}) }
    },
    announce: (signed) => post('/api/eggs', signed),
    postPulse: (signed) => post('/api/pulses', signed),
    async fetchConfig(eggAddress) {
      const body = await getOptional<SignedConfig & { message: { issuedAt: string | bigint } }>(`/api/eggs/${eggAddress}/config`)
      if (!body) return undefined
      return { ...body, message: { ...body.message, issuedAt: BigInt(body.message.issuedAt) } }
    },
  }
}
