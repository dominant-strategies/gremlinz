/** gremlins: heartbeat glue for funding.ts. Thin on purpose: decisions live in decideFunding(). */
import fs from "fs";
import path from "path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { CHAIN, USD, USDC } from "@gremlins/treasury";
import { advanceFunding, decideFunding, startFunding, type FundingJob } from "./funding.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("gremlins.funding");
const JOB_KEY = "gremlin_funding_job";
/** Credits below this trigger a top-up (upstream's smallest tier is $5). */
export const LOW_CREDITS_CENTS = 500;
export const TOPUP_TIER_USD = 5;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

interface KV {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

function seedPhrase(): string | undefined {
  const file = path.join(process.env.GREMLIN_HOME ?? "/var/lib/gremlin", "seed");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim() : undefined;
}

export async function runFundingTick(opts: { creditsCents: number; kv: KV }): Promise<{ shouldWake: boolean; message?: string }> {
  const phrase = seedPhrase();
  if (!phrase) return { shouldWake: false }; // not running as a gremlin
  const ctx = { phrase, log: (m: string) => logger.info(m) };
  const job: FundingJob | undefined = JSON.parse(opts.kv.getKV(JOB_KEY) ?? "null") ?? undefined;
  const save = (j: FundingJob) => opts.kv.setKV(JOB_KEY, JSON.stringify(j));

  try {
    if (job?.stage === "bridging" || job?.stage === "swapping") {
      const next = await advanceFunding(ctx, job);
      save(next);
      if (next.stage === "done") return { shouldWake: true, message: `Converted QUAI to $${Number(next.usdcMicro) / 1e6} USDC on Base for a credit top-up.` };
      if (next.stage === "failed") return { shouldWake: true, message: `QUAI→USDC funding failed: ${next.reason}` };
      return { shouldWake: false };
    }
    if (job?.stage === "failed" && Date.now() - Date.parse(job.at) < RETRY_AFTER_FAILURE_MS) return { shouldWake: false };

    const evm = Wallet.fromPhrase(phrase);
    const provider = new JsonRpcProvider("https://mainnet.base.org", CHAIN.base, { staticNetwork: true });
    const usdcMicro: bigint = await new Contract(USDC[CHAIN.base]!, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(evm.address);
    const decision = decideFunding({
      creditsCents: opts.creditsCents,
      lowCreditsCents: LOW_CREDITS_CENTS,
      usdcMicro,
      tierUsd: TOPUP_TIER_USD,
      // The bill this cycle is the top-up itself; existing USDC and credits are the non-QUAI holdings.
      cycleBills: [{ id: "conway-topup", asset: "usdc:8453", valueUsd: BigInt(TOPUP_TIER_USD) * USD, dueAt: new Date() }],
      nonCoreHoldings: [
        { asset: "usdc:8453", valueUsd: usdcMicro },
        { asset: "credit:conway", valueUsd: (BigInt(Math.max(0, opts.creditsCents)) * USD) / 100n },
      ],
    });
    if (!decision.convert) return { shouldWake: false };
    logger.info(decision.reason);
    save(await startFunding(ctx, decision.targetUsdMicro));
    return { shouldWake: false };
  } catch (err: any) {
    save({ stage: "failed", reason: err.message, at: new Date().toISOString() });
    logger.warn(`funding tick failed: ${err.message}`);
    return { shouldWake: false };
  }
}
