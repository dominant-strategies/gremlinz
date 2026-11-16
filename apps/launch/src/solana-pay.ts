/**
 * Solana donations from the browser: SOL, and USDC or USDT (SPL tokens), built here and signed and sent by the
 * donor's Phantom wallet. Building needs only a recent blockhash and whether the token accounts exist, which come
 * from a Solana RPC (injectable, so tests run without a network).
 *
 * A token transfer goes between associated token accounts. The donor must already hold one for the token (that is
 * where their USDC is); the gremlin may not yet, in which case the transaction first creates it, paid for by the donor
 * (about 0.002 SOL of rent).
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage,
  getTransactionEncoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, type Blockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token'

export const SOLANA_RPC = (import.meta.env?.VITE_SOLANA_RPC as string | undefined) || 'https://solana-rpc.publicnode.com'
export const SOLANA_EXPLORER = 'https://solscan.io/tx/'
export const SOLANA_TOKENS = {
  usdc: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  usdt: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT' },
} as const

/** What building a transfer needs from the chain. */
export interface SolanaReader {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>
  accountExists(address: string): Promise<boolean>
}

export function solanaReader(url = SOLANA_RPC, fetchImpl: typeof fetch = fetch): SolanaReader {
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const j = (await r.json()) as { result?: unknown; error?: { message: string } }
    if (j.error) throw new Error(`Solana RPC: ${j.error.message}`)
    return j.result
  }
  return {
    async latestBlockhash() {
      const { value } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as { value: { blockhash: string; lastValidBlockHeight: number } }
      return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }
    },
    async accountExists(a) {
      const r = (await rpc('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }])) as { value: unknown }
      return r.value !== null
    },
  }
}

export interface SolanaDonation {
  /** The donor (fee payer and signer). */
  from: string
  /** The gremlin's Solana address. */
  to: string
  /** Base units (lamports, or token units). */
  amount: bigint
  /** Absent for SOL. */
  token?: { mint: string; decimals: number; symbol: string }
}

/** The unsigned transaction for a donation: its instructions (for inspection) and its wire bytes for the wallet. */
export async function buildSolanaDonation(d: SolanaDonation, chain: SolanaReader) {
  const payer = createNoopSigner(address(d.from))
  const to = address(d.to)
  let instructions
  if (!d.token) {
    instructions = [getTransferSolInstruction({ source: payer, destination: to, amount: d.amount })]
  } else {
    const mint = address(d.token.mint)
    const [fromAta] = await findAssociatedTokenPda({ mint, owner: payer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const [toAta] = await findAssociatedTokenPda({ mint, owner: to, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    const [haveFrom, haveTo] = await Promise.all([chain.accountExists(fromAta), chain.accountExists(toAta)])
    if (!haveFrom) throw new Error(`This wallet holds no ${d.token.symbol} on Solana.`)
    instructions = [
      ...(haveTo ? [] : [getCreateAssociatedTokenIdempotentInstruction({ payer, owner: to, mint, ata: toAta })]),
      getTransferCheckedInstruction({ source: fromAta, mint, destination: toAta, authority: payer, amount: d.amount, decimals: d.token.decimals }),
    ]
  }
  const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
  return { instructions, message, bytes }
}
