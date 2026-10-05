/**
 * Fluence CPU cloud client for egg servers. Browser-safe (fetch + Web Crypto): the launch page uses it directly
 * (api.fluence.dev allows any origin), and gremlins can use it from Node too.
 *
 * Flow: pay USDC on Base via x402 (the paying wallet *is* the account) → Sign-In with Ethereum → create a VM draft
 * with our cloud-init (private; not readable back) → check the estimate → provision → wait for `launched`.
 * Docs: https://fluence.dev/docs/build/api/x402 · https://api.fluence.dev/docs
 */
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { keccak256, type Hex } from 'viem'

export const FLUENCE_API = 'https://api.fluence.dev'
export const FLUENCE_MIN_TOPUP_USD = 10

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** The fixed message a maker signs to derive their egg-hosting key (deterministic, so recoverable). */
export const EGG_KEY_MESSAGE = 'gremlins: derive my egg hosting key (v1).\nOnly sign this on the gremlins hatch page.'

/**
 * Egg hosting key from the maker's signature of EGG_KEY_MESSAGE. Wallet signatures are deterministic (RFC 6979),
 * so the maker can re-derive it later to reach leftover Fluence balance. It only ever holds hosting money.
 */
export function deriveEggKey(signature: Hex): Hex {
  const k = BigInt(keccak256(signature))
  if (k === 0n || k >= SECP256K1_N) throw new Error('derived key out of range; sign again')
  return keccak256(signature)
}

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

export function fluence(opts: { privateKey: Hex; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const base = opts.baseUrl ?? FLUENCE_API
  const f = opts.fetchImpl ?? fetch
  const account = privateKeyToAccount(opts.privateKey)
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

    /** Pay `amountUsd` USDC on Base via x402 and credit this wallet's Fluence account (created on first payment). */
    async topUp(amountUsd: number): Promise<{ transaction: string; amountUsd: string }> {
      if (amountUsd < FLUENCE_MIN_TOPUP_USD) throw new Error(`Fluence top-ups start at $${FLUENCE_MIN_TOPUP_USD}`)
      const pay = wrapFetchWithPaymentFromConfig(f, {
        schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
        spendControls: { maxAmountPerPayment: `$${amountUsd}` },
      } as never)
      const res = await pay(`${base}/v2/x402/top-up?amountUsd=${amountUsd.toFixed(2)}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) throw new Error('Fluence says the payment is under review; do not pay again')
      if (!res.ok) throw new Error(`Fluence top-up failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`)
      return body
    },

    /** Sign-In with Ethereum (domain must be api.fluence.dev). */
    async login(): Promise<void> {
      const { nonce } = (await (await f(`${base}/v1/auth/siwe/nonce`)).json()) as { nonce: string }
      const message = createSiweMessage({ domain: 'api.fluence.dev', address: account.address, uri: 'https://api.fluence.dev', version: '1', chainId: 8453, nonce })
      const signature = await account.signMessage({ message })
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
    terminate: (vmId: string) => call<FluenceVm>('POST', `/v3/vms/${vmId}/terminate`),
  }
}
export type Fluence = ReturnType<typeof fluence>

/** Egg names: lowercase letters, digits and hyphens, at most 25 characters. */
export const eggVmName = (launchId: string) => `egg-${launchId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 21)}`
