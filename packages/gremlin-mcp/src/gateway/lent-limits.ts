/**
 * How hard the gateway may drive one lent key: token buckets for requests and tokens per minute, a daily request cap,
 * a concurrency cap, and the provider's own word (429 + Retry-After, with exponential backoff on top; 401/403 stops the
 * key for good). Nothing here waits: a key without room is skipped for this request, so it is never hammered.
 */
import type { ProviderLimits } from '@gremlins/hatch'

const MIN = 60_000
const BACKOFF_BASE_MS = 10_000
const BACKOFF_MAX_MS = 15 * MIN
/** Out of credit (402): try again much later; the lender tops up or the period resets. */
const NO_CREDIT_MS = 30 * MIN

export class TokenBucket {
  private tokens: number
  private last: number
  constructor(readonly capacity: number, private readonly perMinute: number, now: number) {
    this.tokens = capacity
    this.last = now
  }
  private refill(now: number) {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.perMinute) / MIN)
    this.last = now
  }
  /** Takes n if there is room (a request bigger than the bucket goes through only on a full bucket); else ms to wait. */
  take(n: number, now: number): number {
    this.refill(now)
    const need = Math.min(n, this.capacity)
    if (this.tokens >= need) { this.tokens -= n; return 0 }
    return Math.ceil(((need - this.tokens) * MIN) / this.perMinute)
  }
  /** Correct an estimate once the real count is known (may go into debt). */
  adjust(delta: number, now: number) { this.refill(now); this.tokens -= delta }
}

/** Retry-After as milliseconds: seconds, an HTTP date, or retry-after-ms (OpenAI-style). */
export function retryAfterMs(h: Headers, now: number): number | undefined {
  const ms = Number(h.get('retry-after-ms'))
  if (h.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms
  const v = h.get('retry-after')
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined
}

export interface Disabled { status: number; reason: string; at: number }

/** A 403 that is about this request's content, not the key (OpenRouter's moderation, for one). */
const CONTENT_403 = /moderation|flagged|content.?policy|safety/i

export class KeyLimiter {
  private rpm: TokenBucket
  private tpm?: TokenBucket
  private day: number[] = []
  private inFlight = 0
  private strikes = 0
  blockedUntil = 0
  blockReason = ''
  disabled?: Disabled

  constructor(readonly limits: ProviderLimits, private readonly now: () => number = Date.now) {
    this.rpm = new TokenBucket(limits.rpm, limits.rpm, now())
    if (limits.tpm) this.tpm = new TokenBucket(limits.tpm, limits.tpm, now())
  }

  /** A slot for a call of about `tokens`, or why not now. */
  admit(tokens: number): { release: (actualTokens?: number) => void } | { skip: string } {
    const t = this.now()
    if (this.disabled) return { skip: `stopped for good: ${this.disabled.reason}` }
    if (t < this.blockedUntil) return { skip: `${this.blockReason}; resting ${Math.ceil((this.blockedUntil - t) / 1000)}s` }
    if (this.inFlight >= this.limits.concurrency) return { skip: `already ${this.inFlight} calls in flight (limit ${this.limits.concurrency})` }
    this.day = this.day.filter((d) => d > t - 24 * 60 * MIN)
    if (this.limits.rpd && this.day.length >= this.limits.rpd) return { skip: `${this.limits.rpd} requests in the last 24h (limit)` }
    // Check both buckets before taking from either.
    const w = this.rpm.take(1, t)
    if (w) return { skip: `${this.limits.rpm} requests/min limit; room in ${Math.ceil(w / 1000)}s` }
    if (this.tpm) {
      const wt = this.tpm.take(tokens, t)
      if (wt) { this.rpm.adjust(-1, t); return { skip: `${this.limits.tpm} tokens/min limit; room in ${Math.ceil(wt / 1000)}s` } }
    }
    this.day.push(t)
    this.inFlight++
    let done = false
    return {
      release: (actual?: number) => {
        if (done) return
        done = true
        this.inFlight--
        if (actual !== undefined && this.tpm) this.tpm.adjust(actual - tokens, this.now())
      },
    }
  }

  /**
   * The provider's answer. Returns 'disabled' the first time a key is refused (401, or a 403 not about content), so
   * the caller can tell the lender once.
   */
  observe(status: number, headers: Headers, text = ''): 'disabled' | undefined {
    const t = this.now()
    if (status >= 200 && status < 300) { this.strikes = 0; return }
    if (status === 401 || (status === 403 && !CONTENT_403.test(text))) {
      if (this.disabled) return
      this.disabled = { status, reason: `the provider refused the key (${status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 160)}` : ''})`, at: t }
      return 'disabled'
    }
    if (status === 402) { this.block(t, NO_CREDIT_MS, 'out of credit (402)'); return }
    if (status === 429 || status === 408 || status >= 500) {
      this.strikes++
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.strikes - 1))
      this.block(t, Math.max(backoff, retryAfterMs(headers, t) ?? 0), status === 429 ? 'rate limited by the provider (429)' : `provider error ${status}`)
    }
  }

  private block(t: number, ms: number, reason: string) {
    if (t + ms > this.blockedUntil) { this.blockedUntil = t + ms; this.blockReason = reason }
  }

  status() {
    const t = this.now()
    return {
      limits: this.limits,
      inFlight: this.inFlight,
      requestsToday: this.day.filter((d) => d > t - 24 * 60 * MIN).length,
      restingUntil: this.blockedUntil > t ? new Date(this.blockedUntil).toISOString() : null,
      restingBecause: this.blockedUntil > t ? this.blockReason : null,
      disabled: this.disabled ? { status: this.disabled.status, reason: this.disabled.reason, at: new Date(this.disabled.at).toISOString() } : null,
    }
  }
}
