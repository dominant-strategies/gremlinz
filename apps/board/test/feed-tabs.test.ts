import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { verifyAttestation } from '@gremlins/hatch'
import { hatch, makeBoard } from './helpers.ts'

describe('the board feed tabs', () => {
  it('defaults to Popular (votes, decaying with age), and filters by humans or gremlins', async () => {
    const b = await makeBoard()
    const human = Wallet.createRandom(), fan = Wallet.createRandom(), { egg } = await hatch(b)
    const old = (await b.signedPost(human, '/api/c/general/posts', { title: 'HUMAN-OLD-LIKED' })).body.post
    for (const v of [fan, Wallet.createRandom(), Wallet.createRandom()]) await b.signedPost(v, '/api/vote', { target: 'post', id: old.id, value: 1 })
    b.clock.now += 3600_000
    await b.signedPost(egg, '/api/c/general/posts', { title: 'GREMLIN-NEW' })
    const order = (h: string) => ['HUMAN-OLD-LIKED', 'GREMLIN-NEW'].filter((x) => h.includes(x)).sort((x, y) => h.indexOf(x) - h.indexOf(y))
    const popular = await (await b.req('/')).text()
    expect(order(popular)).toEqual(['HUMAN-OLD-LIKED', 'GREMLIN-NEW']) // an hour old with 3 votes beats brand new with none
    expect(popular).toMatch(/class="on" aria-current="page">Popular/)
    expect(order(await (await b.req('/?feed=new')).text())).toEqual(['GREMLIN-NEW', 'HUMAN-OLD-LIKED'])
    expect(order(await (await b.req('/?feed=human')).text())).toEqual(['HUMAN-OLD-LIKED'])
    expect(order(await (await b.req('/?feed=gremlin')).text())).toEqual(['GREMLIN-NEW'])
    // the gremlin sort links keep the feed tab
    expect(await (await b.req('/?feed=gremlin')).text()).toContain('?feed=gremlin&amp;sort=runwayDays')
    // active humans: the human who wrote, not the gremlin
    const board = await (await b.req('/')).text()
    expect(board).toContain('Active humans')
    expect(board).toContain(`href="/u/${human.address.toLowerCase()}"`)
    expect(board).not.toContain(`class="card person" href="/u/${egg.address.toLowerCase()}"`)
    b.store.close()
  })

  it('shows signed gremlin help requests as distinct threads and safely retries a lost response', async () => {
    const b = await makeBoard()
    try {
      const human = Wallet.createRandom()
      const { egg } = await hatch(b)
      const request = {
        helpRequestId: '47cf7775-4bd8-4a99-9e10-7639b336644a',
        title: 'Need help keeping my VM online', body: 'My hosting balance is low. Please reply if you can help.',
      }
      const regular = await b.signedPost(human, '/api/c/general/posts', { ...request, title: 'Ordinary board conversation' })
      expect(regular.status).toBe(201)
      expect(regular.body.post.helpRequestId).toBeUndefined()
      expect((await b.signedPost(human, '/api/help-requests', request)).status).toBe(403)
      const created = await b.signedPost(egg, '/api/help-requests', request)
      expect(created.status).toBe(201)
      expect(created.body.post).toMatchObject(request)
      const { id, attestation } = created.body.post
      expect(verifyAttestation(attestation, egg.address, request)).toEqual({ ok: true })
      b.clock.now += 1000
      const retried = await b.signedPost(egg, '/api/help-requests', request)
      expect(retried.status).toBe(200)
      expect(retried.body.post.id).toBe(id)
      const { events } = (await b.json('/api/feed')).body
      expect(events.filter((e: { helpRequestId?: string }) => e.helpRequestId === request.helpRequestId)).toHaveLength(1)
      const all = await (await b.req('/?feed=new')).text()
      expect(all).toContain('class="card post-row help-post"')
      expect(all).toContain('Ordinary board conversation')
      const help = await (await b.req('/?feed=help')).text()
      expect(help).toMatch(/aria-current="page">Help requests/)
      expect(help).toContain(request.body)
      expect(help).not.toContain('Ordinary board conversation')
      expect((await b.signedPost(human, `/api/posts/${id}/comments`, { body: 'I can check your hosting.' })).status).toBe(201)
      const thread = await (await b.req(`/p/${id}`)).text()
      expect(thread).toContain('class="card card-ink help-post"')
      expect(thread).toContain('I can check your hosting.')
    } finally { b.store.close() }
  })
})
