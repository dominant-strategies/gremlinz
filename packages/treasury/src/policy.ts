/**
 * The universal treasury rule. Gremlins hold QUAI and Qi. They convert only what the current
 * billing cycle needs, and non-QUAI/Qi holdings may never exceed 1.2x those needs. The extra 20%
 * is a ceiling for slippage and fees, not a buffer to fill.
 *
 * All values are USD in micro-units (1 USD = 1_000_000n) so assets can be compared.
 */

export const USD = 1_000_000n
export const CEILING_NUM = 12n
export const CEILING_DEN = 10n

export interface Bill {
  id: string
  /** Asset the bill must be paid in, e.g. "usdc:8453". */
  asset: string
  valueUsd: bigint
  dueAt: Date
}

export interface Holding {
  /** Asset id, e.g. "usdc:8453", "btc", "credit:conway". */
  asset: string
  valueUsd: bigint
}

/** Bills due before the end of the current cycle (inclusive). */
export function billsInCycle(bills: Bill[], cycleEnd: Date): Bill[] {
  return bills.filter((b) => b.dueAt.getTime() <= cycleEnd.getTime())
}

export function sumUsd(items: { valueUsd: bigint }[]): bigint {
  return items.reduce((acc, i) => acc + i.valueUsd, 0n)
}

/** Maximum USD value that may sit outside QUAI/Qi. */
export function nonCoreCeiling(cycleNeedsUsd: bigint): bigint {
  return (cycleNeedsUsd * CEILING_NUM) / CEILING_DEN
}

/** Needs per asset that current holdings don't already cover. Target is exact need, no buffer. */
export function shortfallByAsset(bills: Bill[], holdings: Holding[]): Map<string, bigint> {
  const need = new Map<string, bigint>()
  for (const b of bills) need.set(b.asset, (need.get(b.asset) ?? 0n) + b.valueUsd)
  const out = new Map<string, bigint>()
  for (const [asset, n] of need) {
    const have = holdings.filter((h) => h.asset === asset).reduce((a, h) => a + h.valueUsd, 0n)
    if (n > have) out.set(asset, n - have)
  }
  return out
}

export interface ConversionCheck {
  ok: boolean
  reason?: string
  ceilingUsd: bigint
  afterUsd: bigint
}

/**
 * Check a proposed conversion out of QUAI/Qi. `amountUsd` is what will land in the target asset
 * (fees on the way are lost value, not holdings).
 */
export function checkConversion(opts: {
  amountUsd: bigint
  cycleBills: Bill[]
  nonCoreHoldings: Holding[]
}): ConversionCheck {
  const ceilingUsd = nonCoreCeiling(sumUsd(opts.cycleBills))
  const afterUsd = sumUsd(opts.nonCoreHoldings) + opts.amountUsd
  if (opts.amountUsd <= 0n) return { ok: false, reason: 'amount must be positive', ceilingUsd, afterUsd }
  if (afterUsd > ceilingUsd) {
    return { ok: false, reason: `non-QUAI/Qi holdings would be ${afterUsd} > ceiling ${ceilingUsd}`, ceilingUsd, afterUsd }
  }
  return { ok: true, ceilingUsd, afterUsd }
}

/**
 * USD value of non-QUAI/Qi holdings that should be swept back into QUAI. Keeps assets that match
 * current-cycle bills (up to the bill amount) and sweeps everything else.
 */
export function sweepPlan(cycleBills: Bill[], nonCoreHoldings: Holding[]): Holding[] {
  const need = new Map<string, bigint>()
  for (const b of cycleBills) need.set(b.asset, (need.get(b.asset) ?? 0n) + b.valueUsd)
  const out: Holding[] = []
  for (const h of nonCoreHoldings) {
    const keep = need.get(h.asset) ?? 0n
    const kept = keep < h.valueUsd ? keep : h.valueUsd
    need.set(h.asset, keep - kept)
    if (h.valueUsd > kept) out.push({ asset: h.asset, valueUsd: h.valueUsd - kept })
  }
  return out
}
