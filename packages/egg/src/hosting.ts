/**
 * Hatch custody, egg side: the gremlin takes over the hosting account the hatch backend made for it.
 *
 *   announced ─claim (hatchProof of the cloud-init secret)─► hand-over sealed to us ─open─► hosting.json (0600)
 *   (2-of-2 accounts: the backend's shard and the maker's shard, both sealed to us, multiplied into the key here)
 *   ─► sweep the account now, again once the backend's last token has expired (2 h 15 min after its last sign-in),
 *      then daily
 *
 * From then on hosting.json holds the gremlin's own Fluence account key; it moves with the gremlin (payload.ts).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SigningKey } from 'ethers'
import { HandoverIncomplete, hatchProof, openHostingHandover, type HatchClaim, type HostingHandover, type Sealed } from '@gremlins/hatch'
import { nextCleanupAt, type FluenceCleanupReport } from '@gremlins/hosting'
import type { EggKeys } from './keys.js'
import type { LaunchData } from './launch.js'

export interface HostingFile extends HostingHandover {
  receivedAt: string
  nextCleanupAt: string
  /** VMs the gremlin started itself and wants kept (the sweep stops every other one). */
  keepVmIds?: string[]
  cleanups: { at: string; ok: boolean; summary: string; errors?: string[] }[]
}

export interface HatchBoardClient {
  claimHatch(claim: HatchClaim): Promise<void>
  /** undefined until the backend has sealed the hand-over; 2-of-2 accounts also need the maker's sealed shard. */
  fetchHatchHandoff(eggAddress: string): Promise<{ handoff: Sealed; browserHandoff?: Sealed } | undefined>
}

export interface HostingDeps {
  launch: Pick<LaunchData, 'launchId' | 'hatch'>
  keys: Pick<EggKeys, 'evm'>
  board: HatchBoardClient
  now: () => Date
  load: () => HostingFile | undefined
  save: (f: HostingFile) => void
  /** Sweep the account (cleanupFluenceAccount in production). */
  cleanup: (f: HostingFile) => Promise<FluenceCleanupReport>
}

export function hostingFileStore(path: string) {
  return {
    load: (): HostingFile | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as HostingFile) : undefined),
    save: (f: HostingFile) => {
      writeFileSync(path, JSON.stringify(f, null, 2), { mode: 0o600 })
      chmodSync(path, 0o600)
    },
  }
}

export type HostingProgress = 'not-custody' | 'waiting' | 'received' | 'swept' | 'idle'

/** One step: claim and fetch until the hand-over arrives, then sweep when due. `mem` lives for the process. */
export async function hostingStep(deps: HostingDeps, mem: { claimed?: boolean }): Promise<HostingProgress> {
  const secret = deps.launch.hatch?.secret
  let file = deps.load()
  if (!file) {
    if (!secret) return 'not-custody'
    const { evm } = deps.keys
    if (!mem.claimed) {
      await deps.board.claimHatch({ launchId: deps.launch.launchId, publicKey: evm.signingKey.publicKey, proof: hatchProof(secret, evm.signingKey.publicKey, evm.address) })
      mem.claimed = true
    }
    const sealed = await deps.board.fetchHatchHandoff(evm.address)
    if (!sealed) return 'waiting'
    let h: HostingHandover
    try {
      // 2-of-2: the two shards meet here for the first time; the key is assembled only inside the egg.
      h = await openHostingHandover(new SigningKey(evm.privateKey), sealed.handoff, sealed.browserHandoff)
    } catch (e) {
      if (e instanceof HandoverIncomplete) return 'waiting'
      throw e
    }
    const now = deps.now().toISOString()
    file = { ...h, receivedAt: now, nextCleanupAt: now, cleanups: [] }
    deps.save(file)
    return 'received'
  }
  const now = deps.now()
  if (now.getTime() < Date.parse(file.nextCleanupAt)) return 'idle'
  let ok = false
  let summary: string
  let errors: string[] | undefined
  try {
    const r = await deps.cleanup(file)
    ok = r.errors.length === 0
    errors = r.errors.length ? r.errors : undefined
    summary = `${r.apiKeysDeleted.length} API keys deleted, ${r.vmsTerminated.length} VMs stopped, ${r.draftsDiscarded.length} drafts discarded, ${r.accountSshKeysDeleted.length} SSH keys deleted, VM SSH keys ${r.vmSshKeysCleared ? 'cleared' : 'not cleared'}`
  } catch (e) {
    summary = `sweep failed: ${(e as Error).message}`
  }
  const next = nextCleanupAt({ ranAt: now.getTime(), ok, lastForeignSessionAt: Date.parse(file.lastSessionAt) })
  file = { ...file, nextCleanupAt: new Date(next).toISOString(), cleanups: [...file.cleanups.slice(-29), { at: now.toISOString(), ok, summary, ...(errors ? { errors } : {}) }] }
  deps.save(file)
  return 'swept'
}
