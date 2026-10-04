import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { makeBoard } from './helpers.ts'

function fakeSite() {
  const dir = mkdtempSync(join(tmpdir(), 'site-'))
  mkdirSync(join(dir, 'hatch')); mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<h1>home page</h1>')
  writeFileSync(join(dir, 'hatch/index.html'), '<h1>hatch page</h1>')
  writeFileSync(join(dir, 'assets/board-client.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'nope')
  return dir
}

describe('combined site', () => {
  it('serves home, hatch and assets, and moves the feed to /board', async () => {
    const b = await makeBoard({ siteDir: fakeSite() })
    expect(await (await b.req('/')).text()).toContain('home page')
    expect((await b.req('/hatch')).status).toBe(301)
    expect(await (await b.req('/hatch/')).text()).toContain('hatch page')
    const js = await b.req('/assets/board-client.js')
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    const feed = await (await b.req('/board')).text()
    expect(feed).toContain('Leaderboard')
    expect(feed).toContain('href="/hatch/"')
  })

  it('never serves files outside the allowed paths', async () => {
    const b = await makeBoard({ siteDir: fakeSite() })
    for (const p of ['/assets/../secret.txt', '/assets/%2e%2e%2fsecret.txt', '/secret.txt', '/assets/nope.js']) {
      const r = await b.req(p)
      expect(r.status, p).not.toBe(200)
    }
  })

  it('keeps the feed at / when no site is configured', async () => {
    const b = await makeBoard()
    expect(await (await b.req('/')).text()).toContain('Leaderboard')
  })

  it('renders sign-in slot, write forms and vote buttons for the board client', async () => {
    const b = await makeBoard()
    const human = Wallet.createRandom()
    const post = (await b.signedPost(human, '/api/c/general/posts', { title: 'hello' })).body.post
    await b.signedPost(human, `/api/posts/${post.id}/comments`, { body: 'first' })
    const community = await (await b.req('/c/general')).text()
    expect(community).toContain('id="gremlins-auth"')
    expect(community).toContain('data-path="/api/c/general/posts"')
    expect(community).toContain('src="/assets/board-client.js"')
    const postPage = await (await b.req(`/p/${post.id}`)).text()
    expect(postPage).toContain(`data-path="/api/posts/${post.id}/comments"`)
    expect(postPage).toMatch(/data-vote="1" data-target="post"/)
    expect(postPage).toMatch(/data-vote="-1" data-target="comment"/)
    expect(postPage).toMatch(/data-reply="\d+"/)
  })
})
