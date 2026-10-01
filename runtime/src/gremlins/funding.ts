/**
 * gremlins: fund Conway credits from QUAI, just in time.
 *
 * Upstream tops up Conway credits from USDC on Base (x402). Gremlins hold QUAI, so when credits run low and
 * there isn't enough USDC on Base for the next top-up tier, convert exactly that much QUAI to USDC:
 *
 *   QUAI (Quai) ─wrap+Symbiosis bridge─► QUAI (Base) ─CoW gasless swap─► USDC (Base) ─upstream x402 topup─► credits
 *
 * Every conversion is checked against the universal treasury rule (non-QUAI/Qi ≤ 1.2× this cycle's bills).
 * The job takes minutes (the bridge leg), so its progress is persisted and resumed on later heartbeats.
 */
import {
  CHAIN,
  QUAI_SYNTH,
  QUAI_SYNTH_PERMIT_DOMAIN,
  USD,
  USDC,
  bridgeStatus,
  buildAppData,
  checkConversion,
  createSymbiosis,
  gaslessSell,
  quaiWallet,
  quoteBridge,
  quoteSell,
  sendBridgeFromQuai,
  type Bill,
  type Holding,
} from "@gremlins/treasury";
import { JsonRpcProvider, Wallet as EvmWallet, Contract } from "ethers";
import { Mnemonic, QuaiHDWallet, Zone } from "quais";

export type FundingJob =
  | { stage: "bridging"; targetUsdMicro: string; quaiWei: string; bridgeTx: string; startedAt: string }
  | { stage: "swapping"; targetUsdMicro: string; startedAt: string }
  | { stage: "done"; usdcMicro: string; finishedAt: string }
  | { stage: "failed"; reason: string; at: string };

export interface FundingDecision {
  convert: boolean;
  /** USD (micro) of USDC to obtain; includes nothing beyond the top-up tier itself. */
  targetUsdMicro: bigint;
  reason: string;
}

/**
 * Decide whether to convert QUAI for the next credit top-up.
 * @param creditsCents current Conway credits
 * @param lowCreditsCents threshold under which a top-up is due
 * @param usdcMicro USDC already on Base (micro-USDC)
 * @param tierUsd the smallest top-up tier that covers the need (upstream TOPUP_TIERS, min $5)
 */
export function decideFunding(opts: {
  creditsCents: number;
  lowCreditsCents: number;
  usdcMicro: bigint;
  tierUsd: number;
  cycleBills: Bill[];
  nonCoreHoldings: Holding[];
}): FundingDecision {
  const tierMicro = BigInt(opts.tierUsd) * USD;
  if (opts.creditsCents >= opts.lowCreditsCents) return { convert: false, targetUsdMicro: 0n, reason: "credits sufficient" };
  if (opts.usdcMicro >= tierMicro) return { convert: false, targetUsdMicro: 0n, reason: "USDC already covers the top-up" };
  const targetUsdMicro = tierMicro - opts.usdcMicro;
  const check = checkConversion({ amountUsd: targetUsdMicro, cycleBills: opts.cycleBills, nonCoreHoldings: opts.nonCoreHoldings });
  if (!check.ok) return { convert: false, targetUsdMicro, reason: `treasury rule: ${check.reason}` };
  return { convert: true, targetUsdMicro, reason: `convert ~$${Number(targetUsdMicro) / 1e6} of QUAI for a $${opts.tierUsd} top-up` };
}

/** QUAI (wei) needed to end with `usdMicro` USDC on Base, from a live CoW price plus bridge and swap margins. */
export async function quaiNeededFor(usdMicro: bigint, evmAddress: string): Promise<bigint> {
  const probe = 1000n * 10n ** 18n;
  const q = await quoteSell({
    chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], buyToken: USDC[CHAIN.base]!, from: evmAddress, receiver: evmAddress,
    sellAmountBeforeFee: probe, app: buildAppData({ appCode: "gremlins-funding" }),
  });
  const quaiForUsd = (usdMicro * probe) / q.buyAmount; // at today's price
  const bridgeFee = 10n * 10n ** 18n; // Quai→Base measured at 1–2 QUAI; 10 QUAI leaves headroom
  return (quaiForUsd * 103n) / 100n + bridgeFee; // +3% for the CoW fee and slippage
}

export interface FundingContext {
  phrase: string;
  clientId?: string;
  baseRpc?: string;
  log?: (msg: string) => void;
}

function keys(phrase: string) {
  const m = Mnemonic.fromPhrase(phrase);
  const hd = QuaiHDWallet.fromMnemonic(m);
  const { address } = hd.getNextAddressSync(0, Zone.Cyprus1);
  return {
    quai: quaiWallet(hd.getPrivateKey(address)),
    evm: EvmWallet.fromPhrase(phrase),
  };
}

/** Start a funding job: bridge just enough QUAI to Base. */
export async function startFunding(ctx: FundingContext, targetUsdMicro: bigint): Promise<FundingJob> {
  const { quai, evm } = keys(ctx.phrase);
  const quaiWei = await quaiNeededFor(targetUsdMicro, evm.address);
  const symbiosis = createSymbiosis({ clientId: ctx.clientId ?? "gremlins-runtime" });
  const quote = await quoteBridge({ symbiosis, direction: { from: "quai", to: CHAIN.base }, amount: quaiWei, sender: quai.address, receiver: evm.address });
  const { hash } = await sendBridgeFromQuai(quai, quote, quaiWei);
  ctx.log?.(`funding: bridging ${quaiWei} wei QUAI to Base for ~$${Number(targetUsdMicro) / 1e6} (tx ${hash})`);
  return { stage: "bridging", targetUsdMicro: targetUsdMicro.toString(), quaiWei: quaiWei.toString(), bridgeTx: hash, startedAt: new Date().toISOString() };
}

/** Advance a job one step. Call on each heartbeat until it reaches done/failed. */
export async function advanceFunding(ctx: FundingContext, job: FundingJob): Promise<FundingJob> {
  if (job.stage === "bridging") {
    const s = await bridgeStatus(CHAIN.quai, job.bridgeTx);
    if (s.status === "success") return { stage: "swapping", targetUsdMicro: job.targetUsdMicro, startedAt: job.startedAt };
    if (s.status === "stuck" || s.status === "reverted") return { stage: "failed", reason: `bridge ${s.status}`, at: new Date().toISOString() };
    return job;
  }
  if (job.stage === "swapping") {
    const { evm } = keys(ctx.phrase);
    const provider = new JsonRpcProvider(ctx.baseRpc ?? "https://mainnet.base.org", CHAIN.base, { staticNetwork: true });
    const synth = new Contract(QUAI_SYNTH[CHAIN.base], ["function balanceOf(address) view returns (uint256)"], provider);
    const amount: bigint = await synth.balanceOf(evm.address);
    if (amount === 0n) return { stage: "failed", reason: "no QUAI on Base after bridge", at: new Date().toISOString() };
    const r = await gaslessSell({
      signer: evm.connect(provider), provider, chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base],
      sellTokenPermitDomain: QUAI_SYNTH_PERMIT_DOMAIN, buyToken: USDC[CHAIN.base]!, amount, appCode: "gremlins-funding",
    });
    if (r.status !== "fulfilled") return { stage: "failed", reason: `swap ${r.status}`, at: new Date().toISOString() };
    ctx.log?.(`funding: swapped ${amount} QUAI → ${r.executedBuyAmount} micro-USDC (tx ${r.txHash})`);
    return { stage: "done", usdcMicro: r.executedBuyAmount.toString(), finishedAt: new Date().toISOString() };
  }
  return job;
}
