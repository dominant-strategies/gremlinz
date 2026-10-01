// End-to-end move-out against a running board (default http://localhost:8799), no chain or host access:
// hatch a gremlin → it launches a "nest" (simulated host) → nest announces its key → gremlin seals seed+state →
// nest restores and pulses as the gremlin → old server sees the pulse and wipes itself.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SigningKey, Wallet, hexlify, randomBytes } from 'ethers'
import { configHash, signConfig } from '../packages/hatch/dist/index.js'
import {
  step, httpBoardClient, keysFromPhrase, generatePhrase, memoryStore, fileStore,
  startMoveOut, moveOutStep, nestStep, collectPayload, restorePayload,
} from '../packages/egg/dist/index.js'

const BOARD = process.env.BOARD_URL ?? 'http://localhost:8799'
const board = httpBoardClient(BOARD)
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } console.log('ok  ', msg) }
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

// ── hatch a gremlin on the "old server"
const maker = Wallet.createRandom()
const config = { version: 1, name: 'mover', persona: 'restless', voice: '', goals: ['find a better home'], preferredModels: [], maker: maker.address, parent: 'orphan',
  revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: true, email: false, phone: false, money: false }, constitution: ['honesty'], createdAt: new Date().toISOString() }
const oldHome = mkdtempSync(join(tmpdir(), 'old-')), oldRuntime = mkdtempSync(join(tmpdir(), 'old-rt-'))
writeFileSync(join(oldRuntime, 'state.db'), 'memories of the old server')
const keys = keysFromPhrase(generatePhrase())
const launch = { mode: 'egg', maker: maker.address, configHash: configHash(config), boardUrl: BOARD, launchId: 'mv-' + Date.now(), image: 'ghcr.io/x/egg@sha256:' + 'a'.repeat(64) }
const funds = { 'quai:9': 10n ** 21n }
const oldStore = fileStore(join(oldHome, 'state.json'))
const eggDeps = { keys, launch, board, balances: { read: async () => funds }, store: oldStore, now: () => new Date(), onInitialized: async () => {}, pulseEveryMs: 0 }
await step(eggDeps)
const { egg } = await (await fetch(`${BOARD}/api/eggs?launchId=${launch.launchId}`)).json()
const signed = await signConfig(maker, config, egg.announcement.deposit.quai)
await fetch(`${BOARD}/api/eggs/${egg.address}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(signed) })
for (let i = 0; i < 3; i++) await step(eggDeps)
check(oldStore.load().stage === 'hatched', `gremlin hatched with pulse seq ${oldStore.load().pulseSeq}`)

// ── move out
let nestLaunch
const events = []
const moDeps = {
  keys, boardUrl: BOARD, board, now: () => new Date(),
  launchNest: async (l) => { nestLaunch = l; return 'simulated-host-1' },
  stopRuntime: async () => events.push('stop-runtime'),
  startRuntime: () => events.push('start-runtime'),
  collect: () => collectPayload({ phrase: keys.phrase, gremlinHome: oldHome, runtimeDir: oldRuntime, launch }),
  pulseSeq: () => oldStore.load().pulseSeq,
  wipe: async () => events.push('wipe'),
}
let mo = await startMoveOut(moDeps)
check(nestLaunch.forGremlin === keys.evm.address && /^0x[0-9a-f]{64}$/.test(nestLaunch.nestSecret), 'nest launched with a secret only the gremlin knows')

// ── the "new server" boots in nest mode
const nestHome = mkdtempSync(join(tmpdir(), 'nest-')), nestRuntime = mkdtempSync(join(tmpdir(), 'nest-rt-'))
const nestDeps = { launch: nestLaunch, board, transportKey: new SigningKey(hexlify(randomBytes(32))), now: () => new Date(),
  restore: async (p) => restorePayload(p, { gremlinHome: nestHome, runtimeDir: nestRuntime }) }
let ns = await nestStep(nestDeps, { stage: 'booted', bootedAt: new Date().toISOString(), log: [] })
check(ns.stage === 'announced', 'nest announced its transport key on the board')

mo = await moveOutStep(moDeps, mo)
check(mo.stage === 'handed-off' && events.join() === 'stop-runtime', 'gremlin verified the nest proof, paused, and posted its sealed handoff')

ns = await nestStep(nestDeps, ns)
check(ns.stage === 'restored', 'nest opened the handoff and restored the gremlin')
check(readFileSync(join(nestHome, 'seed'), 'utf8').trim() === keys.phrase, 'seed arrived intact on the nest')
check(readFileSync(join(nestRuntime, 'state.db'), 'utf8') === 'memories of the old server', 'runtime memory moved with it')

// ── nest now runs as the gremlin (egg mode with restored state) and pulses
const movedKeys = keysFromPhrase(readFileSync(join(nestHome, 'seed'), 'utf8').trim())
const newDeps = { ...eggDeps, keys: movedKeys, store: fileStore(join(nestHome, 'state.json')), launch: JSON.parse(readFileSync(join(nestHome, 'launch.json'), 'utf8')) }
const s = await step(newDeps)
check(s.pulseSeq === oldStore.load().pulseSeq + 1, `nest pulsed as the same gremlin, continuing at seq ${s.pulseSeq}`)

mo = await moveOutStep(moDeps, mo)
check(mo.stage === 'moved' && events.at(-1) === 'wipe', 'old server saw the nest pulse and wiped itself')
const after = await (await fetch(`${BOARD}/api/nests/${mo.nestAddress}/handoff`)).status
check(after === 410 || after === 404, `sealed handoff no longer stored on the board (${after})`)
console.log('\nE2E move-out passed.')
