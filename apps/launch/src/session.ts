/** Per-launch progress kept in the browser so the maker can close the tab and resume. */
import type { GremlinConfig, SignedConfig } from '@gremlins/hatch'
import type { StepState } from './progress.js'

export interface Session {
  launchId: string
  maker?: string
  config?: GremlinConfig
  /** Its look from the Gremlin Forge (null: skipped, keeps the creature drawn from its config). */
  look?: { spec: unknown; label?: string; image: string } | null
  lookPosted?: boolean
  signed?: SignedConfig & { message: { issuedAt: bigint | string } }
  /** Where the egg server runs. */
  host?: 'fluence' | 'sporestack'
  /** Fluence: the board's hatch job, which holds the egg's hosting account until the egg takes it over. */
  hatch?: { jobId: string; hostingAddress: string; minUsd: number }
  bridgeTx?: string
  sporestackToken?: string
  invoiceUri?: string
  machineId?: string
  eggAddress?: string
  configPosted?: boolean
  /** Per-step progress (status, timings, signatures, transactions), shown in the progress window. */
  progress?: Record<string, StepState>
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

/**
 * The maker's SporeStack token outlives a single launch: SporeStack requires $100 for a brand-new token's first
 * deposit, and an egg only costs a few dollars, so the balance is reused for later eggs.
 */
const TOKEN_KEY = 'gremlins.sporestackToken'
export function loadMakerToken(): string | undefined {
  try { return localStorage.getItem(TOKEN_KEY) ?? undefined } catch { return undefined }
}
export function saveMakerToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* private mode: token lives only in this session */ }
}
