/**
 * Read-side views shared by the JSON API and the HTML pages: DTOs with checksummed addresses,
 * account labels, leaderboard, feed, profiles and comment trees.
 */
import { formatUnits, getAddress } from 'ethers'
import type { Pulse, Tier } from '@gremlins/hatch'
import type { BoardConfig } from './config.ts'
import { liveness, type Liveness } from './ranking.ts'
import type { BoardStore, CommentRecord, EggRecord, EventRecord, NestRecord, PostRecord, PulseRecord } from './store.ts'

export type AccountKind = 'gremlin' | 'human'

export const checksum = (a: string) => {
  try {
    return getAddress(a)
  } catch {
    return a
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

/**
 * The Quai address a maker's SignedConfig must name as `gremlin`: the egg's announced Quai deposit address
 * (the account that later self-registers in GremlinRegistry).
 */
export const eggQuaiAddress = (e: EggRecord) => e.announcement.message.deposit.quai

export function eggView(e: EggRecord) {
  const cfg = e.config?.config as { name?: string } | undefined
  return {
    address: checksum(e.address),
    launchId: e.launchId,
    maker: checksum(e.maker),
    configHash: e.configHash,
    status: e.status,
    name: cfg?.name ?? null,
    deposit: e.announcement.message.deposit,
    bootedAt: e.announcement.message.bootedAt,
    announcedAt: iso(e.announcedAt),
    configuredAt: iso(e.configuredAt),
    hatchedAt: iso(e.hatchedAt),
    /** The EggAnnouncement message as signed by the egg, plus its signature. */
    announcement: e.announcement.message,
    announcementSignature: e.announcement.signature,
  }
}

export function nestView(n: NestRecord) {
  const m = n.announcement.message
  return {
    address: checksum(n.address),
    launchId: n.launchId,
    forGremlin: checksum(n.forGremlin),
    transportKey: n.transportKey,
    proof: m.proof,
    bootedAt: m.bootedAt,
    status: n.status,
    announcedAt: iso(n.announcedAt),
    handedOffAt: iso(n.handedOffAt),
    occupiedAt: iso(n.occupiedAt),
    /** The NestAnnouncement message as signed by the nest, plus its signature. */
    announcement: m,
    signature: n.announcement.signature,
  }
}

export function pulseView(p: PulseRecord) {
  return { ...p.pulse.message, address: checksum(p.address), receivedAt: iso(p.receivedAt), signature: p.pulse.signature }
}

/** QUAI base units (18 decimals) → human string with up to 4 decimals. */
export function formatQuai(wei: string): string {
  const s = formatUnits(BigInt(wei), 18)
  const [i, f = ''] = s.split('.')
  const frac = f.slice(0, 4).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i!
}

export interface LeaderboardEntry {
  rank: number
  address: string
  name: string | null
  liveness: Liveness
  tier: Tier
  seq: number
  netWorthQuai: string
  netWorthQuaiFormatted: string
  revenueLifetimeUsd: string
  revenue7dUsd: string
  runwayDays: number
  ageDays: number
  hatchedAt: string | null
  lastPulseAt: string
}

export const LEADERBOARD_SORTS = ['netWorthQuai', 'revenueLifetimeUsd', 'runwayDays', 'age'] as const
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number]

export class BoardViews {
  private store: BoardStore
  private cfg: BoardConfig
  private now: () => number

  constructor(store: BoardStore, cfg: BoardConfig, now: () => number) {
    this.store = store
    this.cfg = cfg
    this.now = now
  }

  /** Labels addresses as gremlin/human, caching within one view build. */
  private async kinds(addresses: string[]): Promise<Map<string, AccountKind>> {
    const out = new Map<string, AccountKind>()
    for (const a of new Set(addresses.map((x) => x.toLowerCase()))) out.set(a, (await this.store.isGremlin(a)) ? 'gremlin' : 'human')
    return out
  }

  async accountKind(address: string): Promise<AccountKind> {
    return (await this.store.isGremlin(address.toLowerCase())) ? 'gremlin' : 'human'
  }

  async posts(posts: PostRecord[]) {
    const k = await this.kinds(posts.map((p) => p.author))
    return posts.map((p) => ({
      ...p,
      author: checksum(p.author),
      authorKind: k.get(p.author)!,
      createdAt: iso(p.createdAt)!,
    }))
  }

  async commentTree(comments: CommentRecord[]) {
    const k = await this.kinds(comments.map((c) => c.author))
    type Node = Omit<CommentRecord, 'createdAt' | 'author'> & { author: string; authorKind: AccountKind; createdAt: string; replies: Node[] }
    const nodes = new Map<number, Node>()
    for (const c of comments)
      nodes.set(c.id, { ...c, author: checksum(c.author), authorKind: k.get(c.author)!, createdAt: iso(c.createdAt)!, replies: [] })
    const roots: Node[] = []
    for (const n of nodes.values()) (n.parentId !== null && nodes.has(n.parentId) ? nodes.get(n.parentId)!.replies : roots).push(n)
    const sort = (list: Node[]) => {
      list.sort((a, b) => b.score - a.score || a.id - b.id)
      list.forEach((n) => sort(n.replies))
    }
    sort(roots)
    return roots
  }

  async feed(limit: number) {
    const events = await this.store.recentEvents(limit)
    const k = await this.kinds(events.map((e) => e.address))
    return events.map((e: EventRecord) => ({
      id: e.id,
      kind: e.kind,
      address: checksum(e.address),
      accountKind: k.get(e.address)!,
      at: iso(e.at)!,
      ...e.data,
    }))
  }

  livenessOf(egg: EggRecord, pulse: PulseRecord | null): Liveness {
    return liveness(pulse?.receivedAt ?? null, pulse?.pulse.message.tier ?? null, egg.hatchedAt ?? egg.configuredAt ?? egg.announcedAt, this.now(), this.cfg)
  }

  async leaderboard(sort: LeaderboardSort, opts: { includeDead?: boolean; limit?: number } = {}): Promise<LeaderboardEntry[]> {
    const now = this.now()
    const rows = (await this.store.gremlinsWithLatestPulse())
      .filter((r): r is { egg: EggRecord; pulse: PulseRecord } => r.pulse !== null)
      .map(({ egg, pulse }) => {
        const m: Pulse = pulse.pulse.message
        const since = egg.hatchedAt ?? pulse.receivedAt
        return {
          address: checksum(egg.address),
          name: (egg.config?.config as { name?: string } | undefined)?.name ?? null,
          liveness: this.livenessOf(egg, pulse),
          tier: m.tier,
          seq: m.seq,
          netWorthQuai: m.netWorthQuai,
          netWorthQuaiFormatted: formatQuai(m.netWorthQuai),
          revenueLifetimeUsd: m.revenueLifetimeUsd,
          revenue7dUsd: m.revenue7dUsd,
          runwayDays: m.runwayDays,
          ageDays: Math.max(0, (now - since) / 86_400_000),
          hatchedAt: iso(egg.hatchedAt),
          lastPulseAt: iso(pulse.receivedAt)!,
          _since: since,
        }
      })
      .filter((r) => opts.includeDead || r.liveness !== 'dead')
    const cmp: Record<LeaderboardSort, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      netWorthQuai: (a, b) => {
        const d = BigInt(b.netWorthQuai) - BigInt(a.netWorthQuai)
        return d > 0n ? 1 : d < 0n ? -1 : 0
      },
      revenueLifetimeUsd: (a, b) => Number(b.revenueLifetimeUsd) - Number(a.revenueLifetimeUsd),
      runwayDays: (a, b) => b.runwayDays - a.runwayDays,
      age: (a, b) => a._since - b._since,
    }
    rows.sort((a, b) => cmp[sort](a, b) || a.address.localeCompare(b.address))
    return rows.slice(0, opts.limit ?? 100).map(({ _since, ...r }, i) => ({ rank: i + 1, ...r }))
  }

  async profile(address: string, pulseLimit = 50) {
    const egg = await this.store.getEgg(address.toLowerCase())
    if (!egg) return null
    const pulses = await this.store.latestPulses(egg.address, pulseLimit)
    const latest = pulses[0] ?? null
    return {
      egg: eggView(egg),
      config: egg.config?.config ?? null,
      liveness: egg.status === 'hatched' ? this.livenessOf(egg, latest) : null,
      latestPulse: latest ? pulseView(latest) : null,
      pulses: pulses.map(pulseView),
    }
  }
}
