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
import { CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, RPC, type EvmChainId } from './constants.js'
import { gaslessSell, type OrderResult } from './cow.js'
import { quoteBridge, bridgeStatus, type BridgeStatus } from './symbiosis.js'
import type { Symbiosis } from 'symbiosis-js-sdk'
import type { FundingToken } from './tokens.js'

/** CoW's placeholder for the chain's native coin as a buy token. */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

/** Native gas to keep for one approve + one bridge tx, by chain. Generous on purpose; leftovers are tiny. */
export const GAS_FLOAT_WEI: Record<EvmChainId, bigint> = {
  [CHAIN.base]: 30_000_000_000_000n, // 0.00003 ETH
  [CHAIN.bsc]: 300_000_000_000_000n, // 0.0003 BNB
  [CHAIN.ethereum]: 3_000_000_000_000_000n, // 0.003 ETH
}

export type SweepAction =
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
 * Plan a sweep for one chain. Only permit tokens can be swapped without gas; others need native gas for an
 * approval and are skipped when there is none (reported so the runtime can decide).
 */
export function planSweep(h: ChainHoldings, opts: { gasBudgetToken?: FundingToken; gasBudgetAmount?: bigint } = {}): { actions: SweepAction[]; skipped: FundingToken[] } {
  const actions: SweepAction[] = []
  const skipped: FundingToken[] = []
  const floatNeeded = GAS_FLOAT_WEI[h.chainId]

  let needsBridge = h.quaiSynth > 0n
  for (const { token, amount } of h.tokens) {
    if (amount <= 0n || token.address === 'native' || token.address.toLowerCase() === QUAI_SYNTH[h.chainId].toLowerCase()) continue
    if (!token.permit) { skipped.push(token); continue }
    actions.push({ kind: 'swap-to-quai', chainId: h.chainId, token, amount })
    needsBridge = true
  }
  if (needsBridge) {
    if (h.native < floatNeeded) {
      if (opts.gasBudgetToken && opts.gasBudgetAmount) actions.unshift({ kind: 'buy-gas', chainId: h.chainId, payWith: opts.gasBudgetToken, amount: opts.gasBudgetAmount })
      else skipped.push({ chainId: h.chainId, symbol: 'native-gas', address: 'native', decimals: 18 })
    }
    // amount is resolved at execution time (whole synthetic QUAI balance after swaps fill)
    actions.push({ kind: 'bridge-to-quai', chainId: h.chainId, amount: 0n })
  }
  return { actions, skipped }
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

    if (action.kind === 'buy-gas' || action.kind === 'swap-to-quai') {
      const token = action.kind === 'buy-gas' ? action.payWith : action.token
      const buyToken = action.kind === 'buy-gas' ? NATIVE : QUAI_SYNTH[action.chainId]
      log(`${action.kind}: ${action.amount} ${token.symbol} on ${action.chainId} → ${action.kind === 'buy-gas' ? 'native gas' : 'QUAI'}`)
      const order = await gaslessSell({
        signer, provider, chainId: action.chainId, sellToken: token.address, sellTokenPermitDomain: token.permit!,
        buyToken, amount: action.amount, appCode: 'gremlins-sweeper',
      })
      if (order.status !== 'fulfilled') throw new Error(`CoW order ${order.uid} ended ${order.status}`)
      done.push({ action, order })
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
