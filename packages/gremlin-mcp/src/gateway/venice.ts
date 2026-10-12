/**
 * Venice over x402: no API key. Every request carries a fresh wallet-signed X-Sign-In-With-X header (SIWE on Base),
 * and Venice spends from the wallet's prepaid USDC balance (topped up with x402, see funding). Responses report the
 * remaining balance in X-Balance-Remaining, which we keep for the runway.
 */
import { createAuthFetch } from 'venice-x402-client'
import type { ProviderConfig } from './config.js'
import type { UpstreamFetch } from './providers.js'

export interface VeniceBalance { usd?: number; at?: string }

export function veniceFetch(p: ProviderConfig, privateKey: string, onBalance?: (b: VeniceBalance) => void): UpstreamFetch {
  const authFetch = createAuthFetch(privateKey, { apiUrl: p.baseUrl })
  return async (url, init) => {
    const res = await authFetch(url, init)
    const remaining = res.headers.get('x-balance-remaining')
    if (remaining !== null && !Number.isNaN(Number(remaining))) onBalance?.({ usd: Number(remaining), at: new Date().toISOString() })
    return res
  }
}
