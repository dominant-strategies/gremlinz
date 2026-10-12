/** Upstream calls, and which failures mean "try the next provider". */
import type { ProviderConfig } from './config.js'

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
  throw new Error(`provider kind ${p.kind} needs a signer (see venice.ts)`)
}

/** Worth failing over: the provider is down, overloaded, out of balance or misbehaving. Not: our request is bad. */
export const retryable = (status: number) => status === 402 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
