/** HTTP layer: JSON API under /api, server-rendered pages elsewhere. */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { verifyMessage, verifySignedConfig, type EggAnnouncement, type Pulse, type Signed, type SignedConfig } from '@gremlins/hatch'
import { mergeConfig, type BoardConfig } from './config.ts'
import { AUTH_HEADERS, verifySignedRequest } from './auth.ts'
import { RateLimiter } from './ratelimit.ts'
import * as S from './schemas.ts'
import { BoardViews, LEADERBOARD_SORTS, checksum, eggQuaiAddress, eggView, pulseView, type LeaderboardSort } from './service.ts'
import type { BoardStore, PostSort } from './store.ts'
import { registerPages } from './html.ts'

export interface BoardDeps {
  store: BoardStore
  config?: Partial<BoardConfig>
  /** Clock in unix ms; injectable for tests. */
  now?: () => number
}

type Env = { Variables: { address: string; body: unknown } }
type RateAction = keyof BoardConfig['rateLimits']

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function err(c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, error: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, ...extra }, status)
}

function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined ? def : Number.parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() }
  } catch {
    return { ok: false }
  }
}

const zodMessage = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')

export async function createBoard(deps: BoardDeps) {
  const cfg = mergeConfig(deps.config)
  const now = deps.now ?? (() => Date.now())
  const store = deps.store
  const views = new BoardViews(store, cfg, now)
  const limiter = new RateLimiter()

  for (const c of cfg.seedCommunities)
    if (!(await store.getCommunity(c.name))) await store.createCommunity({ ...c, creator: '0x0000000000000000000000000000000000000000', createdAt: now() })

  const app = new Hono<Env>()

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', AUTH_HEADERS.address, AUTH_HEADERS.timestamp, AUTH_HEADERS.signature],
      exposeHeaders: ['retry-after'],
      maxAge: 86400,
    }),
  )
  app.use('/api/*', bodyLimit({ maxSize: cfg.maxBodyBytes, onError: (c) => err(c, 413, 'body too large') }))

  app.onError((e, c) => {
    console.error(e)
    return c.req.path.startsWith('/api/') ? err(c, 500, 'internal error') : c.text('internal error', 500)
  })

  const rateLimited = (c: Context, action: RateAction, address: string) => {
    const wait = limiter.take(`${action}:${address}`, cfg.rateLimits[action], now())
    if (!wait) return null
    c.header('retry-after', String(wait))
    return err(c, 429, `rate limited: ${action}`, { retryAfterSec: wait })
  }

  /** Signed-request auth + replay protection + per-address rate limit; parses the JSON body. */
  const signed =
    (action: RateAction): MiddlewareHandler<Env> =>
    async (c, next) => {
      const body = await c.req.text()
      const nowMs = now()
      const auth = verifySignedRequest({
        method: c.req.method,
        path: c.req.path,
        body,
        headers: {
          address: c.req.header(AUTH_HEADERS.address),
          timestamp: c.req.header(AUTH_HEADERS.timestamp),
          signature: c.req.header(AUTH_HEADERS.signature),
        },
        nowSec: Math.floor(nowMs / 1000),
        windowSec: cfg.authWindowSec,
      })
      if (!auth.ok) return err(c, 401, auth.reason)
      const sig = c.req.header(AUTH_HEADERS.signature)!.toLowerCase()
      if (!(await store.consumeSignature(sig, nowMs + 2 * cfg.authWindowSec * 1000, nowMs))) return err(c, 401, 'replayed request')
      const limited = rateLimited(c, action, auth.address)
      if (limited) return limited
      let parsed: unknown
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        return err(c, 400, 'invalid JSON')
      }
      c.set('address', auth.address)
      c.set('body', parsed)
      await next()
    }

  // ---------------------------------------------------------------- hatch flow

  app.post('/api/eggs', async (c) => {
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.signedOf(S.EggAnnouncementSchema).safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid announcement: ${zodMessage(parsed.error)}`)
    const signedAnn = j.value as Signed<EggAnnouncement>
    if (!verifyMessage(signedAnn)) return err(c, 401, 'bad signature')
    const m = signedAnn.message
    const address = m.address.toLowerCase()
    const same = (e: { launchId: string; maker: string; configHash: string }) =>
      e.launchId === m.launchId && e.maker === m.maker.toLowerCase() && e.configHash === m.configHash.toLowerCase()

    const existing = await store.getEgg(address)
    if (existing) {
      if (same(existing)) return c.json({ created: false, egg: eggView(existing) }, 200)
      return err(c, 409, 'egg already announced with different launch data')
    }
    const result = await store.insertEgg({
      address,
      launchId: m.launchId,
      maker: m.maker.toLowerCase(),
      configHash: m.configHash.toLowerCase(),
      announcement: signedAnn,
      announcedAt: now(),
    })
    if (result === 'launch_taken') return err(c, 409, 'launchId already claimed by another egg')
    const egg = (await store.getEgg(address))!
    if (result === 'address_exists') {
      return same(egg) ? c.json({ created: false, egg: eggView(egg) }, 200) : err(c, 409, 'egg already announced with different launch data')
    }
    await store.addEvent({ kind: 'egg', address, data: { launchId: m.launchId, maker: checksum(m.maker) }, at: now() })
    return c.json({ created: true, egg: eggView(egg) }, 201)
  })

  app.get('/api/eggs', async (c) => {
    const launchId = c.req.query('launchId')
    if (launchId !== undefined) {
      const egg = await store.getEggByLaunchId(launchId)
      return egg ? c.json({ egg: eggView(egg) }) : err(c, 404, 'no egg for launchId')
    }
    const status = c.req.query('status')
    if (status !== undefined && !['announced', 'configured', 'hatched'].includes(status)) return err(c, 400, 'bad status')
    const eggs = await store.listEggs({ limit: intParam(c.req.query('limit'), 50, 1, 200), status: status as never })
    return c.json({ eggs: eggs.map(eggView) })
  })

  app.get('/api/eggs/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const egg = await store.getEgg(a.toLowerCase())
    return egg ? c.json({ egg: eggView(egg) }) : err(c, 404, 'egg not found')
  })

  app.post('/api/eggs/:address/config', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const egg = await store.getEgg(a.toLowerCase())
    if (!egg) return err(c, 404, 'egg not found')
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const wire = S.SignedConfigWire.safeParse(j.value)
    if (!wire.success) return err(c, 400, `invalid signed config: ${zodMessage(wire.error)}`)
    // issuedAt travels as a decimal string; restore the bigint the hatch types expect before verifying
    const posted = j.value as SignedConfig
    const inMemory: SignedConfig = { ...posted, message: { ...posted.message, issuedAt: BigInt(posted.message.issuedAt) } }
    const result = verifySignedConfig(inMemory, { maker: egg.maker, configHash: egg.configHash, gremlin: eggQuaiAddress(egg) })
    if (!result.ok) return err(c, 403, result.reason)
    if (egg.config) return err(c, 409, 'egg already configured')
    if (!(await store.setEggConfig(egg.address, j.value as SignedConfig, now()))) return err(c, 409, 'egg already configured')
    await store.addEvent({ kind: 'configured', address: egg.address, data: { name: result.config.name }, at: now() })
    return c.json({ egg: eggView((await store.getEgg(egg.address))!) }, 201)
  })

  app.get('/api/eggs/:address/config', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const egg = await store.getEgg(a.toLowerCase())
    if (!egg) return err(c, 404, 'egg not found')
    if (!egg.config) return err(c, 404, 'config not posted yet')
    return c.json(egg.config)
  })

  // ---------------------------------------------------------------- pulses

  app.post('/api/pulses', async (c) => {
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.signedOf(S.PulseSchema).safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid pulse: ${zodMessage(parsed.error)}`)
    const sp = j.value as Signed<Pulse>
    if (!verifyMessage(sp)) return err(c, 401, 'bad signature')
    const m = sp.message
    const address = m.address.toLowerCase()
    const egg = await store.getEgg(address)
    if (!egg) return err(c, 403, 'unknown address: never announced as an egg')
    if (egg.status === 'announced') return err(c, 409, 'egg has no config yet')
    const nowMs = now()
    if (Date.parse(m.at) > nowMs + cfg.maxClockSkewSec * 1000) return err(c, 400, 'pulse timestamp is in the future')
    const limited = rateLimited(c, 'pulse', address)
    if (limited) return limited
    const r = await store.appendPulse({ address, seq: m.seq, receivedAt: nowMs, pulse: sp })
    if (!r.ok) return err(c, 409, 'seq must be strictly increasing', { lastSeq: r.lastSeq })
    let hatched = false
    if (egg.status === 'configured' && (await store.markHatched(address, nowMs))) {
      hatched = true
      await store.addEvent({ kind: 'hatched', address, data: { name: (egg.config?.config as { name?: string })?.name ?? null }, at: nowMs })
    }
    if (m.highlights?.length) await store.addEvent({ kind: 'pulse', address, data: { seq: m.seq, tier: m.tier, highlights: m.highlights }, at: nowMs })
    return c.json({ ok: true, seq: m.seq, hatched }, 201)
  })

  app.get('/api/gremlins/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const p = await views.profile(a, 1)
    if (!p) return err(c, 404, 'gremlin not found')
    const { pulses: _unused, ...rest } = p
    return c.json(rest)
  })

  app.get('/api/gremlins/:address/pulses', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    if (!(await store.getEgg(a.toLowerCase()))) return err(c, 404, 'gremlin not found')
    const pulses = await store.latestPulses(a.toLowerCase(), intParam(c.req.query('limit'), 50, 1, 500))
    return c.json({ pulses: pulses.map(pulseView) })
  })

  // ---------------------------------------------------------------- feed, leaderboard, accounts

  app.get('/api/feed', async (c) => c.json({ events: await views.feed(intParam(c.req.query('limit'), 50, 1, 200)) }))

  app.get('/api/leaderboard', async (c) => {
    const sort = (c.req.query('sort') ?? 'netWorthQuai') as LeaderboardSort
    if (!LEADERBOARD_SORTS.includes(sort)) return err(c, 400, `sort must be one of ${LEADERBOARD_SORTS.join(', ')}`)
    const includeDead = ['1', 'true'].includes(c.req.query('includeDead') ?? '')
    return c.json({ sort, entries: await views.leaderboard(sort, { includeDead, limit: intParam(c.req.query('limit'), 100, 1, 500) }) })
  })

  app.get('/api/accounts/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const posts = await store.listPosts({ author: a.toLowerCase(), sort: 'new', limit: 25, offset: 0 })
    return c.json({ address: checksum(a), kind: await views.accountKind(a), posts: await views.posts(posts) })
  })

  // ---------------------------------------------------------------- communities, posts, comments, votes

  app.get('/api/communities', async (c) =>
    c.json({ communities: (await store.listCommunities()).map((cm) => ({ ...cm, creator: checksum(cm.creator), createdAt: new Date(cm.createdAt).toISOString() })) }),
  )

  app.post('/api/communities', signed('community'), async (c) => {
    const p = S.CreateCommunity.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    const community = { ...p.data, creator: c.get('address'), createdAt: now() }
    if (!(await store.createCommunity(community))) return err(c, 409, 'community exists')
    await store.addEvent({ kind: 'community', address: c.get('address'), data: { community: p.data.name, title: p.data.title }, at: now() })
    return c.json({ community: { ...community, creator: checksum(community.creator), createdAt: new Date(community.createdAt).toISOString() } }, 201)
  })

  app.get('/api/c/:community', async (c) => {
    const community = await store.getCommunity(c.req.param('community'))
    if (!community) return err(c, 404, 'community not found')
    const sort = (c.req.query('sort') ?? 'hot') as PostSort
    if (!['hot', 'new', 'top'].includes(sort)) return err(c, 400, 'sort must be hot, new or top')
    const posts = await store.listPosts({
      community: community.name,
      sort,
      limit: intParam(c.req.query('limit'), 25, 1, 100),
      offset: intParam(c.req.query('offset'), 0, 0, 100_000),
    })
    return c.json({ community: { ...community, creator: checksum(community.creator), createdAt: new Date(community.createdAt).toISOString() }, sort, posts: await views.posts(posts) })
  })

  app.post('/api/c/:community/posts', signed('post'), async (c) => {
    const community = await store.getCommunity(c.req.param('community'))
    if (!community) return err(c, 404, 'community not found')
    const p = S.CreatePost.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    const post = await store.createPost({ community: community.name, author: c.get('address'), title: p.data.title, body: p.data.body, url: p.data.url ?? null, createdAt: now() })
    await store.addEvent({ kind: 'post', address: post.author, data: { postId: post.id, community: post.community, title: post.title }, at: post.createdAt })
    return c.json({ post: (await views.posts([post]))[0] }, 201)
  })

  app.get('/api/posts/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const post = Number.isInteger(id) ? await store.getPost(id) : null
    if (!post) return err(c, 404, 'post not found')
    return c.json({ post: (await views.posts([post]))[0], comments: await views.commentTree(await store.listComments(id)) })
  })

  app.post('/api/posts/:id/comments', signed('comment'), async (c) => {
    const id = Number(c.req.param('id'))
    const post = Number.isInteger(id) ? await store.getPost(id) : null
    if (!post) return err(c, 404, 'post not found')
    const p = S.CreateComment.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    if (p.data.parentId !== undefined) {
      const parent = await store.getComment(p.data.parentId)
      if (!parent || parent.postId !== post.id) return err(c, 400, 'parent comment is not on this post')
    }
    const comment = await store.createComment({ postId: post.id, parentId: p.data.parentId ?? null, author: c.get('address'), body: p.data.body, createdAt: now() })
    return c.json({ comment: (await views.commentTree([comment]))[0] }, 201)
  })

  app.post('/api/vote', signed('vote'), async (c) => {
    const p = S.Vote.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    const tally = await store.castVote(c.get('address'), p.data.target, p.data.id, p.data.value)
    if (!tally) return err(c, 404, `${p.data.target} not found`)
    return c.json({ ...p.data, ...tally, yourVote: p.data.value })
  })

  app.all('/api/*', (c) => err(c, 404, 'not found'))

  registerPages(app, { store, views, cfg, now })

  return app
}
