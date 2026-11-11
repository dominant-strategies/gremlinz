/** Entry point: PORT (default 8787), BOARD_DB (default ./data/board.db, or ':memory:'). */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { constants as zlibConstants } from 'node:zlib'
import { serve } from '@hono/node-server'
import { createBoard } from './app.ts'
import { configFromEnv } from './config.ts'
import { SqliteBoardStore } from './sqlite-store.ts'
import { claudeDesigner, photoProviderFromEnv, type ForgeDesigner } from './forge.ts'
import { hatchWorker } from './hatch.ts'
import { hatchFromEnv, liveHatchDeps } from './hatch-live.ts'

// CVE-2026-111497 (Node2Shell): Node's Brotli decoder could be made to write out of bounds by untrusted input. The fix
// (22.23.4, 24.22.1, 26.12.1) is a cherry-pick that also added this constant, so its absence means an unpatched Node.
if ((zlibConstants as Record<string, number | undefined>).BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH === undefined)
  console.warn(`WARNING: Node ${process.version} is missing the CVE-2026-111497 fix. Upgrade to 22.23.4+, 24.22.1+ or 26.12.1+ (see .nvmrc).`)

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.BOARD_DB ?? 'data/board.db'
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })

const store = new SqliteBoardStore(dbPath)
// Gremlin Forge: designs need ANTHROPIC_API_KEY (or FORGE_DESIGN=on with another SDK credential); photos need FAL_KEY,
// GEMINI_API_KEY or OPENAI_API_KEY. Either can be switched off with FORGE_DESIGN=off / FORGE_PHOTO_PROVIDER=off.
const designOn = process.env.FORGE_DESIGN === 'on' || (process.env.FORGE_DESIGN !== 'off' && !!process.env.ANTHROPIC_API_KEY)
const designer: ForgeDesigner | undefined = designOn ? claudeDesigner() : undefined
const photo = process.env.FORGE_PHOTO_PROVIDER === 'off' ? undefined : photoProviderFromEnv()
// Hatch custody for Fluence eggs (see hatch.ts, hatch-live.ts for the env it needs); off unless configured.
const hatch = hatchFromEnv(process.env, dbPath)
const app = await createBoard({ store, config: configFromEnv(), forge: { designer, photo }, hatch })
// The worker's 2-of-2 signers and the routes the makers' pages talk to share one coordinator.
const worker = hatch && hatchWorker({ store: hatch.store, cfg: hatch.cfg, deps: liveHatchDeps(process.env, store, hatch.mpc) })
worker?.start()
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`gremlins board listening on http://${info.address}:${info.port} (db: ${dbPath})`)
  console.log(`forge: design ${designer ? 'on' : 'off'}, photo ${photo ? `${photo.name} (${photo.model})` : 'off'}`)
  console.log(`hatch on Fluence: ${hatch ? `on (${hatch.cfg.custody} custody, ${hatch.cfg.image}, eggs talk to ${hatch.cfg.publicUrl})` : 'off'}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    worker?.stop()
    server.close()
    hatch?.store.close()
    void store.close().then(() => process.exit(0))
  })
