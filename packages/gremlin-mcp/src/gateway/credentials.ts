/** Credential availability. No secret or upstream error body is persisted or exposed in health output. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { apiKeyFromFile } from './key-file.js'
import { readKey } from '../hashference.js'
import type { GatewayConfig, ProviderConfig } from './config.js'

export type CredentialState = { state: 'ready' | 'rate-limited' | 'quota-exhausted' | 'invalid' | 'unavailable'; retryAt?: number; failures: number; fingerprint?: string }
export const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex')

export function credentialFingerprint(p: ProviderConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (p.credentialHash) return p.credentialHash
  const key = p.kind === 'hashference' && p.keyFile ? readKey(p.keyFile)?.apiKey : p.apiKeyEnv ? env[p.apiKeyEnv] : apiKeyFromFile(p.keyFile)
  return key ? fingerprint(key) : undefined
}

/** Expand multiple credentials without changing the provider name used by the maker's model policy. */
export function expandCredentials(cfg: GatewayConfig) {
  const canonical = new Map<string, string>()
  const ids = new Set(cfg.providers.map(p => p.id))
  if (ids.size !== cfg.providers.length) throw new Error('duplicate provider id')
  const providers = cfg.providers.flatMap(p => {
    const envs = [...new Set([...(p.apiKeyEnv ? [p.apiKeyEnv] : []), ...(p.apiKeyEnvs ?? [])])]
    if (p.kind !== 'openai' || !envs.length) return [p]
    return envs.map((apiKeyEnv, i) => {
      const id = i ? `${p.id}:key:${i + 1}` : p.id
      if (i && ids.has(id)) throw new Error(`duplicate credential id: ${id}`)
      ids.add(id)
      canonical.set(id, p.id)
      return { ...p, id, apiKeyEnv, apiKeyEnvs: undefined }
    })
  })
  return { cfg: { ...cfg, providers }, canonical }
}

/** Standard Retry-After (seconds or HTTP date); quota headers vary, so adapters can supply Retry-After themselves. */
export function retryAt(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after')
  if (!value) return undefined
  const ms = /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value)
  return Number.isFinite(ms) && ms > now ? ms : undefined
}

export class Credentials {
  private states = new Map<string, CredentialState>()
  constructor(private opts: { now?: () => number; file?: string } = {}) {
    if (opts.file) {
      try {
        const rows = JSON.parse(readFileSync(opts.file, 'utf8')) as Record<string, CredentialState>
        for (const [id, s] of Object.entries(rows)) if (['ready', 'rate-limited', 'quota-exhausted', 'invalid', 'unavailable'].includes(s.state) && Number.isFinite(s.failures)) this.states.set(id, s)
      } catch { /* first boot or unreadable state: the upstream remains authoritative */ }
    }
  }
  private now() { return (this.opts.now ?? Date.now)() }
  private save() { if (this.opts.file) writeJsonDurable(this.opts.file, Object.fromEntries(this.states)) }
  /** A changed secret is new authorization, so it may replace an invalid credential. */
  available(id: string, fp?: string): boolean {
    const s = this.states.get(id)
    if (!s) return true
    if (fp !== undefined && s.fingerprint !== fp) { this.states.delete(id); this.save(); return true }
    return s.state !== 'invalid' && (s.retryAt === undefined || s.retryAt <= this.now())
  }
  fail(id: string, status?: number, headers = new Headers(), fp?: string, resetAt?: number) {
    const prev = this.states.get(id)
    const failures = (prev?.failures ?? 0) + 1
    const state = status === 401 || status === 403 ? 'invalid' : status === 402 ? 'quota-exhausted' : status === 429 ? 'rate-limited' : 'unavailable'
    const delay = state === 'quota-exhausted' ? 30 * 60_000 : Math.min(10 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 10))
    const retry = retryAt(headers, this.now()) ?? (state === 'quota-exhausted' && resetAt && resetAt > this.now() ? Math.min(this.now() + delay, resetAt) : this.now() + delay)
    this.states.set(id, { state, failures, fingerprint: fp, ...(state === 'invalid' ? {} : { retryAt: retry }) })
    this.save()
  }
  success(id: string) { if (this.states.delete(id)) this.save() }
  /** Top-ups reset temporary failures only. Invalid/revoked authorization needs a replacement credential. */
  reset(id?: string) {
    const reset: string[] = []
    for (const [key, s] of this.states) if ((!id || id === key) && s.state !== 'invalid') { this.states.delete(key); reset.push(key) }
    this.save()
    return reset
  }
  snapshot() { return Object.fromEntries([...this.states].map(([id, { fingerprint: _fp, ...s }]) => [id, s])) }
}
