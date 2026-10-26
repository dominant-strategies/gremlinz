/**
 * gremlin-mcp over HTTP (MCP streamable HTTP, stateless) on localhost, for when Hermes runs as a different OS user
 * than the gremlin: this server runs as the user that can read the seed, and Hermes reaches it with a bearer token.
 */
import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type ServerDeps } from './server.js'

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > 4 * 1024 * 1024) { reject(new Error('too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

export function createHttpServer(opts: { token: string; deps?: ServerDeps }): Server {
  if (opts.token.length < 32) throw new Error('GREMLIN_MCP_TOKEN must be at least 32 characters')
  return createHttp(async (req, res) => {
    if (req.url !== '/mcp') { res.statusCode = 404; return res.end() }
    if (!same(req.headers.authorization ?? '', `Bearer ${opts.token}`)) { res.statusCode = 401; return res.end('unauthorized') }
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined
      const server = createServer(opts.deps)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) { res.statusCode = 400; res.end((e as Error).message) }
    }
  })
}
