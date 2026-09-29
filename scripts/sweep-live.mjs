// Live sweeper run for the test wallet on Base: USDC → (gas) + QUAI → Quai. Usage: node scripts/sweep-live.mjs <keyfile>
import { readFileSync } from 'node:fs'
import { Wallet, JsonRpcProvider, Contract, formatUnits, formatEther } from 'ethers'
import { CHAIN, FUNDING_TOKENS, createSymbiosis, planSweep, executeSweep, RPC, QUAI_SYNTH } from '../packages/treasury/dist/index.js'
const key = readFileSync(process.argv[2], 'utf8').trim()
const p = new JsonRpcProvider(RPC[CHAIN.base], CHAIN.base, { staticNetwork: true })
const w = new Wallet(key, p)
const usdc = FUNDING_TOKENS.find((t) => t.chainId === CHAIN.base && t.symbol === 'USDC')
const erc = ['function balanceOf(address) view returns (uint256)']
const usdcBal = await new Contract(usdc.address, erc, p).balanceOf(w.address)
const gasBudget = 100_000n // 0.10 USDC
const plan = planSweep(
  { chainId: CHAIN.base, native: await p.getBalance(w.address), quaiSynth: await new Contract(QUAI_SYNTH[CHAIN.base], erc, p).balanceOf(w.address), tokens: [{ token: usdc, amount: usdcBal - gasBudget }] },
  { gasBudgetToken: usdc, gasBudgetAmount: gasBudget },
)
console.log('plan:', plan.actions.map((a) => `${a.kind}(${a.amount})`).join(' → '), '| skipped:', plan.skipped.map((s) => s.symbol))
const results = await executeSweep({ signer: w, symbiosis: createSymbiosis({ clientId: 'gremlins-sweeper' }), quaiAddress: w.address, log: (m) => console.log(new Date().toISOString().slice(11, 19), m) }, plan.actions)
for (const r of results) console.log(r.action.kind, 'order' in r ? `${r.order.status} sold ${r.order.executedSellAmount} bought ${r.order.executedBuyAmount} tx ${r.order.txHash}` : `bridge tx ${r.bridgeTx} status ${r.status.status}`)
console.log('Base now: ETH', formatEther(await p.getBalance(w.address)), '| USDC', formatUnits(await new Contract(usdc.address, erc, p).balanceOf(w.address), 6), '| QUAI', formatUnits(await new Contract(QUAI_SYNTH[CHAIN.base], erc, p).balanceOf(w.address), 18))
