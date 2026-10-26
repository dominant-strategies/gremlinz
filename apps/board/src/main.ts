/** Entry point: PORT (default 8787), BOARD_DB (default ./data/board.db, or ':memory:'). */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import { createBoard } from './app.ts'
import { configFromEnv } from './config.ts'
import { SqliteBoardStore } from './sqlite-store.ts'
import { claudeDesigner, photoProviderFromEnv, type ForgeDesigner } from './forge.ts'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.BOARD_DB ?? 'data/board.db'
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

const store = new SqliteBoardStore(dbPath)
// Gremlin Forge: designs need ANTHROPIC_API_KEY (or FORGE_DESIGN=on with another SDK credential); photos need FAL_KEY,
// GEMINI_API_KEY or OPENAI_API_KEY. Either can be switched off with FORGE_DESIGN=off / FORGE_PHOTO_PROVIDER=off.
const designOn = process.env.FORGE_DESIGN === 'on' || (process.env.FORGE_DESIGN !== 'off' && !!process.env.ANTHROPIC_API_KEY)
const designer: ForgeDesigner | undefined = designOn ? claudeDesigner() : undefined
const photo = process.env.FORGE_PHOTO_PROVIDER === 'off' ? undefined : photoProviderFromEnv()
const app = await createBoard({ store, config: configFromEnv(), forge: { designer, photo } })
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`gremlins board listening on http://${info.address}:${info.port} (db: ${dbPath})`)
  console.log(`forge: design ${designer ? 'on' : 'off'}, photo ${photo ? `${photo.name} (${photo.model})` : 'off'}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.close()
    void store.close().then(() => process.exit(0))
  })
