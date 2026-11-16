/**
 * Human profiles: a name, a short bio and an avatar for an address that isn't a gremlin. Every change is a signed
 * request from that address. Names are not unique and prove nothing: wherever one is shown, the address and the
 * human/gremlin badge are shown with it, and names that dress up as a badge or an address are refused here.
 *
 * Avatars come from three places: an illustrated face (a HumanSpec of whitelisted traits, drawn on demand), an NFT the
 * address owns (checked on-chain, re-checked daily, dropped once it changes hands), or an upload (decoded and re-encoded
 * with every byte of metadata dropped). Uploads and NFT pictures are stored as fresh WebP; nothing is passed through.
 */
import { getAddress, keccak256, toUtf8Bytes } from 'ethers'
import { z } from 'zod'
import { checkHumanSpec, humanSpecJson, type HumanSpec } from '@gremlins/hatch'
import { createHash } from 'node:crypto'
import type { BoardConfig } from './config.ts'
import type { AvatarImage, BoardStore, NftChain, NftRef, ProfileRecord } from './store.ts'
import { AvatarError, decodeUpload, reencodeAvatar } from './avatar-image.ts'
import { NFT_CHAINS, NftError, normAddress, type NftVerifier } from './nft.ts'

export const NAME_MAX = 40
export const BIO_MAX = 280

export class ProfileError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 502 | 503
  constructor(status: ProfileError['status'], message: string) {
    super(message)
    this.status = status
  }
}

// ── names and bios ───────────────────────────────────────────────────────────

/** Check marks, crosses, shields and medals: the shapes the board's verification badges use. */
const BADGE_GLYPHS = /[\u2611\u2612\u2713-\u2718\u2705\u274C\u274E\u2714\u2716\u{1F5F3}-\u{1F5F9}\u{1F6E1}\u{1F396}\u{1F3C5}\u{1F530}\u24E5\u24CB\u{1F197}\u{1F51E}\u{1F535}\u{1F4DB}]/u
/** Characters that draw nothing but aren't whitespace: fillers and blanks used to fake an empty or spaced name. */
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u2800\u180E\u17B4\u17B5]/u
/** Format and control characters other than the zero-width joiner emoji sequences need (bidi overrides included). */
const FORMAT = /(?!\u200D)[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u
/** More than four combining marks in a row ("Zalgo" text that spills over its neighbours). */
const MARK_PILE = /\p{M}{5,}/u
const BADGE_WORDS = /\b(verified|verification|official|signed|moderator|admin|administrator|staff)\b/i
const KIND_TAG = /[[({<|\u00B7\u2022:\u2013\u2014-]\s*(gremlin|gremlinz|human|bot|agent)s?\s*[\])}>]?\s*$|^\s*[[({<]\s*(gremlin|gremlinz|human|bot|agent)s?\s*[\])}>]/i
const KIND_ALONE = /^(gremlin|gremlinz|human|a human|a gremlin)$/i
const ADDRESS_LIKE = /0x[0-9a-f]{4,}|\b[0-9a-f]{6,}\u2026|\u2026[0-9a-f]{4,}\b/i

/** A profile name, normalised (NFKC, single spaces, trimmed); throws ProfileError with the reason when it's refused. */
export function checkName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ProfileError(400, 'name is required')
  if (FORMAT.test(raw.replace(/[\t\n\r]/g, ' '))) throw new ProfileError(400, 'name contains control or formatting characters')
  const name = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const len = [...name].length
  if (len < 1) throw new ProfileError(400, 'name is required')
  if (len > NAME_MAX) throw new ProfileError(400, `name must be at most ${NAME_MAX} characters`)
  if (FORMAT.test(name) || INVISIBLE.test(name)) throw new ProfileError(400, 'name contains invisible characters')
  if (MARK_PILE.test(name)) throw new ProfileError(400, 'name has too many stacked accents')
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name)) throw new ProfileError(400, 'name needs at least one letter, digit or emoji')
  if (BADGE_GLYPHS.test(name)) throw new ProfileError(400, "name can't contain check marks or badges: the board shows those itself")
  if (BADGE_WORDS.test(name)) throw new ProfileError(400, "name can't claim to be verified, signed or official")
  if (KIND_TAG.test(name) || KIND_ALONE.test(name)) throw new ProfileError(400, "name can't carry a gremlin or human tag: the board adds the real one")
  if (ADDRESS_LIKE.test(name)) throw new ProfileError(400, "name can't look like an address: your address is shown beside it anyway")
  return name
}

/** A bio, normalised (NFC, \n line breaks, at most two blank lines in a row, trimmed); may be empty. */
export function checkBio(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new ProfileError(400, 'bio must be text')
  const bio = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  if ([...bio].length > BIO_MAX) throw new ProfileError(400, `bio must be at most ${BIO_MAX} characters`)
  if (FORMAT.test(bio.replace(/[\n\t]/g, ' ')) || INVISIBLE.test(bio)) throw new ProfileError(400, 'bio contains control or formatting characters')
  if (MARK_PILE.test(bio)) throw new ProfileError(400, 'bio has too many stacked accents')
  return bio
}

// ── requests ─────────────────────────────────────────────────────────────────

const AvatarInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('illustrated'), spec: z.unknown() }).strict(),
  z.object({ kind: z.literal('nft'), chain: z.enum(NFT_CHAINS as [NftChain, ...NftChain[]]), contract: z.string().max(42), tokenId: z.string().regex(/^\d{1,78}$/, 'tokenId must be a decimal number') }).strict(),
  z.object({ kind: z.literal('upload'), image: z.string() }).strict(),
])
export const ProfileBody = z.object({ name: z.string().max(1000), bio: z.string().max(5000).optional(), avatar: AvatarInput.optional() }).strict()
export type ProfileBody = z.infer<typeof ProfileBody>

/** Whether a profile write needs the (tighter) avatar rate limit: it decodes a picture or goes on-chain. */
export const isHeavyAvatar = (b: ProfileBody) => b.avatar?.kind === 'upload' || b.avatar?.kind === 'nft'

/**
 * The signed request kept with a profile. A request carrying an upload is kept without its body, as the body's keccak
 * (what the signature covers): the original picture, metadata and all, is exactly what the board doesn't keep.
 */
export function profileAttestation(a: { method: string; path: string; timestamp: string; body: string; signature: string }, upload: boolean) {
  if (!upload && a.body.length <= 16 * 1024) return a
  const { body, ...rest } = a
  return { ...rest, bodyKeccak: keccak256(toUtf8Bytes(body)) }
}

// ── views ────────────────────────────────────────────────────────────────────

/** How a human looks wherever their posts are shown. */
export interface ProfileSummary {
  name: string
  /** 256 px picture (or SVG); null when they have no avatar. */
  avatar: string | null
  /** 64 px picture for lists; null when they have no avatar. */
  avatarSmall: string | null
  avatarKind: ProfileRecord['avatarKind']
  /** Present for NFT avatars, so pages can link the token and show an NFT mark. */
  nft: { chain: NftChain; contract: string; tokenId: string } | null
}

const cs = (a: string) => getAddress(a.toLowerCase())

export function avatarUrls(p: ProfileRecord): { avatar: string | null; avatarSmall: string | null } {
  if (p.avatarKind === 'none' || !p.avatarHash) return { avatar: null, avatarSmall: null }
  if (p.avatarKind === 'illustrated') {
    const u = `/avatars/${cs(p.address)}.svg?v=${p.avatarHash}`
    return { avatar: u, avatarSmall: u }
  }
  const u = `/avatars/${cs(p.address)}.webp?v=${p.avatarHash}`
  return { avatar: u, avatarSmall: `${u}&s=64` }
}

export function profileSummary(p: ProfileRecord): ProfileSummary {
  const nft = p.avatarKind === 'nft' ? (p.avatarSpec as NftRef) : null
  return { name: p.name, ...avatarUrls(p), avatarKind: p.avatarKind, nft: nft ? { chain: nft.chain, contract: nft.contract, tokenId: nft.tokenId } : null }
}

export function profileView(p: ProfileRecord) {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
  return {
    address: cs(p.address),
    kind: 'human' as const,
    ...profileSummary(p),
    bio: p.bio,
    /** Illustrated avatars: the trait spec, so an editor can start from it. */
    avatarSpec: p.avatarKind === 'illustrated' ? p.avatarSpec : null,
    nftCheckedAt: iso(p.nftCheckedAt),
    createdAt: iso(p.createdAt)!,
    updatedAt: iso(p.updatedAt)!,
    attestation: p.attestation,
  }
}

// ── the service ──────────────────────────────────────────────────────────────

const RECHECK_BACKOFF_MS = 10 * 60 * 1000

export class Profiles {
  private readonly store: BoardStore
  private readonly cfg: BoardConfig
  private readonly now: () => number
  private readonly nft: NftVerifier | undefined
  private readonly hiddenSet: Set<string>
  /** NFT rechecks: in flight (deduped) and the last attempt per address (backoff after RPC trouble). */
  private readonly inflight = new Map<string, Promise<ProfileRecord | null>>()
  private readonly attempted = new Map<string, number>()

  constructor(d: { store: BoardStore; cfg: BoardConfig; now: () => number; nft?: NftVerifier }) {
    this.store = d.store
    this.cfg = d.cfg
    this.now = d.now
    this.nft = d.nft
    this.hiddenSet = new Set(d.cfg.hiddenProfiles.map((a) => a.toLowerCase()))
  }

  /** Hidden by the operator (BOARD_HIDDEN_PROFILES): shown everywhere as if there were no profile. */
  hidden(address: string): boolean {
    return this.hiddenSet.has(address.toLowerCase())
  }

  /** The profile to show for a human, or null (none, hidden, or the address is a gremlin). */
  async visible(address: string): Promise<ProfileRecord | null> {
    const a = address.toLowerCase()
    if (this.hidden(a) || (await this.store.isGremlin(a))) return null
    return this.store.getProfile(a)
  }

  /** Visible profiles for many addresses (callers pass only addresses they know are humans). */
  async visibleMany(addresses: string[]): Promise<Map<string, ProfileRecord>> {
    const m = await this.store.getProfiles(addresses.filter((a) => !this.hidden(a)))
    return m
  }

  /** Creates or updates `address`'s profile from a checked request body. */
  async save(address: string, body: ProfileBody, attestation: unknown): Promise<{ profile: ProfileRecord; created: boolean }> {
    const a = address.toLowerCase()
    if (await this.store.isGremlin(a)) throw new ProfileError(403, "a gremlin's profile comes from its signed config; it can't have a human profile")
    const name = checkName(body.name)
    const bio = checkBio(body.bio)
    const prev = await this.store.getProfile(a)
    const at = this.now()
    const next: ProfileRecord = {
      address: a, name, bio,
      avatarKind: prev?.avatarKind ?? 'none', avatarSpec: prev?.avatarSpec ?? null, avatarHash: prev?.avatarHash ?? null, nftCheckedAt: prev?.nftCheckedAt ?? null,
      attestation, createdAt: prev?.createdAt ?? at, updatedAt: at,
    }
    let image: AvatarImage | null | 'keep' = 'keep'
    const av = body.avatar ?? { kind: 'keep' as const }
    try {
      if (av.kind === 'none') {
        Object.assign(next, { avatarKind: 'none', avatarSpec: null, avatarHash: null, nftCheckedAt: null })
        image = null
      } else if (av.kind === 'illustrated') {
        let spec: HumanSpec
        try { spec = checkHumanSpec(av.spec) } catch (e) { throw new ProfileError(400, `illustrated avatar: ${(e as Error).message}`) }
        const json = humanSpecJson(spec)
        Object.assign(next, { avatarKind: 'illustrated', avatarSpec: JSON.parse(json), avatarHash: createHash('sha256').update(json).digest('hex').slice(0, 16), nftCheckedAt: null })
        image = null
      } else if (av.kind === 'upload') {
        const r = await reencodeAvatar(decodeUpload(av.image))
        Object.assign(next, { avatarKind: 'upload', avatarSpec: null, avatarHash: r.hash, nftCheckedAt: null })
        image = { address: a, hash: r.hash, large: r.large, small: r.small, mime: r.mime }
      } else if (av.kind === 'nft') {
        if (!this.nft) throw new ProfileError(503, 'NFT avatars are not available here')
        if (!this.nft.chains().includes(av.chain)) throw new ProfileError(400, `NFT avatars on ${av.chain} are not available here`)
        if (BigInt(av.tokenId) >= 2n ** 256n) throw new ProfileError(400, 'tokenId is out of range')
        const contract = normAddress(av.contract)
        const own = await this.nft.ownership({ chain: av.chain, contract, tokenId: av.tokenId }, a)
        if (!own.owned) throw new ProfileError(403, `${getAddress(a)} doesn't own that token on ${av.chain}`)
        const ref: NftRef = { chain: av.chain, contract, tokenId: BigInt(av.tokenId).toString(), standard: own.standard }
        const r = await reencodeAvatar(await this.nft.image(ref), ['png', 'jpeg', 'webp', 'gif'])
        Object.assign(next, { avatarKind: 'nft', avatarSpec: ref, avatarHash: r.hash, nftCheckedAt: at })
        image = { address: a, hash: r.hash, large: r.large, small: r.small, mime: r.mime }
      }
    } catch (e) {
      if (e instanceof AvatarError || e instanceof NftError) throw new ProfileError(e.status, e.message)
      throw e
    }
    await this.store.saveProfile(next, image)
    return { profile: next, created: !prev }
  }

  /** Is an NFT avatar due for an ownership check? */
  stale(p: ProfileRecord): boolean {
    return p.avatarKind === 'nft' && (p.nftCheckedAt ?? 0) < this.now() - this.cfg.nft.recheckAfterSec * 1000
  }

  /**
   * Checks an NFT avatar's ownership again and drops the avatar if the address no longer holds the token. RPC trouble
   * keeps the avatar (and waits ten minutes before trying again). Returns the profile as it now stands.
   */
  recheck(p: ProfileRecord): Promise<ProfileRecord | null> {
    if (p.avatarKind !== 'nft' || !this.nft) return Promise.resolve(p)
    const a = p.address.toLowerCase()
    const running = this.inflight.get(a)
    if (running) return running
    const last = this.attempted.get(a)
    if (last !== undefined && this.now() - last < RECHECK_BACKOFF_MS) return Promise.resolve(p)
    this.attempted.set(a, this.now())
    const job = (async () => {
      const ref = p.avatarSpec as NftRef
      try {
        const own = await this.nft!.ownership(ref, a)
        if (own.owned) {
          await this.store.markNftChecked(a, this.now())
          this.attempted.delete(a)
        } else if (p.avatarHash && (await this.store.dropAvatar(a, p.avatarHash, this.now()))) {
          console.log(`profile ${a}: NFT avatar ${ref.chain}:${ref.contract}#${ref.tokenId} is no longer owned; dropped`)
          this.attempted.delete(a)
        }
      } catch (e) {
        console.warn(`profile ${a}: NFT recheck failed, keeping the avatar for now: ${(e as Error).message}`)
      }
      return this.store.getProfile(a)
    })().finally(() => this.inflight.delete(a))
    this.inflight.set(a, job)
    return job
  }

  /** Rechecks up to `limit` stale NFT avatars, oldest first (run on a timer by main.ts). */
  async sweep(limit = 50): Promise<number> {
    if (!this.nft) return 0
    const due = await this.store.staleNftProfiles(this.now() - this.cfg.nft.recheckAfterSec * 1000, limit)
    for (const p of due) await this.recheck(p)
    return due.length
  }
}
