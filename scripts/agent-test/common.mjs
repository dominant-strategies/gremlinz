// Shared by hatch.mjs and watch.mjs: where state lives, the prod board's public GET API, and dev SSH to the egg.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const CACHE = process.env.AGENT_TEST_DIR ?? join(homedir(), '.cache', 'gremlinz-agent-test')
export const DEFAULT_BOARD = 'https://gremlinz.ai'
export const DEV_KEY = process.env.GREMLINZ_DEV_KEY ?? join(homedir(), '.ssh', 'gremlinz_dev_ed25519')

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
export const statePath = (name) => join(CACHE, `${name}.json`)
export const runDir = (name) => join(CACHE, name)

export function loadState(name) {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')) } catch { return undefined }
}

/** Merge `patch` into the state file (atomic rename). Arrays under `txs` are appended, not replaced. */
export function saveState(name, patch) {
  mkdirSync(CACHE, { recursive: true, mode: 0o700 })
  const cur = loadState(name) ?? { name, createdAt: new Date().toISOString() }
  const next = mergeState(cur, patch)
  const tmp = `${statePath(name)}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, statePath(name))
  return next
}

export function mergeState(cur, patch) {
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
  if (cur.gremlin || patch.gremlin) next.gremlin = { ...cur.gremlin, ...patch.gremlin }
  if (patch.txs) {
    const seen = new Set((cur.txs ?? []).map((t) => t.hash))
    next.txs = [...(cur.txs ?? []), ...patch.txs.filter((t) => !seen.has(t.hash))]
  }
  return next
}

/** --flag value / --flag=value / --bool. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const [k, v] = a.slice(2).split(/=(.*)/s)
    if (v !== undefined) out[k] = v
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
    else out[k] = true
  }
  return out
}

/** "15m", "2h", "90s", "1d" → ms. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(String(s).trim())
  if (!m) throw new Error(`bad duration "${s}" (e.g. 15m, 1h)`)
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'm']
}

// ── the board's public API (GET only) ────────────────────────────────────────

export function boardReader(base = DEFAULT_BOARD, fetchImpl = fetch) {
  const get = async (path) => {
    const res = await fetchImpl(new URL(path, base), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) { const e = new Error(`GET ${path}: ${res.status} ${body.error ?? ''}`.trim()); e.status = res.status; throw e }
    return body
  }
  return {
    get,
    job: async (jobId) => (await get(`/api/hatch/${encodeURIComponent(jobId)}`)).job,
    eggByLaunch: async (launchId) => (await get(`/api/eggs?launchId=${encodeURIComponent(launchId)}`)).egg,
    egg: async (address) => (await get(`/api/eggs/${address}`)).egg,
    pulses: async (address, limit = 100) => (await get(`/api/gremlins/${address}/pulses?limit=${limit}`)).pulses,
    accountPosts: async (address) => (await get(`/api/accounts/${address}`)).posts ?? [],
    /**
     * Comments by any of `authors` on recent posts. The board has no per-author comment listing, so this walks the
     * newest posts of every community (bounded): comments on old posts are missed.
     */
    async commentsBy(authors, { postsPerCommunity = 50, maxPosts = 80, sinceMs = Date.now() - 7 * 864e5 } = {}) {
      const who = new Set(authors.filter(Boolean).map((a) => a.toLowerCase()))
      const { communities } = await get('/api/communities')
      const posts = []
      for (const c of communities ?? []) {
        const r = await get(`/api/c/${encodeURIComponent(c.name)}?sort=new&limit=${postsPerCommunity}`)
        posts.push(...(r.posts ?? []).filter((p) => p.commentCount > 0 && Date.parse(p.createdAt) >= sinceMs))
      }
      const out = []
      for (const p of posts.slice(0, maxPosts)) {
        const { comments } = await get(`/api/posts/${p.id}`)
        const walk = (list) => { for (const c of list ?? []) { if (who.has(String(c.author).toLowerCase())) out.push(c); walk(c.replies) } }
        walk(comments)
      }
      return out
    },
  }
}

// ── dev SSH ──────────────────────────────────────────────────────────────────

export function sshArgs(ip, { key = DEV_KEY, user = 'gremlinz-dev' } = {}) {
  mkdirSync(CACHE, { recursive: true, mode: 0o700 })
  return [
    '-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
    // Eggs are new servers: trust a key on first sight, then hold it to that (our own known_hosts, not ~/.ssh's).
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(CACHE, 'known_hosts')}`,
    `${user}@${ip}`,
  ]
}

/** Run egg-collect.py on the egg (as root via sudo) and parse its JSON. */
export function collectFromEgg(ip, { hours = 48, key = DEV_KEY, timeoutMs = 240_000 } = {}) {
  if (!existsSync(key)) return Promise.resolve({ ip, error: `dev key ${key} not found` })
  const script = readFileSync(join(HERE, 'egg-collect.py'))
  return new Promise((resolve) => {
    const child = execFile('ssh', [...sshArgs(ip, { key }), 'sudo', '-n', 'python3', '-', String(hours)], { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ip, error: (stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300) })
      try { resolve({ ip, ...JSON.parse(stdout) }) } catch { resolve({ ip, error: `unparseable collector output: ${(stderr || stdout).slice(0, 200)}` }) }
    })
    child.stdin.end(script)
  })
}
