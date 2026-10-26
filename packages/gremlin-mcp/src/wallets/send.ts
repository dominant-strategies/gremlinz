/**
 * Outgoing sends for every family. Each sender validates the destination for its chain, builds and signs the
 * transaction, and (unless dryRun) broadcasts it. Network access is injectable for tests.
 */
import { Contract, JsonRpcProvider, Wallet, isAddress as isEvmAddress } from 'ethers'
import { JsonRpcProvider as QuaiProvider, Mnemonic, QiHDWallet, Wallet as QuaiWallet, Zone, getZoneForAddress, isQuaiAddress } from 'quais'
import { Address, NETWORK, p2wpkh, selectUTXO } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  address as solAddress, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createTransactionMessage,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, isAddress as isSolAddress, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token'
import { QUAI, SOLANA, UTXO_CHAINS, esploraFor, evmChain, rpcFor, type Asset } from './chains.js'
import { LITECOIN, type ChainKeys } from './keys.js'

export interface SendResult { tx: string; explorer: string; dryRun: boolean }

/** Why `to` is not a valid destination for this asset, or undefined. */
export function destinationProblem(asset: Asset, to: string): string | undefined {
  switch (asset.family) {
    case 'evm': return isEvmAddress(to) ? undefined : `not an EVM address (0x…40 hex)`
    case 'quai': return isQuaiAddress(to) && getZoneForAddress(to) === Zone.Cyprus1 ? undefined : 'not a Quai address in zone cyprus1 (0x00…)'
    case 'qi': return /^PM8T[1-9A-HJ-NP-Za-km-z]{60,140}$/.test(to) ? undefined : 'Qi is sent to a payment code (PM8T…), not an address'
    case 'solana': return isSolAddress(to) ? undefined : 'not a Solana address (base58)'
    case 'utxo': {
      try { Address(asset.chain === 'bitcoin' ? NETWORK : LITECOIN).decode(to); return undefined } catch { return `not a ${asset.chain} address` }
    }
  }
}

// ── EVM ──────────────────────────────────────────────────────────────────────
async function sendEvm(keys: ChainKeys, asset: Asset, to: string, amount: bigint, dryRun: boolean, env: NodeJS.ProcessEnv): Promise<SendResult> {
  const c = evmChain(asset.chain)!
  const signer = new Wallet(keys.evm.privateKey, new JsonRpcProvider(rpcFor(c.name, c.rpc, env), c.chainId, { staticNetwork: true }))
  const req = asset.token
    ? await new Contract(asset.token, ['function transfer(address,uint256) returns (bool)'], signer).transfer.populateTransaction(to, amount)
    : { to, value: amount }
  if (dryRun) {
    const gas = await signer.estimateGas(req)
    return { tx: `dry-run: ${asset.token ? 'transfer' : 'native send'} on ${c.name}, est. gas ${gas}`, explorer: '', dryRun }
  }
  const sent = await signer.sendTransaction(req)
  return { tx: sent.hash, explorer: c.explorer + sent.hash, dryRun }
}

// ── Quai and Qi ──────────────────────────────────────────────────────────────
async function sendQuai(keys: ChainKeys, to: string, amount: bigint, dryRun: boolean, env: NodeJS.ProcessEnv): Promise<SendResult> {
  const provider = new QuaiProvider(rpcFor('quai', QUAI.rpc, env), undefined, { usePathing: true })
  const w = new QuaiWallet(keys.quai.privateKey, provider)
  if (dryRun) return { tx: `dry-run: ${amount} wei QUAI from ${w.address} to ${to}`, explorer: '', dryRun }
  const sent = await w.sendTransaction({ from: w.address, to, value: amount })
  return { tx: sent.hash, explorer: QUAI.explorer + sent.hash, dryRun }
}

async function sendQi(phrase: string, to: string, amount: bigint, dryRun: boolean, env: NodeJS.ProcessEnv): Promise<SendResult> {
  const qi = QiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase))
  qi.connect(new QuaiProvider(rpcFor('quai', QUAI.rpc, env), undefined, { usePathing: true }))
  await qi.scan(Zone.Cyprus1)
  const spendable = await qi.getSpendableBalance(Zone.Cyprus1)
  if (spendable < amount) throw new Error(`only ${spendable} Qi units are spendable`)
  if (dryRun) return { tx: `dry-run: ${amount} Qi units to ${to.slice(0, 12)}… (spendable ${spendable})`, explorer: '', dryRun }
  const sent = await qi.sendTransaction(to, amount, Zone.Cyprus1, Zone.Cyprus1)
  return { tx: sent.hash, explorer: QUAI.explorer + sent.hash, dryRun }
}

// ── Solana ───────────────────────────────────────────────────────────────────
type SolRpc = (method: string, params: unknown[]) => Promise<unknown>
const solRpc = (url: string, fetchImpl: typeof fetch): SolRpc => async (method, params) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = (await r.json()) as { result?: unknown; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

export async function buildSolanaTransfer(keys: ChainKeys, asset: Asset, to: string, amount: bigint, blockhash: { blockhash: string; lastValidBlockHeight: bigint }) {
  const signer = await createKeyPairSignerFromBytes(keys.solana.secretKey)
  const dest = solAddress(to)
  let instructions
  if (!asset.token) {
    instructions = [getTransferSolInstruction({ source: signer, destination: dest, amount })]
  } else {
    const mint = solAddress(asset.token)
    const [fromAta] = await findAssociatedTokenPda({ mint, owner: signer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const [toAta] = await findAssociatedTokenPda({ mint, owner: dest, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    instructions = [
      // Creates the recipient's token account if it does not exist (the sender pays its rent).
      getCreateAssociatedTokenIdempotentInstruction({ payer: signer, owner: dest, mint, ata: toAta }),
      getTransferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: signer, amount, decimals: asset.decimals }),
    ]
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return signTransactionMessageWithSigners(message)
}

async function sendSolana(keys: ChainKeys, asset: Asset, to: string, amount: bigint, dryRun: boolean, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<SendResult> {
  const rpc = solRpc(rpcFor('solana', SOLANA.rpc, env), fetchImpl)
  const { value } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string; lastValidBlockHeight: number } }
  const signed = await buildSolanaTransfer(keys, asset, to, amount, { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) })
  const wire = getBase64EncodedWireTransaction(signed)
  if (dryRun) {
    const sim = (await rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }])) as { value: { err: unknown } }
    return { tx: `dry-run: simulation ${sim.value.err ? `failed: ${JSON.stringify(sim.value.err)}` : 'ok'}`, explorer: '', dryRun }
  }
  const sig = (await rpc('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }])) as string
  return { tx: sig ?? getSignatureFromTransaction(signed), explorer: SOLANA.explorer + sig, dryRun }
}

// ── Bitcoin and Litecoin ─────────────────────────────────────────────────────
interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean } }

export async function buildUtxoTransfer(keys: ChainKeys, chain: 'bitcoin' | 'litecoin', to: string, amount: bigint, utxos: Utxo[], feeRateSatVb: number) {
  const net = chain === 'bitcoin' ? NETWORK : LITECOIN
  const k = keys[chain]
  const spend = p2wpkh(k.publicKey, net)
  const inputs = utxos.filter((u) => u.status.confirmed).map((u) => ({
    txid: u.txid, index: u.vout, witnessUtxo: { script: spend.script, amount: BigInt(u.value) },
  }))
  const sel = selectUTXO(inputs, [{ address: to, amount }], 'default', { changeAddress: spend.address!, feePerByte: BigInt(Math.ceil(feeRateSatVb)), bip69: true, createTx: true, network: net })
  if (!sel || !sel.tx) throw new Error('not enough confirmed funds for this amount plus the network fee')
  sel.tx.sign(k.privateKey)
  sel.tx.finalize()
  return { hex: hex.encode(sel.tx.extract()), txid: sel.tx.id, fee: sel.fee }
}

async function sendUtxo(keys: ChainKeys, chain: 'bitcoin' | 'litecoin', to: string, amount: bigint, dryRun: boolean, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<SendResult> {
  const base = esploraFor(chain, env)
  const utxos = (await (await fetchImpl(`${base}/address/${keys[chain].address}/utxo`)).json()) as Utxo[]
  const fees = (await (await fetchImpl(`${base}/fee-estimates`)).json()) as Record<string, number>
  const rate = fees['3'] ?? fees['6'] ?? 2
  const built = await buildUtxoTransfer(keys, chain, to, amount, utxos, rate)
  if (dryRun) return { tx: `dry-run: txid ${built.txid}, fee ${built.fee} sats at ${rate} sat/vB`, explorer: '', dryRun }
  const r = await fetchImpl(`${base}/tx`, { method: 'POST', body: built.hex })
  if (!r.ok) throw new Error(`broadcast failed: ${r.status} ${(await r.text()).slice(0, 200)}`)
  const txid = (await r.text()).trim()
  return { tx: txid, explorer: UTXO_CHAINS[chain].explorer + txid, dryRun }
}

/** Send `amount` (base units) of `asset` to `to`. */
export async function send(opts: { keys: ChainKeys; phrase: string; asset: Asset; to: string; amount: bigint; dryRun?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<SendResult> {
  const { keys, phrase, asset, to, amount } = opts
  const dryRun = opts.dryRun ?? false
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const problem = destinationProblem(asset, to)
  if (problem) throw new Error(`Bad destination for ${asset.id}: ${problem}.`)
  if (amount <= 0n) throw new Error('Amount must be positive.')
  switch (asset.family) {
    case 'evm': return sendEvm(keys, asset, to, amount, dryRun, env)
    case 'quai': return sendQuai(keys, to, amount, dryRun, env)
    case 'qi': return sendQi(phrase, to, amount, dryRun, env)
    case 'solana': return sendSolana(keys, asset, to, amount, dryRun, env, fetchImpl)
    case 'utxo': return sendUtxo(keys, asset.chain as 'bitcoin' | 'litecoin', to, amount, dryRun, env, fetchImpl)
  }
}


