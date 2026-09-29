/**
 * Gasless swaps through CoW Protocol. The seller signs an EIP-2612 permit and a CoW order off-chain;
 * the permit runs as a pre-hook inside the settlement, so the seller never needs native gas.
 * Proven on Base mainnet: see research/launch-checks.md §7.
 */
import { Contract, Signature, keccak256, toUtf8Bytes, type Provider, type Signer, type TypedDataDomain } from 'ethers'
import { COW, type EvmChainId } from './constants.js'

export interface Hook {
  target: string
  callData: string
  gasLimit: string
}

export interface PermitDomain {
  name: string
  version: string
}

const ERC2612 = [
  'function nonces(address) view returns (uint256)',
  'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
]

/** Sign an EIP-2612 permit for the CoW vault relayer and wrap it as a pre-hook. */
export async function permitHook(opts: {
  signer: Signer
  provider: Provider
  chainId: EvmChainId
  token: string
  domain: PermitDomain
  value: bigint
  deadline: bigint
  spender?: string
}): Promise<Hook> {
  const owner = await opts.signer.getAddress()
  const spender = opts.spender ?? COW.vaultRelayer
  const token = new Contract(opts.token, ERC2612, opts.provider)
  const nonce: bigint = await token.nonces(owner)
  const sig = Signature.from(
    await opts.signer.signTypedData(
      { ...opts.domain, chainId: opts.chainId, verifyingContract: opts.token },
      {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { owner, spender, value: opts.value, nonce, deadline: opts.deadline },
    ),
  )
  const callData = token.interface.encodeFunctionData('permit', [owner, spender, opts.value, opts.deadline, sig.v, sig.r, sig.s])
  // Fail fast if the permit is invalid rather than letting the order sit unfillable.
  await opts.provider.call({ to: opts.token, data: callData, from: '0x000000000000000000000000000000000000dEaD' })
  return { target: opts.token, callData, gasLimit: '100000' }
}

export interface AppData {
  appData: string
  appDataHash: string
}

export function buildAppData(opts: { appCode: string; preHooks?: Hook[]; postHooks?: Hook[] }): AppData {
  const hooks: Record<string, unknown> = { version: '0.1.0' }
  if (opts.preHooks?.length) hooks.pre = opts.preHooks
  if (opts.postHooks?.length) hooks.post = opts.postHooks
  const appData = JSON.stringify({ appCode: opts.appCode, metadata: { hooks }, version: '1.3.0' })
  return { appData, appDataHash: keccak256(toUtf8Bytes(appData)) }
}

export interface CowQuote {
  id: number
  sellAmount: bigint
  feeAmount: bigint
  buyAmount: bigint
  validTo: number
}

export async function quoteSell(opts: {
  chainId: EvmChainId
  sellToken: string
  buyToken: string
  from: string
  receiver: string
  sellAmountBeforeFee: bigint
  app: AppData
  fetchImpl?: typeof fetch
}): Promise<CowQuote> {
  const f = opts.fetchImpl ?? fetch
  const res = await f(`${COW.api[opts.chainId]}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sellToken: opts.sellToken,
      buyToken: opts.buyToken,
      from: opts.from,
      receiver: opts.receiver,
      kind: 'sell',
      sellAmountBeforeFee: opts.sellAmountBeforeFee.toString(),
      signingScheme: 'eip712',
      onchainOrder: false,
      appData: opts.app.appData,
      appDataHash: opts.app.appDataHash,
      validFor: 1800,
    }),
  })
  const body = await res.json()
  if (!res.ok || !body.quote) throw new Error(`CoW quote failed: ${JSON.stringify(body).slice(0, 300)}`)
  return {
    id: body.id,
    sellAmount: BigInt(body.quote.sellAmount),
    feeAmount: BigInt(body.quote.feeAmount),
    buyAmount: BigInt(body.quote.buyAmount),
    validTo: body.quote.validTo,
  }
}

export interface CowOrder {
  sellToken: string
  buyToken: string
  receiver: string
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: string
  feeAmount: string
  kind: 'sell'
  partiallyFillable: boolean
  sellTokenBalance: 'erc20'
  buyTokenBalance: 'erc20'
}

/** Orders carry no separate fee: the quoted fee is folded into sellAmount. */
export function orderFromQuote(opts: {
  quote: CowQuote
  sellToken: string
  buyToken: string
  receiver: string
  appDataHash: string
  slippageBps: number
}): CowOrder {
  const buyMin = (opts.quote.buyAmount * BigInt(10_000 - opts.slippageBps)) / 10_000n
  return {
    sellToken: opts.sellToken,
    buyToken: opts.buyToken,
    receiver: opts.receiver,
    sellAmount: (opts.quote.sellAmount + opts.quote.feeAmount).toString(),
    buyAmount: buyMin.toString(),
    validTo: opts.quote.validTo,
    appData: opts.appDataHash,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  }
}

export const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
}

export function orderDomain(chainId: EvmChainId): TypedDataDomain {
  return { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: COW.settlement }
}

export async function submitOrder(opts: {
  chainId: EvmChainId
  signer: Signer
  order: CowOrder
  app: AppData
  quoteId?: number
  fetchImpl?: typeof fetch
}): Promise<string> {
  const f = opts.fetchImpl ?? fetch
  const signature = await opts.signer.signTypedData(orderDomain(opts.chainId), ORDER_TYPES, opts.order)
  const res = await f(`${COW.api[opts.chainId]}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...opts.order,
      appData: opts.app.appData,
      appDataHash: opts.app.appDataHash,
      signingScheme: 'eip712',
      signature,
      from: await opts.signer.getAddress(),
      quoteId: opts.quoteId,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`CoW order rejected: ${JSON.stringify(body).slice(0, 300)}`)
  return body as string
}

export interface OrderResult {
  status: string
  executedSellAmount: bigint
  executedBuyAmount: bigint
  txHash?: string
}

export async function waitForOrder(opts: {
  chainId: EvmChainId
  uid: string
  timeoutMs?: number
  pollMs?: number
  fetchImpl?: typeof fetch
}): Promise<OrderResult> {
  const f = opts.fetchImpl ?? fetch
  const api = COW.api[opts.chainId]
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
  for (;;) {
    const o = await (await f(`${api}/orders/${opts.uid}`)).json()
    if (o.status !== 'open' && o.status !== 'presignaturePending') {
      const trades = await (await f(`${api}/trades?orderUid=${opts.uid}`)).json().catch(() => [])
      return {
        status: o.status,
        executedSellAmount: BigInt(o.executedSellAmount ?? 0),
        executedBuyAmount: BigInt(o.executedBuyAmount ?? 0),
        txHash: trades?.[0]?.txHash,
      }
    }
    if (Date.now() > deadline) return { status: 'timeout', executedSellAmount: 0n, executedBuyAmount: 0n }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 10_000))
  }
}

/** Gasless sell of a permit-capable token: permit hook → quote → order → wait. */
export async function gaslessSell(opts: {
  signer: Signer
  provider: Provider
  chainId: EvmChainId
  sellToken: string
  sellTokenPermitDomain: PermitDomain
  buyToken: string
  amount: bigint
  receiver?: string
  slippageBps?: number
  appCode?: string
}): Promise<OrderResult & { uid: string }> {
  const from = await opts.signer.getAddress()
  const receiver = opts.receiver ?? from
  const hook = await permitHook({
    signer: opts.signer,
    provider: opts.provider,
    chainId: opts.chainId,
    token: opts.sellToken,
    domain: opts.sellTokenPermitDomain,
    value: opts.amount,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  })
  const app = buildAppData({ appCode: opts.appCode ?? 'gremlins', preHooks: [hook] })
  const quote = await quoteSell({ chainId: opts.chainId, sellToken: opts.sellToken, buyToken: opts.buyToken, from, receiver, sellAmountBeforeFee: opts.amount, app })
  const order = orderFromQuote({ quote, sellToken: opts.sellToken, buyToken: opts.buyToken, receiver, appDataHash: app.appDataHash, slippageBps: opts.slippageBps ?? 100 })
  const uid = await submitOrder({ chainId: opts.chainId, signer: opts.signer, order, app, quoteId: quote.id })
  return { uid, ...(await waitForOrder({ chainId: opts.chainId, uid })) }
}
