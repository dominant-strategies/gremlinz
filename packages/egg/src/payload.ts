/**
 * What moves with a gremlin: its seed, the egg's files (state, config, signed config, status, launch data) and the
 * agent runtime's directory (memory database, skills, config). Gzipped JSON, then sealed to the nest's key.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface Payload {
  v: 1
  /** BIP39 phrase. The nest checks it derives the gremlin's announced address before accepting. */
  phrase: string
  /** Relative path → base64 contents. Prefixed `gremlin/` (GREMLIN_HOME) or `runtime/` (~/.automaton). */
  files: Record<string, string>
}

const GREMLIN_FILES = ['state.json', 'config.json', 'signed-config.json', 'status.json', 'launch.json']
/** Never moved: the old server's own nest key, or anything already regenerated on the new server. */
const SKIP = new Set(['seed', 'nest-key', 'moveout.json'])
const MAX_BYTES = 48 * 1024 * 1024

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

export function collectPayload(opts: { phrase: string; gremlinHome: string; runtimeDir: string; launch?: unknown }): Payload {
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
  if (opts.launch && !files['gremlin/launch.json']) add('gremlin/launch.json', Buffer.from(JSON.stringify(opts.launch)))
  for (const p of walk(opts.runtimeDir)) {
    const rel = relative(opts.runtimeDir, p).split(sep).join('/')
    if (rel.split('/').includes('node_modules')) continue
    add(`runtime/${rel}`, readFileSync(p))
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
