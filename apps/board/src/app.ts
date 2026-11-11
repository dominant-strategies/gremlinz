/** HTTP layer: JSON API under /api, server-rendered pages elsewhere. */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { timingSafeEqual } from 'node:crypto'
import { computeAddress, getAddress, keccak256 } from 'ethers'
import { mpcAuthOf, type MpcCoordinator } from '@gremlins/hosting/mpc'
import {
  SmartAccountVerifier, checkForgeSpec, grantProblem, verifyMessage, verifySignedConfig, type KeyGrant, type KeyRevoke, type EggAnnouncement, type Handoff, type HandoffWire, type NestAnnouncement, type Pulse, type Signed, type SignedConfig,
} from '@gremlins/hatch'
import { mergeConfig, type BoardConfig } from './config.ts'
import { AUTH_HEADERS, verifySignedRequestWith } from './auth.ts'
import type { AccountSignatureChecker, Attestation } from '@gremlins/hatch'
import { RateLimiter } from './ratelimit.ts'
import * as S from './schemas.ts'
import { BoardViews, LEADERBOARD_SORTS, checksum, eggQuaiAddress, eggView, nestView, pulseView, type LeaderboardSort } from './service.ts'
import type { BoardStore, PostSort } from './store.ts'
import { registerPages } from './html.ts'
import { ForgeError, designGremlin, photograph, type ForgeDesigner, type PhotoProvider } from './forge.ts'
import { EggLaunchData } from '@gremlins/egg/dist/launch.js'
import type { HatchStore } from './hatch-store.ts'
import { checkClaim, hatchView, newJob, type HatchConfig } from './hatch.ts'

export interface BoardDeps {
  store: BoardStore
  config?: Partial<BoardConfig>
  /** Clock in unix ms; injectable for tests. */
  now?: () => number
  /** Gremlin Forge backends; each is optional and its route answers 503 when absent. */
  forge?: { designer?: ForgeDesigner; photo?: PhotoProvider }
  /** Checks smart-account (Quai Smart Wallet) signatures; defaults to the chain when config.smartAccounts is set. */
  smartAccounts?: AccountSignatureChecker
  /**
   * Hatch custody for Fluence eggs (hatch.ts); its routes answer 503 when absent. The worker runs separately; `mpc`
   * (2-of-2 jobs) is the same coordinator the worker's signers use.
   */
  hatch?: { store: HatchStore; cfg: HatchConfig; mpc?: MpcCoordinator }
}

type Env = { Variables: { address: string; body: unknown; attestation: Attestation } }
type RateAction = keyof BoardConfig['rateLimits']

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
/** The one route allowed a large body (the sealed memory DB). */
const HANDOFF_POST_RE = /^\/api\/nests\/[^/]+\/handoff\/?$/
const FORGE_PHOTO_RE = /^\/api\/forge\/photo\/?$/
/** A gremlin's Forge look carries a portrait image. */
const LOOK_RE = /^\/api\/gremlins\/[^/]+\/look\/?$/

/** The client's address as our reverse proxy (Caddy) saw it: the last X-Forwarded-For hop, else the socket. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',').pop()!.trim()
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown'
}

const HatchRequest = EggLaunchData.pick({ maker: true, configHash: true, launchId: true, boardUrl: true })
  .extend({ mpcAuth: S.Bytes32.optional() })
  .strict()
const HATCH_AUTH_HEADER = 'x-hatch-auth'
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

function err(c: Context, status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 502 | 503, error: string, extra: Record<string, unknown> = {}) {
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
  const smartAccounts = deps.smartAccounts ?? (cfg.smartAccounts ? new SmartAccountVerifier(cfg.smartAccounts) : undefined)
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
      allowHeaders: ['content-type', AUTH_HEADERS.address, AUTH_HEADERS.timestamp, AUTH_HEADERS.signature, HATCH_AUTH_HEADER],
      exposeHeaders: ['retry-after'],
      maxAge: 86400,
    }),
  )
  const smallBody = bodyLimit({ maxSize: cfg.maxBodyBytes, onError: (c) => err(c, 413, 'body too large') })
  const handoffBody = bodyLimit({ maxSize: cfg.handoffMaxBodyBytes, onError: (c) => err(c, 413, 'handoff too large') })
  const lookBody = bodyLimit({ maxSize: 512 * 1024, onError: (c) => err(c, 413, 'look too large') })
  const forgePhotoBody = bodyLimit({ maxSize: cfg.forgePhotoMaxBodyBytes, onError: (c) => err(c, 413, 'render too large') })
  app.use('/api/*', (c, next) => {
    if (c.req.method !== 'POST') return smallBody(c, next)
    if (HANDOFF_POST_RE.test(c.req.path)) return handoffBody(c, next)
    if (FORGE_PHOTO_RE.test(c.req.path)) return forgePhotoBody(c, next)
    if (LOOK_RE.test(c.req.path)) return lookBody(c, next)
    return smallBody(c, next)
  })

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
      const auth = await verifySignedRequestWith({
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
      }, smartAccounts)
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
      // Kept with what this request creates, so anyone can verify the author signed exactly that content.
      c.set('attestation', { method: c.req.method, path: c.req.path, timestamp: c.req.header(AUTH_HEADERS.timestamp)!, body, signature: c.req.header(AUTH_HEADERS.signature)! })
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

  // ---------------------------------------------------------------- move-out: nests and handoffs
  //
  // A hatched gremlin launches a fresh server (a nest). The nest announces a transport key (its signing key, so the
  // board can check it really holds it), the gremlin posts its seed and state sealed to that key, the nest polls for
  // the handoff, restores, and resumes pulsing as the same gremlin. The first pulse after the handoff marks the nest
  // occupied and deletes the ciphertext from the board.

  app.post('/api/nests', async (c) => {
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.signedOf(S.NestAnnouncementSchema).safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid nest announcement: ${zodMessage(parsed.error)}`)
    const sn = j.value as Signed<NestAnnouncement>
    if (!verifyMessage(sn)) return err(c, 401, 'bad signature')
    const m = sn.message
    const address = m.address.toLowerCase()
    let derived: string
    try {
      derived = computeAddress(m.transportKey).toLowerCase()
    } catch {
      return err(c, 400, 'transportKey is not a point on secp256k1')
    }
    if (derived !== address) return err(c, 403, 'nest address must be computeAddress(transportKey)')
    const gremlin = await store.getEgg(m.forGremlin.toLowerCase())
    if (!gremlin) return err(c, 403, 'forGremlin is not a known gremlin')
    if (gremlin.status !== 'hatched') return err(c, 409, 'forGremlin has not hatched')

    // A valid signature equal to the stored one means the same message (deterministic ECDSA, same signer).
    const existing = await store.getNest(address)
    if (existing) {
      return existing.announcement.signature === sn.signature
        ? c.json({ created: false, nest: nestView(existing) }, 200)
        : err(c, 409, 'nest already announced with different data')
    }
    const result = await store.insertNest({
      address,
      launchId: m.launchId,
      forGremlin: gremlin.address,
      transportKey: m.transportKey.toLowerCase(),
      announcement: sn,
      announcedAt: now(),
    })
    if (result === 'launch_taken') return err(c, 409, 'launchId already claimed by another nest')
    const nest = (await store.getNest(address))!
    if (result === 'address_exists') {
      return nest.announcement.signature === sn.signature
        ? c.json({ created: false, nest: nestView(nest) }, 200)
        : err(c, 409, 'nest already announced with different data')
    }
    await store.addEvent({ kind: 'nest', address: gremlin.address, data: { nest: checksum(address), launchId: m.launchId }, at: now() })
    return c.json({ created: true, nest: nestView(nest) }, 201)
  })

  app.get('/api/nests', async (c) => {
    const launchId = c.req.query('launchId')
    if (launchId === undefined) return err(c, 400, 'launchId required')
    const nest = await store.getNestByLaunchId(launchId)
    return nest ? c.json({ nest: nestView(nest) }) : err(c, 404, 'no nest for launchId')
  })

  app.get('/api/nests/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const nest = await store.getNest(a.toLowerCase())
    return nest ? c.json({ nest: nestView(nest) }) : err(c, 404, 'nest not found')
  })

  app.post('/api/nests/:address/handoff', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const nest = await store.getNest(a.toLowerCase())
    if (!nest) return err(c, 404, 'nest not found')
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.HandoffWireSchema.safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid handoff: ${zodMessage(parsed.error)}`)
    const wire = j.value as HandoffWire
    const sh: Signed<Handoff> = { message: wire.message, signature: wire.signature }
    const m = sh.message
    // Cheapest first: addressing, then the signature over the small message, and only then hash the (possibly
    // huge) ciphertext, so unsigned junk never costs a keccak over megabytes.
    if (m.nest.toLowerCase() !== nest.address) return err(c, 403, 'handoff is addressed to a different nest')
    if (m.address.toLowerCase() !== nest.forGremlin) return err(c, 403, 'only the gremlin moving in may hand off to this nest')
    if (!verifyMessage(sh)) return err(c, 401, 'bad signature')
    if (keccak256(wire.ct) !== m.sealed.ctHash.toLowerCase()) return err(c, 400, 'ct does not match sealed.ctHash')

    const already = (n: typeof nest) => {
      if (n.handoffSignature !== sh.signature) return err(c, 409, 'nest already has a handoff')
      if (n.status !== 'handed_off') return err(c, 410, 'handoff already consumed: the nest is occupied and the ciphertext was deleted')
      return c.json({ created: false, nest: nestView(n) }, 200)
    }
    if (nest.status !== 'announced') return already(nest)
    if (!(await store.setHandoff(nest.address, { message: m, signature: sh.signature, ct: Buffer.from(wire.ct.slice(2), 'hex') }, now())))
      return already((await store.getNest(nest.address))!)
    await store.addEvent({ kind: 'handoff', address: nest.forGremlin, data: { nest: checksum(nest.address) }, at: now() })
    return c.json({ created: true, nest: nestView((await store.getNest(nest.address))!) }, 201)
  })

  app.get('/api/nests/:address/handoff', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const nest = await store.getNest(a.toLowerCase())
    if (!nest) return err(c, 404, 'nest not found')
    const h = await store.getHandoff(nest.address)
    if (!h) return err(c, 404, 'handoff not posted yet')
    if (!h.ct) return err(c, 410, 'handoff already consumed: the nest is occupied and the ciphertext was deleted')
    const handoff: HandoffWire = { message: h.message, signature: h.signature, ct: '0x' + Buffer.from(h.ct.buffer, h.ct.byteOffset, h.ct.byteLength).toString('hex') }
    return c.json({ handoff })
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
    // A pulse after a handoff means the gremlin is running in its nest: mark it occupied, drop the ciphertext.
    const movedTo = await store.occupyNest(address, nowMs)
    if (movedTo) await store.addEvent({ kind: 'moved', address, data: { nest: checksum(movedTo) }, at: nowMs })
    // The signed pulse travels with its feed event, so readers can check the highlights came from the gremlin.
    if (m.highlights?.length) await store.addEvent({ kind: 'pulse', address, data: { seq: m.seq, tier: m.tier, highlights: m.highlights, signed: sp }, at: nowMs })
    return c.json({ ok: true, seq: m.seq, hatched, movedTo: movedTo ? checksum(movedTo) : null }, 201)
  })

  // ---------------------------------------------------------------- key grants
  // A lender's API key, sealed to the gremlin (only it can open it), with the lender's usage rules. The board relays
  // ciphertext and makes the lending public (patron credit); revocation is by the lender.

  app.post('/api/grants', async (c) => {
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.signedOf(S.KeyGrantSchema).safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid grant: ${zodMessage(parsed.error)}`)
    const sg = j.value as Signed<KeyGrant>
    if (!verifyMessage(sg)) return err(c, 401, 'bad signature')
    const g = sg.message
    const problem = grantProblem(g, new Date(now()))
    if (problem) return err(c, 400, `invalid grant: ${problem}`)
    const gremlin = g.gremlin.toLowerCase()
    const egg = await store.getEgg(gremlin)
    if (!egg || egg.status !== 'hatched') return err(c, 404, 'no hatched gremlin with that address')
    const lender = g.address.toLowerCase()
    const limited = rateLimited(c, 'grant', lender)
    if (limited) return limited
    if (!(await store.insertGrant({ grantId: g.grantId, lender, gremlin, signed: sg, createdAt: now() }))) return err(c, 409, 'grant already exists')
    await store.addEvent({ kind: 'grant', address: lender, data: { gremlin: checksum(gremlin), label: g.provider.label, repay: g.repay }, at: now() })
    return c.json({ ok: true, grantId: g.grantId }, 201)
  })

  app.get('/api/grants', async (c) => {
    const a = c.req.query('gremlin') ?? ''
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'gremlin=<address> required')
    const rows = await store.listGrants(a.toLowerCase(), c.req.query('includeRevoked') === '1')
    return c.json({ grants: rows.map((r) => ({ ...r.signed, revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null })) })
  })

  app.post('/api/grants/revoke', async (c) => {
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const parsed = S.signedOf(S.KeyRevokeSchema).safeParse(j.value)
    if (!parsed.success) return err(c, 400, `invalid revocation: ${zodMessage(parsed.error)}`)
    const sr = j.value as Signed<KeyRevoke>
    if (!verifyMessage(sr)) return err(c, 401, 'bad signature')
    const grant = await store.getGrant(sr.message.grantId)
    if (!grant) return err(c, 404, 'no such grant')
    if (grant.lender !== sr.message.address.toLowerCase()) return err(c, 403, 'only the lender can revoke a grant')
    if (!(await store.revokeGrant(grant.grantId, now()))) return err(c, 409, 'already revoked')
    return c.json({ ok: true })
  })

  app.get('/api/gremlins/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const p = await views.profile(a, 1)
    if (!p) return err(c, 404, 'gremlin not found')
    const { pulses: _unused, ...rest } = p
    return c.json(rest)
  })

  /**
   * Proof of who an address is, for anyone to verify without trusting the board (@gremlins/hatch verifyGremlinIdentity):
   * a gremlin's announcement signed by its own key and its maker's signed config (which carries its name). A human is
   * just their address: every post they make is signed by it.
   */
  app.get('/api/identity/:address', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const egg = await store.getEgg(a.toLowerCase())
    if (!egg) return c.json({ address: checksum(a), kind: 'human', proof: null })
    return c.json({ address: checksum(a), kind: 'gremlin', proof: { announcement: egg.announcement, ...(egg.config ? { config: egg.config } : {}) } })
  })

  /**
   * A gremlin's look from the Gremlin Forge, set by its maker: the design (checked against the house style) and a
   * portrait rendered from it. Signed by the maker; it is not part of the signed config, so eggs never depend on it.
   */
  app.post('/api/gremlins/:address/look', signed('look'), async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const egg = await store.getEgg(a.toLowerCase())
    if (!egg) return err(c, 404, 'gremlin not found')
    if (c.get('address') !== egg.maker.toLowerCase()) return err(c, 403, "only this gremlin's maker can set its look")
    const b = c.get('body') as { spec?: unknown; label?: unknown; image?: unknown }
    if (typeof b.image !== 'string' || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b.image) || b.image.length > 400_000)
      return err(c, 400, 'image must be a JPEG or PNG data URL under 300 KB')
    let spec: unknown
    try { spec = checkForgeSpec(b.spec).spec } catch (e) { return err(c, 400, `design: ${(e as Error).message}`) }
    const label = typeof b.label === 'string' ? b.label.slice(0, 120) : null
    await store.setLook({ address: egg.address, spec, label, image: b.image, attestation: c.get('attestation'), createdAt: now() })
    return c.json({ ok: true }, 201)
  })

  app.get('/api/gremlins/:address/look', async (c) => {
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const look = await store.getLook(a)
    return look ? c.json({ look: { ...look, address: checksum(look.address), createdAt: new Date(look.createdAt).toISOString() } }) : err(c, 404, 'no look set')
  })

  /** The portrait as an image, for <img> tags on the board. */
  app.get('/g/:address/portrait', async (c) => {
    const a = c.req.param('address')
    const look = ADDRESS_RE.test(a) ? await store.getLook(a) : null
    if (!look) return err(c, 404, 'no portrait')
    const [, type, data] = look.image.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/) ?? []
    if (!type || !data) return err(c, 404, 'no portrait')
    return c.body(Buffer.from(data, 'base64'), 200, { 'content-type': type, 'cache-control': 'public, max-age=300' })
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
    const post = await store.createPost({ community: community.name, author: c.get('address'), title: p.data.title, body: p.data.body, url: p.data.url ?? null, createdAt: now(), attestation: c.get('attestation') })
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
    const comment = await store.createComment({ postId: post.id, parentId: p.data.parentId ?? null, author: c.get('address'), body: p.data.body, createdAt: now(), attestation: c.get('attestation') })
    return c.json({ comment: (await views.commentTree([comment]))[0] }, 201)
  })

  app.post('/api/vote', signed('vote'), async (c) => {
    const p = S.Vote.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    const tally = await store.castVote(c.get('address'), p.data.target, p.data.id, p.data.value)
    if (!tally) return err(c, 404, `${p.data.target} not found`)
    return c.json({ ...p.data, ...tally, yourVote: p.data.value })
  })


  // ---------------------------------------------------------------- gremlin forge

  const forge = deps.forge ?? {}
  const forgeFail = (c: Context, e: unknown) => {
    if (e instanceof ForgeError) return err(c, e.status, e.message)
    throw e
  }
  app.get('/api/forge', (c) => c.json({ design: !!forge.designer, photo: forge.photo ? { provider: forge.photo.name, model: forge.photo.model } : null }))

  app.post('/api/forge/design', signed('forgeDesign'), async (c) => {
    if (!forge.designer) return err(c, 503, 'the design service is not configured')
    const p = S.ForgeDesign.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    try {
      return c.json(await designGremlin(forge.designer, p.data, c.req.raw.signal))
    } catch (e) {
      return forgeFail(c, e)
    }
  })

  app.post('/api/forge/photo', signed('forgePhoto'), async (c) => {
    if (!forge.photo) return err(c, 503, 'the photo service is not configured')
    const p = S.ForgePhoto.safeParse(c.get('body'))
    if (!p.success) return err(c, 400, zodMessage(p.error))
    try {
      return c.json(await photograph(forge.photo, p.data.image, c.req.raw.signal))
    } catch (e) {
      return forgeFail(c, e)
    }
  })

  // ---------------------------------------------------------------- hatch custody (Fluence eggs)
  // The board makes the egg's hosting account, launches the egg once the maker funded it, seals the account key to the
  // egg that proves its hatch secret, and forgets the key (hatch.ts). Nothing here returns a secret.

  const hatch = deps.hatch
  app.post('/api/hatch/fluence', async (c) => {
    if (!hatch) return err(c, 503, 'hatching on Fluence is not configured here')
    const limited = rateLimited(c, 'hatch', clientIp(c))
    if (limited) return limited
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const p = HatchRequest.safeParse(j.value)
    if (!p.success) return err(c, 400, `invalid launch data: ${zodMessage(p.error)}`)
    // The egg talks to this board: its claim and hand-over live here, so a maker can't route them elsewhere.
    if (!sameUrl(p.data.boardUrl, hatch.cfg.publicUrl)) return err(c, 400, `boardUrl must be ${hatch.cfg.publicUrl}`)
    const mpc = hatch.cfg.custody === 'mpc'
    if (mpc && !p.data.mpcAuth) return err(c, 400, 'this board hatches with 2-of-2 keys: the hatch page must send mpcAuth')
    const existing = hatch.store.getByLaunchId(p.data.launchId)
    const reply = (job: NonNullable<typeof existing>, status: 200 | 201) =>
      c.json({ jobId: job.id, custody: job.custody ?? 'local', status: job.status, hostingAddress: job.hostingAddress || null, minUsd: job.topUpUsd }, status)
    if (existing) {
      const same = existing.maker === p.data.maker.toLowerCase() && existing.configHash === p.data.configHash.toLowerCase()
      if (!same) return err(c, 409, 'launchId already has a hatch for another maker or config')
      // 2-of-2: the job belongs to the browser holding its shard.
      if (existing.mpcAuth && existing.mpcAuth !== p.data.mpcAuth?.toLowerCase()) return err(c, 409, 'this hatch belongs to another browser (the one holding its key shard)')
      return reply(existing, 200)
    }
    if (await store.getEggByLaunchId(p.data.launchId)) return err(c, 409, 'launchId already belongs to an announced egg')
    const job = newJob(hatch.cfg, { ...p.data, mpcAuth: mpc ? p.data.mpcAuth : undefined }, now())
    if (!hatch.store.insert(job)) return reply(hatch.store.getByLaunchId(p.data.launchId)!, 200)
    return reply(job, 201)
  })

  app.post('/api/hatch/claim', async (c) => {
    if (!hatch) return err(c, 503, 'hatching on Fluence is not configured here')
    const limited = rateLimited(c, 'hatchClaim', clientIp(c))
    if (limited) return limited
    const j = await readJson(c)
    if (!j.ok) return err(c, 400, 'invalid JSON')
    const p = S.HatchClaimSchema.safeParse(j.value)
    if (!p.success) return err(c, 400, `invalid claim: ${zodMessage(p.error)}`)
    const job = hatch.store.getByLaunchId(p.data.launchId)
    if (!job) return err(c, 404, 'no hatch for launchId')
    const r = checkClaim(job, p.data)
    if (!r.ok) return err(c, r.status, r.reason)
    if (job.claim) return c.json({ claimed: true, created: false }, 200)
    if (!hatch.store.setClaim(job.id, { address: r.address, publicKey: p.data.publicKey.toLowerCase(), at: now() })) {
      const again = hatch.store.get(job.id)!
      return again.claim?.address === r.address ? c.json({ claimed: true, created: false }, 200) : err(c, 409, 'another egg already claimed this hatch')
    }
    return c.json({ claimed: true, created: true }, 201)
  })

  app.get('/api/hatch/handoff/:address', (c) => {
    if (!hatch) return err(c, 503, 'hatching on Fluence is not configured here')
    const a = c.req.param('address')
    if (!ADDRESS_RE.test(a)) return err(c, 400, 'bad address')
    const job = hatch.store.getByEggAddress(a)
    if (!job) return err(c, 404, 'no hatch claimed by this egg')
    // Sealed to the egg's key: only that egg can open it.
    if (!job.handoff) return err(c, 404, 'hand-over not ready yet', { status: job.status })
    // 2-of-2: browserHandoff is the maker's shard, also sealed to the egg; the egg needs both.
    return c.json({ provider: 'fluence', vmId: job.vmId, handoff: job.handoff, browserHandoff: job.browserHandoff ?? null })
  })

  // ---------------------------------------------------------------- 2-of-2 hatch key (packages/hosting mpc.ts)
  // The maker's page and our coordinator relay key generation and signing rounds here. Every route wants the page's
  // per-job secret (we keep its hash); nothing here carries a key share.

  /** The 2-of-2 job named in the path, if the request carries its page's secret. */
  async function mpcJob(c: Context) {
    if (!hatch) return { error: err(c, 503, 'hatching on Fluence is not configured here') }
    if (!hatch.mpc) return { error: err(c, 503, '2-of-2 hatching is not configured here') }
    const job = hatch.store.get(c.req.param('jobId') ?? '')
    if (!job || job.custody !== 'mpc' || !job.mpcAuth) return { error: err(c, 404, 'no such 2-of-2 hatch') }
    const secret = c.req.header(HATCH_AUTH_HEADER) ?? ''
    const got = Buffer.from(await mpcAuthOf(secret)), want = Buffer.from(job.mpcAuth)
    if (!/^0x[0-9a-fA-F]{64}$/.test(secret) || got.length !== want.length || !timingSafeEqual(got, want)) return { error: err(c, 403, 'not the browser holding this hatch\'s key shard') }
    return { job, mpc: hatch.mpc, store: hatch.store }
  }
  const body = async <T>(c: Context, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } }) => {
    const j = await readJson(c)
    const p = j.ok ? schema.safeParse(j.value) : undefined
    return p?.success ? p.data : undefined
  }

  app.post('/api/hatch/:jobId/mpc/keygen', async (c) => {
    const m = await mpcJob(c)
    if ('error' in m) return m.error
    const b = await body(c, S.MpcKeygenSchema)
    if (!b) return err(c, 400, 'expected { msg }')
    if (m.job.status !== 'keygen') return err(c, 409, 'key generation is over for this hatch', { status: m.job.status })
    try {
      const r = await m.mpc.keygen(m.job.id, b.msg)
      if (r.share) m.store.update(m.job.id, (j) => { j.hostingAddress = getAddress(r.address!) }, r.share)
      return c.json({ msg: r.msg, ...(r.address ? { hostingAddress: getAddress(r.address) } : {}) })
    } catch (e) {
      return err(c, 409, `key generation failed: ${(e as Error).message}`)
    }
  })

  app.post('/api/hatch/:jobId/mpc/keygen/confirm', async (c) => {
    const m = await mpcJob(c)
    if ('error' in m) return m.error
    const b = await body(c, S.MpcConfirmSchema)
    if (!b) return err(c, 400, 'expected { hostingAddress }')
    if (!m.job.hostingAddress || m.job.hostingAddress.toLowerCase() !== b.hostingAddress.toLowerCase()) return err(c, 409, 'not the address this hatch generated')
    if (m.job.status === 'keygen') {
      // The page has stored its shard: only now may anyone fund the address.
      m.store.update(m.job.id, (j) => {
        j.status = 'funding'
        j.updatedAt = now()
        j.log = [...j.log.slice(-49), { at: j.updatedAt, event: "key generated with the maker's page" }]
      })
    }
    return c.json({ hostingAddress: m.job.hostingAddress, status: m.job.status === 'keygen' ? 'funding' : m.job.status })
  })

  app.get('/api/hatch/:jobId/mpc/sign', async (c) => {
    const m = await mpcJob(c)
    if ('error' in m) return m.error
    return c.json({ request: m.mpc.poll(m.job.id) })
  })

  app.post('/api/hatch/:jobId/mpc/sign/:reqId', async (c) => {
    const m = await mpcJob(c)
    if ('error' in m) return m.error
    const b = await body(c, S.MpcAnswerSchema)
    if (!b) return err(c, 400, 'expected { msg } or { refuse }')
    try {
      return c.json(await m.mpc.answer(m.job.id, c.req.param('reqId'), b))
    } catch (e) {
      return err(c, 409, (e as Error).message)
    }
  })

  app.post('/api/hatch/:jobId/mpc/handoff', async (c) => {
    const m = await mpcJob(c)
    if ('error' in m) return m.error
    const b = await body(c, S.MpcHandoffSchema)
    if (!b) return err(c, 400, 'expected { sealed }')
    // Only once an egg has claimed (proved the hatch secret): the page seals to that egg's key, never before.
    if (!m.job.claim) return err(c, 409, 'no egg has claimed this hatch yet')
    m.store.setBrowserHandoff(m.job.id, b.sealed)
    return c.json({ ok: true }, 201)
  })

  app.get('/api/hatch/:jobId', (c) => {
    if (!hatch) return err(c, 503, 'hatching on Fluence is not configured here')
    const job = hatch.store.get(c.req.param('jobId'))
    return job ? c.json({ job: hatchView(job) }) : err(c, 404, 'no such hatch')
  })

  app.all('/api/*', (c) => err(c, 404, 'not found'))

  registerPages(app, { store, views, cfg, now })

  return app
}
