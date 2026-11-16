/** Per-launch progress kept in the browser so the maker can close the tab and resume. */
import type { GremlinConfig, ModelPolicy, SignedConfig } from '@gremlins/hatch'
import type { StepState } from './progress.js'

/** The builder's steps, in order: who it is, its body, its mind, what it thinks with, the rules it lives by. */
export const BUILD_STEPS = ['name', 'look', 'persona', 'models', 'rules'] as const
export type BuildStep = (typeof BUILD_STEPS)[number]

/** The gremlin as described so far; becomes `config` after the last builder step. */
export interface Draft {
  name?: string
  goals?: string[]
  persona?: string
  voice?: string
  /** null: no policy (it may use any model). */
  models?: ModelPolicy | null
  /** The money-and-rules form as filled in, so Back keeps it. */
  rules?: Record<string, string[]>
  createdAt?: string
}

export interface Session {
  launchId: string
  channel?: 'stable' | 'canary'
  maker?: string
  draft?: Draft
  /** The builder step on screen, so Back works and a reload resumes there. */
  at?: BuildStep
  config?: GremlinConfig
  /** Its look from the Gremlin Forge (null: skipped, keeps the creature drawn from its config). */
  look?: { spec: unknown; label?: string; image: string } | null
  lookPosted?: boolean
  signed?: SignedConfig & { message: { issuedAt: bigint | string } }
  /** Where the egg server runs. */
  host?: 'fluence' | 'sporestack'
  /** Fluence: the board's hatch job, which holds the egg's hosting account until the egg takes it over. */
  hatch?: { jobId: string; custody?: 'local' | 'mpc'; hostingAddress: string | null; minUsd: number }
  /** How the maker pays for a Fluence egg: USDC on Base from an EVM wallet, or QUAI bridged from Pelagus. */
  payWith?: 'usdc' | 'quai'
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
export const SESSION_KEY = KEY
const SAVED_KEY = 'gremlins.launch.saved'
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
export type LaunchChannel = 'stable' | 'canary'
export interface SavedSession { session: Session; channel?: LaunchChannel; savedAt: string }

const revive = (s: Session) => {
  if (s.signed) s.signed.message.issuedAt = BigInt(s.signed.message.issuedAt)
  return s
}

export function loadSession(): Session | undefined {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return undefined
    return revive(JSON.parse(raw) as Session)
  } catch {
    return undefined
  }
}

export function saveSession(s: Session): void {
  try {
    const active = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null
    // An old tab must not overwrite a new or resumed hatch selected in another tab.
    if (active?.launchId && active.launchId !== s.launchId) return
    localStorage.setItem(KEY, JSON.stringify(s, replacer))
  } catch { /* private mode: progress just isn't resumable */ }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export function newLaunchId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function savedSessions(): SavedSession[] {
  const rows: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
  if (!Array.isArray(rows) || rows.some(r => !r?.session || typeof r.session.launchId !== 'string' || typeof r.savedAt !== 'string' || (r.channel !== undefined && r.channel !== 'stable' && r.channel !== 'canary'))) {
    throw new Error('Saved hatches could not be read. Your current hatch has not been replaced.')
  }
  return (rows as SavedSession[]).map(r => ({ ...r, session: revive(r.session) }))
}

/** Save the old session durably before replacing it. MPC shares keep their existing per-launch keys. */
function archive(current: Session, channel?: LaunchChannel) {
  const active = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null
  if (active?.launchId && active.launchId !== current.launchId) throw new Error('Another tab selected a different hatch. Reload before switching.')
  const rows = savedSessions()
  if (current.maker || current.draft || current.config || current.hatch || current.machineId || current.invoiceUri || current.sporestackToken) {
    const row: SavedSession = { session: current, channel: channel ?? current.channel, savedAt: new Date().toISOString() }
    const index = rows.findIndex(r => r.session.launchId === current.launchId)
    if (index < 0) rows.unshift(row)
    else rows[index] = row
    // A quota/storage failure must leave the active hatch and its key share intact.
    localStorage.setItem(SAVED_KEY, JSON.stringify(rows, replacer))
  }
}

export function startOver(current: Session, currentChannel: LaunchChannel | undefined, nextChannel: LaunchChannel): Session {
  archive(current, currentChannel)
  const next: Session = { launchId: newLaunchId(), channel: nextChannel }
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

export function resumeSaved(launchId: string, current: Session, currentChannel?: LaunchChannel, targetChannel?: LaunchChannel): Session {
  const saved = savedSessions().find(r => r.session.launchId === launchId)
  if (!saved) throw new Error('This saved hatch is no longer available.')
  archive(current, currentChannel)
  const channel = targetChannel ?? saved.channel ?? saved.session.channel
  const next = { ...saved.session, ...(channel ? { channel } : {}) }
  localStorage.setItem(KEY, JSON.stringify(next, replacer))
  return next
}

export function hatchUrl(currentUrl: string, channel: LaunchChannel): string {
  const url = new URL(currentUrl)
  url.searchParams.delete('hatch-paused')
  if (channel === 'canary') url.searchParams.set('canary', '1')
  else url.searchParams.delete('canary')
  return url.toString()
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
