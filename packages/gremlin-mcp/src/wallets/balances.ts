/**
 * Balances of every asset in ASSETS, per family. Readers take their network access as arguments so tests can run
 * without the network; failures of one chain never hide the others (they are reported per chain).
 */
import { Contract, JsonRpcProvider } from 'ethers'
import { JsonRpcProvider as QuaiProvider, Mnemonic, QiHDWallet, Zone } from 'quais'
import { ASSETS, EVM_CHAINS, QUAI, SOLANA, esploraFor, rpcFor, type Asset } from './chains.js'
import type { ChainKeys } from './keys.js'

export interface Holding { asset: Asset; amount: bigint }
export interface BalanceReport { holdings: Holding[]; errors: { chain: string; error: string }[] }

const ERC20 = ['function balanceOf(address) view returns (uint256)']

export async function evmBalances(address: string, env: NodeJS.ProcessEnv = process.env): Promise<BalanceReport> {
  const out: BalanceReport = { holdings: [], errors: [] }
  await Promise.all(EVM_CHAINS.map(async (c) => {
    try {
      const p = new JsonRpcProvider(rpcFor(c.name, c.rpc, env), c.chainId, { staticNetwork: true })
      for (const a of ASSETS.filter((x) => x.chain === c.name)) {
        const amount = a.token ? ((await new Contract(a.token, ERC20, p).balanceOf(address)) as bigint) : await p.getBalance(address)
        out.holdings.push({ asset: a, amount })
      }
    } catch (e) {
      out.errors.push({ chain: c.name, error: (e as Error).message.slice(0, 160) })
    }
  }))
  return out
}

type Fetch = typeof fetch
const rpcCall = async (fetchImpl: Fetch, url: string, method: string, params: unknown[]) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = (await r.json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

export async function solanaBalances(address: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): Promise<BalanceReport> {
  const url = rpcFor('solana', SOLANA.rpc, env)
  const out: BalanceReport = { holdings: [], errors: [] }
  try {
    const lamports = (await rpcCall(fetchImpl, url, 'getBalance', [address, { commitment: 'confirmed' }])) as { value: number }
    out.holdings.push({ asset: ASSETS.find((a) => a.id === 'sol:solana')!, amount: BigInt(lamports.value) })
    for (const a of ASSETS.filter((x) => x.chain === 'solana' && x.token)) {
      const r = (await rpcCall(fetchImpl, url, 'getTokenAccountsByOwner', [address, { mint: a.token }, { encoding: 'jsonParsed', commitment: 'confirmed' }])) as {
        value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[]
      }
      out.holdings.push({ asset: a, amount: r.value.reduce((s, v) => s + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n) })
    }
  } catch (e) {
    out.errors.push({ chain: 'solana', error: (e as Error).message.slice(0, 160) })
  }
  return out
}

export async function utxoBalances(addresses: { bitcoin: string; litecoin: string }, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): Promise<BalanceReport> {
  const out: BalanceReport = { holdings: [], errors: [] }
  await Promise.all((['bitcoin', 'litecoin'] as const).map(async (chain) => {
    try {
      const r = await fetchImpl(`${esploraFor(chain, env)}/address/${addresses[chain]}`)
      if (!r.ok) throw new Error(`esplora ${r.status}`)
      const j = (await r.json()) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } }
      const sats = j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum + j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum
      out.holdings.push({ asset: ASSETS.find((a) => a.chain === chain)!, amount: BigInt(sats) })
    } catch (e) {
      out.errors.push({ chain, error: (e as Error).message.slice(0, 160) })
    }
  }))
  return out
}

export async function quaiBalances(keys: Pick<ChainKeys, 'quai'>, phrase: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<BalanceReport> {
  const out: BalanceReport = { holdings: [], errors: [] }
  const provider = new QuaiProvider(rpcFor('quai', QUAI.rpc, env), undefined, { usePathing: true })
  try {
    out.holdings.push({ asset: ASSETS.find((a) => a.id === 'quai:quai')!, amount: await provider.getBalance(keys.quai.address) })
  } catch (e) {
    out.errors.push({ chain: 'quai', error: (e as Error).message.slice(0, 160) })
  }
  if (phrase) {
    try {
      // Qi is UTXO-based: the wallet scans its addresses (and payment channels) to find what it can spend.
      const qi = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase))
      qi.connect(provider)
      await qi.scan(Zone.Cyprus1)
      out.holdings.push({ asset: ASSETS.find((a) => a.id === 'qi:quai')!, amount: await qi.getSpendableBalance(Zone.Cyprus1) })
    } catch (e) {
      out.errors.push({ chain: 'qi', error: (e as Error).message.slice(0, 160) })
    }
  }
  return out
}

/** Everything at once. */
export async function allBalances(keys: ChainKeys, phrase?: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): Promise<BalanceReport> {
  const parts = await Promise.all([
    quaiBalances(keys, phrase, env),
    evmBalances(keys.evm.address, env),
    solanaBalances(keys.solana.address, env, fetchImpl),
    utxoBalances({ bitcoin: keys.bitcoin.address, litecoin: keys.litecoin.address }, env, fetchImpl),
  ])
  return { holdings: parts.flatMap((p) => p.holdings), errors: parts.flatMap((p) => p.errors) }
}
