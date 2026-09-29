import type { EggAnnouncement, Pulse, Signed, SignedConfig } from '@gremlins/hatch'

export interface BoardClient {
  announce(signed: Signed<EggAnnouncement>): Promise<void>
  fetchConfig(eggAddress: string): Promise<SignedConfig | undefined>
  postPulse(signed: Signed<Pulse>): Promise<void>
}

/** SignedConfig carries a bigint (issuedAt); JSON has none, so it travels as a decimal string. */
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export function httpBoardClient(baseUrl: string, fetchImpl: typeof fetch = fetch): BoardClient {
  const url = (p: string) => new URL(p, baseUrl).toString()
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, replacer) })
    if (!res.ok) throw new Error(`board ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return {
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
