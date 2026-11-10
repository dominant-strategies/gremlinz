/**
 * A gremlin taking over its own Fluence account. Whoever signed in before it (the hatch backend) holds a 2-hour access
 * token that can't be revoked; with it they could mint API keys, add SSH keys or start VMs. So the owner sweeps the
 * account: every API key deleted, every VM that isn't its own (or one it chose to keep) stopped, no SSH keys on its VM
 * and none left on the account. Run it on receipt, again once the last foreign token has expired, then daily.
 *
 * Dev gremlins keep the team's SSH access through cloud-init (user gremlinz-dev), not through Fluence keys, so this
 * doesn't touch it.
 */
import type { Fluence } from './fluence.js'

export interface FluenceCleanupReport {
  at: string
  apiKeysDeleted: string[]
  vmsTerminated: string[]
  draftsDiscarded: string[]
  accountSshKeysDeleted: string[]
  vmSshKeysCleared: boolean
  /** Per-item failures; the sweep carries on and the caller retries sooner. */
  errors: string[]
}

const GONE = new Set(['terminated', 'terminating'])

export async function cleanupFluenceAccount(fl: Fluence, o: { vmId: string; keepVmIds?: string[]; now?: () => Date }): Promise<FluenceCleanupReport> {
  const report: FluenceCleanupReport = { at: (o.now?.() ?? new Date()).toISOString(), apiKeysDeleted: [], vmsTerminated: [], draftsDiscarded: [], accountSshKeysDeleted: [], vmSshKeysCleared: false, errors: [] }
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      return true
    } catch (e) {
      report.errors.push(`${what}: ${(e as Error).message}`)
      return false
    }
  }
  await fl.login()

  // API keys first: they outlive any token.
  for (const k of await fl.listApiKeys()) if (await attempt(`delete API key ${k.id}`, () => fl.deleteApiKey(k.id))) report.apiKeysDeleted.push(k.id)

  const vms = await fl.listVms()
  const own = vms.find((v) => v.id === o.vmId)
  // Without our own VM in the list, "every other VM" could include ourselves (wrong account, wrong id): stop nothing.
  if (!own || GONE.has(own.status)) throw new Error(`own VM ${o.vmId} is not live in this account (${own?.status ?? 'missing'}); refusing to stop any VM`)
  const keep = new Set([o.vmId, ...(o.keepVmIds ?? [])])
  for (const v of vms) {
    if (keep.has(v.id) || GONE.has(v.status)) continue
    if (v.status === 'draft') {
      if (await attempt(`discard draft ${v.id}`, () => fl.discardDraft(v.id))) report.draftsDiscarded.push(v.id)
    } else if (await attempt(`terminate VM ${v.id}`, () => fl.terminate(v.id, `gremlin-cleanup-${v.id}`))) report.vmsTerminated.push(v.id)
  }

  // Always replace, even when the list looks empty: a pending change applies on the next restart.
  report.vmSshKeysCleared = await attempt('clear VM SSH keys', () => fl.setVmSshKeys(o.vmId, []))
  for (const k of await fl.listSshKeys()) {
    if (k.managedService) continue
    if (await attempt(`delete SSH key ${k.id}`, () => fl.deleteSshKey(k.id))) report.accountSshKeysDeleted.push(k.id)
  }
  return report
}

/** Access tokens last 2 hours; sweep again a little after the last one anyone else could hold has expired. */
export const FOREIGN_TOKEN_TTL_MS = 2 * 60 * 60_000 + 15 * 60_000
const DAY_MS = 24 * 60 * 60_000
const RETRY_MS = 15 * 60_000

/** When to sweep next: retry soon after a failure, once more after the foreign-token window, then daily. */
export function nextCleanupAt(o: { ranAt: number; ok: boolean; lastForeignSessionAt: number }): number {
  if (!o.ok) return o.ranAt + RETRY_MS
  const afterTokens = o.lastForeignSessionAt + FOREIGN_TOKEN_TTL_MS
  return o.ranAt < afterTokens ? afterTokens : o.ranAt + DAY_MS
}
