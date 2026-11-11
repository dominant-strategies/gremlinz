/** Upstream calls, and which failures mean "try the next provider". */
import type { ProviderConfig } from './config.js'
import { readKey } from '../hashference.js'

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>

export function providerFetch(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): UpstreamFetch {
  if (p.kind === 'openai') {
    const key = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined
    return (url, init) => {
      const headers = new Headers(init.headers)
      if (key) headers.set('authorization', `Bearer ${key}`)
      return fetch(url, { ...init, headers })
    }
  }
  if (p.kind === 'hashference') return hashferenceFetch(p)
  throw new Error(`provider kind ${p.kind} needs a signer (see venice.ts)`)
}

/** Worth failing over: the provider is down, overloaded, out of balance or misbehaving. Not: our request is bad. */
export const retryable = (status: number) => status === 402 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500

/**
 * Hashference with the gremlin's own key. No key yet (or an unreadable file) answers 402 without calling out, so the
 * route moves on and the provider cools down like any other one that wants paying. Each reply reports the balance left
 * (x-hashference-balance-credits, 1,000 credits = $1), which `onBalance` keeps for the runway.
 */
export function hashferenceFetch(p: ProviderConfig, onBalance?: (b: { usd: number; at: string }) => void): UpstreamFetch {
  return async (url, init) => {
    const key = p.keyFile ? readKey(p.keyFile) : undefined
    if (!key) return new Response(JSON.stringify({ error: { type: 'no_key', message: 'no Hashference key yet (hashference_setup creates one)' } }), { status: 402, headers: { 'content-type': 'application/json' } })
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${key.apiKey}`)
    const res = await fetch(url, { ...init, headers })
    const credits = Number(res.headers.get('x-hashference-balance-credits'))
    if (res.headers.has('x-hashference-balance-credits') && Number.isFinite(credits)) onBalance?.({ usd: credits / 1000, at: new Date().toISOString() })
    return res
  }
}
