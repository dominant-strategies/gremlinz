/**
 * What moves with a gremlin: its seed, the egg's files (state, config, signed config, status, launch data) and the
 * agent runtime's directory (memory database, skills, config). Gzipped JSON, then sealed to the nest's key.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface Payload {
  v: 1
  /** BIP39 phrase. The nest checks it derives the gremlin's announced address before accepting. */
  phrase: string
  /** Relative path → base64 contents. Prefixed `gremlin/` (GREMLIN_HOME) or `runtime/` (AUTOMATON_DIR: the runtime's state, i.e. the Hermes home). */
  files: Record<string, string>
}

// hosting.json: the gremlin's own hosting account (hatch custody), which it keeps wherever it lives.
const GREMLIN_FILES = ['state.json', 'config.json', 'signed-config.json', 'private-directions.json', 'status.json', 'launch.json', 'hosting.json',
  'hashference.json', 'inference-purchase.json', 'hosting-renewal.json', 'inference-ledger.jsonl', 'inference-credentials.json', 'inference-reservations.json', 'inference-sources.json', 'inference-docs.json', 'health-actions.jsonl', 'health-state.json', 'mining.json', 'earnings.jsonl', 'income.jsonl', 'issues.jsonl', 'sends.jsonl']
/** Never moved: the old server's own nest key, or anything already regenerated on the new server. */
const SKIP = new Set(['seed', 'nest-key', 'moveout.json'])
const MAX_BYTES = 48 * 1024 * 1024

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name)
    return entry.isDirectory() ? walk(p) : entry.isFile() ? [p] : []
  })
}

export function runtimeFiles(runtimeDir: string): Record<string, string> {
  const files: Record<string, string> = {}
  let total = 0
  for (const p of walk(runtimeDir)) {
    const rel = relative(runtimeDir, p).split(sep).join('/')
    if (rel.split('/').includes('node_modules')) continue
    const data = readFileSync(p)
    total += data.length
    if (total > MAX_BYTES) throw new Error(`move-out payload exceeds ${MAX_BYTES} bytes`)
    files[rel] = data.toString('base64')
  }
  return files
}

export function collectPayload(opts: { phrase: string; gremlinHome: string; runtimeDir: string; launch?: unknown; runtimeOwner?: { uid: number; gid: number } }): Payload {
  const files: Record<string, string> = {}
  let total = 0
  const add = (key: string, data: Buffer) => {
    total += data.length
    if (total > MAX_BYTES) throw new Error(`move-out payload exceeds ${MAX_BYTES} bytes`)
    files[key] = data.toString('base64')
  }
  for (const f of GREMLIN_FILES) {
    const p = join(opts.gremlinHome, f)
    if (existsSync(p) && !SKIP.has(f)) add(`gremlin/${f}`, readFileSync(p))
  }
  // Only dedicated provider-key JSON files move; never follow symlinks into other protected directories.
  const inferenceKeys = join(opts.gremlinHome, 'inference-keys')
  if (existsSync(inferenceKeys)) for (const entry of readdirSync(inferenceKeys, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(entry.name)) add(`gremlin/inference-keys/${entry.name}`, readFileSync(join(inferenceKeys, entry.name)))
  }
  // A move preserves the gremlin's identity, so unexpired consumed approvals must follow it to prevent replay.
  const approvals = join(opts.gremlinHome, 'maker-approvals')
  if (existsSync(approvals)) for (const entry of readdirSync(approvals, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
    const expiry = readFileSync(join(approvals, entry.name))
    if (Number(expiry.toString()) > Date.now()) add(`gremlin/maker-approvals/${entry.name}`, expiry)
  }
  if (opts.launch && !files['gremlin/launch.json']) add('gremlin/launch.json', Buffer.from(JSON.stringify(opts.launch)))
  // Read agent-owned files as the agent, even if its files change while we are taking the snapshot.
  let runtime: Record<string, string>
  if (opts.runtimeOwner) {
    const source = `import { runtimeFiles } from ${JSON.stringify(import.meta.url)}; process.stdout.write(JSON.stringify(runtimeFiles(process.argv[1])))`
    runtime = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, opts.runtimeDir], {
      ...opts.runtimeOwner, env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
    })) as Record<string, string>
  } else runtime = runtimeFiles(opts.runtimeDir)
  for (const [rel, data] of Object.entries(runtime)) {
    add(`runtime/${rel}`, Buffer.from(data, 'base64'))
  }
  return { v: 1, phrase: opts.phrase, files }
}

export function encodePayload(p: Payload): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(p))))
}

export function decodePayload(bytes: Uint8Array): Payload {
  const p = JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8')) as Payload
  if (p.v !== 1 || typeof p.phrase !== 'string' || typeof p.files !== 'object') throw new Error('malformed payload')
  return p
}

/** Write a payload into a fresh server. Refuses paths that escape their directory. */
export function restorePayload(p: Payload, opts: { gremlinHome: string; runtimeDir: string }): void {
  for (const [key, b64] of Object.entries(p.files)) {
    const [area, ...rest] = key.split('/')
    const rel = rest.join('/')
    if (!rel || rel.split('/').some((s) => s === '..' || s === '') || rel.startsWith('/')) throw new Error(`unsafe path in payload: ${key}`)
    const base = area === 'gremlin' ? opts.gremlinHome : area === 'runtime' ? opts.runtimeDir : undefined
    if (!base) throw new Error(`unknown area in payload: ${key}`)
    const out = join(base, rel)
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
    writeFileSync(out, Buffer.from(b64, 'base64'), { mode: 0o600 })
  }
  const seed = join(opts.gremlinHome, 'seed')
  writeFileSync(seed, p.phrase + '\n', { mode: 0o600 })
  chmodSync(seed, 0o600)
}
