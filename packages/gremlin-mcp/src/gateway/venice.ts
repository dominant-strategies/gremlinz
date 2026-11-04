/**
 * Venice over x402: no API key. Every request carries a fresh wallet-signed X-Sign-In-With-X header (SIWE on Base),
 * and Venice spends from the wallet's prepaid USDC balance (topped up with x402, see funding). Responses report the
 * remaining balance in X-Balance-Remaining, which we keep for the runway.
 */
import { createAuthFetch } from 'venice-x402-client'
import type { ProviderConfig } from './config.js'
import type { UpstreamFetch } from './providers.js'

export interface VeniceBalance { usd?: number; at?: string }

/**
 * Venice rejects a sign-in whose timestamps are off (X402_SIGN_IN_EXPIRED). That happens when this machine's clock is
 * behind, typically right after the host slept and before the VM's clock is resynced (within seconds). Wait and sign
 * again a few times before giving up.
 */
const SIGN_IN_RETRIES = 3

async function signInExpired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  return /X402_SIGN_IN_EXPIRED|Sign-in-with-X message has expired/i.test(await res.clone().text().catch(() => ''))
}

export function veniceFetch(p: ProviderConfig, privateKey: string, onBalance?: (b: VeniceBalance) => void,
  opts: { retryDelayMs?: number } = {}): UpstreamFetch {
  const authFetch = createAuthFetch(privateKey, { apiUrl: p.baseUrl })
  const delay = opts.retryDelayMs ?? 5000
  return async (url, init) => {
    let res = await authFetch(url, init)
    for (let i = 0; i < SIGN_IN_RETRIES && await signInExpired(res); i++) {
      console.error(`venice: sign-in rejected as expired (clock ${res.headers.get('date') ? `off by ${Math.round((Date.now() - Date.parse(res.headers.get('date')!)) / 1000)}s` : 'behind?'}); signing again`)
      await new Promise((r) => setTimeout(r, delay))
      res = await authFetch(url, init)
    }
    const remaining = res.headers.get('x-balance-remaining')
    if (remaining !== null && !Number.isNaN(Number(remaining))) onBalance?.({ usd: Number(remaining), at: new Date().toISOString() })
    return res
  }
}
