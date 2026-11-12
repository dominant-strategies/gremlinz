/** Persisted by the egg; transient failures recover quickly without an unbounded restart storm. */
export function restartPlan(failures: number, uptimeMs: number, now: number) {
  const count = uptimeMs >= 600_000 ? 1 : failures + 1
  return { failures: count, nextStartAt: now + Math.min(5_000 * 2 ** Math.min(count - 1, 16), 300_000) }
}
