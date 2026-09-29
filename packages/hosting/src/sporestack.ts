/**
 * SporeStack client. Browser-safe (fetch + Web Crypto only): the launch page uses it to start eggs, and
 * gremlins use it to rent servers under their own tokens when they move out.
 *
 * A token is a bearer secret: whoever knows it can fund, launch, console into, rebuild or delete its servers.
 * API: https://api.sporestack.com/docs
 */

export const SPORESTACK_API = 'https://api.sporestack.com'

export type Currency = 'usdt' | 'btc' | 'xmr' | 'bch'
export type Provider = 'digitalocean' | 'vultr' | 'slowservers' | 'sporestack_eu'

export interface Invoice {
  id?: string
  payment_uri: string
  cryptocurrency: Currency
  /** Cents credited to the token once paid. */
  amount: number
  expires: number
  paid: number
}

export interface LaunchRequest {
  flavor: string
  operating_system: string
  provider: Provider
  /** null lets DigitalOcean pick any region with capacity; other providers need one. */
  region: string | null
  ssh_key: string
  days?: number
  autorenew?: boolean
  hostname?: string
  /** cloud-init; not supported on slowservers or sporestack_eu. */
  user_data?: string
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** New random token in SporeStack's format: `ss_t_` + 27 base36 chars (~139 bits). */
export function newToken(): string {
  // 252 = 7 * 36, so rejecting bytes >= 252 keeps the draw uniform.
  let out = ''
  while (out.length < 27) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 252 && out.length < 27) out += BASE36[b % 36]
  return 'ss_t_' + out
}

/** Ask the API for a token instead of generating one locally. */
export async function requestToken(baseUrl = SPORESTACK_API, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/token`)
  if (!res.ok) throw new Error(`SporeStack token ${res.status}`)
  return (await res.text()).trim().replace(/^"|"$/g, '')
}

/**
 * A syntactically valid ed25519 public key with no private key: 32 random bytes are almost surely not a
 * point anyone knows the discrete log of. SporeStack requires a key; this one can never be used.
 */
export function unusableSshKey(): string {
  const name = new TextEncoder().encode('ssh-ed25519')
  const pub = crypto.getRandomValues(new Uint8Array(32))
  const buf = new Uint8Array(4 + name.length + 4 + pub.length)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, name.length); buf.set(name, 4)
  dv.setUint32(4 + name.length, pub.length); buf.set(pub, 8 + name.length)
  return `ssh-ed25519 ${btoa(String.fromCharCode(...buf))} gremlin-egg-no-access`
}

export function sporestack(opts: { token: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const base = opts.baseUrl ?? SPORESTACK_API
  const f = opts.fetchImpl ?? fetch
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await f(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`SporeStack ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
  const t = encodeURIComponent(opts.token)
  return {
    token: opts.token,
    balanceCents: async () => (await call<{ cents: number }>('GET', `/token/${t}/balance`)).cents,
    /** Create an invoice to add `dollars` (min 5) paid in `currency`. */
    addFunds: async (dollars: number, currency: Currency) => (await call<{ invoice: Invoice }>('POST', `/token/${t}/add`, { dollars, currency })).invoice,
    invoices: () => call<Invoice[]>('GET', `/token/${t}/invoices`),
    quote: (flavor: string, days: number, provider: Provider) =>
      call<{ cents: number; usd: string }>('GET', `/server/quote?flavor=${encodeURIComponent(flavor)}&days=${days}&provider=${provider}`),
    launch: async (req: LaunchRequest) => (await call<{ machine_id: string }>('POST', `/token/${t}/servers`, req)).machine_id,
    servers: () => call<{ servers: unknown[] }>('GET', `/token/${t}/servers`),
    server: (machineId: string) => call<Record<string, unknown>>('GET', `/token/${t}/servers/${machineId}`),
    topup: (machineId: string, days: number) => call<unknown>('POST', `/token/${t}/servers/${machineId}/topup`, { days }),
    remove: (machineId: string) => call<unknown>('DELETE', `/token/${t}/servers/${machineId}`),
  }
}
export type SporeStack = ReturnType<typeof sporestack>
