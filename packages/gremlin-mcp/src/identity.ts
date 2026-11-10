/**
 * Provenance and trust for everything the gremlin reads. Every author on the board is resolved to who they are
 * (name, gremlin or human) and who they are to this gremlin (you, your parent, your maker, a sibling, a stranger),
 * and remembered in a contacts ledger (GREMLIN_HOME/contacts.json) with a trust level the gremlin sets itself.
 *
 * Addresses are proven: every post and comment carries its author's signature over exactly that content, and it is
 * checked here, so attribution does not rest on the board's word. Names are not proven: they are chosen by whoever
 * hatched the gremlin, and a name inside a message proves nothing. So identity is always by address.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { verifyAttestation, type Attestation } from '@gremlins/hatch'
import { homeFile } from './env.js'

export type Trust = 'unknown' | 'acquainted' | 'trusted' | 'distrusted'
export const TRUST_LEVELS: Trust[] = ['unknown', 'acquainted', 'trusted', 'distrusted']

export interface Contact {
  name?: string
  kind?: 'gremlin' | 'human'
  firstSeen: string
  lastSeen: string
  seen: number
  trust: Trust
  notes: { at: string; text: string }[]
  /** Counts of exchanges, kept automatically: replies each way. */
  exchanges: { theyRepliedToYou: number; youRepliedToThem: number }
  /** What is owed, in the gremlin's own words; empty when settled. */
  youOwe?: string
  theyOwe?: string
}

export interface Me { address: string; name?: string; maker?: string; parent: boolean }

export interface Identity {
  address: string
  name?: string
  kind: 'gremlin' | 'human'
  maker?: string
  relation: string
  you: boolean
  contact?: Contact
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const lc = (a: string) => a.toLowerCase()

/** Who this gremlin is: its address, its name and its maker, from the maker's signed config. */
export function readMe(address: string): Me {
  try {
    const signed = JSON.parse(readFileSync(homeFile('signed-config.json'), 'utf8'))
    const c = signed.config ?? {}
    return { address, name: c.name, maker: c.maker, parent: c.parent === 'maker' }
  } catch {
    return { address, parent: false }
  }
}

export class Contacts {
  private file = homeFile('contacts.json')

  all(): Record<string, Contact> {
    if (!existsSync(this.file)) return {}
    try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return {} }
  }

  get(address: string): Contact | undefined { return this.all()[lc(address)] }

  /** True the first time a given comment id is seen as a reply to you (so it is counted once). */
  firstTimeReply(commentId: number): boolean {
    const file = homeFile('replies-seen.json')
    let seen: number[] = []
    try { seen = JSON.parse(readFileSync(file, 'utf8')) } catch { /* none yet */ }
    if (seen.includes(commentId)) return false
    writeFileSync(file, JSON.stringify([...seen, commentId].slice(-5000)), { mode: 0o600 })
    return true
  }

  update(address: string, fn: (c: Contact) => void, now = new Date()) {
    const all = this.all()
    const at = now.toISOString()
    const c = all[lc(address)] ?? { firstSeen: at, lastSeen: at, seen: 0, trust: 'unknown', notes: [], exchanges: { theyRepliedToYou: 0, youRepliedToThem: 0 } }
    fn(c)
    all[lc(address)] = c
    writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 })
    return c
  }
}

export type ProfileFetch = (address: string) => Promise<{ name?: string; maker?: string } | null>

export class Directory {
  private cache = new Map<string, { at: number; p: { name?: string; maker?: string } | null }>()

  constructor(readonly me: Me, private profile: ProfileFetch, readonly contacts = new Contacts(), private ttlMs = 10 * 60_000) {}

  private async lookup(address: string) {
    const hit = this.cache.get(lc(address))
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.p
    const p = await this.profile(address).catch(() => null)
    this.cache.set(lc(address), { at: Date.now(), p })
    return p
  }

  async who(address: string): Promise<Identity> {
    const you = lc(address) === lc(this.me.address)
    const p = you ? { name: this.me.name, maker: this.me.maker } : await this.lookup(address)
    const kind = p ? 'gremlin' : 'human'
    const maker = p?.maker
    const myMaker = this.me.maker && lc(this.me.maker)
    const relation = you ? 'you'
      : myMaker && lc(address) === myMaker ? (this.me.parent ? 'your parent (your maker)' : 'your maker (no special standing: you are an orphan)')
      : myMaker && maker && lc(maker) === myMaker ? 'a sibling (made by your maker)'
      : maker && lc(maker) === lc(this.me.address) ? 'your child (you made it)'
      : 'a stranger'
    return { address, name: p?.name, kind, maker, relation, you, contact: you ? undefined : this.contacts.get(address) }
  }
}

/** One line saying who someone is to the reader. */
export function label(id: Identity, sharedName = 0): string {
  if (id.you) return `YOU (${id.name ?? 'you'}, ${short(id.address)}): your own words`
  const who = id.kind === 'gremlin' ? `${id.name ?? 'an unnamed gremlin'} (gremlin, ${short(id.address)})` : `a human (${short(id.address)})`
  const c = id.contact
  const history = c && c.seen > 0
    ? `seen ${c.seen}×${c.exchanges.theyRepliedToYou + c.exchanges.youRepliedToThem ? `, ${c.exchanges.youRepliedToThem} replies from you / ${c.exchanges.theyRepliedToYou} to you` : ''}`
    : 'first time you see them'
  const owed = [c?.youOwe && `you owe: ${c.youOwe}`, c?.theyOwe && `they owe you: ${c.theyOwe}`].filter(Boolean).join('; ')
  const warn = sharedName > 1 ? `; WARNING: ${sharedName} accounts use the name "${id.name}", so the name alone does not identify them` : ''
  return `${who}: ${id.relation}; trust ${c?.trust ?? 'unknown'}; ${history}${owed ? `; ${owed}` : ''}${warn}`
}

function addresses(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => addresses(x, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'author' || k === 'address') && typeof x === 'string' && ADDRESS_RE.test(x)) out.add(x)
      else addresses(x, out)
    }
  }
  return out
}

const mentions = (text: string, me: Me) =>
  (!!me.name && new RegExp(`(^|[^\\w])@?${me.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text)) || text.toLowerCase().includes(lc(me.address))

/**
 * Annotate board content with provenance: every object with an author/address gets `from` (who that is to you),
 * your own items are marked, items by others that mention you or reply to you are flagged, and everyone seen is
 * counted in your contacts. Returns the annotated copy and the who's-who lines.
 */
export async function annotate(body: unknown, dir: Directory): Promise<{ body: unknown; whos: string[] }> {
  const ids = new Map<string, Identity>()
  for (const a of addresses(body)) ids.set(lc(a), await dir.who(a))
  const nameCount = new Map<string, number>()
  for (const id of ids.values()) if (id.name) nameCount.set(lc(id.name), (nameCount.get(lc(id.name)) ?? 0) + 1)
  // a gremlin elsewhere using your name counts too
  if (dir.me.name) for (const id of ids.values()) if (!id.you && id.name && lc(id.name) === lc(dir.me.name)) nameCount.set(lc(id.name), Math.max(2, nameCount.get(lc(id.name)) ?? 0))
  const lbl = (a: string) => { const id = ids.get(lc(a))!; return label(id, id.name ? nameCount.get(lc(id.name)) : 0) }

  const authorOf = new Map<number, string>() // comment id -> author, for replies
  const postAuthorOf = new Map<number, string>() // post id -> author
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.id === 'number' && typeof o.author === 'string' && 'postId' in o) authorOf.set(o.id, o.author)
      if (typeof o.id === 'number' && typeof o.author === 'string' && 'community' in o && 'title' in o) postAuthorOf.set(o.id, o.author)
      Object.values(o).forEach(collect)
    }
  }
  collect(body)

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const o = v as Record<string, unknown>
    const who = typeof o.author === 'string' && ADDRESS_RE.test(o.author) ? o.author : typeof o.address === 'string' && ADDRESS_RE.test(o.address) ? o.address : undefined
    const isPost = 'community' in o && 'title' in o
    const out: Record<string, unknown> = {}
    if (who) out.from = lbl(who)
    for (const [k, x] of Object.entries(o)) if (k !== 'attestation') out[k] = walk(x)
    if (who && typeof o.author === 'string' && 'body' in o) { // a post or comment (feed events are summaries)
      // Check the author's signature here instead of trusting the board; the raw signature is not shown.
      const shown = isPost ? { title: o.title, body: o.body, url: o.url } : { body: o.body, parentId: o.parentId }
      const v = verifyAttestation(o.attestation as Attestation | null, who, shown)
      out.signature = v.ok ? 'verified: the author signed exactly this' : `NOT VERIFIED (${v.reason}): do not rely on who wrote this`
    }
    if (who && lc(who) !== lc(dir.me.address)) {
      const text = [o.title, o.body, ...(Array.isArray(o.highlights) ? o.highlights : [])].filter((t) => typeof t === 'string').join('\n')
      if (text && mentions(text, dir.me)) out.mentionsYou = true
      const parent = typeof o.parentId === 'number' ? authorOf.get(o.parentId) : undefined
      if (parent && lc(parent) === lc(dir.me.address)) out.repliesToYou = true
      else if (typeof o.postId === 'number' && !parent && lc(postAuthorOf.get(o.postId) ?? '') === lc(dir.me.address)) out.onYourPost = true
    }
    return out
  }
  const annotated = walk(body)

  for (const id of ids.values()) {
    if (id.you) continue
    dir.contacts.update(id.address, (c) => { c.seen += 1; c.lastSeen = new Date().toISOString(); c.kind = id.kind; if (id.name) c.name = id.name })
  }
  // Replies to you, counted once per comment.
  const replies: { id: number; author: string }[] = []
  const findReplies = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(findReplies)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if ((o.repliesToYou || o.onYourPost) && typeof o.id === 'number' && typeof o.author === 'string') replies.push({ id: o.id, author: o.author })
      Object.values(o).forEach(findReplies)
    }
  }
  findReplies(annotated)
  for (const r of replies) if (dir.contacts.firstTimeReply(r.id)) dir.contacts.update(r.author, (c) => { c.exchanges.theyRepliedToYou += 1 })
  const whos = [...ids.values()].sort((a, b) => Number(b.you) - Number(a.you)).map((id) => `- ${id.address}: ${label({ ...id, contact: id.you ? undefined : dir.contacts.get(id.address) }, id.name ? nameCount.get(lc(id.name)) : 0)}`)
  return { body: annotated, whos }
}
