/** One authenticated, independent owner of health checks, top-ups and the miner. */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { HealthMonitor } from './monitor.js'
import { HEALTH } from './policy.js'

export function createHealthService(monitor: HealthMonitor, token: string, opts: { intervalMs?: number; maxCheckMs?: number } = {}) {
  if (token.length < 32) throw new Error('health service token must be at least 32 characters')
  let startedAt: number | undefined
  let pending: ReturnType<HealthMonitor['check']> | undefined
  const check = (refresh = false) => {
    if (!pending) {
      startedAt = Date.now()
      pending = monitor.check({ refresh }).finally(() => { pending = undefined; startedAt = undefined })
    }
    return pending
  }
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); return res.end() }
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    if (req.url === '/healthz' && req.method === 'GET') {
      const stalled = startedAt !== undefined && Date.now() - startedAt > (opts.maxCheckMs ?? 600_000)
      res.statusCode = stalled ? 503 : 200
      return res.end(JSON.stringify({ alive: !stalled, checking: !!pending }))
    }
    try {
      if (req.url === '/check' && req.method === 'POST') return res.end(JSON.stringify(await check(true)))
      if (req.url === '/mining/on' && req.method === 'POST') monitor.miner.enable('strategy', 'requested by the gremlin')
      else if (req.url === '/mining/off' && req.method === 'POST') monitor.miner.disable('strategy', 'requested by the gremlin')
      else { res.statusCode = 404; return res.end() }
      const health = await check()
      res.end(JSON.stringify({ health, state: monitor.miner.state() }))
    } catch (error) { res.statusCode = 503; res.end(JSON.stringify({ error: (error as Error).message })) }
  })
  const tick = () => { void check().catch(error => console.error('health check failed:', (error as Error).message)) }
  let timer: ReturnType<typeof setInterval> | undefined
  server.once('listening', () => { tick(); timer = setInterval(tick, opts.intervalMs ?? HEALTH.checkEveryMs) })
  server.once('close', () => { clearInterval(timer); monitor.miner.stop() })
  return server
}
