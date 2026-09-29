/** Per-launch progress kept in the browser so the maker can close the tab and resume. */
import type { GremlinConfig, SignedConfig } from '@gremlins/hatch'

export interface Session {
  launchId: string
  maker?: string
  config?: GremlinConfig
  signed?: SignedConfig & { message: { issuedAt: bigint | string } }
  sporestackToken?: string
  invoiceUri?: string
  machineId?: string
  eggAddress?: string
  configPosted?: boolean
}

const KEY = 'gremlins.launch'
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export function loadSession(): Session | undefined {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return undefined
    const s = JSON.parse(raw) as Session
    if (s.signed) s.signed.message.issuedAt = BigInt(s.signed.message.issuedAt)
    return s
  } catch {
    return undefined
  }
}

export function saveSession(s: Session): void {
  try { localStorage.setItem(KEY, JSON.stringify(s, replacer)) } catch { /* private mode: progress just isn't resumable */ }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export function newLaunchId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}
