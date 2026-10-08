/**
 * Launch an egg on Fluence from the browser, funded with QUAI from Pelagus or USDC on Base.
 *
 *   maker signs EGG_KEY_MESSAGE ─► egg hosting key (deterministic, never stored)
 *   QUAI ─wrap+Symbiosis─► QUAI on Base (egg key) ─CoW gasless─► USDC (egg key) ─x402─► Fluence balance
 *   ─SIWE─► create VM draft with cloud-init ─► estimate ─► provision ─► launched
 *
 * Every step reports through a StepHandle (progress.ts): signatures, transactions with explorer links, and
 * background checks, so the maker always sees what is happening.
 */
import { Contract, JsonRpcProvider, Wallet, formatUnits, hexlify, toUtf8Bytes } from 'ethers'
import { BrowserProvider, Contract as QuaiContract } from 'quais'
import {
  CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, USDC, WQUAI, buildAppData, bridgeStatus, createSymbiosis, gaslessSell, quaiProvider, quoteBridge, quoteSell,
} from '@gremlins/treasury'
import { EGG_KEY_MESSAGE, FLUENCE_MIN_TOPUP_USD, deriveEggKey, eggVmName, fluence } from '@gremlins/hosting'
import type { Hex } from 'viem'
import { pelagus } from './pelagus.js'
import type { StepHandle } from './progress.js'

const base = () => new JsonRpcProvider('https://mainnet.base.org', CHAIN.base, { staticNetwork: true })
const ERC20 = ['function balanceOf(address) view returns (uint256)']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const fmtUsd = (micro: bigint) => `$${Number(formatUnits(micro, 6)).toFixed(2)}`

export const usdcBalance = async (addr: string) => (await new Contract(USDC[CHAIN.base]!, ERC20, base()).balanceOf(addr)) as bigint
/** QUAI (synthetic) already at the egg key on Base, e.g. from a bridge whose page session was lost. */
export const quaiOnBase = async (addr: string) => (await new Contract(QUAI_SYNTH[CHAIN.base], ERC20, base()).balanceOf(addr)) as bigint

/** Ask the maker's wallet for the deterministic egg-hosting key. */
export async function eggKey(maker: string, step: StepHandle): Promise<Wallet> {
  step.signing('Confirm the message in Pelagus')
  const sig = (await pelagus().request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(EGG_KEY_MESSAGE)), maker] })) as Hex
  const key = new Wallet(deriveEggKey(sig))
  step.signed()
  step.done(`egg key ${key.address.slice(0, 8)}…`)
  return key
}

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

/** QUAI (wei) to bridge so the egg key ends up with at least `usdMicro` USDC after bridge + swap. */
export async function quaiNeededFor(usdMicro: bigint, eggAddress: string): Promise<bigint> {
  const probe = 1000n * 10n ** 18n
  const q = await quoteSell({ chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], buyToken: USDC[CHAIN.base]!, from: eggAddress, receiver: eggAddress, sellAmountBeforeFee: probe, app: buildAppData({ appCode: 'gremlins-egg' }) })
  return ((usdMicro * probe) / q.buyAmount) * 105n / 100n + 5n * 10n ** 18n // +5% swap fee/slippage, +5 QUAI bridge fee
}

/**
 * Maker wraps and bridges QUAI to the egg key on Base with Pelagus (three signatures). `onSent` gets the bridge
 * hash the moment it is broadcast, so a reload never loses track of money in flight.
 */
export async function bridgeQuaiToEgg(maker: string, eggAddress: string, quaiWei: bigint, step: StepHandle, onSent: (hash: string) => void): Promise<string> {
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

  const quote = await quoteBridge({ symbiosis: createSymbiosis({ clientId: 'gremlins-hatch' }), direction: { from: 'quai', to: CHAIN.base }, amount: quaiWei, sender: maker, receiver: eggAddress })
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

/** Follow the bridge to Base, then swap the egg key's QUAI on Base to USDC gaslessly (CoW, permit). */
export async function swapBridgedQuai(key: Wallet, bridgeTx: string | undefined, bridge: StepHandle, swap: StepHandle): Promise<void> {
  if (bridgeTx) {
    bridge.tx('symbiosis', bridgeTx, 'Symbiosis transfer')
    for (;;) {
      const s = await bridgeStatus(CHAIN.quai, bridgeTx).catch(() => ({ status: 'unknown' as const, outHash: undefined }))
      if (s.status === 'success') {
        bridge.tx('symbiosis', bridgeTx, 'Symbiosis transfer', 'confirmed')
        if (s.outHash) bridge.tx('base', s.outHash, 'Arrived on Base', 'confirmed')
        break
      }
      if (s.status === 'stuck' || s.status === 'reverted') throw new Error(`bridge ${s.status}; contact Symbiosis support with tx ${bridgeTx}`)
      bridge.waiting('Symbiosis relayers are moving your QUAI to Base')
      await sleep(15_000)
    }
  }
  bridge.done()
  const amount = await quaiOnBase(key.address)
  if (amount === 0n) return swap.skip('nothing to swap')
  swap.waiting(`Swapping ${Number(formatUnits(amount, 18)).toFixed(0)} QUAI to USDC on CoW (no gas needed)`)
  const p = base()
  const r = await gaslessSell({ signer: key.connect(p), provider: p, chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], sellTokenPermitDomain: QUAI_SYNTH_PERMIT_DOMAIN, buyToken: USDC[CHAIN.base]!, amount, appCode: 'gremlins-egg' })
  swap.tx('cow-base', r.uid, 'CoW order', r.status === 'fulfilled' ? 'confirmed' : 'failed')
  if (r.txHash) swap.tx('base', r.txHash, 'Swap settled', 'confirmed')
  if (r.status !== 'fulfilled') throw new Error(`swap ${r.status}`)
  swap.done(`received ${fmtUsd(r.executedBuyAmount)} USDC`)
}

/** Top up Fluence from the egg key's USDC, then create and provision the egg VM. Returns the VM id. */
export async function launchOnFluence(key: Wallet, o: { launchId: string; cloudInit: string; topUpUsd?: number }, step: StepHandle): Promise<string> {
  const fl = fluence({ privateKey: key.privateKey as Hex })
  const topUp = o.topUpUsd ?? FLUENCE_MIN_TOPUP_USD
  step.waiting(`Paying $${topUp} to Fluence (x402, no gas)`)
  const paid = await fl.topUp(topUp)
  if (paid.transaction) step.tx('base', paid.transaction, `Fluence top-up $${topUp}`, 'confirmed')
  step.waiting('Signing in to Fluence with the egg key')
  await fl.login()
  step.waiting('Choosing the cheapest small server')
  const [plan, imageId] = await Promise.all([fl.cheapestPlan(1, 2), fl.ubuntuImageId()])
  const draft = await fl.createDraft({ name: eggVmName(o.launchId), plan, imageId, cloudInit: o.cloudInit, idempotencyKey: `egg-${o.launchId}` })
  step.tx('fluence', draft.id, 'Server')
  const est = await fl.estimate(draft.id)
  step.waiting(`Starting the server (about $${Number(est.monthlyTotal).toFixed(2)}/month, billed per second)`)
  await fl.provision(draft.id)
  for (;;) {
    const vm = await fl.vm(draft.id)
    if (vm.status === 'launched') {
      step.tx('fluence', draft.id, 'Server', 'confirmed')
      step.done('server running')
      return draft.id
    }
    if (vm.status === 'failed') throw new Error(`Fluence could not start the server: ${JSON.stringify(vm.failure ?? '')}`)
    step.waiting(`Server ${vm.status}`)
    await sleep(10_000)
  }
}
