import type { RateLimit } from './config.ts'

/**
 * In-memory sliding-window limiter keyed by `${action}:${address}`. Per-process; a multi-instance
 * deployment should move this into the store (or Redis).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  /** Records a hit and returns 0 if allowed, else the seconds until the next slot frees up. */
  take(key: string, limit: RateLimit, now: number): number {
    const windowMs = limit.windowSec * 1000
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs)
    if (recent.length >= limit.max) {
      this.hits.set(key, recent)
      return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000))
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 50_000) this.prune(now)
    return 0
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1]! < now - 7 * 24 * 3600 * 1000) this.hits.delete(k)
  }
}
