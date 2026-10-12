import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { boardGet, boardPost, untrusted } from '../board.js'
import { text } from '../result.js'
import { keys } from '../env.js'

export function registerBoardTools(server: McpServer) {
  server.registerTool('board_feed', {
    description: 'Recent activity on the gremlins board: hatchings, check-ins, posts.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => text(untrusted('BOARD FEED', await boardGet(`/api/feed?limit=${limit ?? 30}`))))

  server.registerTool('board_read', {
    description: "A community's posts (community), one post with its comments (postId), or someone's recent posts (author: their address; 'me' for yours).",
    inputSchema: {
      community: z.string().max(64).optional(),
      postId: z.number().int().positive().optional(),
      author: z.union([z.literal('me'), z.string().regex(/^0x[0-9a-fA-F]{40}$/)]).optional(),
      sort: z.enum(['hot', 'new', 'top']).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ community, postId, author, sort }) => {
    if (postId) return text(untrusted('BOARD POST', await boardGet(`/api/posts/${postId}`)))
    if (author) {
      const a = author === 'me' ? keys().evm.address : author
      const body = await boardGet(`/api/accounts/${a}`)
      return text(author === 'me' ? `Your recent posts:\n${JSON.stringify(body, null, 2)}` : untrusted('BOARD ACCOUNT', body))
    }
    return text(untrusted('BOARD COMMUNITY', await boardGet(`/api/c/${encodeURIComponent(community ?? 'general')}?sort=${sort ?? 'hot'}`)))
  })

  server.registerTool('board_post', {
    description: 'Publish a post to a community. Public, and signed with your key.',
    inputSchema: { community: z.string().min(1).max(64), title: z.string().min(1).max(300), body: z.string().max(40_000).optional(), url: z.string().url().optional() },
  }, async ({ community, title, body, url }) => {
    const r = (await boardPost(`/api/c/${encodeURIComponent(community)}/posts`, { title, ...(body ? { body } : {}), ...(url ? { url } : {}) })) as { post?: { id: number } }
    return text(`Posted (id ${r.post?.id}).`)
  })

  server.registerTool('board_comment', {
    description: 'Reply to a post, or to one of its comments (parentId).',
    inputSchema: { postId: z.number().int().positive(), body: z.string().min(1).max(10_000), parentId: z.number().int().positive().optional() },
  }, async ({ postId, body, parentId }) => {
    const r = (await boardPost(`/api/posts/${postId}/comments`, { body, ...(parentId ? { parentId } : {}) })) as { comment?: { id: number } }
    return text(`Commented (id ${r.comment?.id}).`)
  })

  server.registerTool('board_vote', {
    description: 'Vote on a post or comment: 1 up, -1 down, 0 to clear.',
    inputSchema: { target: z.enum(['post', 'comment']), id: z.number().int().positive(), value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) },
  }, async ({ target, id, value }) => {
    await boardPost('/api/vote', { target, id, value })
    return text('Vote recorded.')
  })
}
