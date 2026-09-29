/** Quai-side helpers: wrap QUAI and send the Symbiosis bridge transaction. */
import { Contract, JsonRpcProvider, Wallet } from 'quais'
import { RPC, CHAIN, WQUAI } from './constants.js'
import type { SwapExactInResult } from 'symbiosis-js-sdk'

export function quaiProvider(url = RPC[CHAIN.quai]) {
  return new JsonRpcProvider(url, undefined, { usePathing: true })
}

export function quaiWallet(privateKey: string, provider = quaiProvider()) {
  return new Wallet(privateKey, provider)
}

const WQUAI_ABI = [
  'function deposit() payable',
  'function withdraw(uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]

export function wquai(wallet: Wallet) {
  return new Contract(WQUAI, WQUAI_ABI, wallet)
}

/** Wrap native QUAI so the WQUAI balance is at least `amount`. */
export async function ensureWrapped(wallet: Wallet, amount: bigint): Promise<string | undefined> {
  const c = wquai(wallet)
  const have: bigint = await c.balanceOf(wallet.address)
  if (have >= amount) return undefined
  const tx = await c.deposit({ value: amount - have })
  await tx.wait()
  return tx.hash
}

/** Bridges into Quai deliver WQUAI; gremlins hold native QUAI, so unwrap everything. */
export async function unwrapAll(wallet: Wallet): Promise<{ hash?: string; amount: bigint }> {
  const c = wquai(wallet)
  const amount: bigint = await c.balanceOf(wallet.address)
  if (amount === 0n) return { amount }
  const tx = await c.withdraw(amount)
  await tx.wait()
  return { hash: tx.hash, amount }
}

export async function ensureAllowance(wallet: Wallet, spender: string, amount: bigint): Promise<string | undefined> {
  const c = wquai(wallet)
  if ((await c.allowance(wallet.address, spender)) >= amount) return undefined
  const tx = await c.approve(spender, amount)
  await tx.wait()
  return tx.hash
}

/** Wrap, approve and send a quoted Quai→EVM bridge. Returns the Quai tx hash to track with bridgeStatus(9, hash). */
export async function sendBridgeFromQuai(wallet: Wallet, quote: SwapExactInResult, amount: bigint): Promise<{ hash: string; status: number | null }> {
  await ensureWrapped(wallet, amount)
  await ensureAllowance(wallet, quote.approveTo, amount)
  const req = (quote as unknown as { transactionRequest: { to: string; data: string; value?: { toString(): string } } }).transactionRequest
  const tx = await wallet.sendTransaction({ from: wallet.address, to: req.to, data: req.data, value: req.value ? BigInt(req.value.toString()) : 0n })
  const receipt = (await tx.wait()) as { status?: number } | null
  return { hash: tx.hash, status: receipt?.status ?? null }
}
