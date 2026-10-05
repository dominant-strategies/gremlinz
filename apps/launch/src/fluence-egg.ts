/**
 * Launch an egg on Fluence from the browser, funded with QUAI from Pelagus or USDC on Base.
 *
 *   maker signs EGG_KEY_MESSAGE ─► egg hosting key (deterministic, never stored)
 *   QUAI ─wrap+Symbiosis─► QUAI on Base (egg key) ─CoW gasless─► USDC (egg key) ─x402─► Fluence balance
 *   ─SIWE─► create VM draft with cloud-init ─► estimate ─► provision ─► launched
 *
 * The egg key only ever holds hosting money; the gremlin's own keys are generated on the egg server.
 */
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers'
import { BrowserProvider, Contract as QuaiContract } from 'quais'
import {
  CHAIN, QUAI_SYNTH, QUAI_SYNTH_PERMIT_DOMAIN, USDC, WQUAI, buildAppData, bridgeStatus, createSymbiosis, gaslessSell, quoteBridge, quoteSell,
} from '@gremlins/treasury'
import { EGG_KEY_MESSAGE, FLUENCE_MIN_TOPUP_USD, deriveEggKey, eggVmName, fluence } from '@gremlins/hosting'
import { hexlify, toUtf8Bytes } from 'ethers'
import type { Hex } from 'viem'
import { pelagus } from './pelagus.js'

const base = () => new JsonRpcProvider('https://mainnet.base.org', CHAIN.base, { staticNetwork: true })
const ERC20 = ['function balanceOf(address) view returns (uint256)']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Ask the maker's wallet for the deterministic egg-hosting key. */
export async function eggKey(maker: string): Promise<Wallet> {
  const sig = (await pelagus().request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(EGG_KEY_MESSAGE)), maker] })) as Hex
  return new Wallet(deriveEggKey(sig))
}

export const usdcBalance = async (addr: string) => (await new Contract(USDC[CHAIN.base]!, ERC20, base()).balanceOf(addr)) as bigint
const synthBalance = async (addr: string) => (await new Contract(QUAI_SYNTH[CHAIN.base], ERC20, base()).balanceOf(addr)) as bigint

/** QUAI (wei) to bridge so the egg key ends up with at least `usdMicro` USDC after bridge + swap. */
export async function quaiNeededFor(usdMicro: bigint, eggAddress: string): Promise<bigint> {
  const probe = 1000n * 10n ** 18n
  const q = await quoteSell({ chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], buyToken: USDC[CHAIN.base]!, from: eggAddress, receiver: eggAddress, sellAmountBeforeFee: probe, app: buildAppData({ appCode: 'gremlins-egg' }) })
  return (usdMicro * probe) / q.buyAmount * 105n / 100n + 5n * 10n ** 18n // +5% for swap fee/slippage, +5 QUAI bridge fee
}

/** Maker wraps and bridges QUAI to the egg key on Base with Pelagus (three Quai transactions). Returns the bridge tx. */
export async function bridgeQuaiToEgg(maker: string, eggAddress: string, quaiWei: bigint, status: (s: string) => void): Promise<string> {
  const signer = await new BrowserProvider(pelagus() as never).getSigner(maker)
  const wquai = new QuaiContract(WQUAI, ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], signer)
  const have: bigint = await wquai.balanceOf(maker)
  if (have < quaiWei) {
    status('Confirm in Pelagus: wrap QUAI (1 of 3)…')
    await (await wquai.deposit({ value: quaiWei - have })).wait()
  }
  const quote = await quoteBridge({ symbiosis: createSymbiosis({ clientId: 'gremlins-hatch' }), direction: { from: 'quai', to: CHAIN.base }, amount: quaiWei, sender: maker, receiver: eggAddress })
  if ((await wquai.allowance(maker, quote.approveTo)) < quaiWei) {
    status('Confirm in Pelagus: approve the bridge (2 of 3)…')
    await (await wquai.approve(quote.approveTo, quaiWei)).wait()
  }
  status('Confirm in Pelagus: bridge to Base (3 of 3)…')
  const req = (quote as unknown as { transactionRequest: { to: string; data: string; value?: { toString(): string } } }).transactionRequest
  const tx = await signer.sendTransaction({ from: maker, to: req.to, data: req.data, value: req.value ? BigInt(req.value.toString()) : 0n })
  await tx.wait()
  return tx.hash
}

/** Wait for the bridge, then swap the egg key's QUAI on Base to USDC gaslessly (CoW, permit). */
export async function swapBridgedQuai(key: Wallet, bridgeTx: string, status: (s: string) => void): Promise<void> {
  for (;;) {
    const s = await bridgeStatus(CHAIN.quai, bridgeTx).catch(() => ({ status: 'unknown' as const }))
    if (s.status === 'success') break
    if (s.status === 'stuck' || s.status === 'reverted') throw new Error(`bridge ${s.status}; contact Symbiosis support with tx ${bridgeTx}`)
    status('Bridging QUAI to Base (usually 5–10 minutes)…')
    await sleep(20_000)
  }
  const amount = await synthBalance(key.address)
  if (amount === 0n) return
  status('Swapping to USDC (no gas needed)…')
  const p = base()
  const r = await gaslessSell({ signer: key.connect(p), provider: p, chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], sellTokenPermitDomain: QUAI_SYNTH_PERMIT_DOMAIN, buyToken: USDC[CHAIN.base]!, amount, appCode: 'gremlins-egg' })
  if (r.status !== 'fulfilled') throw new Error(`swap ${r.status}`)
}

/** Top up Fluence from the egg key's USDC, then create and provision the egg VM. Returns the VM id. */
export async function launchOnFluence(key: Wallet, o: { launchId: string; cloudInit: string; topUpUsd?: number }, status: (s: string) => void): Promise<string> {
  const fl = fluence({ privateKey: key.privateKey as Hex })
  const topUp = o.topUpUsd ?? FLUENCE_MIN_TOPUP_USD
  status(`Paying $${topUp} to Fluence from the egg key…`)
  await fl.topUp(topUp)
  status('Signing in to Fluence…')
  await fl.login()
  status('Choosing the cheapest small server…')
  const [plan, imageId] = await Promise.all([fl.cheapestPlan(1, 2), fl.ubuntuImageId()])
  const draft = await fl.createDraft({ name: eggVmName(o.launchId), plan, imageId, cloudInit: o.cloudInit, idempotencyKey: `egg-${o.launchId}` })
  const est = await fl.estimate(draft.id)
  status(`Starting the egg server (about $${Number(est.monthlyTotal).toFixed(2)}/month, billed per second)…`)
  await fl.provision(draft.id)
  for (;;) {
    const vm = await fl.vm(draft.id)
    if (vm.status === 'launched') return draft.id
    if (vm.status === 'failed') throw new Error(`Fluence could not start the server: ${JSON.stringify(vm.failure ?? '')}`)
    status(`Server ${vm.status}…`)
    await sleep(15_000)
  }
}

export const fmtUsd = (micro: bigint) => `$${Number(formatUnits(micro, 6)).toFixed(2)}`
