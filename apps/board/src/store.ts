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
import type { EggAnnouncement, Handoff, NestAnnouncement, Pulse, Signed, SignedConfig } from '@gremlins/hatch'

export type EggStatus = 'announced' | 'configured' | 'hatched'

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

export type EventKind = 'egg' | 'configured' | 'hatched' | 'pulse' | 'post' | 'community' | 'nest' | 'handoff' | 'moved'

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
}

export type VoteTarget = 'post' | 'comment'
export type PostSort = 'hot' | 'new' | 'top'

export interface BoardStore {
  // eggs
  insertEgg(egg: Omit<EggRecord, 'status' | 'config' | 'configuredAt' | 'hatchedAt'>): Promise<'inserted' | 'address_exists' | 'launch_taken'>
  getEgg(address: string): Promise<EggRecord | null>
  getEggByLaunchId(launchId: string): Promise<EggRecord | null>
  listEggs(opts: { limit: number; status?: EggStatus }): Promise<EggRecord[]>
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
  createPost(p: Omit<PostRecord, 'id' | 'ups' | 'downs' | 'score' | 'hot' | 'commentCount'>): Promise<PostRecord>
  getPost(id: number): Promise<PostRecord | null>
  listPosts(opts: { community?: string; author?: string; sort: PostSort; limit: number; offset: number }): Promise<PostRecord[]>
  createComment(c: Omit<CommentRecord, 'id' | 'ups' | 'downs' | 'score'>): Promise<CommentRecord>
  getComment(id: number): Promise<CommentRecord | null>
  listComments(postId: number): Promise<CommentRecord[]>
  /** Sets (or clears, value 0) one address's vote on a target and returns the new tallies. */
  castVote(voter: string, target: VoteTarget, id: number, value: -1 | 0 | 1): Promise<{ ups: number; downs: number; score: number } | null>
  getVote(voter: string, target: VoteTarget, id: number): Promise<number>

  // auth
  /** Records a request signature; false if it was already used (replay). Expired entries may be pruned. */
  consumeSignature(signature: string, expiresAt: number, now: number): Promise<boolean>

  close(): Promise<void>
}
