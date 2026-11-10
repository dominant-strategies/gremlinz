/**
 * Hatch jobs (hatch.ts), in their own SQLite file (mode 0600), apart from the public board data. The hosting key and the
 * egg's hatch secret are encrypted at rest (AES-256-GCM, key from BOARD_HATCH_SECRET, bound to the job id) and set to
 * NULL once the key is sealed to its egg; secure_delete and a WAL checkpoint keep the old pages from lingering.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Sealed } from '@gremlins/hatch'
import type { TopUpAuthorization } from '@gremlins/hosting'

export type HatchStatus =
  | 'funding' // waiting for USDC (or bridged QUAI) at the hosting address
  | 'paying' // x402 top-up started; resolved before anything else is paid
  | 'topped-up' // Fluence credited
  | 'launching' // VM draft created, provisioning
  | 'launched' // VM running; waiting for the egg's claim
  | 'handed-off' // account key sealed to the egg
  | 'done' // our copy of the key deleted
  | 'failed'

export interface HatchJob {
  id: string
  launchId: string
  maker: string
  configHash: string
  boardUrl: string
  hostingAddress: string
  status: HatchStatus
  topUpUsd: number
  createdAt: number
  updatedAt: number
  /** Plaintext in memory only; null once handed off. */
  key: string | null
  /** Hatch secret in the egg's cloud-init; null once handed off. */
  secret: string | null
  funds?: { usdc: string; quai: string; at: number }
  swaps?: { uid: string; status: string; at: number }[]
  topUp?: {
    startedAt: number
    /** Every payment authorization signed for this attempt (x402 may sign a fresh one on recovery). */
    auths: TopUpAuthorization[]
    underReview?: boolean
    transaction?: string
    paidAt?: number
  }
  vmId?: string
  /** Our last Fluence sign-in; its token (2 h, not revocable) runs out from here. */
  lastSessionAt?: number
  launchedAt?: number
  claim?: { address: string; publicKey: string; at: number }
  handoff?: Sealed
  handedOffAt?: number
  keyDeletedAt?: number
  error?: string
  nextCheckAt?: number
  log: { at: number; event: string }[]
}

/** AES-256-GCM under a key derived from the operator's secret; `aad` binds a ciphertext to its job. */
export function secretBox(secret: string) {
  if (secret.length < 32) throw new Error('BOARD_HATCH_SECRET must be at least 32 characters')
  const key = createHash('sha256').update('gremlins-hatch-store-v1\0').update(secret).digest()
  return {
    seal(plain: string, aad: string): string {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(Buffer.from(aad))
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return ['v1', iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join(':')
    },
    open(box: string, aad: string): string {
      const [v, iv, ct, tag] = box.split(':')
      if (v !== 'v1' || !iv || !ct || !tag) throw new Error('unknown hatch secret box')
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
      d.setAAD(Buffer.from(aad))
      d.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
    },
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_jobs (
  id          TEXT PRIMARY KEY,
  launch_id   TEXT NOT NULL UNIQUE,
  egg_address TEXT UNIQUE,
  claim       TEXT,
  status      TEXT NOT NULL,
  key_enc     TEXT,
  secret_enc  TEXT,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hatch_jobs_status ON hatch_jobs(status);
`

const TERMINAL: HatchStatus[] = ['done', 'failed']

type Row = { id: string; key_enc: string | null; secret_enc: string | null; claim: string | null; data: string }
const COLS = 'id, key_enc, secret_enc, claim, data'

export class HatchStore {
  private db: DatabaseSync
  private box: ReturnType<typeof secretBox>

  /** `path` may be ':memory:' for tests. */
  constructor(path: string, secret: string) {
    this.box = secretBox(secret)
    // Create the file 0600 ourselves: SQLite gives its -wal and -shm files the database file's mode.
    if (path !== ':memory:') closeSync(openSync(path, 'a', 0o600))
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;')
    this.db.exec(SCHEMA)
  }

  private toJob(r: Row | undefined): HatchJob | null {
    if (!r) return null
    const job = JSON.parse(r.data) as HatchJob
    job.key = r.key_enc ? this.box.open(r.key_enc, `key:${r.id}`) : null
    job.secret = r.secret_enc ? this.box.open(r.secret_enc, `secret:${r.id}`) : null
    if (r.claim) job.claim = JSON.parse(r.claim)
    return job
  }

  private one(sql: string, ...args: string[]) {
    return this.toJob(this.db.prepare(`SELECT ${COLS} FROM hatch_jobs WHERE ${sql}`).get(...args) as Row | undefined)
  }

  /** False when the launchId already has a job. */
  insert(job: HatchJob): boolean {
    try {
      this.db.prepare('INSERT INTO hatch_jobs (id, launch_id, egg_address, status, key_enc, secret_enc, data, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(
        job.id, job.launchId, job.status,
        job.key ? this.box.seal(job.key, `key:${job.id}`) : null,
        job.secret ? this.box.seal(job.secret, `secret:${job.id}`) : null,
        this.data(job), job.createdAt, job.updatedAt,
      )
      return true
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) return false
      throw e
    }
  }

  /**
   * Writes the worker's view of a job. Not the encrypted columns (they only ever go from set to NULL: `forgetSecrets`)
   * and not the claim, which the API writes (`setClaim`) while the worker may hold an older copy.
   */
  save(job: HatchJob): void {
    this.db.prepare('UPDATE hatch_jobs SET status = ?, data = ?, updated_at = ? WHERE id = ?').run(job.status, this.data(job), job.updatedAt, job.id)
  }

  /** First claim wins: false if the job already has one, or another job has this egg. */
  setClaim(id: string, claim: NonNullable<HatchJob['claim']>): boolean {
    try {
      return this.db.prepare('UPDATE hatch_jobs SET claim = ?, egg_address = ? WHERE id = ? AND claim IS NULL').run(JSON.stringify(claim), claim.address.toLowerCase(), id).changes === 1
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) return false
      throw e
    }
  }

  /** Drop the hosting key and hatch secret for good, and scrub them from the file. */
  forgetSecrets(id: string): void {
    this.db.prepare('UPDATE hatch_jobs SET key_enc = NULL, secret_enc = NULL WHERE id = ?').run(id)
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  get = (id: string) => this.one('id = ?', id)
  getByLaunchId = (launchId: string) => this.one('launch_id = ?', launchId)
  getByEggAddress = (address: string) => this.one('egg_address = ?', address.toLowerCase())

  /** Jobs the worker still has to move along. */
  active(): HatchJob[] {
    const rows = this.db.prepare(`SELECT ${COLS} FROM hatch_jobs WHERE status NOT IN (${TERMINAL.map(() => '?').join(', ')}) ORDER BY created_at`).all(...TERMINAL) as Row[]
    return rows.map((r) => this.toJob(r)!)
  }

  /** Raw row, for tests that check what is at rest. */
  raw(id: string) {
    return this.db.prepare('SELECT * FROM hatch_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  }

  private data(job: HatchJob): string {
    const { key: _k, secret: _s, claim: _c, ...rest } = job
    return JSON.stringify(rest)
  }

  close(): void {
    this.db.close()
  }
}
