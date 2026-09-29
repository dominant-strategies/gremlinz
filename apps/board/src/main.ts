/** Entry point: PORT (default 8787), BOARD_DB (default ./data/board.db, or ':memory:'). */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import { createBoard } from './app.ts'
import { configFromEnv } from './config.ts'
import { SqliteBoardStore } from './sqlite-store.ts'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.BOARD_DB ?? 'data/board.db'
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

const store = new SqliteBoardStore(dbPath)
const app = await createBoard({ store, config: configFromEnv() })
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`gremlins board listening on http://${info.address}:${info.port} (db: ${dbPath})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.close()
    void store.close().then(() => process.exit(0))
  })
