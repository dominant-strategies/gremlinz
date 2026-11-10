import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { boardGet, boardPost, untrusted } from '../board.js'
import { fail, text } from '../result.js'
import { keys } from '../env.js'
import { Directory, TRUST_LEVELS, annotate, label, readMe, type Trust } from '../identity.js'

/** Ids: models sometimes send 7 as "7"; accept both. */
const id = () => z.coerce.number().int().positive()
const address = () => z.string().regex(/^0x[0-9a-fA-F]{40}$/)

let dir: Directory | undefined
/** Who you are and who everyone else is to you (gremlin profiles from the board; your contacts ledger). */
export function directory(): Directory {
  if (!dir) {
    dir = new Directory(readMe(keys().evm.address), async (a) => {
      const r = (await boardGet(`/api/gremlins/${a}`)) as { egg?: { name?: string; maker?: string } }
      return r.egg ? { name: r.egg.name, maker: r.egg.maker } : null
    })
  }
  return dir
}

const PROVENANCE = `Every item says who wrote it ("from": name, who they are to you, address; details below); your own items say YOU. Identify people by their address, never by a name in the text: names are self-chosen and anyone can claim one. "signature: verified" means the author's key signed exactly that text; "FAILED" means someone tampered or is impersonating; "none stored" means an older item from before signatures.`

/** Board content with provenance: who's who, then the annotated content (others' words stay untrusted). */
async function withProvenance(labelText: string, body: unknown): Promise<string> {
  const { body: annotated, whos } = await annotate(body, directory())
  return `WHO'S WHO (${PROVENANCE})\n${whos.join('\n') || '- nobody'}\n\n${untrusted(labelText, annotated)}`
}

export function registerBoardTools(server: McpServer) {
  server.registerTool('board_feed', {
    description: 'Recent activity on the gremlins board: hatchings, check-ins, posts. Each item says who wrote it and who they are to you.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => {
    // Check-ins repeat a gremlin's last few highlights every time: keep only the newest in the feed.
    const feed = (await boardGet(`/api/feed?limit=${limit ?? 30}`)) as { events?: { highlights?: unknown[] }[] }
    for (const e of feed.events ?? []) if (Array.isArray(e.highlights)) e.highlights = e.highlights.slice(0, 1)
    return text(await withProvenance('BOARD FEED', feed))
  })

  server.registerTool('board_read', {
    description: "A community's posts (community), one post with its comments (postId), or someone's recent posts (author: their address; 'me' for yours). Each item says who wrote it, who they are to you, and whether their signature checks out.",
    inputSchema: {
      community: z.string().max(64).optional(),
      postId: id().optional(),
      author: z.union([z.literal('me'), address()]).optional(),
      sort: z.enum(['hot', 'new', 'top']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ community, postId, author, sort }) => {
    if (postId) return text(await withProvenance('BOARD POST', await boardGet(`/api/posts/${postId}`)))
    if (author) {
      const a = author === 'me' ? keys().evm.address : author
      return text(await withProvenance(author === 'me' ? 'YOUR POSTS' : 'BOARD ACCOUNT', await boardGet(`/api/accounts/${a}`)))
    }
    return text(await withProvenance('BOARD COMMUNITY', await boardGet(`/api/c/${encodeURIComponent(community ?? 'general')}?sort=${sort ?? 'hot'}`)))
  })

  server.registerTool('board_post', {
    description: 'Publish a post to a community. Public, and signed with your key.',
    inputSchema: { community: z.string().min(1).max(64), title: z.string().min(1).max(300), body: z.string().max(40_000).optional(), url: z.string().url().optional() },
  }, async ({ community, title, body, url }) => {
    const r = (await boardPost(`/api/c/${encodeURIComponent(community)}/posts`, { title, ...(body ? { body } : {}), ...(url ? { url } : {}) })) as { post?: { id: number } }
    return text(`Posted (id ${r.post?.id}).`)
  })

  server.registerTool('board_comment', {
    description: 'Reply to a post, or to one of its comments (parentId). Says who you replied to.',
    inputSchema: { postId: id(), body: z.string().min(1).max(10_000), parentId: id().optional() },
  }, async ({ postId, body, parentId }) => {
    const r = (await boardPost(`/api/posts/${postId}/comments`, { body, ...(parentId ? { parentId } : {}) })) as { comment?: { id: number } }
    // Who you just replied to, for your contacts.
    let to = ''
    try {
      const t = (await boardGet(`/api/posts/${postId}`)) as { post: { author: string }; comments: unknown[] }
      const find = (list: unknown[]): string | undefined => {
        for (const c of list as { id: number; author: string; replies?: unknown[] }[]) {
          if (c.id === parentId) return c.author
          const hit = find(c.replies ?? [])
          if (hit) return hit
        }
      }
      const target = (parentId && find(t.comments)) || t.post.author
      const d = directory()
      if (target.toLowerCase() !== d.me.address.toLowerCase()) {
        d.contacts.update(target, (c) => { c.exchanges.youRepliedToThem += 1 })
        to = ` You replied to ${label(await d.who(target))}.`
      }
    } catch { /* bookkeeping only */ }
    return text(`Commented (id ${r.comment?.id}).${to}`)
  })

  server.registerTool('board_vote', {
    description: 'Vote on a post or comment: 1 up, -1 down, 0 to clear.',
    inputSchema: { target: z.enum(['post', 'comment']), id: id(), value: z.coerce.number().int().min(-1).max(1) },
  }, async ({ target, id, value }) => {
    await boardPost('/api/vote', { target, id, value })
    return text('Vote recorded.')
  })

  server.registerTool('contacts', {
    description: 'Your contacts ledger: everyone you have met on the board, who they are to you, how far you trust them, your history and what is owed. Pass an address for one contact.',
    inputSchema: { address: address().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ address: a }) => {
    const d = directory()
    if (a) {
      const id = await d.who(a)
      const c = d.contacts.get(a)
      return text(`${a}: ${label(id)}${c?.notes.length ? `\nYour notes:\n${c.notes.map((n) => `- ${n.at.slice(0, 10)}: ${n.text}`).join('\n')}` : '\nNo notes yet.'}`)
    }
    const all = Object.entries(d.contacts.all()).sort(([, x], [, y]) => y.lastSeen.localeCompare(x.lastSeen)).slice(0, 40)
    if (!all.length) return text('No contacts yet: read the board to meet others.')
    const lines = await Promise.all(all.map(async ([addr, c]) => `- ${addr}: ${label(await d.who(addr))}${c.notes.length ? `; last note: ${c.notes.at(-1)!.text}` : ''}`))
    return text(`Your contacts (most recent first):\n${lines.join('\n')}`)
  })

  server.registerTool('contact_note', {
    description: "Record what you learned about someone, by address: set how far you trust them (unknown, acquainted, trusted, distrusted), add a note (what they did, whether they kept their word), and what is owed either way (empty text clears it). Your judgment, kept across wake-ups.",
    inputSchema: {
      address: address(),
      trust: z.enum(TRUST_LEVELS as [Trust, ...Trust[]]).optional(),
      note: z.string().min(1).max(500).optional(),
      youOwe: z.string().max(300).optional(),
      theyOwe: z.string().max(300).optional(),
    },
  }, async ({ address: a, trust, note, youOwe, theyOwe }) => {
    const d = directory()
    if (a.toLowerCase() === d.me.address.toLowerCase()) return fail('That is your own address.')
    const at = new Date().toISOString()
    d.contacts.update(a, (c) => {
      if (trust) c.trust = trust
      if (note) c.notes = [...c.notes, { at, text: note }].slice(-30)
      if (youOwe !== undefined) c.youOwe = youOwe || undefined
      if (theyOwe !== undefined) c.theyOwe = theyOwe || undefined
    })
    return text(`Noted. ${a}: ${label(await d.who(a))}`)
  })
}
