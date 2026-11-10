/**
 * Fund a Fluence egg from the browser. The hatch service on the board holds the egg's hosting account (a fresh key
 * nobody else has) until the egg runs, then seals it to the egg and deletes its copy; the maker only pays its address.
 *
 *   USDC on Base ─────────────────────────────────────────► hosting address ─(board)─x402─► Fluence ─► egg VM
 *   QUAI ─wrap+Symbiosis─► QUAI on Base at the hosting address ─(board)─CoW gasless─► USDC ─┘
 *
 * Every step reports through a StepHandle (progress.ts): signatures, transactions with explorer links, and
 * background checks, so the maker always sees what is happening.
 */
import { JsonRpcProvider, formatUnits } from 'ethers'
import { BrowserProvider, Contract as QuaiContract } from 'quais'
import { CHAIN, QUAI_SYNTH, USDC, WQUAI, buildAppData, bridgeStatus, createSymbiosis, quaiProvider, quoteBridge, quoteSell, quaiOnBase as quaiAt, usdcOnBase } from '@gremlins/treasury'
import { pelagus } from './pelagus.js'
import type { StepHandle } from './progress.js'

const base = () => new JsonRpcProvider('https://mainnet.base.org', CHAIN.base, { staticNetwork: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const fmtUsd = (micro: bigint) => `$${Number(formatUnits(micro, 6)).toFixed(2)}`

export const usdcBalance = (addr: string) => usdcOnBase(base(), addr)
/** QUAI (synthetic) already at the hosting address on Base, e.g. from a bridge whose page session was lost. */
export const quaiOnBase = (addr: string) => quaiAt(base(), addr)

/**
 * Wait for a Quai transaction through our own RPC connection. Pelagus only signs and sends: its bundled quais
 * (1.0.0-alpha.52) can't parse current Quai block headers (primeTerminusNumber), so tx.wait() through it fails
 * even when the transaction succeeded.
 */
export async function waitQuaiTx(hash: string, onCheck?: () => void, timeoutMs = 10 * 60_000): Promise<void> {
  const p = quaiProvider()
  const end = Date.now() + timeoutMs
  for (;;) {
    const r = await p.getTransactionReceipt(hash).catch(() => null)
    onCheck?.()
    if (r) {
      if ((r as { status?: number }).status === 0) throw new Error(`Quai transaction ${hash} failed`)
      return
    }
    if (Date.now() > end) throw new Error(`Quai transaction ${hash} not confirmed yet; check quaiscan.io before retrying`)
    await sleep(4_000)
  }
}

/** QUAI (wei) to bridge so the hosting address ends up with at least `usdMicro` USDC after bridge + swap. */
export async function quaiNeededFor(usdMicro: bigint, hostingAddress: string): Promise<bigint> {
  const probe = 1000n * 10n ** 18n
  const q = await quoteSell({ chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], buyToken: USDC[CHAIN.base]!, from: hostingAddress, receiver: hostingAddress, sellAmountBeforeFee: probe, app: buildAppData({ appCode: 'gremlins-egg' }) })
  return ((usdMicro * probe) / q.buyAmount) * 105n / 100n + 5n * 10n ** 18n // +5% swap fee/slippage, +5 QUAI bridge fee
}

/**
 * Maker wraps and bridges QUAI to the hosting address on Base with Pelagus (three signatures). `onSent` gets the
 * bridge hash the moment it is broadcast, so a reload never loses track of money in flight.
 */
export async function bridgeQuaiTo(maker: string, hostingAddress: string, quaiWei: bigint, step: StepHandle, onSent: (hash: string) => void): Promise<string> {
  step.start('Preparing the bridge')
  const signer = await new BrowserProvider(pelagus() as never).getSigner(maker)
  const wquai = new QuaiContract(WQUAI, ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], signer)

  const send = async (n: number, label: string, fn: () => Promise<{ hash: string }>) => {
    step.signing(`Confirm "${label}" in Pelagus (${n} of 3)`)
    const tx = await fn()
    step.signed(`${label}: sent, confirming`)
    step.tx('quai', tx.hash, label)
    step.waiting(`${label}: waiting for confirmation`)
    await waitQuaiTx(tx.hash, () => step.touch())
    step.tx('quai', tx.hash, label, 'confirmed')
    return tx.hash
  }

  const have: bigint = await wquai.balanceOf(maker)
  if (have < quaiWei) await send(1, 'Wrap QUAI', () => wquai.deposit({ value: quaiWei - have }))
  else step.signed('QUAI already wrapped')

  const quote = await quoteBridge({ symbiosis: createSymbiosis({ clientId: 'gremlins-hatch' }), direction: { from: 'quai', to: CHAIN.base }, amount: quaiWei, sender: maker, receiver: hostingAddress })
  if ((await wquai.allowance(maker, quote.approveTo)) < quaiWei) await send(2, 'Approve bridge', () => wquai.approve(quote.approveTo, quaiWei))
  else step.signed('Bridge already approved')

  const req = (quote as unknown as { transactionRequest: { to: string; data: string; value?: { toString(): string } } }).transactionRequest
  const hash = await send(3, 'Bridge to Base', async () => {
    const tx = await signer.sendTransaction({ from: maker, to: req.to, data: req.data, value: req.value ? BigInt(req.value.toString()) : 0n })
    onSent(tx.hash)
    return tx
  })
  step.done('All three transactions confirmed')
  return hash
}

/** Follow a Symbiosis transfer until it lands on Base (the hatch service swaps it from there). */
export async function followBridge(bridgeTx: string, step: StepHandle): Promise<void> {
  step.tx('symbiosis', bridgeTx, 'Symbiosis transfer')
  for (;;) {
    const s = await bridgeStatus(CHAIN.quai, bridgeTx).catch(() => ({ status: 'unknown' as const, outHash: undefined }))
    if (s.status === 'success') {
      step.tx('symbiosis', bridgeTx, 'Symbiosis transfer', 'confirmed')
      if (s.outHash) step.tx('base', s.outHash, 'Arrived on Base', 'confirmed')
      return step.done()
    }
    if (s.status === 'stuck' || s.status === 'reverted') throw new Error(`bridge ${s.status}; contact Symbiosis support with tx ${bridgeTx}`)
    step.waiting('Symbiosis relayers are moving your QUAI to Base')
    await sleep(15_000)
  }
}
