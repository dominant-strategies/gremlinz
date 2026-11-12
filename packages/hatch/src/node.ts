/** Node-only durability and deadline helpers. Never imported by the browser entry point. */
import { randomUUID } from 'node:crypto'
import { closeSync, fchownSync, fsyncSync, linkSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/** Sync the contents before publishing, then sync the directory entry. An exclusive write never replaces identity. */
export function writeDurable(path: string, data: string | Uint8Array, opts: { mode?: number; exclusive?: boolean } = {}): void {
  const dir = dirname(path)
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', opts.mode ?? 0o600)
    // The root egg updates files also read by the gremlin user. Atomic replacement must retain that ownership.
    if (!opts.exclusive && process.getuid?.() === 0) {
      let previous
      try { previous = statSync(path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; previous = statSync(dir) }
      fchownSync(fd, previous.uid, previous.gid)
    }
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (opts.exclusive) { linkSync(temp, path); unlinkSync(temp) }
    else renameSync(temp, path)
    const directory = openSync(dir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}

export function writeJsonDurable(path: string, value: unknown): void {
  writeDurable(path, JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
}

/** Financial/event journals must reach disk before their caller reports success. */
export function appendDurable(path: string, line: string): void {
  const fd = openSync(path, 'a', 0o600)
  try { writeFileSync(fd, line); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

/** Covers response headers AND body consumption. Also bounds adapters which accidentally ignore AbortSignal. */
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, label = 'request'): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('deadline must be positive')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`)
      reject(error)
      controller.abort(error)
    }, ms)
  })
  try { return await Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]) }
  finally { clearTimeout(timer) }
}

/** Kernel advisory lock. stdin EOF releases it even when this Node process is killed outright. */
export async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const holder = spawn('flock', ['--exclusive', '--nonblock', path, 'sh', '-c', 'printf locked; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  holder.stdin.on('error', () => {}) // failed acquisition can close stdin before the cleanup runs
  const closed = new Promise<void>(resolve => holder.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.stdout.once('data', () => resolve())
      holder.once('close', () => reject(new Error('another payment is in progress (or flock is unavailable)')))
    })
    return await run()
  } finally {
    holder.stdin.end()
    await closed
  }
}
