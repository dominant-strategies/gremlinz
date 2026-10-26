/**
 * Wallet sign-in and signed requests for the forge page. Shares the board's stored sign-in (same localStorage keys as
 * board-client.ts), and signs requests the same way: EIP-191 over `METHOD path\nts\nkeccak(body)`.
 */
import { hexlify, toUtf8Bytes } from 'ethers'
import { AUTH_HEADERS, requestSigningPayload } from '@gremlins/hatch'
import { pelagus, type Eip1193 } from './wallets.js'

const KEY = 'gremlins.board.address'
const KIND = 'gremlins.board.wallet' // 'pelagus' | 'evm'
const load = (k: string) => { try { return localStorage.getItem(k) ?? undefined } catch { return undefined } }
const store = (k: string, v?: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch { /* private mode */ } }

let address = load(KEY)
let kind = load(KIND) as 'pelagus' | 'evm' | undefined

export const signedInAddress = (): string | undefined => address

/** Connects Pelagus when it's installed, otherwise the EVM wallet picker. */
export async function signIn(): Promise<string> {
  if (pelagus()) {
    address = ((await pelagus()!.request({ method: 'quai_requestAccounts' })) as string[])?.[0]
    kind = 'pelagus'
  } else {
    const { connectEvm } = await import('./wallets.js')
    address = (await connectEvm()).address
    kind = 'evm'
  }
  if (!address) throw new Error('No account was selected.')
  store(KEY, address)
  store(KIND, kind)
  return address
}

export function signOut(): void {
  address = undefined
  kind = undefined
  store(KEY)
  store(KIND)
}

async function provider(): Promise<Eip1193> {
  if (kind === 'pelagus') {
    const p = pelagus()
    if (!p) throw new Error('Pelagus is not available in this browser.')
    return p
  }
  const { connectEvm } = await import('./wallets.js')
  return (await connectEvm()).provider
}

/** POSTs JSON as a signed board request and returns the parsed reply; throws with the board's error message. */
export async function signedPostJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (!address) await signIn()
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  const p = await provider()
  const signature = (await p.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(requestSigningPayload('POST', path, ts, raw))), address] })) as string
  const res = await fetch(path, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', [AUTH_HEADERS.address]: address!, [AUTH_HEADERS.timestamp]: String(ts), [AUTH_HEADERS.signature]: signature },
    body: raw,
  })
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; retryAfterSec?: number }
  if (!res.ok) {
    if (res.status === 429) throw new Error(`You've reached today's limit. Try again in ${Math.ceil((j.retryAfterSec ?? 3600) / 60)} minutes.`)
    throw new Error(j.error ?? `The board answered ${res.status}.`)
  }
  return j
}
