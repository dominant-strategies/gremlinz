import { describe, expect, it, vi } from 'vitest'
import { address, getTransactionDecoder } from '@solana/kit'
import { SYSTEM_PROGRAM_ADDRESS, parseTransferSolInstruction } from '@solana-program/system'
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, parseTransferCheckedInstruction } from '@solana-program/token'
import { SOLANA_TOKENS, buildSolanaDonation, solanaReader, type SolanaReader } from '../src/solana-pay.js'

const DONOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const GREMLIN = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

/** A chain where only the listed accounts exist. */
const chain = (existing: string[] = []): SolanaReader & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 123n }),
    accountExists: async (a) => { asked.push(a); return existing.includes(a) },
  }
}
const ata = async (owner: string, mint: string) => (await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]

describe('Solana donations', () => {
  it('sends SOL with a single system transfer, paid and signed by the donor', async () => {
    const { instructions, bytes } = await buildSolanaDonation({ from: DONOR, to: GREMLIN, amount: 25_000_000n }, chain())
    expect(instructions).toHaveLength(1)
    expect(instructions[0]!.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS)
    const t = parseTransferSolInstruction(instructions[0] as never)
    expect(t.accounts.source.address).toBe(DONOR)
    expect(t.accounts.destination.address).toBe(GREMLIN)
    expect(t.data.amount).toBe(25_000_000n)
    // Unsigned wire transaction: one signature slot (the donor's), left for the wallet.
    const tx = getTransactionDecoder().decode(bytes)
    expect(Object.keys(tx.signatures)).toEqual([DONOR])
    expect(Object.values(tx.signatures)).toEqual([null])
  })

  it("creates the gremlin's token account first when it has none, then transfers with the mint's decimals", async () => {
    const usdc = SOLANA_TOKENS.usdc
    const fromAta = await ata(DONOR, usdc.mint)
    const toAta = await ata(GREMLIN, usdc.mint)
    const c = chain([fromAta])
    const { instructions } = await buildSolanaDonation({ from: DONOR, to: GREMLIN, amount: 10_000_000n, token: usdc }, c)
    expect(c.asked.sort()).toEqual([fromAta, toAta].sort())
    expect(instructions.map((i) => i.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS])
    const create = instructions[0]!
    expect([...create.data!]).toEqual([1]) // CreateIdempotent
    expect(create.accounts!.map((a) => a.address)).toEqual([DONOR, toAta, GREMLIN, usdc.mint, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS])
    const t = parseTransferCheckedInstruction(instructions[1] as never)
    expect(t.accounts.source.address).toBe(fromAta)
    expect(t.accounts.destination.address).toBe(toAta)
    expect(t.accounts.mint.address).toBe(usdc.mint)
    expect(t.accounts.authority.address).toBe(DONOR)
    expect(t.data).toMatchObject({ amount: 10_000_000n, decimals: 6 })
  })

  it("skips creating the gremlin's token account when it exists", async () => {
    const usdt = SOLANA_TOKENS.usdt
    const { instructions } = await buildSolanaDonation({ from: DONOR, to: GREMLIN, amount: 5_000_000n, token: usdt }, chain([await ata(DONOR, usdt.mint), await ata(GREMLIN, usdt.mint)]))
    expect(instructions.map((i) => i.programAddress)).toEqual([TOKEN_PROGRAM_ADDRESS])
  })

  it('stops before the wallet when the donor holds none of the token', async () => {
    await expect(buildSolanaDonation({ from: DONOR, to: GREMLIN, amount: 1n, token: SOLANA_TOKENS.usdc }, chain())).rejects.toThrow(/holds no USDC/)
  })

  it('reads the blockhash and accounts over JSON-RPC', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { method } = JSON.parse(init!.body as string)
      const result = method === 'getLatestBlockhash' ? { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 99 } } : { value: null }
      return Response.json({ jsonrpc: '2.0', id: 1, result })
    })
    const r = solanaReader('https://rpc.example', fetchImpl as unknown as typeof fetch)
    expect(await r.latestBlockhash()).toEqual({ blockhash: BLOCKHASH, lastValidBlockHeight: 99n })
    expect(await r.accountExists(GREMLIN)).toBe(false)
  })
})
