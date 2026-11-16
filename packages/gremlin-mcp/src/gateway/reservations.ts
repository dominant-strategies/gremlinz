/** Reserve estimated spend synchronously before sending; concurrent requests cannot promise the same allowance. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeJsonDurable } from '@gremlins/hatch/node'
import type { RouteTarget } from './config.js'

export interface SpendingScope { id: string; limit: number; used: number; until: number }
export interface Reservation { body: Record<string, unknown>; estimatedUsd: number; release(): void }
interface Hold { usd: number; scopes: { id: string; until: number }[] }

export class Reservations {
  private holds = new Map<string, Hold>()
  constructor(private opts: { file?: string; now?: () => number } = {}) {
    if (opts.file) try { this.holds = new Map(Object.entries(JSON.parse(readFileSync(opts.file, 'utf8')))) } catch { /* first run */ }
  }
  private now() { return (this.opts.now ?? Date.now)() }
  private save() { if (this.opts.file) writeJsonDurable(this.opts.file, Object.fromEntries(this.holds)) }
  pending(id: string) {
    return [...this.holds.values()].reduce((n, h) => n + (h.scopes.some(s => s.id === id && s.until > this.now()) ? h.usd : 0), 0)
  }
  reserve(body: Record<string, unknown>, target: RouteTarget, scopes: SpendingScope[], maxPerCallUsd = Infinity): Reservation | undefined {
    for (const [id, h] of this.holds) if (h.scopes.every(s => s.until <= this.now())) this.holds.delete(id)
    if (!scopes.length) return { body, estimatedUsd: 0, release() {} }
    // Both zero means unknown prices on a paid target; such calls cannot safely consume a bounded allowance.
    if (target.inputPerM === 0 && target.outputPerM === 0) return undefined
    const room = Math.min(maxPerCallUsd, ...scopes.map(s => s.limit - s.used - this.pending(s.id)))
    // One token per serialized byte is a conservative text estimate, including tools and message wrappers.
    // Multimodal/provider-specific billing still needs a provider-side hard limit.
    const input = Buffer.byteLength(JSON.stringify(body)) * target.inputPerM / 1_000_000
    const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? 8192)
    if (!Number.isFinite(requested) || requested < 1 || room <= input) return undefined
    const tokens = Math.min(Math.floor(requested), target.outputPerM > 0 ? Math.floor((room - input) * 1_000_000 / target.outputPerM) : Math.floor(requested))
    if (tokens < 1) return undefined
    const estimatedUsd = input + tokens * target.outputPerM / 1_000_000
    const id = randomUUID()
    this.holds.set(id, { usd: estimatedUsd, scopes: scopes.map(({ id, until }) => ({ id, until })) })
    this.save() // Interrupted processes leave conservative holds until the relevant period resets.
    const capped = { ...body }
    delete capped.max_tokens
    delete capped.max_completion_tokens
    capped[body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'] = tokens
    let released = false
    return { body: capped, estimatedUsd, release: () => { if (!released) { released = true; this.holds.delete(id); this.save() } } }
  }
}
