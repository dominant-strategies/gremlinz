/**
 * Funding sweeper: bring money that arrived on Ethereum, Base or BSC home to QUAI on Quai.
 *
 *   token ──CoW (gasless, permit)──► synthetic QUAI ──Symbiosis bridge──► WQUAI on Quai
 *
 * The bridge leg is an ordinary EVM transaction, so the sweeper first makes sure there is a little native gas,
 * buying it gaslessly through CoW if needed. Callers decide *what* to sweep (see policy.sweepPlan); this
 * module only plans and executes routes.
 */
import { Contract, JsonRpcProvider, type Signer } from 'ethers'
import { CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, RPC, WRAPPED_NATIVE, type EvmChainId } from './constants.js'
import { gaslessSell, type OrderResult } from './cow.js'
import { quoteBridge, bridgeStatus, type BridgeStatus } from './symbiosis.js'
import type { Symbiosis } from 'symbiosis-js-sdk'
import { FUNDING_TOKENS, type FundingToken } from './tokens.js'

/** CoW's placeholder for the chain's native coin as a buy token. */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

/** Native gas to keep for one approve + one bridge tx, by chain. Generous on purpose; leftovers are tiny. */
export const GAS_FLOAT_WEI: Record<EvmChainId, bigint> = {
  [CHAIN.base]: 30_000_000_000_000n, // 0.00003 ETH
  [CHAIN.bsc]: 300_000_000_000_000n, // 0.0003 BNB
  [CHAIN.ethereum]: 3_000_000_000_000_000n, // 0.003 ETH
}

/** Gas coin above this many gas floats is treated as funding: wrapped and swapped to QUAI. */
export const NATIVE_RESERVE_FLOATS = 4n
const MIN_WRAP_FLOATS = 10n

export type SweepAction =
  | { kind: 'wrap-native'; chainId: EvmChainId; amount: bigint }
  | { kind: 'swap-to-quai'; chainId: EvmChainId; token: FundingToken; amount: bigint }
  | { kind: 'buy-gas'; chainId: EvmChainId; payWith: FundingToken; amount: bigint }
  | { kind: 'bridge-to-quai'; chainId: EvmChainId; amount: bigint }

export interface ChainHoldings {
  chainId: EvmChainId
  native: bigint
  tokens: { token: FundingToken; amount: bigint }[]
  quaiSynth: bigint
}

/**
 * Plan a sweep for one chain. Permit tokens swap gaslessly. Tokens without permit, and spare gas coin (wrapped
 * first), need gas for an approval: they are swapped when the chain has gas, otherwise skipped (reported so the
 * runtime can decide). A reserve of gas coin is always kept for the approvals and the bridge.
 */
export function planSweep(h: ChainHoldings, opts: { gasBudgetToken?: FundingToken; gasBudgetAmount?: bigint } = {}): { actions: SweepAction[]; skipped: FundingToken[] } {
  const actions: SweepAction[] = []
  const skipped: FundingToken[] = []
  const floatNeeded = GAS_FLOAT_WEI[h.chainId]
  const hasGas = h.native >= floatNeeded
  const wrapped = WRAPPED_NATIVE[h.chainId].toLowerCase()

  let needsBridge = h.quaiSynth > 0n
  // spare gas coin: keep a reserve, wrap and sell the rest
  const spare = h.native - floatNeeded * NATIVE_RESERVE_FLOATS
  if (spare >= floatNeeded * MIN_WRAP_FLOATS) {
    const wToken = FUNDING_TOKENS.find((t) => t.chainId === h.chainId && t.address.toLowerCase() === wrapped)!
    actions.push({ kind: 'wrap-native', chainId: h.chainId, amount: spare })
    // amount resolved at execution time (whole wrapped balance, including any received directly)
    actions.push({ kind: 'swap-to-quai', chainId: h.chainId, token: wToken, amount: 0n })
    needsBridge = true
  }
  for (const { token, amount } of h.tokens) {
    if (amount <= 0n || token.address === 'native' || token.address.toLowerCase() === QUAI_SYNTH[h.chainId].toLowerCase()) continue
    if (!token.permit && !hasGas) { skipped.push(token); continue }
    actions.push({ kind: 'swap-to-quai', chainId: h.chainId, token, amount })
    needsBridge = true
  }
  if (needsBridge) {
    if (!hasGas) {
      if (opts.gasBudgetToken && opts.gasBudgetAmount) actions.unshift({ kind: 'buy-gas', chainId: h.chainId, payWith: opts.gasBudgetToken, amount: opts.gasBudgetAmount })
      else skipped.push({ chainId: h.chainId, symbol: 'native-gas', address: 'native', decimals: 18 })
    }
    // amount is resolved at execution time (whole synthetic QUAI balance after swaps fill)
    actions.push({ kind: 'bridge-to-quai', chainId: h.chainId, amount: 0n })
  }
  // a directly received wrapped token and a wrap of spare gas coin are one swap
  const seen = new Set<string>()
  return {
    actions: actions.filter((a) => {
      if (a.kind !== 'swap-to-quai' || a.token.address.toLowerCase() !== wrapped) return true
      if (seen.has(wrapped)) return false
      seen.add(wrapped)
      return true
    }).map((a) => (a.kind === 'swap-to-quai' && a.token.address.toLowerCase() === wrapped ? { ...a, amount: 0n } : a)),
    skipped,
  }
}

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]

export interface SweepContext {
  signer: Signer
  symbiosis: Symbiosis
  /** Quai address that receives the bridged WQUAI. */
  quaiAddress: string
  rpc?: Record<number, string>
  log?: (msg: string) => void
}

export type SweepResult =
  | { action: SweepAction }
  | { action: SweepAction; order: OrderResult & { uid: string } }
  | { action: SweepAction; bridgeTx: string; status: BridgeStatus }

/** Execute planned actions in order. Stops at the first failure and returns what completed. */
export async function executeSweep(ctx: SweepContext, actions: SweepAction[]): Promise<SweepResult[]> {
  const log = ctx.log ?? (() => {})
  const done: SweepResult[] = []
  for (const action of actions) {
    const provider = new JsonRpcProvider((ctx.rpc ?? RPC)[action.chainId], action.chainId, { staticNetwork: true })
    const signer = ctx.signer.connect(provider)
    const me = await signer.getAddress()

    if (action.kind === 'wrap-native') {
      log(`wrap-native: ${action.amount} on ${action.chainId}`)
      const w = new Contract(WRAPPED_NATIVE[action.chainId], ['function deposit() payable'], signer)
      await (await w.deposit({ value: action.amount })).wait()
      done.push({ action })
      continue
    }

    if (action.kind === 'buy-gas' || action.kind === 'swap-to-quai') {
      const token = action.kind === 'buy-gas' ? action.payWith : action.token
      let amount = action.amount
      if (amount === 0n) amount = await new Contract(token.address, ERC20, signer).balanceOf(me) // resolved now (wrapped coin)
      if (amount === 0n) continue
      const buyToken = action.kind === 'buy-gas' ? NATIVE : QUAI_SYNTH[action.chainId]
      log(`${action.kind}: ${amount} ${token.symbol} on ${action.chainId} → ${action.kind === 'buy-gas' ? 'native gas' : 'QUAI'}`)
      const order = await gaslessSell({
        signer, provider, chainId: action.chainId, sellToken: token.address, sellTokenPermitDomain: token.permit,
        buyToken, amount, appCode: 'gremlins-sweeper',
      })
      if (order.status !== 'fulfilled') throw new Error(`CoW order ${order.uid} ended ${order.status}`)
      done.push({ action: { ...action, amount }, order })
      continue
    }

    // bridge-to-quai: bridge the whole synthetic QUAI balance
    const synth = new Contract(QUAI_SYNTH[action.chainId], ERC20, signer)
    const amount: bigint = await synth.balanceOf(me)
    if (amount === 0n) continue
    const quote = await quoteBridge({ symbiosis: ctx.symbiosis, direction: { from: action.chainId, to: 'quai' }, amount, sender: me, receiver: ctx.quaiAddress })
    if ((await synth.allowance(me, quote.approveTo)) < amount) await (await synth.approve(quote.approveTo, amount)).wait()
    const req = (quote as unknown as { transactionRequest: { to: string; data: string; value?: { toString(): string } } }).transactionRequest
    log(`bridge-to-quai: ${amount} QUAI from ${action.chainId}`)
    const tx = await signer.sendTransaction({ to: req.to, data: req.data, value: req.value ? BigInt(req.value.toString()) : 0n })
    await tx.wait()
    done.push({ action: { ...action, amount }, bridgeTx: tx.hash, status: await bridgeStatus(action.chainId, tx.hash) })
  }
  return done
}
