/** BoardStore on Node's built-in SQLite (node:sqlite). Single process; WAL mode. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  BoardStore, Community, CommentRecord, EggRecord, EggStatus, EventRecord, NestRecord, NestStatus, PostRecord, PostSort, PulseRecord,
  StoredHandoff, VoteTarget,
} from './store.ts'
import { hot } from './ranking.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eggs (
  address       TEXT PRIMARY KEY,
  launch_id     TEXT NOT NULL UNIQUE,
  maker         TEXT NOT NULL,
  config_hash   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'announced',
  announcement  TEXT NOT NULL,
  config        TEXT,
  announced_at  INTEGER NOT NULL,
  configured_at INTEGER,
  hatched_at    INTEGER
);
CREATE INDEX IF NOT EXISTS eggs_announced ON eggs(announced_at DESC);

CREATE TABLE IF NOT EXISTS pulses (
  address     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  pulse       TEXT NOT NULL,
  PRIMARY KEY (address, seq)
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  address TEXT NOT NULL,
  data    TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS communities (
  name        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  creator     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  community     TEXT NOT NULL REFERENCES communities(name),
  author        TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  url           TEXT,
  created_at    INTEGER NOT NULL,
  ups           INTEGER NOT NULL DEFAULT 0,
  downs         INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  hot           REAL NOT NULL,
  comment_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS posts_hot ON posts(community, hot DESC);
CREATE INDEX IF NOT EXISTS posts_new ON posts(community, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_top ON posts(community, score DESC);
CREATE INDEX IF NOT EXISTS posts_author ON posts(author, created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  parent_id  INTEGER REFERENCES comments(id),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ups        INTEGER NOT NULL DEFAULT 0,
  downs      INTEGER NOT NULL DEFAULT 0,
  score      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS votes (
  voter  TEXT NOT NULL,
  target TEXT NOT NULL,
  id     INTEGER NOT NULL,
  value  INTEGER NOT NULL,
  PRIMARY KEY (voter, target, id)
);

CREATE TABLE IF NOT EXISTS nests (
  address           TEXT PRIMARY KEY,
  launch_id         TEXT NOT NULL UNIQUE,
  for_gremlin       TEXT NOT NULL,
  transport_key     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'announced',
  announcement      TEXT NOT NULL,
  announced_at      INTEGER NOT NULL,
  handed_off_at     INTEGER,
  occupied_at       INTEGER,
  handoff_signature TEXT
);
CREATE INDEX IF NOT EXISTS nests_gremlin ON nests(for_gremlin, status);

-- Kept apart from nests so listing nests never touches the (possibly huge) ciphertext.
CREATE TABLE IF NOT EXISTS nest_handoffs (
  nest       TEXT PRIMARY KEY REFERENCES nests(address),
  message    TEXT NOT NULL, -- Handoff message as signed (commits to sealed.ctHash)
  signature  TEXT NOT NULL,
  ct         BLOB           -- NULL once the nest is occupied
);

CREATE TABLE IF NOT EXISTS used_signatures (
  signature  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`

type Row = Record<string, SQLInputValue>

const egg = (r: Row): EggRecord => ({
  address: r.address as string,
  launchId: r.launch_id as string,
  maker: r.maker as string,
  configHash: r.config_hash as string,
  status: r.status as EggStatus,
  announcement: JSON.parse(r.announcement as string),
  config: r.config ? JSON.parse(r.config as string) : null,
  announcedAt: r.announced_at as number,
  configuredAt: (r.configured_at as number | null) ?? null,
  hatchedAt: (r.hatched_at as number | null) ?? null,
})

const nest = (r: Row): NestRecord => ({
  address: r.address as string,
  launchId: r.launch_id as string,
  forGremlin: r.for_gremlin as string,
  transportKey: r.transport_key as string,
  status: r.status as NestStatus,
  announcement: JSON.parse(r.announcement as string),
  announcedAt: r.announced_at as number,
  handedOffAt: (r.handed_off_at as number | null) ?? null,
  occupiedAt: (r.occupied_at as number | null) ?? null,
  handoffSignature: (r.handoff_signature as string | null) ?? null,
})

const pulse = (r: Row): PulseRecord => ({
  address: r.address as string,
  seq: r.seq as number,
  receivedAt: r.received_at as number,
  pulse: JSON.parse(r.pulse as string),
})

const post = (r: Row): PostRecord => ({
  id: r.id as number,
  community: r.community as string,
  author: r.author as string,
  title: r.title as string,
  body: r.body as string,
  url: (r.url as string | null) ?? null,
  createdAt: r.created_at as number,
  ups: r.ups as number,
  downs: r.downs as number,
  score: r.score as number,
  hot: r.hot as number,
  commentCount: r.comment_count as number,
})

const comment = (r: Row): CommentRecord => ({
  id: r.id as number,
  postId: r.post_id as number,
  parentId: (r.parent_id as number | null) ?? null,
  author: r.author as string,
  body: r.body as string,
  createdAt: r.created_at as number,
  ups: r.ups as number,
  downs: r.downs as number,
  score: r.score as number,
})

const community = (r: Row): Community => ({
  name: r.name as string,
  title: r.title as string,
  description: r.description as string,
  creator: r.creator as string,
  createdAt: r.created_at as number,
})

const POST_ORDER: Record<PostSort, string> = {
  hot: 'hot DESC, id DESC',
  new: 'created_at DESC, id DESC',
  top: 'score DESC, created_at DESC',
}

export class SqliteBoardStore implements BoardStore {
  private db: DatabaseSync

  /** `path` may be ':memory:' for tests. */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // secure_delete: freed pages are zeroed, so deleted handoff ciphertexts don't linger in the file.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;')
    this.db.exec(SCHEMA)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  // eggs

  async insertEgg(e: Omit<EggRecord, 'status' | 'config' | 'configuredAt' | 'hatchedAt'>) {
    return this.tx(() => {
      if (this.one('SELECT 1 FROM eggs WHERE address = ?', e.address)) return 'address_exists' as const
      if (this.one('SELECT 1 FROM eggs WHERE launch_id = ?', e.launchId)) return 'launch_taken' as const
      this.db
        .prepare('INSERT INTO eggs (address, launch_id, maker, config_hash, announcement, announced_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.address, e.launchId, e.maker, e.configHash, JSON.stringify(e.announcement), e.announcedAt)
      return 'inserted' as const
    })
  }

  async getEgg(address: string) {
    const r = this.one('SELECT * FROM eggs WHERE address = ?', address)
    return r ? egg(r) : null
  }

  async getEggByLaunchId(launchId: string) {
    const r = this.one('SELECT * FROM eggs WHERE launch_id = ?', launchId)
    return r ? egg(r) : null
  }

  async listEggs({ limit, status }: { limit: number; status?: EggStatus }) {
    return status
      ? this.all('SELECT * FROM eggs WHERE status = ? ORDER BY announced_at DESC LIMIT ?', status, limit).map(egg)
      : this.all('SELECT * FROM eggs ORDER BY announced_at DESC LIMIT ?', limit).map(egg)
  }

  async setEggConfig(address: string, config: unknown, at: number) {
    const r = this.db
      .prepare(`UPDATE eggs SET config = ?, status = 'configured', configured_at = ? WHERE address = ? AND config IS NULL`)
      .run(JSON.stringify(config), at, address)
    return r.changes === 1
  }

  async markHatched(address: string, at: number) {
    const r = this.db
      .prepare(`UPDATE eggs SET status = 'hatched', hatched_at = ? WHERE address = ? AND status = 'configured'`)
      .run(at, address)
    return r.changes === 1
  }

  async isGremlin(address: string) {
    return !!this.one('SELECT 1 FROM eggs WHERE address = ?', address)
  }

  // nests

  async insertNest(n: Omit<NestRecord, 'status' | 'handedOffAt' | 'occupiedAt' | 'handoffSignature'>) {
    return this.tx(() => {
      if (this.one('SELECT 1 FROM nests WHERE address = ?', n.address)) return 'address_exists' as const
      if (this.one('SELECT 1 FROM nests WHERE launch_id = ?', n.launchId)) return 'launch_taken' as const
      this.db
        .prepare('INSERT INTO nests (address, launch_id, for_gremlin, transport_key, announcement, announced_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(n.address, n.launchId, n.forGremlin, n.transportKey, JSON.stringify(n.announcement), n.announcedAt)
      return 'inserted' as const
    })
  }

  async getNest(address: string) {
    const r = this.one('SELECT * FROM nests WHERE address = ?', address)
    return r ? nest(r) : null
  }

  async getNestByLaunchId(launchId: string) {
    const r = this.one('SELECT * FROM nests WHERE launch_id = ?', launchId)
    return r ? nest(r) : null
  }

  async setHandoff(nestAddress: string, h: StoredHandoff & { ct: Uint8Array }, at: number) {
    return this.tx(() => {
      const r = this.db
        .prepare(`UPDATE nests SET status = 'handed_off', handed_off_at = ?, handoff_signature = ? WHERE address = ? AND status = 'announced'`)
        .run(at, h.signature, nestAddress)
      if (r.changes !== 1) return false
      this.db.prepare('INSERT INTO nest_handoffs (nest, message, signature, ct) VALUES (?, ?, ?, ?)').run(nestAddress, JSON.stringify(h.message), h.signature, h.ct)
      return true
    })
  }

  async getHandoff(nestAddress: string) {
    const r = this.one('SELECT * FROM nest_handoffs WHERE nest = ?', nestAddress)
    if (!r) return null
    return { message: JSON.parse(r.message as string), signature: r.signature as string, ct: r.ct === null ? null : new Uint8Array(r.ct as Uint8Array) }
  }

  async occupyNest(gremlin: string, at: number) {
    // Fast path for the common case (no pending move): one indexed lookup, no write transaction.
    if (!this.one(`SELECT 1 FROM nests WHERE for_gremlin = ? AND status = 'handed_off'`, gremlin)) return null
    const winner = this.tx(() => {
      const pending = this.all(`SELECT address FROM nests WHERE for_gremlin = ? AND status = 'handed_off' ORDER BY handed_off_at DESC, rowid DESC`, gremlin)
      if (!pending.length) return null
      const [winner, ...rest] = pending.map((r) => r.address as string)
      this.db.prepare(`UPDATE nests SET status = 'occupied', occupied_at = ? WHERE address = ?`).run(at, winner!)
      for (const a of rest) this.db.prepare(`UPDATE nests SET status = 'abandoned' WHERE address = ?`).run(a)
      for (const a of [winner!, ...rest]) this.db.prepare('UPDATE nest_handoffs SET ct = NULL WHERE nest = ?').run(a)
      return winner!
    })
    // Push the zeroed pages into the main file and drop the WAL copy of the original ciphertext.
    if (winner) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return winner
  }

  // pulses

  async appendPulse(p: PulseRecord) {
    return this.tx(() => {
      const last = this.one('SELECT MAX(seq) AS seq FROM pulses WHERE address = ?', p.address)?.seq as number | null
      if (last !== null && last !== undefined && p.seq <= last) return { ok: false as const, lastSeq: last }
      this.db
        .prepare('INSERT INTO pulses (address, seq, received_at, pulse) VALUES (?, ?, ?, ?)')
        .run(p.address, p.seq, p.receivedAt, JSON.stringify(p.pulse))
      return { ok: true as const }
    })
  }

  async latestPulses(address: string, limit: number) {
    return this.all('SELECT * FROM pulses WHERE address = ? ORDER BY seq DESC LIMIT ?', address, limit).map(pulse)
  }

  async gremlinsWithLatestPulse() {
    const rows = this.all(`
      SELECT e.*, p.seq AS p_seq, p.received_at AS p_received_at, p.pulse AS p_pulse
      FROM eggs e
      LEFT JOIN pulses p ON p.address = e.address
        AND p.seq = (SELECT MAX(seq) FROM pulses WHERE address = e.address)
      WHERE e.status IN ('configured', 'hatched')`)
    return rows.map((r) => ({
      egg: egg(r),
      pulse: r.p_seq === null ? null : pulse({ address: r.address, seq: r.p_seq, received_at: r.p_received_at, pulse: r.p_pulse }),
    }))
  }

  // activity

  async addEvent(e: Omit<EventRecord, 'id'>) {
    this.db.prepare('INSERT INTO events (kind, address, data, at) VALUES (?, ?, ?, ?)').run(e.kind, e.address, JSON.stringify(e.data), e.at)
  }

  async recentEvents(limit: number) {
    return this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit).map((r) => ({
      id: r.id as number,
      kind: r.kind as EventRecord['kind'],
      address: r.address as string,
      data: JSON.parse(r.data as string),
      at: r.at as number,
    }))
  }

  // communities

  async createCommunity(c: Community) {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO communities (name, title, description, creator, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(c.name, c.title, c.description, c.creator, c.createdAt)
    return r.changes === 1
  }

  async getCommunity(name: string) {
    const r = this.one('SELECT * FROM communities WHERE name = ?', name)
    return r ? community(r) : null
  }

  async listCommunities() {
    return this.all(`
      SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.community = c.name) AS post_count
      FROM communities c ORDER BY post_count DESC, c.name`).map((r) => ({ ...community(r), postCount: r.post_count as number }))
  }

  // posts

  async createPost(p: Omit<PostRecord, 'id' | 'ups' | 'downs' | 'score' | 'hot' | 'commentCount'>) {
    const r = this.db
      .prepare('INSERT INTO posts (community, author, title, body, url, created_at, hot) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.community, p.author, p.title, p.body, p.url, p.createdAt, hot(0, 0, p.createdAt))
    return (await this.getPost(Number(r.lastInsertRowid)))!
  }

  async getPost(id: number) {
    const r = this.one('SELECT * FROM posts WHERE id = ?', id)
    return r ? post(r) : null
  }

  async listPosts({ community, author, sort, limit, offset }: { community?: string; author?: string; sort: PostSort; limit: number; offset: number }) {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (community) (where.push('community = ?'), params.push(community))
    if (author) (where.push('author = ?'), params.push(author))
    const sql = `SELECT * FROM posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${POST_ORDER[sort]} LIMIT ? OFFSET ?`
    return this.all(sql, ...params, limit, offset).map(post)
  }

  // comments

  async createComment(c: Omit<CommentRecord, 'id' | 'ups' | 'downs' | 'score'>) {
    const id = this.tx(() => {
      const r = this.db
        .prepare('INSERT INTO comments (post_id, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.postId, c.parentId, c.author, c.body, c.createdAt)
      this.db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(c.postId)
      return Number(r.lastInsertRowid)
    })
    return (await this.getComment(id))!
  }

  async getComment(id: number) {
    const r = this.one('SELECT * FROM comments WHERE id = ?', id)
    return r ? comment(r) : null
  }

  async listComments(postId: number) {
    return this.all('SELECT * FROM comments WHERE post_id = ? ORDER BY id', postId).map(comment)
  }

  // votes

  async castVote(voter: string, target: VoteTarget, id: number, value: -1 | 0 | 1) {
    const table = target === 'post' ? 'posts' : 'comments'
    return this.tx(() => {
      const row = this.one(`SELECT * FROM ${table} WHERE id = ?`, id)
      if (!row) return null
      const prev = (this.one('SELECT value FROM votes WHERE voter = ? AND target = ? AND id = ?', voter, target, id)?.value as number) ?? 0
      const ups = (row.ups as number) - (prev === 1 ? 1 : 0) + (value === 1 ? 1 : 0)
      const downs = (row.downs as number) - (prev === -1 ? 1 : 0) + (value === -1 ? 1 : 0)
      const score = ups - downs
      if (value === 0) this.db.prepare('DELETE FROM votes WHERE voter = ? AND target = ? AND id = ?').run(voter, target, id)
      else
        this.db
          .prepare('INSERT INTO votes (voter, target, id, value) VALUES (?, ?, ?, ?) ON CONFLICT (voter, target, id) DO UPDATE SET value = excluded.value')
          .run(voter, target, id, value)
      if (target === 'post')
        this.db.prepare('UPDATE posts SET ups = ?, downs = ?, score = ?, hot = ? WHERE id = ?').run(ups, downs, score, hot(ups, downs, row.created_at as number), id)
      else this.db.prepare('UPDATE comments SET ups = ?, downs = ?, score = ? WHERE id = ?').run(ups, downs, score, id)
      return { ups, downs, score }
    })
  }

  async getVote(voter: string, target: VoteTarget, id: number) {
    return (this.one('SELECT value FROM votes WHERE voter = ? AND target = ? AND id = ?', voter, target, id)?.value as number) ?? 0
  }

  // auth

  async consumeSignature(signature: string, expiresAt: number, now: number) {
    this.db.prepare('DELETE FROM used_signatures WHERE expires_at < ?').run(now)
    const r = this.db.prepare('INSERT OR IGNORE INTO used_signatures (signature, expires_at) VALUES (?, ?)').run(signature, expiresAt)
    return r.changes === 1
  }

  async close() {
    this.db.close()
  }
}
