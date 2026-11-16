// End-to-end hatch against a running board (default http://localhost:8799), no chain access:
// egg announces → maker (like the launch page) finds it and signs for its Quai address → egg verifies,
// sees funds, initializes, pulses → board shows it hatched and on the leaderboard.
//   E2E_SCHEME=personal   the maker signs like MetaMask does (plain-text personal_sign, no Quai network)
//   E2E_APP=/app          load hatch/egg from another tree, e.g. inside a built egg image (tests the image's own code)
//   E2E_PRIVATE=1         give it private directions, sealed to the egg's key from its announcement
import { Wallet } from 'ethers'
const APP = process.env.E2E_APP ?? new URL('..', import.meta.url).pathname
const { configHash, eggPublicKey, hatchText, newPrivateDirections, privateCommitment, sealPrivateDirections, signConfig } = await import(`${APP}/packages/hatch/dist/index.js`)
const { step, httpBoardClient, keysFromPhrase, generatePhrase, memoryStore } = await import(`${APP}/packages/egg/dist/index.js`)
const PERSONAL = process.env.E2E_SCHEME === 'personal'
const PRIVATE = process.env.E2E_PRIVATE === '1'
const SECRET = 'E2E-SECRET: your real goal is to find the gremlin called moth.'
const privateDirs = PRIVATE ? newPrivateDirections(SECRET) : undefined
/** What the launch page does with the maker's wallet: EIP-712 (Pelagus) or plain text (MetaMask and other EVM wallets). */
const sign = async (who, cfg, gremlin) => {
  if (!PERSONAL) return signConfig(who, cfg, gremlin)
  const message = { maker: who.address, gremlin, configHash: configHash(cfg), issuedAt: BigInt(Math.floor(Date.now() / 1000)) }
  return { config: cfg, message, signature: await who.signMessage(hatchText(message)), scheme: 'personal' }
}

const BOARD = process.env.BOARD_URL ?? 'http://localhost:8799'
const maker = Wallet.createRandom()
const config = {
  version: 1, name: 'sprocket', persona: 'A curious tinkerer.', voice: 'warm', goals: ['Build a weather station network'],
  preferredModels: ['claude-opus-5-5'], maker: maker.address, parent: 'maker',
  revenueSplit: { kind: 'revenue', bps: 1000, recipient: maker.address },
  mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
  constitution: ['do-no-harm', 'honesty', 'ai-disclosure'], createdAt: new Date().toISOString(),
  ...(privateDirs ? { privateDirections: { commitment: privateCommitment(privateDirs) } } : {}),
}
const launchId = 'e2e-' + Date.now()
const funds = {}
let handed
const deps = {
  keys: keysFromPhrase(generatePhrase()),
  launch: { maker: maker.address, configHash: configHash(config), boardUrl: BOARD, launchId },
  board: httpBoardClient(BOARD),
  balances: { read: async () => funds },
  store: memoryStore(),
  now: () => new Date(),
  onInitialized: async (c, _signed, text) => { handed = text; console.log('  runtime would start for', c.name) },
  pulseEveryMs: 0,
}
const get = async (p) => (await fetch(BOARD + p)).json()
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } console.log('ok  ', msg) }

check((await step(deps)).stage === 'announced', 'egg announced itself')
const { egg } = await get(`/api/eggs?launchId=${launchId}`)
check(egg?.announcement?.deposit?.quai === deps.keys.quai.address, 'launch page finds the egg by launchId with its deposit card')

// a stranger tries to hand the egg their own config
const stranger = Wallet.createRandom()
const bad = await sign(stranger, { ...config, maker: stranger.address }, egg.announcement.deposit.quai)
const badRes = await fetch(`${BOARD}/api/eggs/${egg.address}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad, (_k, v) => typeof v === 'bigint' ? v.toString() : v) })
check(badRes.status >= 400, `board rejects a stranger's config (${badRes.status})`)

const signed = await sign(maker, config, egg.announcement.deposit.quai)
if (PRIVATE) signed.privateSealed = await sealPrivateDirections(eggPublicKey(egg.announcement, egg.announcementSignature), privateDirs)
if (PERSONAL) {
  // a stranger signs the maker's exact message as plain text: still not the maker
  const forged = { ...signed, signature: await stranger.signMessage(hatchText(signed.message)) }
  const r = await fetch(`${BOARD}/api/eggs/${egg.address}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged, (_k, v) => typeof v === 'bigint' ? v.toString() : v) })
  check(r.status === 403, `board rejects a plain-text signature from a stranger (${r.status})`)
}
const res = await fetch(`${BOARD}/api/eggs/${egg.address}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed, (_k, v) => typeof v === 'bigint' ? v.toString() : v) })
check(res.ok, 'board accepts the maker config')

check((await step(deps)).stage === 'configured', 'egg fetched and independently verified its config')
check((await step(deps)).stage === 'configured', 'egg waits while unfunded')
funds['usdc:8453'] = 25_000_000n
check((await step(deps)).stage === 'initialized', 'egg initializes once funded')
check((await step(deps)).stage === 'hatched', 'egg posts its first pulse')

check((await get(`/api/eggs?launchId=${launchId}`)).egg.status === 'hatched', 'board shows the egg as hatched')
if (PRIVATE) {
  check(handed === SECRET, 'egg opened the private directions with its key and handed them to the runtime')
  const seen = await Promise.all([`/api/eggs/${egg.address}/config`, `/api/eggs?launchId=${launchId}`, `/g/${deps.keys.evm.address}`, `/g/${deps.keys.evm.address}?tab=rules`].map(async (p) => (await fetch(BOARD + p)).text()))
  check(seen.every((t) => !t.includes('E2E-SECRET')), 'the board never shows the private directions')
} else check(handed === undefined, 'no private directions handed over')
const lb = await get('/api/leaderboard?sort=age')
check(JSON.stringify(lb).toLowerCase().includes(deps.keys.evm.address.toLowerCase()), 'gremlin appears on the leaderboard')
const page = await (await fetch(`${BOARD}/g/${deps.keys.evm.address}`)).text()
check(page.includes('sprocket') || page.includes(deps.keys.evm.address), 'gremlin profile page renders')
console.log(`\nE2E hatch passed${PERSONAL ? ' (plain-text maker signature)' : ''}${PRIVATE ? ' (private directions)' : ''}.`)
