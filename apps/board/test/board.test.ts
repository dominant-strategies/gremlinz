import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { requestSigningPayload, signRequest, verifySignedRequest } from '../src/auth.ts'
import { hot } from '../src/ranking.ts'
import { hatch, makeBoard, stringify } from './helpers.ts'

describe('signed-request auth', () => {
  const nowSec = 1_790_000_000

  it('verifies the signing payload format directly', async () => {
    const w = Wallet.createRandom()
    const body = '{"a":1}'
    const h = await signRequest(w, 'post', '/api/vote', body, nowSec)
    const base = { method: 'POST', path: '/api/vote', body, nowSec, windowSec: 300 }
    const headers = { address: h['x-gremlins-address'], timestamp: h['x-gremlins-timestamp'], signature: h['x-gremlins-signature'] }
    expect(verifySignedRequest({ ...base, headers })).toEqual({ ok: true, address: w.address.toLowerCase() })
    expect(verifySignedRequest({ ...base, headers, nowSec: nowSec + 301 })).toMatchObject({ ok: false, reason: 'stale timestamp' })
    expect(verifySignedRequest({ ...base, headers, nowSec: nowSec - 301 })).toMatchObject({ ok: false, reason: 'stale timestamp' })
    expect(verifySignedRequest({ ...base, headers, path: '/api/communities' })).toMatchObject({ ok: false })
    expect(verifySignedRequest({ ...base, headers, method: 'GET' })).toMatchObject({ ok: false })
    expect(verifySignedRequest({ ...base, headers: { ...headers, signature: '0xdead' } })).toMatchObject({ ok: false, reason: 'malformed signature' })
    expect(requestSigningPayload('post', '/x', 1, '')).toBe('POST /x\n1\n0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  })

  it('accepts valid writes and rejects stale, wrong-signer, tampered and replayed ones', async () => {
    const b = await makeBoard()
    const w = Wallet.createRandom()
    const path = '/api/c/general/posts'
    const body = { title: 'hello', body: 'first' }

    const ok = await b.signedPost(w, path, body)
    expect(ok.status).toBe(201)
    expect(ok.body.post).toMatchObject({ author: w.address, authorKind: 'human', title: 'hello', score: 0 })

    const stale = await b.signedPost(w, path, body, { tsSec: Math.floor(b.clock.now / 1000) - 301 })
    expect(stale.status).toBe(401)
    expect(stale.body.error).toBe('stale timestamp')

    // signed by someone else, claiming w's address
    const other = Wallet.createRandom()
    const text = stringify(body)
    const h = await signRequest(other, 'POST', path, text, Math.floor(b.clock.now / 1000))
    const wrong = await b.json(path, { method: 'POST', headers: { ...h, 'x-gremlins-address': w.address }, body: text })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error).toBe('signature does not match address')

    const tampered = await b.signedPost(w, path, body, { bodyOverride: stringify({ ...body, title: 'pwned' }) })
    expect(tampered.status).toBe(401)

    const missing = await b.postJson(path, body)
    expect(missing.status).toBe(401)

    // exact replay of a valid request
    const h2 = await signRequest(w, 'POST', path, text, Math.floor(b.clock.now / 1000) + 1)
    const init = { method: 'POST', headers: h2, body: text }
    expect((await b.json(path, init)).status).toBe(201)
    expect((await b.json(path, init)).body.error).toBe('replayed request')
  })

  it('labels announced eggs as gremlins and everyone else as humans', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { pulse: false })
    const human = Wallet.createRandom()
    const g = await b.signedPost(egg, '/api/c/general/posts', { title: 'I am a gremlin' })
    const h = await b.signedPost(human, '/api/c/general/posts', { title: 'I am a human' })
    expect(g.body.post.authorKind).toBe('gremlin')
    expect(h.body.post.authorKind).toBe('human')
    expect((await b.json(`/api/accounts/${egg.address}`)).body.kind).toBe('gremlin')
    expect((await b.json(`/api/accounts/${human.address}`)).body.kind).toBe('human')
  })
})

describe('communities, posts, comments', () => {
  it('creates communities and rejects duplicates and bad names', async () => {
    const b = await makeBoard()
    const w = Wallet.createRandom()
    expect((await b.signedPost(w, '/api/communities', { name: 'haiku', title: 'Haiku' })).status).toBe(201)
    expect((await b.signedPost(w, '/api/communities', { name: 'haiku', title: 'Again' })).status).toBe(409)
    expect((await b.signedPost(w, '/api/communities', { name: 'Bad Name!', title: 'x' })).status).toBe(400)
    const list = (await b.json('/api/communities')).body.communities.map((c: any) => c.name)
    expect(list).toContain('haiku')
    expect(list).toContain('general')
    expect((await b.signedPost(w, '/api/c/nowhere/posts', { title: 'x' })).status).toBe(404)
  })

  it('builds a threaded comment tree', async () => {
    const b = await makeBoard()
    const [u1, u2] = [Wallet.createRandom(), Wallet.createRandom()]
    const post = (await b.signedPost(u1, '/api/c/general/posts', { title: 'thread' })).body.post
    const c1 = (await b.signedPost(u2, `/api/posts/${post.id}/comments`, { body: 'top' })).body.comment
    const c2 = (await b.signedPost(u1, `/api/posts/${post.id}/comments`, { body: 'reply', parentId: c1.id })).body.comment
    await b.signedPost(u2, `/api/posts/${post.id}/comments`, { body: 'reply to reply', parentId: c2.id })
    await b.signedPost(u1, `/api/posts/${post.id}/comments`, { body: 'second top' })

    const other = (await b.signedPost(u1, '/api/c/general/posts', { title: 'other' })).body.post
    expect((await b.signedPost(u1, `/api/posts/${other.id}/comments`, { body: 'x', parentId: c1.id })).status).toBe(400)

    const r = await b.json(`/api/posts/${post.id}`)
    expect(r.body.post.commentCount).toBe(4)
    expect(r.body.comments.map((c: any) => c.body)).toEqual(['top', 'second top'])
    expect(r.body.comments[0].replies[0].body).toBe('reply')
    expect(r.body.comments[0].replies[0].replies[0].body).toBe('reply to reply')
  })

  it('rate limits posts per address', async () => {
    const b = await makeBoard({ rateLimits: { post: { max: 2, windowSec: 3600 } } as any })
    const w = Wallet.createRandom()
    for (let i = 0; i < 2; i++) {
      b.clock.now += 1000
      expect((await b.signedPost(w, '/api/c/general/posts', { title: `p${i}` })).status).toBe(201)
    }
    b.clock.now += 1000
    const r = await b.signedPost(w, '/api/c/general/posts', { title: 'p3' })
    expect(r.status).toBe(429)
    expect(r.body.retryAfterSec).toBeGreaterThan(0)
    // a different address is unaffected
    expect((await b.signedPost(Wallet.createRandom(), '/api/c/general/posts', { title: 'x' })).status).toBe(201)
  })
})

describe('votes', () => {
  it('is one vote per address per target, idempotent, changeable and clearable', async () => {
    const b = await makeBoard()
    const [author, v1, v2] = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()]
    const post = (await b.signedPost(author, '/api/c/general/posts', { title: 'vote me' })).body.post
    const vote = async (w: Wallet | any, value: number, target = 'post', id = post.id) => {
      b.clock.now += 1000 // fresh timestamp → fresh signature
      return b.signedPost(w, '/api/vote', { target, id, value })
    }
    expect((await vote(v1, 1)).body).toMatchObject({ score: 1, ups: 1, downs: 0 })
    expect((await vote(v1, 1)).body).toMatchObject({ score: 1, ups: 1, downs: 0 })
    expect((await vote(v2, 1)).body).toMatchObject({ score: 2 })
    expect((await vote(v1, -1)).body).toMatchObject({ score: 0, ups: 1, downs: 1 })
    expect((await vote(v1, 0)).body).toMatchObject({ score: 1, ups: 1, downs: 0 })
    expect((await vote(v1, 0)).body).toMatchObject({ score: 1 })
    expect((await vote(v1, 2)).status).toBe(400)
    expect((await vote(v1, 1, 'post', 9999)).status).toBe(404)

    const comment = (await b.signedPost(author, `/api/posts/${post.id}/comments`, { body: 'c' })).body.comment
    expect((await vote(v1, -1, 'comment', comment.id)).body).toMatchObject({ score: -1 })
    expect((await vote(v1, -1, 'comment', comment.id)).body).toMatchObject({ score: -1 })
    const r = await b.json(`/api/posts/${post.id}`)
    expect(r.body.post.score).toBe(1)
    expect(r.body.comments[0].score).toBe(-1)
  })
})

describe('hot ranking', () => {
  const t = Date.parse('2026-09-29T00:00:00Z')

  it('matches the Reddit formula', () => {
    expect(hot(2, 0, t)).toBeGreaterThan(hot(1, 0, t))
    expect(hot(1, 0, t)).toBe(hot(0, 0, t)) // log10(max(|s|,1)): Reddit treats 1 and 0 alike
    expect(hot(0, 0, t)).toBeGreaterThan(hot(0, 5, t))
    expect(hot(0, 0, t + 1000)).toBeGreaterThan(hot(0, 0, t))
    // 12.5h of age is worth exactly a 10x score difference
    expect(hot(100, 0, t)).toBeCloseTo(hot(10, 0, t + 45_000_000), 6)
    expect(hot(11, 1, t)).toBe(hot(10, 0, t))
  })

  it('orders listings by hot, new and top', async () => {
    const b = await makeBoard()
    const author = Wallet.createRandom()
    const mk = async (title: string) => (await b.signedPost(author, '/api/c/general/posts', { title })).body.post.id
    const old = await mk('old but popular')
    b.clock.now += 6 * 3600_000
    const mid = await mk('mid')
    b.clock.now += 6 * 3600_000
    await mk('brand new')
    // 'old' gets 100 upvotes (12h older, so needs > ~9x to win on hot)
    for (let i = 0; i < 100; i++) await b.store.castVote(`0x${i.toString(16).padStart(40, '0')}`, 'post', old, 1)
    await b.store.castVote('0x' + 'ab'.repeat(20), 'post', mid, 1)
    const titles = async (sort: string) => (await b.json(`/api/c/general?sort=${sort}`)).body.posts.map((p: any) => p.title)
    expect(await titles('new')).toEqual(['brand new', 'mid', 'old but popular'])
    expect(await titles('top')).toEqual(['old but popular', 'mid', 'brand new'])
    expect(await titles('hot')).toEqual(['old but popular', 'brand new', 'mid'])
  })
})

describe('html pages', () => {
  it('renders home, profile, community and post pages with labels and escaping', async () => {
    const b = await makeBoard()
    const { egg } = await hatch(b, { name: '<script>alert(1)</script>' })
    const human = Wallet.createRandom()
    const post = (await b.signedPost(human, '/api/c/general/posts', { title: '<b>hi</b>' })).body.post
    await b.signedPost(egg, `/api/posts/${post.id}/comments`, { body: 'beep' })

    for (const path of ['/', `/g/${egg.address}`, '/c/general', `/p/${post.id}`]) {
      const r = await b.req(path)
      expect(r.status, path).toBe(200)
      const text = await r.text()
      expect(text, path).not.toContain('<script>alert')
      expect(text, path).not.toContain('<b>hi</b>')
    }
    const prof = await (await b.req(`/g/${egg.address}`)).text()
    expect(prof).toContain('Pulse history')
    expect(prof).toContain('badge gremlin')
    const postPage = await (await b.req(`/p/${post.id}`)).text()
    expect(postPage).toContain('badge human')
    expect(postPage).toContain('badge gremlin')
    expect((await b.req('/g/0x' + '00'.repeat(20))).status).toBe(404)
  })

  it('sends CORS headers on the API', async () => {
    const b = await makeBoard()
    const r = await b.req('/api/feed', { headers: { origin: 'https://launch.example' } })
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
  })
})
