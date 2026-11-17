import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
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
    b.store.close()
  })
})
