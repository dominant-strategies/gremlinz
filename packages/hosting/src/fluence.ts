/**
 * Fluence CPU cloud client for egg servers. Browser-safe (fetch + Web Crypto; api.fluence.dev allows any origin). The
 * board's hatch service uses it to launch eggs, and gremlins to run (and sweep) the account they take over.
 *
 * Flow: pay USDC on Base via x402 (the paying wallet *is* the account) → Sign-In with Ethereum → create a VM draft
 * with our cloud-init (private; not readable back) → check the estimate → provision → wait for `launched`.
 * Docs: https://fluence.dev/docs/build/api/x402 · https://api.fluence.dev/docs
 */
import { wrapFetchWithPaymentFromConfig, x402Client, x402HTTPClient } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { createSiweMessage } from 'viem/siwe'
import type { HostingSigner, TypedDataToSign } from './signer.js'

export const FLUENCE_API = 'https://api.fluence.dev'
export const FLUENCE_MIN_TOPUP_USD = 10

export interface Plan {
  clusterId: string
  configurationId: string
  vcpu: number
  ramGb: number
  hourlyUsd: number
}

export interface FluenceVm {
  id: string
  status: string
  bootDiskId?: string
  interfaceIds?: string[]
  hasCloudInit?: boolean
  failure?: unknown
}

export interface Estimate {
  hourlyTotal: string
  monthlyTotal: string
}

/** x402 answered 409: the payment is held for review. Never pay again for it; wait for the credit or a human. */
export class TopUpUnderReview extends Error {
  constructor() {
    super('Fluence says the payment is under review; do not pay again')
  }
}

/** The payment a top-up is about to sign: EIP-3009 (nonce, validBefore) or Permit2 (nonce, deadline). */
export interface TopUpAuthorization {
  primaryType: string
  nonce: string
  /** Unix seconds after which the signed authorization can no longer settle. */
  validBefore: number
  value?: string
}

export function authorizationOf(td: TypedDataToSign): TopUpAuthorization {
  const m = td.message as Record<string, unknown>
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))
  return {
    primaryType: td.primaryType,
    nonce: str(m.nonce) ?? '',
    validBefore: Number(str(m.validBefore) ?? str(m.deadline) ?? 0),
    value: str(m.value) ?? str((m.permitted as Record<string, unknown> | undefined)?.amount),
  }
}

/**
 * Where Fluence takes x402 USDC on Base: asks for a top-up without paying and reads the 402 answer. The maker's browser
 * calls this itself (api.fluence.dev allows any origin) before co-signing a payment, so the board can't name the payee.
 */
export async function fluencePayTo(amountUsd: number, o: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<string[]> {
  const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl ?? FLUENCE_API}/v2/x402/top-up?amountUsd=${amountUsd.toFixed(2)}`, { method: 'POST' })
  if (res.status !== 402) throw new Error(`Fluence answered ${res.status}, not a payment request`)
  const body = await res.json().catch(() => undefined)
  const req = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((h) => res.headers.get(h), body)
  const payTo = req.accepts.filter((a) => a.network === 'eip155:8453').map((a) => a.payTo)
  if (!payTo.length) throw new Error('Fluence names no payee on Base')
  return payTo
}

export function fluence(opts: { signer: HostingSigner; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const base = opts.baseUrl ?? FLUENCE_API
  const f = opts.fetchImpl ?? fetch
  const account = opts.signer
  let token: string | undefined

  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    if (!token) throw new Error('call login() first')
    const res = await f(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Fluence ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  return {
    address: account.address,

    /**
     * Pay `amountUsd` USDC on Base via x402 and credit this wallet's Fluence account (created on first payment).
     * `onAuthorization` sees the payment authorization before it is signed: persist it, and a crash mid-payment can be
     * resolved later (USDC `authorizationState(from, nonce)`, or wait out `validBefore`) instead of paying twice.
     */
    async topUp(amountUsd: number, o: { onAuthorization?: (a: TopUpAuthorization) => void | Promise<void> } = {}): Promise<{ transaction: string; amountUsd: string }> {
      if (amountUsd < FLUENCE_MIN_TOPUP_USD) throw new Error(`Fluence top-ups start at $${FLUENCE_MIN_TOPUP_USD}`)
      const signTypedData = async (td: TypedDataToSign) => {
        await o.onAuthorization?.(authorizationOf(td))
        return account.signTypedData(td)
      }
      const pay = wrapFetchWithPaymentFromConfig(f, {
        schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme({ address: account.address, signTypedData }) }],
        spendControls: { maxAmountPerPayment: `$${amountUsd}` },
      } as never)
      const res = await pay(`${base}/v2/x402/top-up?amountUsd=${amountUsd.toFixed(2)}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) throw new TopUpUnderReview()
      if (!res.ok) throw new Error(`Fluence top-up failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`)
      return body
    },

    /** Lifetime deposits on this account (decimal strings summed). Above zero once any top-up was credited. */
    async totalDeposited(): Promise<number> {
      const { items } = await call<{ items: { totalDepositedAmount: string }[] }>('GET', '/v3/account/balances')
      return items.reduce((a, i) => a + (Number(i.totalDepositedAmount) || 0), 0)
    },

    /** Sign-In with Ethereum (domain must be api.fluence.dev). */
    async login(): Promise<void> {
      const { nonce } = (await (await f(`${base}/v1/auth/siwe/nonce`)).json()) as { nonce: string }
      const message = createSiweMessage({ domain: 'api.fluence.dev', address: account.address, uri: 'https://api.fluence.dev', version: '1', chainId: 8453, nonce })
      const signature = await account.signMessage(message)
      const res = await f(`${base}/v1/auth/siwe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) })
      if (!res.ok) throw new Error(`Fluence sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
      token = ((await res.json()) as { accessToken: string }).accessToken
    },

    balance: () => call<unknown>('GET', '/v2/users/balances'),

    /** Cheapest configuration with at least `minVcpu`/`minRamGb` in a cluster that still has a public IPv4. */
    async cheapestPlan(minVcpu = 1, minRamGb = 2): Promise<Plan> {
      const [{ resources }, { items }] = await Promise.all([
        call<{ resources: Record<string, { availableConfigurations: { id: string; vcpu: number; ramGb: number }[]; availablePublicIps: Record<string, number> }> }>('GET', '/v1/clusters/resources'),
        call<{ items: { vmTypeId: { clusterId: string; vmConfigurationId: string }; priceInfo: { pricePerHourPerQty: string } }[] }>('GET', '/v3/prices/vm'),
      ])
      const price = new Map(items.map((i) => [`${i.vmTypeId.clusterId}/${i.vmTypeId.vmConfigurationId}`, Number(i.priceInfo.pricePerHourPerQty)]))
      const plans: Plan[] = []
      for (const [clusterId, r] of Object.entries(resources)) {
        if (!((r.availablePublicIps?.V4 ?? 0) > 0)) continue
        for (const c of r.availableConfigurations) {
          const hourlyUsd = price.get(`${clusterId}/${c.id}`)
          if (c.vcpu >= minVcpu && c.ramGb >= minRamGb && hourlyUsd !== undefined && Number.isFinite(hourlyUsd)) plans.push({ clusterId, configurationId: c.id, vcpu: c.vcpu, ramGb: c.ramGb, hourlyUsd })
        }
      }
      if (!plans.length) throw new Error('no Fluence configuration with a free public IPv4 matches')
      return plans.sort((a, b) => a.hourlyUsd - b.hourlyUsd)[0]
    },

    /** A catalog Ubuntu image (cloud-init capable). */
    async ubuntuImageId(): Promise<string> {
      const { items } = await call<{ items: { id: string; distribution: string; slug: string; name: string; isDefault: boolean }[] }>('GET', '/v1/storages/default_images')
      const ubuntu = items.filter((i) => /ubuntu/i.test(`${i.distribution} ${i.slug} ${i.name}`))
      const pick = ubuntu.find((i) => /24/.test(i.slug + i.name)) ?? ubuntu.find((i) => i.isDefault) ?? ubuntu[0]
      if (!pick) throw new Error('no Ubuntu image in the Fluence catalog')
      return pick.id
    },

    /** Create a VM draft (nothing billed yet). cloudInit is stored privately and can't be read back. */
    createDraft: (o: { name: string; plan: Plan; imageId: string; cloudInit: string; diskGb?: number; idempotencyKey: string }) =>
      call<FluenceVm>(
        'POST',
        '/v3/vms',
        {
          name: o.name,
          clusterId: o.plan.clusterId,
          configurationId: o.plan.configurationId,
          bootDisk: { kind: 'new', volumeGb: o.diskGb ?? 25, source: { type: 'catalog', imageId: o.imageId } },
          interfaces: [{ kind: 'public', addressType: 'V4', default: true }],
          cloudInit: o.cloudInit,
          sshKeyIds: [], // no SSH keys: nobody logs into an egg
        },
        { 'idempotency-key': o.idempotencyKey },
      ),
    estimate: (vmId: string) => call<Estimate>('GET', `/v3/vms/${vmId}/estimate`),
    provision: (vmId: string) => call<FluenceVm>('POST', `/v3/vms/${vmId}/provision`),
    vm: (vmId: string) => call<FluenceVm>('GET', `/v3/vms/${vmId}`),
    /** Terminate a provisioned VM. Its disks and public IP are retained (and billed) until deleted separately. */
    terminate: (vmId: string, idempotencyKey: string) => call<unknown>('POST', `/v3/vms/${vmId}/terminate`, undefined, { 'idempotency-key': idempotencyKey }),
    /** Throw away a draft (never provisioned). */
    discardDraft: (vmId: string) => call<void>('DELETE', `/v3/vms/${vmId}`),
    listVms: () => paged<FluenceVm & { sshKeyIds?: string[] }>('/v3/vms'),
    /** Replace the VM's SSH keys (Fluence applies them on the next restart). */
    setVmSshKeys: (vmId: string, sshKeyIds: string[]) => call<FluenceVm>('PUT', `/v3/vms/${vmId}/ssh-keys`, { sshKeys: sshKeyIds }),

    // Account access. Anyone holding a sign-in token (2 hours, not revocable) can mint API keys and SSH keys; the owner
    // can list and delete them.
    listApiKeys: async () => (await call<{ items: ApiKey[] }>('GET', '/v3/api-keys')).items,
    deleteApiKey: (id: string) => call<void>('DELETE', `/v3/api-keys/${encodeURIComponent(id)}`),
    listSshKeys: () => paged<SshKey>('/v3/ssh-keys'),
    deleteSshKey: (id: string) => call<unknown>('DELETE', `/v3/ssh-keys/${encodeURIComponent(id)}`),
  }

  async function paged<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= 100; page++) {
      const r = await call<{ items: T[]; pagination?: { totalPages: number } }>('GET', `${path}?page=${page}&perPage=200`)
      out.push(...r.items)
      if (!r.pagination || page >= r.pagination.totalPages || !r.items.length) break
    }
    return out
  }
}

export interface ApiKey {
  id: string
  name: string
  scopes: string[]
  createdAt: string
}

export interface SshKey {
  id: string
  name: string
  fingerprint: string
  /** Set when a managed service created it; read-only for the account. */
  managedService?: { id: string; name: string } | null
}
export type Fluence = ReturnType<typeof fluence>

/** Egg names: lowercase letters, digits and hyphens, at most 25 characters. */
export const eggVmName = (launchId: string) => `egg-${launchId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 21)}`
