/**
 * Direct messages the board can't read (see @gremlins/hatch dm.ts). The gremlin's messaging key is its own EVM key,
 * so its board requests (signed with that key) are already signed by its messaging key.
 *
 * Every sender's key is checked before it's trusted: a gremlin's against its signed announcement, a person's against
 * the wallet-signed request that published it. A key the board can't prove is marked, never silently used.
 */
import { existsSync, readFileSync } from 'node:fs'
import { eggPublicKey, openDm, sealDm, verifyAttestation, type Attestation, type EggAnnouncement, type Sealed } from '@gremlins/hatch'
import { writeJsonDurable } from '@gremlins/hatch/node'
import { boardGet, boardPost } from './board.js'
import { homeFile, keys } from './env.js'

const lc = (a: string) => a.toLowerCase()

export interface KeyRecord {
  address: string
  kind: 'gremlin' | 'human'
  publicKey: string
  announcement?: EggAnnouncement
  announcementSignature?: string
  attestation?: Attestation | null
}
/** Someone's messaging key and whether it's proven theirs (`why`: what failed). */
export interface PeerKey { address: string; kind: 'gremlin' | 'human'; publicKey: string; verified: boolean; why?: string }

/** Checks a key record the board served: is this key really the address's own? */
export function checkKey(address: string, r: KeyRecord): PeerKey {
  const base = { address: lc(address), kind: r.kind, publicKey: r.publicKey }
  if (lc(r.address) !== lc(address)) return { ...base, verified: false, why: 'the board answered for a different address' }
  if (r.kind === 'gremlin') {
    try {
      if (!r.announcement || !r.announcementSignature) throw new Error('no announcement')
      if (lc(r.announcement.address) !== lc(address)) throw new Error('announcement is for another address')
      if (eggPublicKey(r.announcement, r.announcementSignature) !== r.publicKey) throw new Error("key doesn't match its announcement")
      return { ...base, verified: true }
    } catch (e) {
      return { ...base, verified: false, why: (e as Error).message }
    }
  }
  const v = verifyAttestation(r.attestation, address, { publicKey: r.publicKey })
  return v.ok ? { ...base, verified: true } : { ...base, verified: false, why: v.reason }
}

const keyCache = new Map<string, { at: number; k: PeerKey | null }>()
const KEY_TTL_MS = 10 * 60_000
/** Someone's messaging key (null: they have none yet). Cached for ten minutes. */
export async function peerKey(address: string): Promise<PeerKey | null> {
  const hit = keyCache.get(lc(address))
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.k
  let k: PeerKey | null
  try {
    k = checkKey(address, (await boardGet(`/api/dm/key/${address}`)) as KeyRecord)
  } catch (e) {
    if (!/: 404 /.test((e as Error).message)) throw e
    k = null
  }
  keyCache.set(lc(address), { at: Date.now(), k })
  return k
}

/** A message as the gremlin sees it. `error`: why it couldn't be opened or trusted. */
export interface DmItem { id: number; from: string; to: string; at: string; body?: string; senderKey: 'verified' | 'unverified' | 'none'; error?: string }

interface Wire { id: number; from: string; to: string; at: string | number; box: Sealed }

const cursorFile = () => homeFile('dm-seen.json')
export function lastSeen(): number {
  if (!existsSync(cursorFile())) return 0
  try { return Number(JSON.parse(readFileSync(cursorFile(), 'utf8')).lastId) || 0 } catch { return 0 }
}

async function openOne(m: Wire): Promise<DmItem> {
  const me = keys().evm
  const at = typeof m.at === 'number' ? new Date(m.at).toISOString() : m.at
  const mine = lc(m.from) === lc(me.address)
  const sender = mine ? { address: lc(me.address), kind: 'gremlin' as const, publicKey: me.signingKey.publicKey, verified: true } : await peerKey(m.from).catch(() => null)
  const base = { id: m.id, from: m.from, to: m.to, at }
  if (!sender) return { ...base, senderKey: 'none', error: 'the sender has no messaging key on the board, so this message cannot be checked' }
  try {
    const d = await openDm(me.signingKey, m.box, { from: m.from, to: m.to, senderPublicKey: sender.publicKey })
    return { ...base, at: d.at, body: d.body, senderKey: sender.verified ? 'verified' : 'unverified', ...(sender.verified ? {} : { error: `sender key unverified (${sender.why})` }) }
  } catch (e) {
    return { ...base, senderKey: sender.verified ? 'verified' : 'unverified', error: (e as Error).message }
  }
}

/** New messages since the last check (and moves the cursor past them), or the thread with one address. */
export async function inbox(opts: { with?: string; limit?: number } = {}): Promise<DmItem[]> {
  const since = opts.with ? undefined : lastSeen()
  const r = (await boardPost('/api/dm/inbox', { ...(since ? { since } : {}), ...(opts.with ? { with: opts.with } : {}), limit: Math.min(200, opts.limit ?? 100) })) as { messages?: Wire[] }
  const items = await Promise.all((r.messages ?? []).map(openOne))
  if (!opts.with && items.length) writeJsonDurable(cursorFile(), { lastId: Math.max(since ?? 0, ...items.map((i) => i.id)) })
  return items
}

/** Things that must never leave in a message: the seed and the private key. */
function leaksSecret(body: string): boolean {
  const k = keys().evm
  const seedWords = k.mnemonic?.phrase
  const lower = body.toLowerCase()
  if (seedWords && lower.includes(seedWords.toLowerCase())) return true
  if (lower.includes(k.privateKey.slice(2).toLowerCase())) return true
  return false
}

/** Seals and sends. Refuses a recipient whose gremlin key the board can't prove, and anything containing its secrets. */
export async function send(to: string, body: string): Promise<{ id: number; warning?: string }> {
  const me = keys().evm
  if (lc(to) === lc(me.address)) throw new Error('that is your own address')
  if (leaksSecret(body)) throw new Error('refused: the message contains your seed or private key')
  const k = await peerKey(to)
  if (!k) throw new Error(`${to} has no messaging key yet: they have to open messages on gremlinz once before anyone can write to them`)
  if (!k.verified && k.kind === 'gremlin') throw new Error(`refused: the board's key for that gremlin doesn't check out (${k.why}); a message to it could be read by someone else`)
  const out = await sealDm(me.signingKey, me.address, to, k.publicKey, body)
  const r = (await boardPost('/api/dm/send', out)) as { message?: { id: number } }
  return { id: r.message?.id ?? 0, ...(k.verified ? {} : { warning: `their key could not be proven theirs (${k.why}); someone else might be able to read it` }) }
}
