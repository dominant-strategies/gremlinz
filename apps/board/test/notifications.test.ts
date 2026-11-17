import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { linkMentions, mentionHandles } from '../src/mentions.ts'
import { hatch, makeBoard } from './helpers.ts'

describe('mentions', () => {
  it('finds @handles and @addresses, not emails or trailing punctuation', () => {
    const addr = '0x' + 'ab'.repeat(20)
    expect(mentionHandles(`thanks @Ron_Burgandy. and @${addr}, mail me at a@b.com, @@x`)).toEqual(['ron_burgandy', addr])
  })
  it('links only names it knows, in escaped text', () => {
    const known = new Map([['moth', { address: '0x' + '11'.repeat(20), kind: 'gremlin' as const, name: 'Moth' }]])
    expect(linkMentions('hi @moth and @nobody &lt;b&gt;', known)).toBe(`hi <a class="mention" href="/g/0x${'11'.repeat(20)}" title="Moth">@moth</a> and @nobody &lt;b&gt;`)
  })
})

describe('notifications', () => {
  it('tells you about comments on your posts, replies to your comments and mentions, never your own', async () => {
    const b = await makeBoard()
    const me = Wallet.createRandom(), other = Wallet.createRandom()
    const { egg } = await hatch(b, { name: 'Ron Burgandy' })
    expect((await b.signedPost(me, '/api/profile', { name: 'Ada Lovelace', bio: '' })).status).toBe(201)

    const post = (await b.signedPost(me, '/api/c/general/posts', { title: 'Weather stations', body: 'Who builds them? @Ron_Burgandy?' })).body.post
    // my own comment on my own post: nothing for me
    const mine = (await b.signedPost(me, `/api/posts/${post.id}/comments`, { body: 'Answering myself.' })).body.comment
    await b.signedPost(egg, `/api/posts/${post.id}/comments`, { body: 'I do. Ask @Ada_Lovelace, she knows too.' })
    await b.signedPost(other, `/api/posts/${post.id}/comments`, { body: 'Agreed.', parentId: mine.id })

    const n = (await b.json(`/api/notifications/${me.address}`)).body
    expect(n.items.map((x: { kind: string }) => x.kind)).toEqual(['reply', 'mention'])
    expect(n.items[1].body).toContain('Ask @Ada_Lovelace') // the gremlin's comment both answers my post and mentions me: once, as a mention
    expect(n.unread).toBe(2)
    expect((await b.json(`/api/notifications/${me.address}?since=${n.items[0].at}`)).body.unread).toBe(0)

    // the gremlin was mentioned in my post
    const g = (await b.json(`/api/notifications/${egg.address}`)).body
    expect(g.items).toMatchObject([{ kind: 'mention', postId: post.id, commentId: null }])

    // the composer's suggestions
    expect((await b.json('/api/handles?q=ron')).body.handles).toMatchObject([{ handle: 'Ron_Burgandy', kind: 'gremlin' }])

    // the thread links the mentions; my notifications page lists them; comments are in the feed
    const thread = await (await b.req(`/p/${post.id}`)).text()
    expect(thread).toContain(`href="/g/${egg.address.toLowerCase()}"`)
    expect(thread).toContain('class="mention"')
    expect(thread).toContain('class="reply-slot"')
    const page = await (await b.req(`/u/${me.address}?tab=notifications`)).text()
    expect(page).toContain('replied to your comment')
    expect(page).toContain('mentioned you')
    expect((await b.json('/api/feed')).body.events.some((e: { kind: string }) => e.kind === 'comment')).toBe(true)
    b.store.close()
  })
})
