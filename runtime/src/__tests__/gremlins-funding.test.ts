import { describe, expect, it } from "vitest";
import { USD } from "@gremlins/treasury";
import { decideFunding } from "../gremlins/funding.js";

const bills = [{ id: "topup", asset: "usdc:8453", valueUsd: 5n * USD, dueAt: new Date() }];
const base = { lowCreditsCents: 500, tierUsd: 5, cycleBills: bills };

describe("gremlin funding decision", () => {
  it("does nothing while credits are sufficient", () => {
    expect(decideFunding({ ...base, creditsCents: 900, usdcMicro: 0n, nonCoreHoldings: [] }).convert).toBe(false);
  });
  it("does nothing when USDC already covers the top-up", () => {
    expect(decideFunding({ ...base, creditsCents: 100, usdcMicro: 6n * USD, nonCoreHoldings: [{ asset: "usdc:8453", valueUsd: 6n * USD }] }).convert).toBe(false);
  });
  it("converts only the shortfall for the next tier", () => {
    const d = decideFunding({ ...base, creditsCents: 100, usdcMicro: 2n * USD, nonCoreHoldings: [{ asset: "usdc:8453", valueUsd: 2n * USD }, { asset: "credit:conway", valueUsd: 1n * USD }] });
    expect(d.convert).toBe(true);
    expect(d.targetUsdMicro).toBe(3n * USD);
  });
  it("refuses when other holdings would break the 1.2x rule", () => {
    const d = decideFunding({ ...base, creditsCents: 100, usdcMicro: 0n, nonCoreHoldings: [{ asset: "btc", valueUsd: 4n * USD }] });
    expect(d.convert).toBe(false);
    expect(d.reason).toMatch(/treasury rule/);
  });
});
