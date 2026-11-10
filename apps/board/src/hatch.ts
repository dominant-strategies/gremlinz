/**
 * Hatch custody for Fluence eggs: nobody, not the maker and not us, keeps control of a gremlin's hosting account.
 *
 *   funding ─USDC at the hosting address (QUAI bridged there is swapped)─► paying ─x402 credited─► topped-up
 *   ─VM draft─► launching ─running─► launched ─egg claims with its hatch proof─► handed-off ─key forgotten─► done
 *
 * The backend makes a fresh account key (on Fluence the paying wallet is the account), renders the egg's cloud-init
 * itself (our image, our dev keys, a hatch secret: makers can't inject anything), launches the VM once the maker has
 * funded the address, seals the key to the egg that proves the secret, and deletes its copy. The egg then sweeps the
 * account (packages/hosting fluence-cleanup) against anything our session could still do.
 *
 * Every step persists before it acts and is safe to resume after a crash. Money moves in one place only, the x402
 * top-up, and never twice: each payment authorization is recorded before it is signed, and an unfinished top-up is
 * resolved (authorization used on-chain, Fluence shows a deposit, or the authorization expired unused) before another
 * is attempted. A 409 "under review" is never paid again.
 *
 * One worker per board (the board is single-process SQLite); jobs are stepped one at a time.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Wallet, computeAddress, hexlify } from 'ethers'
import { hatchProof, sealHostingHandover, type HatchClaim, type Sealed } from '@gremlins/hatch'
import { TopUpUnderReview, eggVmName, type Plan, type TopUpAuthorization } from '@gremlins/hosting'
import { renderCloudInit } from '@gremlins/egg/dist/cloud-init.js'
import type { HatchJob, HatchStore } from './hatch-store.ts'

/** What the state machine needs from Fluence (a `fluence()` client in production). */
export interface FluenceClient {
  topUp(amountUsd: number, o: { onAuthorization?: (a: TopUpAuthorization) => void | Promise<void> }): Promise<{ transaction?: string }>
  login(): Promise<void>
  totalDeposited(): Promise<number>
  cheapestPlan(minVcpu?: number, minRamGb?: number): Promise<Plan>
  ubuntuImageId(): Promise<string>
  createDraft(o: { name: string; plan: Plan; imageId: string; cloudInit: string; idempotencyKey: string }): Promise<{ id: string }>
  provision(vmId: string): Promise<unknown>
  vm(vmId: string): Promise<{ id: string; status: string; failure?: unknown }>
}

export interface HatchDeps {
  now: () => number
  fluence: (privateKey: string) => FluenceClient
  /** Base chain reads and the gasless QUAI→USDC sale, signed by the hosting key. */
  base: {
    usdc(address: string): Promise<bigint>
    quai(address: string): Promise<bigint>
    authorizationUsed(authorizer: string, nonce: string): Promise<boolean>
    sellQuai(privateKey: string, amount: bigint): Promise<{ uid: string; status: string }>
  }
  /** The board's record of the egg announced under a launchId. */
  findEgg(launchId: string): Promise<{ address: string; maker: string; configHash: string } | null>
}

export interface HatchConfig {
  /** Egg image pinned by digest (BOARD_EGG_IMAGE). */
  image: string
  artifact?: { url: string; sha256: string }
  /** Dev phase: the team's SSH keys on every egg (BOARD_EGG_DEV_SSH_KEYS). */
  devSshKeys: string[]
  /** The board eggs must talk to (BOARD_PUBLIC_URL); a maker can't point an egg elsewhere. */
  publicUrl: string
  topUpUsd: number
}

const MIN = 60_000
/** Re-sign-in before our token (2 h) runs out. */
const SESSION_MS = 90 * MIN
/** After an authorization's validBefore, allow this long before treating it as dead. */
const SETTLE_GRACE_MS = 2 * MIN

const usdMicro = (usd: number) => BigInt(Math.round(usd * 1e6))
const rec = (job: HatchJob, at: number, event: string) => { job.log = [...job.log.slice(-49), { at, event }] }

export function eggCloudInit(cfg: HatchConfig, job: Pick<HatchJob, 'maker' | 'configHash' | 'boardUrl' | 'launchId'>, secret: string): string {
  return renderCloudInit({
    launch: {
      maker: job.maker, configHash: job.configHash, boardUrl: job.boardUrl, launchId: job.launchId, hatch: { secret },
      ...(cfg.devSshKeys.length ? { dev: { sshKeys: cfg.devSshKeys } } : {}),
    },
    image: cfg.image,
    artifact: cfg.artifact,
  })
}

export function newJob(cfg: HatchConfig, input: { maker: string; configHash: string; launchId: string; boardUrl: string }, now: number): HatchJob {
  const key = hexlify(randomBytes(32))
  const job: HatchJob = {
    id: randomUUID(), launchId: input.launchId, maker: input.maker.toLowerCase(), configHash: input.configHash.toLowerCase(), boardUrl: input.boardUrl,
    hostingAddress: new Wallet(key).address, status: 'funding', topUpUsd: cfg.topUpUsd, createdAt: now, updatedAt: now,
    key, secret: hexlify(randomBytes(32)), log: [{ at: now, event: 'created' }],
  }
  eggCloudInit(cfg, job, job.secret!) // fail now, not after the maker paid
  return job
}

/** Check an egg's claim against the job's hatch secret. Returns the claim to store, or why not. */
export function checkClaim(job: HatchJob, c: HatchClaim): { ok: true; address: string } | { ok: false; status: 403 | 409; reason: string } {
  let address: string
  try {
    address = computeAddress(c.publicKey).toLowerCase()
  } catch {
    return { ok: false, status: 403, reason: 'publicKey is not a point on secp256k1' }
  }
  if (job.claim) return job.claim.address === address ? { ok: true, address } : { ok: false, status: 409, reason: 'another egg already claimed this hatch' }
  if (!job.secret) return { ok: false, status: 409, reason: 'hatch already handed off' }
  if (hatchProof(job.secret, c.publicKey, address) !== c.proof.toLowerCase()) return { ok: false, status: 403, reason: 'bad hatch proof' }
  return { ok: true, address }
}

/**
 * Fluence sessions per job, kept across ticks so we don't sign in (and extend our token window) more than needed.
 * Per deps object, i.e. per process: a restart signs in afresh.
 */
const allSessions = new WeakMap<HatchDeps, Map<string, { fl: FluenceClient; at: number }>>()
const sessionsOf = (deps: HatchDeps) => {
  let m = allSessions.get(deps)
  if (!m) allSessions.set(deps, (m = new Map()))
  return m
}

async function session(deps: HatchDeps, job: HatchJob): Promise<FluenceClient> {
  const now = deps.now()
  const sessions = sessionsOf(deps)
  const s = sessions.get(job.id)
  if (s && now - s.at < SESSION_MS) return s.fl
  const fl = s?.fl ?? deps.fluence(job.key!)
  await fl.login()
  sessions.set(job.id, { fl, at: now })
  job.lastSessionAt = now
  return fl
}

/**
 * Advance a job by at most one stage. `persist` is called before anything irreversible (signing a payment, creating a
 * VM) so a crash right after leaves a record to resume from.
 */
export async function hatchStep(deps: HatchDeps, cfg: HatchConfig, job: HatchJob, persist: (j: HatchJob) => void): Promise<HatchJob> {
  const now = deps.now()
  const save = (event?: string) => {
    job.updatedAt = deps.now()
    if (event) rec(job, job.updatedAt, event)
    persist(job)
  }
  job.error = undefined

  switch (job.status) {
    case 'funding': {
      const need = usdMicro(job.topUpUsd)
      const [usdc, quai] = await Promise.all([deps.base.usdc(job.hostingAddress), deps.base.quai(job.hostingAddress)])
      job.funds = { usdc: usdc.toString(), quai: quai.toString(), at: now }
      if (usdc >= need) {
        job.status = 'paying'
        save('funded')
        break
      }
      if (quai > 0n) {
        // QUAI bridged here by the maker: sell it for USDC (gasless; the hosting key signs a permit and the order).
        const r = await deps.base.sellQuai(job.key!, quai)
        job.swaps = [...(job.swaps ?? []), { uid: r.uid, status: r.status, at: deps.now() }]
        save(`swap ${r.status}`)
        break
      }
      save()
      break
    }

    case 'paying': {
      if (job.topUp && !job.topUp.paidAt) {
        const verdict = await resolveTopUp(deps, job)
        if (verdict === 'paid') {
          job.topUp.paidAt = deps.now()
          job.status = 'topped-up'
          save('top-up confirmed')
          break
        }
        if (verdict === 'wait') {
          save()
          break
        }
        rec(job, now, 'earlier top-up never settled; paying again')
      }
      job.topUp = { startedAt: now, auths: [] }
      save('top-up started')
      try {
        const paid = await deps.fluence(job.key!).topUp(job.topUpUsd, {
          onAuthorization: (a) => {
            job.topUp!.auths.push(a)
            save('payment authorization recorded')
          },
        })
        job.topUp.transaction = paid.transaction
        job.topUp.paidAt = deps.now()
        job.status = 'topped-up'
        save('topped up')
      } catch (e) {
        if (e instanceof TopUpUnderReview) {
          job.topUp.underReview = true
          job.error = e.message
          save('top-up under review')
          break
        }
        throw e // resolved on the next tick, never blindly retried
      }
      break
    }

    case 'topped-up': {
      const fl = await session(deps, job)
      const [plan, imageId] = await Promise.all([fl.cheapestPlan(1, 2), fl.ubuntuImageId()])
      // Same idempotency key on every attempt: a draft created just before a crash comes back instead of a second one.
      const draft = await fl.createDraft({ name: eggVmName(job.launchId), plan, imageId, cloudInit: eggCloudInit(cfg, job, job.secret!), idempotencyKey: `egg-${job.launchId}` })
      job.vmId = draft.id
      job.status = 'launching'
      save(`server ${draft.id} (${plan.vcpu} vCPU, ${plan.ramGb} GB, $${plan.hourlyUsd}/h)`)
      break
    }

    case 'launching': {
      const fl = await session(deps, job)
      // Provisioning is not replayed by Fluence: look before acting.
      const vm = await fl.vm(job.vmId!)
      if (vm.status === 'draft') {
        await fl.provision(job.vmId!)
        save('provisioning')
      } else if (vm.status === 'launched') {
        job.launchedAt = deps.now()
        job.status = 'launched'
        save('server running')
      } else if (vm.status === 'failed') {
        job.status = 'failed'
        job.error = `Fluence could not start the server: ${JSON.stringify(vm.failure ?? '')}`
        save('server failed')
      } else save()
      break
    }

    case 'launched': {
      if (!job.claim) break
      const egg = await deps.findEgg(job.launchId)
      // The claim proved the secret; the announcement must be that same egg, for this maker and config.
      if (!egg || egg.address.toLowerCase() !== job.claim.address || egg.maker.toLowerCase() !== job.maker || egg.configHash.toLowerCase() !== job.configHash) break
      sessionsOf(deps).delete(job.id) // never sign in again: the egg's sweep counts on our last session
      job.handoff = await sealHostingHandover(job.claim.publicKey, {
        v: 1, provider: 'fluence', hostingKey: job.key!, hostingAddress: job.hostingAddress, vmId: job.vmId!,
        launchedAt: new Date(job.launchedAt!).toISOString(), lastSessionAt: new Date(job.lastSessionAt ?? job.launchedAt!).toISOString(),
      })
      job.handedOffAt = deps.now()
      job.status = 'handed-off'
      save('hosting account sealed to the egg')
      break
    }

    case 'handed-off': {
      job.key = null
      job.secret = null
      job.keyDeletedAt = deps.now()
      job.status = 'done'
      save('our copy of the key deleted')
      break
    }
  }
  return job
}

/** An unfinished top-up: did it pay, might it still, or did it certainly not? */
async function resolveTopUp(deps: HatchDeps, job: HatchJob): Promise<'paid' | 'wait' | 'unpaid'> {
  const t = job.topUp!
  for (const a of t.auths) if (a.nonce && (await deps.base.authorizationUsed(job.hostingAddress, a.nonce))) return 'paid'
  try {
    if ((await session(deps, job).then((fl) => fl.totalDeposited())) > 0) return 'paid'
  } catch {
    // no account yet (created by the first payment), or Fluence is down: not proof either way
  }
  if (t.underReview) {
    job.error = 'Fluence is reviewing the payment; it will not be paid again'
    return 'wait'
  }
  const deadline = Math.max(0, ...t.auths.map((a) => a.validBefore * 1000))
  // No authorization was ever signed, or every one expired unused: nothing can settle any more.
  return deps.now() < deadline + SETTLE_GRACE_MS ? 'wait' : 'unpaid'
}

/** Public view of a job (no secrets). */
export function hatchView(job: HatchJob) {
  return {
    jobId: job.id,
    launchId: job.launchId,
    status: job.status,
    hostingAddress: job.hostingAddress,
    minUsd: job.topUpUsd,
    funds: job.funds ? { usdc: job.funds.usdc, quai: job.funds.quai, at: new Date(job.funds.at).toISOString() } : null,
    swaps: job.swaps ?? [],
    topUp: job.topUp ? { transaction: job.topUp.transaction ?? null, underReview: !!job.topUp.underReview, paidAt: job.topUp.paidAt ? new Date(job.topUp.paidAt).toISOString() : null } : null,
    vmId: job.vmId ?? null,
    launchedAt: job.launchedAt ? new Date(job.launchedAt).toISOString() : null,
    eggAddress: job.claim ? computeAddress(job.claim.publicKey) : null,
    handedOffAt: job.handedOffAt ? new Date(job.handedOffAt).toISOString() : null,
    keyDeleted: job.status === 'done',
    error: job.error ?? null,
    log: job.log.map((l) => ({ at: new Date(l.at).toISOString(), event: l.event })),
    updatedAt: new Date(job.updatedAt).toISOString(),
  }
}

/** Funding jobs nobody paid slow down: every tick for an hour, then every 5 minutes, then hourly after two days. */
function due(job: HatchJob, now: number): boolean {
  if (job.nextCheckAt && now < job.nextCheckAt) return false
  if (job.status !== 'funding') return true
  const age = now - job.createdAt
  const every = age < 60 * MIN ? 0 : age < 2 * 24 * 60 * MIN ? 5 * MIN : 60 * MIN
  return now - job.updatedAt >= every
}

export function hatchWorker(o: { store: HatchStore; deps: HatchDeps; cfg: HatchConfig; log?: (...a: unknown[]) => void }) {
  const log = o.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), 'hatch', ...a))
  const persist = (j: HatchJob) => {
    // Scrub first: a crash in between leaves 'handed-off' without a key, which resumes to 'done'.
    if (j.key === null) o.store.forgetSecrets(j.id)
    o.store.save(j)
  }
  let running = false
  /** One pass over every active job. Returns the jobs as they now stand. */
  async function tick(): Promise<HatchJob[]> {
    if (running) return []
    running = true
    try {
      const out: HatchJob[] = []
      for (const job of o.store.active()) {
        if (!due(job, o.deps.now())) continue
        const before = job.status
        try {
          await hatchStep(o.deps, o.cfg, job, persist)
          job.nextCheckAt = undefined
        } catch (e) {
          job.error = (e as Error).message
          job.nextCheckAt = o.deps.now() + MIN
          job.updatedAt = o.deps.now()
          persist(job)
          log(job.id, job.status, 'failed:', job.error)
        }
        if (job.status !== before) log(job.id, before, '→', job.status)
        out.push(job)
      }
      return out
    } finally {
      running = false
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    tick,
    start(everyMs = 15_000) {
      const loop = async () => {
        await tick().catch((e) => log('tick failed:', (e as Error).message))
        timer = setTimeout(loop, everyMs)
      }
      void loop()
    },
    stop() {
      clearTimeout(timer)
    },
  }
}

export type HatchWire = { handoff: Sealed; vmId: string; provider: 'fluence' }
