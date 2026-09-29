/**
 * QUAI bridging via Symbiosis. WQUAI on Quai is the origin token; Ethereum, Base and BSC hold synthetic QUAI.
 * The public REST API refuses Quai routes, so we use the JS SDK. Proven on mainnet: research/launch-checks.md §5.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Symbiosis, Token, TokenAmount, type SwapExactInResult } from 'symbiosis-js-sdk'

type Address = `0x${string}`
import { CHAIN, QUAI_SYNTH, WQUAI, type EvmChainId } from './constants.js'

type CacheData = { tokens: Array<Record<string, unknown> & { id: number; chainId: number; address: string; symbol?: string }>; omniPools: unknown[] }

const WQUAI_TOKEN_ID = 108

/**
 * The npm SDK's token cache (3.11.60) lacks synthetic QUAI on BSC even though Symbiosis mints it there.
 * Add any missing synthetic QUAI entries so the SDK can route them.
 */
export function withQuaiSynths(cache: CacheData): CacheData {
  const tokens = [...cache.tokens]
  let nextId = Math.max(...tokens.map((t) => t.id)) + 1
  for (const [chainId, address] of Object.entries(QUAI_SYNTH)) {
    const exists = tokens.some((t) => t.chainId === Number(chainId) && t.address.toLowerCase() === address.toLowerCase())
    if (exists) continue
    tokens.push({
      id: nextId++,
      chainId: Number(chainId),
      address,
      decimals: 18,
      symbol: 'QUAI',
      name: 'Quai Network',
      chainFromId: CHAIN.quai,
      originalId: WQUAI_TOKEN_ID,
      deprecated: false,
    })
  }
  return { ...cache, tokens }
}

/** Node-only: read the SDK's bundled mainnet cache. Browser builds should import the JSON via their bundler. */
export function loadMainnetCache(): CacheData {
  const require = createRequire(import.meta.url)
  const cjsIndex = require.resolve('symbiosis-js-sdk')
  const file = join(dirname(cjsIndex), 'crosschain', 'config', 'cache', 'mainnet.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function createSymbiosis(opts: { clientId: string; cache?: CacheData; zeroXApiKey?: string }): Symbiosis {
  const configCache = withQuaiSynths(opts.cache ?? loadMainnetCache())
  return new Symbiosis('mainnet', opts.clientId, {
    configCache: configCache as never,
    ...(opts.zeroXApiKey ? { zeroXConfig: { apiKeys: [opts.zeroXApiKey] } as never } : {}),
  })
}

export const wquaiToken = () => new Token({ chainId: CHAIN.quai as never, address: WQUAI as Address, decimals: 18, symbol: 'WQUAI' })

/** Synthetic QUAI must be built with chainFromId, or the SDK won't recognise it as bridgeable. */
export const quaiSynthToken = (chainId: EvmChainId) =>
  new Token({ chainId: chainId as never, address: QUAI_SYNTH[chainId] as Address, decimals: 18, symbol: 'QUAI', chainFromId: CHAIN.quai as never })

export type Direction = { from: 'quai'; to: EvmChainId } | { from: EvmChainId; to: 'quai' }

/** Quote a plain bridge of `amount` (18 decimals) between Quai and an EVM chain. */
export async function quoteBridge(opts: {
  symbiosis: Symbiosis
  direction: Direction
  amount: bigint
  sender: string
  receiver: string
  slippageBps?: number
}): Promise<SwapExactInResult> {
  const d = opts.direction
  const tokenIn = d.from === 'quai' ? wquaiToken() : quaiSynthToken(d.from)
  const tokenOut = d.to === 'quai' ? wquaiToken() : quaiSynthToken(d.to)
  const candidates = opts.symbiosis.swapExactIn({
    tokenAmountIn: new TokenAmount(tokenIn, opts.amount.toString()),
    tokenOut,
    from: opts.sender as Address,
    to: opts.receiver as Address,
    slippage: opts.slippageBps ?? 300,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  })
  if (!candidates.length) throw new Error(`no Symbiosis route for ${JSON.stringify(d)}`)
  return Promise.any(candidates)
}

export interface BridgeStatus {
  status: 'pending' | 'success' | 'stuck' | 'reverted' | 'unknown'
  outChainId?: number
  outHash?: string
  outAmount?: bigint
}

/** Poll Symbiosis for the destination leg of a bridge started on `chainId`. */
export async function bridgeStatus(chainId: number, hash: string, fetchImpl: typeof fetch = fetch): Promise<BridgeStatus> {
  const res = await fetchImpl(`https://api.symbiosis.finance/crosschain/v1/tx/${chainId}/${hash}`)
  if (!res.ok) return { status: 'unknown' }
  const d = await res.json()
  const text = String(d?.status?.text ?? '').toLowerCase()
  const status = (['pending', 'success', 'stuck', 'reverted'].find((s) => text.startsWith(s)) ?? 'unknown') as BridgeStatus['status']
  const out = d?.txOut
  return { status, outChainId: out?.chainId, outHash: out?.hash, outAmount: out?.tokenAmount ? BigInt(out.tokenAmount.amount) : undefined }
}
