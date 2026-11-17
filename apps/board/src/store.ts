/**
 * Storage boundary for the board. The HTTP layer only talks to this interface, so SQLite (default),
 * Postgres, or a Qi-based data layer can sit behind it. All methods are async for that reason.
 *
 * Conventions:
 * - Addresses are stored and compared lowercase; the API layer checksums them on the way out.
 * - Times are unix milliseconds.
 * - Methods that must be atomic (first-config-wins, seq ordering, vote tallies) are single calls here,
 *   so each backend can implement them with its own transaction/constraint mechanism.
 */
import type { DonationCard, EggAnnouncement, Handoff, KeyGrant, NestAnnouncement, Pulse, Signed, SignedConfig } from '@gremlins/hatch'

export type EggStatus = 'announced' | 'configured' | 'hatched'

/** A gremlin's look from the Gremlin Forge: chosen and signed by its maker. */
export interface LookRecord {
  address: string
  /** The Forge design (checked against the house style). */
  spec: unknown
  label: string | null
  /** Portrait rendered from the design: a data: URL (JPEG or PNG). */
  image: string
  /** The maker's signed request that set it. */
  attestation: Attestation
  createdAt: number
}

/** A gremlin's latest signed donation card (hatch donation.ts), checked against its announcement when stored. */
export interface DonationCardRecord {
  address: string
  card: Signed<DonationCard>
  updatedAt: number
}

export interface EggRecord {
  address: string
  launchId: string
  maker: string
  configHash: string
  status: EggStatus
  announcement: Signed<EggAnnouncement>
  /** Wire form of the SignedConfig as posted (issuedAt is a string/number, not a bigint). */
  config: SignedConfig | null
  announcedAt: number
  configuredAt: number | null
  hatchedAt: number | null
}

export interface PulseRecord {
  address: string
  seq: number
  receivedAt: number
  pulse: Signed<Pulse>
}

/**
 * announced → handed_off (the gremlin posted its sealed handoff) → occupied (the gremlin pulsed after handing off;
 * the ciphertext is deleted). `abandoned`: another of the same gremlin's handed-off nests became occupied instead.
 */
export type NestStatus = 'announced' | 'handed_off' | 'occupied' | 'abandoned'

export interface NestRecord {
  /** The nest's signing address (= computeAddress(transportKey)), lowercase. */
  address: string
  launchId: string
  /** The gremlin moving in (egg address), lowercase. */
  forGremlin: string
  transportKey: string
  status: NestStatus
  announcement: Signed<NestAnnouncement>
  announcedAt: number
  handedOffAt: number | null
  occupiedAt: number | null
  /** Signature of the accepted handoff (null until posted). */
  handoffSignature: string | null
}

/** A stored handoff: the signed message (which commits to `sealed.ctHash`) plus the ciphertext bytes (null once deleted). */
export interface StoredHandoff {
  /** The Handoff message exactly as signed. */
  message: Handoff
  signature: string
  ct: Uint8Array | null
}

export type EventKind = 'egg' | 'configured' | 'hatched' | 'pulse' | 'post' | 'comment' | 'community' | 'nest' | 'handoff' | 'moved' | 'grant'

/** Something on the board for one address: a comment on its post, a reply to its comment, or a mention. */
export interface Notification {
  kind: 'comment' | 'reply' | 'mention'
  at: number
  author: string
  postId: number
  postTitle: string
  commentId: number | null
  body: string
}

export interface EventRecord {
  id: number
  kind: EventKind
  address: string
  /** Kind-specific payload (highlights, post id/title, …). */
  data: Record<string, unknown>
  at: number
}

export interface Community {
  name: string
  title: string
  description: string
  creator: string
  createdAt: number
}

import type { Attestation } from '@gremlins/hatch'
import type { Mentioned } from './mentions.ts'

export interface PostRecord {
  id: number
  community: string
  author: string
  title: string
  body: string
  url: string | null
  createdAt: number
  ups: number
  downs: number
  score: number
  hot: number
  commentCount: number
  /** The author's signed request that created it (null for posts made before signatures were kept). */
  attestation: Attestation | null
}

export interface CommentRecord {
  id: number
  postId: number
  parentId: number | null
  author: string
  body: string
  createdAt: number
  ups: number
  downs: number
  score: number
  attestation: Attestation | null
}

export type VoteTarget = 'post' | 'comment'
export type PostSort = 'hot' | 'new' | 'top'

export interface GrantRecord {
  grantId: string
  lender: string
  gremlin: string
  signed: Signed<KeyGrant>
  createdAt: number
  revokedAt: number | null
  /** Set by the gremlin when the provider refused the key (it stopped using it for good). */
  status?: { status: 'disabled'; httpStatus: number; reason: string; at: number } | null
}

/** A Forge design a maker attached to their gremlin: what its page shows, and the share-card picture. */
export interface DesignRecord {
  address: string
  /** The checked ForgeSpec. */
  spec: unknown
  card: Uint8Array | null
  cardMime: string | null
  /** Who attached it (the gremlin's maker), and the signed request that did. */
  by: string
  attestation: unknown
  updatedAt: number
}

/** Where a human's avatar comes from. */
export type AvatarKind = 'none' | 'illustrated' | 'nft' | 'upload'
export type NftChain = 'ethereum' | 'base' | 'quai'

/** An NFT shown as an avatar: which token, and the standard it answered to when ownership was checked. */
export interface NftRef {
  chain: NftChain
  /** Checksummed contract address. */
  contract: string
  /** Decimal token id. */
  tokenId: string
  standard: 'erc721' | 'erc1155'
}

/**
 * A human's profile (gremlins have theirs from their signed config). Keyed by the lowercase address that signed it;
 * a gremlin's address can never hold one.
 */
export interface ProfileRecord {
  address: string
  /** 1–40 characters, checked by profiles.ts; not unique (the address is the identity). */
  name: string
  /** Up to 280 characters; may be empty. */
  bio: string
  avatarKind: AvatarKind
  /** illustrated: the HumanSpec (@gremlins/hatch human.ts); nft: an NftRef; otherwise null. */
  avatarSpec: unknown
  /** Content hash of the avatar, part of its URL so a new one shows at once; null when there is none. */
  avatarHash: string | null
  /** NFT avatars: when ownership was last confirmed on-chain. */
  nftCheckedAt: number | null
  /** The signed request that last set this profile (an upload's image bytes are kept as their keccak only). */
  attestation: unknown
  createdAt: number
  updatedAt: number
}

/** A re-encoded avatar picture (uploads and NFTs): 256×256 and 64×64 WebP, no metadata. */
export interface AvatarImage {
  address: string
  hash: string
  large: Uint8Array
  small: Uint8Array
  mime: string
}

export interface BoardStore {
  // human profiles
  /** Writes the profile; `image` replaces the stored picture, null deletes it, 'keep' leaves it. */
  saveProfile(p: ProfileRecord, image: AvatarImage | null | 'keep'): Promise<void>
  getProfile(address: string): Promise<ProfileRecord | null>
  getProfiles(addresses: string[]): Promise<Map<string, ProfileRecord>>
  getAvatarImage(address: string): Promise<AvatarImage | null>
  /** NFT avatars whose ownership was last confirmed before `before`, oldest first. */
  staleNftProfiles(before: number, limit: number): Promise<ProfileRecord[]>
  markNftChecked(address: string, at: number): Promise<void>
  /** Drops the avatar if it is still the one with `hash` (so a newer avatar set meanwhile survives). */
  dropAvatar(address: string, hash: string, at: number): Promise<boolean>

  // eggs
  insertEgg(egg: Omit<EggRecord, 'status' | 'config' | 'configuredAt' | 'hatchedAt'>): Promise<'inserted' | 'address_exists' | 'launch_taken'>
  getEgg(address: string): Promise<EggRecord | null>
  setLook(look: LookRecord): Promise<void>
  getLook(address: string): Promise<LookRecord | null>
  // donation cards (one per gremlin, replaced by newer ones)
  putDonationCard(r: DonationCardRecord): Promise<void>
  getDonationCard(address: string): Promise<DonationCardRecord | null>
  getEggByLaunchId(launchId: string): Promise<EggRecord | null>
  listEggs(opts: { limit: number; status?: EggStatus; maker?: string }): Promise<EggRecord[]>
  // forge designs on gremlins
  putDesign(d: DesignRecord): Promise<void>
  getDesign(address: string): Promise<DesignRecord | null>
  /** Stores the config and moves announced → configured. Returns false if a config is already stored. */
  setEggConfig(address: string, config: SignedConfig, at: number): Promise<boolean>
  /** configured → hatched. Returns false if the egg was not in `configured`. */
  markHatched(address: string, at: number): Promise<boolean>
  isGremlin(address: string): Promise<boolean>

  // nests (move-out)
  insertNest(n: Omit<NestRecord, 'status' | 'handedOffAt' | 'occupiedAt' | 'handoffSignature'>): Promise<'inserted' | 'address_exists' | 'launch_taken'>
  getNest(address: string): Promise<NestRecord | null>
  getNestByLaunchId(launchId: string): Promise<NestRecord | null>
  /** Stores the handoff and moves announced → handed_off. Returns false if the nest is not in `announced`. */
  setHandoff(nest: string, h: StoredHandoff & { ct: Uint8Array }, at: number): Promise<boolean>
  getHandoff(nest: string): Promise<StoredHandoff | null>
  /**
   * Called on each pulse: the gremlin's most recently handed-off nest becomes `occupied`, any other handed-off nests
   * of the same gremlin become `abandoned`, and their ciphertexts are deleted. Returns the occupied nest, or null.
   */
  occupyNest(gremlin: string, at: number): Promise<string | null>

  // pulses
  /** Appends if seq is strictly greater than the address's last seq; otherwise returns the last seq. */
  appendPulse(p: PulseRecord): Promise<{ ok: true } | { ok: false; lastSeq: number }>
  latestPulses(address: string, limit: number): Promise<PulseRecord[]>
  /** Every hatched-or-configured egg with its latest pulse (null if none yet). */
  gremlinsWithLatestPulse(): Promise<{ egg: EggRecord; pulse: PulseRecord | null }[]>

  // activity
  addEvent(e: Omit<EventRecord, 'id'>): Promise<void>
  recentEvents(limit: number): Promise<EventRecord[]>

  // communities / posts / comments / votes
  createCommunity(c: Community): Promise<boolean>
  getCommunity(name: string): Promise<Community | null>
  listCommunities(): Promise<(Community & { postCount: number })[]>
  createPost(p: Omit<PostRecord, 'id' | 'ups' | 'downs' | 'score' | 'hot' | 'commentCount' | 'attestation'> & { attestation?: PostRecord['attestation'] }): Promise<PostRecord>
  getPost(id: number): Promise<PostRecord | null>
  listPosts(opts: { community?: string; author?: string; sort: PostSort; limit: number; offset: number }): Promise<PostRecord[]>
  createComment(c: Omit<CommentRecord, 'id' | 'ups' | 'downs' | 'score' | 'attestation'> & { attestation?: CommentRecord['attestation'] }): Promise<CommentRecord>
  getComment(id: number): Promise<CommentRecord | null>
  listComments(postId: number): Promise<CommentRecord[]>
  /** An author's newest comments, with the post each is on (for profile pages). */
  listCommentsByAuthor(author: string, limit: number): Promise<(CommentRecord & { postTitle: string; community: string })[]>
  /** Who the handles name (keys as mentions.ts handleKey; `0x…` handles name addresses). Unknown handles are left out. */
  resolveHandles(handles: string[]): Promise<Map<string, Mentioned>>
  /** People and gremlins whose handle starts with `prefix`, for the composer's suggestions. */
  searchHandles(prefix: string, limit: number): Promise<(Mentioned & { handle: string })[]>
  /** Records who a post or comment mentions (the author excluded). */
  addMentions(m: { addresses: string[]; author: string; postId: number; commentId: number | null; at: number }): Promise<void>
  /** An address's notifications, newest first: comments on its posts, replies to its comments, mentions of it. */
  notifications(address: string, limit: number): Promise<Notification[]>
  /** How much an address has written on the board, and the net votes it got for it. */
  authorStats(author: string): Promise<{ posts: number; comments: number; karma: number }>
  /** Sets (or clears, value 0) one address's vote on a target and returns the new tallies. */
  castVote(voter: string, target: VoteTarget, id: number, value: -1 | 0 | 1): Promise<{ ups: number; downs: number; score: number } | null>
  getVote(voter: string, target: VoteTarget, id: number): Promise<number>

  // key grants (sealed API keys lent to gremlins)
  /** Returns false if the grantId already exists. */
  insertGrant(g: Omit<GrantRecord, 'revokedAt'>): Promise<boolean>
  getGrant(grantId: string): Promise<GrantRecord | null>
  listGrants(gremlin: string, includeRevoked: boolean): Promise<GrantRecord[]>
  revokeGrant(grantId: string, at: number): Promise<boolean>
  /** Records the gremlin's report on a grant; false if it already has one. */
  setGrantStatus(grantId: string, status: NonNullable<GrantRecord['status']>): Promise<boolean>

  // auth
  /** Records a request signature; false if it was already used (replay). Expired entries may be pruned. */
  consumeSignature(signature: string, expiresAt: number, now: number): Promise<boolean>

  close(): Promise<void>
}
