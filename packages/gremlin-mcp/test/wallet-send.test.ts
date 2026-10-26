import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Address, NETWORK, OutScript } from '@scure/btc-signer'
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, getBase64EncodedWireTransaction } from '@solana/kit'
import { base58, base64 } from '@scure/base'
import { deriveKeys } from '../src/wallets/keys.js'
import { asset } from '../src/wallets/chains.js'
import { buildSolanaTransfer, buildUtxoTransfer, destinationProblem } from '../src/wallets/send.js'
import { SendPolicy, priceFn } from '../src/wallets/policy.js'

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const me = deriveKeys(ABANDON)
const them = deriveKeys(OTHER)

describe('destinations', () => {
  it('accepts each family\'s own address format and rejects the others', () => {
    expect(destinationProblem(asset('usdc:base')!, them.evm.address)).toBeUndefined()
    expect(destinationProblem(asset('usdc:base')!, them.solana.address)).toBeDefined()
    expect(destinationProblem(asset('quai:quai')!, them.quai.address)).toBeUndefined()
    expect(destinationProblem(asset('quai:quai')!, them.evm.address)).toBeDefined() // not in cyprus1
    expect(destinationProblem(asset('qi:quai')!, them.qi.paymentCode)).toBeUndefined()
    expect(destinationProblem(asset('qi:quai')!, them.quai.address)).toMatch(/payment code/)
    expect(destinationProblem(asset('sol:solana')!, them.solana.address)).toBeUndefined()
    expect(destinationProblem(asset('btc:bitcoin')!, them.bitcoin.address)).toBeUndefined()
    expect(destinationProblem(asset('btc:bitcoin')!, them.litecoin.address)).toBeDefined()
    expect(destinationProblem(asset('ltc:litecoin')!, them.litecoin.address)).toBeUndefined()
  })
})

describe('bitcoin transfer', () => {
  it('builds and signs a SegWit transaction with change back to itself', async () => {
    const utxos = [
      { txid: 'aa'.repeat(32), vout: 0, value: 60_000, status: { confirmed: true } },
      { txid: 'bb'.repeat(32), vout: 1, value: 50_000, status: { confirmed: true } },
      { txid: 'cc'.repeat(32), vout: 0, value: 999_999, status: { confirmed: false } }, // unconfirmed: never spent
    ]
    const built = await buildUtxoTransfer(me, 'bitcoin', them.bitcoin.address, 70_000n, utxos, 5)
    const tx = Transaction.fromRaw(Buffer.from(built.hex, 'hex'), { allowUnknownOutputs: true })
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
    const addr = (o: { script?: Uint8Array }) => Address(NETWORK).encode(OutScript.decode(o.script!))
    expect(outs.find((o) => addr(o) === them.bitcoin.address)!.amount).toBe(70_000n)
    const change = outs.find((o) => addr(o) === me.bitcoin.address)!
    expect(change.amount).toBe(110_000n - 70_000n - built.fee)
    expect(built.fee).toBeGreaterThan(0n)
    expect(tx.inputsLength).toBe(2)
  })

  it('refuses when confirmed funds cannot cover amount plus fee', async () => {
    await expect(buildUtxoTransfer(me, 'bitcoin', them.bitcoin.address, 100_000n, [{ txid: 'aa'.repeat(32), vout: 0, value: 50_000, status: { confirmed: true } }], 5)).rejects.toThrow(/not enough/)
  })
})

describe('solana transfer', () => {
  const blockhash = { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1000n }
  const decode = (signed: Parameters<typeof getBase64EncodedWireTransaction>[0]) => {
    const tx = getTransactionDecoder().decode(base64.decode(getBase64EncodedWireTransaction(signed)))
    return getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  }
  it('builds a signed SOL transfer', async () => {
    const msg = decode(await buildSolanaTransfer(me, asset('sol:solana')!, them.solana.address, 1_000_000n, blockhash))
    expect(msg.instructions).toHaveLength(1)
    expect(msg.staticAccounts[0]).toBe(me.solana.address) // fee payer
    expect(msg.staticAccounts).toContain(them.solana.address)
  })
  it('builds a USDC transfer that creates the recipient\'s token account if needed', async () => {
    const msg = decode(await buildSolanaTransfer(me, asset('usdc:solana')!, them.solana.address, 5_000_000n, blockhash))
    expect(msg.instructions).toHaveLength(2)
    expect(msg.staticAccounts).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  })
})

describe('spending policy', () => {
  it('values stables 1:1, refuses unknown prices, and enforces per-send and rolling daily caps', async () => {
    let clock = Date.parse('2026-10-26T12:00:00Z')
    const p = new SendPolicy(join(mkdtempSync(join(tmpdir(), 'sends-')), 'sends.jsonl'), { perSendUsd: 10, dailyUsd: 25 }, () => clock)
    const price = priceFn({ fetchImpl: (async () => new Response(JSON.stringify({ coins: { 'coingecko:solana': { price: 150 } } }))) as typeof fetch })
    expect(await price(asset('usdc:base')!, 7_500_000n)).toBe(7.5)
    expect(await price(asset('sol:solana')!, 50_000_000n)).toBeCloseTo(7.5)
    expect(p.check(undefined)).toMatch(/no live price/)
    expect(p.check(12)).toMatch(/per-send limit/)
    p.record({ asset: 'usdc:base', to: 'x', amount: '9', usd: 9, tx: '0x1' })
    p.record({ asset: 'usdc:base', to: 'x', amount: '9', usd: 9, tx: '0x2' })
    p.record({ asset: 'usdc:base', to: 'x', amount: '9', usd: 9, dryRun: true }) // dry runs do not count
    expect(p.check(8)).toMatch(/daily limit/)
    expect(p.check(7)).toBeUndefined()
    clock += 25 * 3_600_000
    expect(p.spentLast24h()).toBe(0)
  })

  it('values Qi through its live Qi→QUAI rate', async () => {
    const price = priceFn({
      fetchImpl: (async () => new Response(JSON.stringify({ coins: { 'coingecko:quai-network': { price: 0.01 } } }))) as typeof fetch,
      qiToQuai: async (qi) => qi * 10n ** 15n * 2n, // pretend 1 Qi unit = 0.002 QUAI
    })
    expect(await price(asset('qi:quai')!, 5_000n)).toBeCloseTo(0.1) // 5000 units → 10 QUAI → $0.10
    expect(await priceFn()(asset('qi:quai')!, 1n)).toBeUndefined() // no rate → refused upstream
  })
})
