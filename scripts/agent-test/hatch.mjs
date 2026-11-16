#!/usr/bin/env node
// Hatch a named test gremlin on production through the real hatch page, with the wallet harness's MetaMask profile.
//
//   node scripts/agent-test/hatch.mjs <name>                  dry run: builds the gremlin and stops at the first payment
//   node scripts/agent-test/hatch.mjs <name> --spend          pays, waits for the egg, signs its config, feeds it QUAI
//
// Options:
//   --spend              allow the two payments (each is printed first: amount, recipient, chain):
//                          1. USDC on Base from the test account to the egg's 2-of-2 hosting address (the job's minUsd)
//                          2. --quai QUAI on Quai from the test account to the gremlin's own Quai wallet
//   --quai N             QUAI to feed the gremlin (default 100)
//   --quai-via pelagus|key  send it with the Pelagus profile (default), or straight from privkey.key with quais
//   --max-usd N          refuse an egg payment above this (default 15)
//   --persona FILE       JSON { name, goals[], persona, voice?, constitution?[] } (default: a test-pilot persona)
//   --base URL           site + board (default https://gremlinz.ai)
//   --timeout 3h         give up waiting after this long (state is kept; run again to resume)
//   --new                drop an unpaid, unfinished hatch session left in the wallet profile and start over
//   HEADED=1             show the browser
//
// Resumable: the page keeps its session in the MetaMask profile's localStorage, and this script keeps
// ~/.cache/gremlinz-agent-test/<name>.json (launchId, jobId, hosting address, gremlin addresses, tx hashes) for
// watch.mjs. Run it again with the same name to pick up where it stopped. The page must stay open from the payment
// until the egg holds its hosting account: it co-signs the hatch (2-of-2) and hands its key share to the egg.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Contract, JsonRpcProvider, formatEther, formatUnits } from 'ethers'
import { launchWallet } from '../wallet-harness/launch.mjs'
import { waitForApproval } from '../wallet-harness/approve.mjs'
import { walletPassword } from '../wallet-harness/secrets.mjs'
import { clickAny, dump, sleep, unlockIfLocked } from '../wallet-harness/ui.mjs'
import { DEFAULT_BOARD, NAME_RE, boardReader, loadState, parseArgs, parseDuration, runDir, saveState, statePath } from './common.mjs'
import { FREE_SCREENS, TEST_ACCOUNT, checkPersona, classifyScreen, defaultPersona, eggPayment, fromSession, quaiPayment, resumeDecision } from './hatch-plan.mjs'

const args = parseArgs(process.argv.slice(2))
const name = args._[0]
if (!name || !NAME_RE.test(name)) {
  console.error('usage: hatch.mjs <name> [--spend] [--quai 100] [--quai-via pelagus|key] [--max-usd 15] [--persona FILE] [--base URL] [--timeout 3h] [--new]')
  process.exit(2)
}
let state = loadState(name) ?? {}
const BASE = String(args.base ?? state.board ?? DEFAULT_BOARD).replace(/\/$/, '')
const SPEND = args.spend === true
const QUAI = args.quai ?? state.quaiAmount ?? 100
const MAX_USD = Number(args['max-usd'] ?? 15)
const DEADLINE = Date.now() + parseDuration(args.timeout ?? '3h')
const persona = checkPersona(args.persona ? JSON.parse(readFileSync(args.persona, 'utf8')) : state.persona ?? defaultPersona(name))
const board = boardReader(BASE)
mkdirSync(runDir(name), { recursive: true, mode: 0o700 })
const LOG = join(runDir(name), 'hatch.log')

function log(...a) {
  const line = `${new Date().toISOString()}  ${a.join(' ')}`
  console.log(line)
  appendFileSync(LOG, line + '\n')
}
const remember = (patch) => { state = saveState(name, patch); return state }
class Stop extends Error {}

// ── the page ─────────────────────────────────────────────────────────────────

/** Everything classifyScreen needs, read from the page in one go. */
const probe = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const app = q('#app')
  return {
    eyebrow: app?.querySelector('.eyebrow')?.textContent ?? '',
    h2: app?.querySelector('h2')?.textContent ?? '',
    text: (app?.textContent ?? '').slice(0, 400),
    error: app?.querySelector(':scope > .error p')?.textContent ?? '',
    formError: app?.querySelector('.form-error')?.textContent ?? '',
    mstate: !!q('#mstate') && !!q('form#f[hidden]'),
    has: {
      notConfigured: /not configured yet/.test(app?.textContent ?? ''),
      go: !!q('#go'), nameField: !!q('input[name=name]'), forge: !!q('#forge'), personaField: !!q('textarea[name=persona]'),
      primaryModel: !!q('form#f:not([hidden]) select[name=primary]'), parentRadio: !!q('input[name=parent]'), hostRadio: !!q('input[name=host]'),
      usdc: !!q('#usdc'), quai: !!q('#quai'), sign: !!q('#sign'), lookPost: !!q('#look'), hatchAnother: !!q('#new'),
    },
  }
})
const readSession = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('gremlins.launch') ?? 'null') } catch { return null } })
const submit = (page) => page.locator('#f button:not([type=button])').last().click()

async function signedInAs(page) {
  const chip = page.locator('.auth-chip')
  return (await chip.isVisible().catch(() => false)) ? ((await chip.getAttribute('title')) ?? '').toLowerCase() : undefined
}

/** Sign in through the header dialog with MetaMask, as the test account (as smoke.mjs does). */
async function ensureSignedIn(w, page) {
  const who = await signedInAs(page)
  if (who === TEST_ACCOUNT.toLowerCase()) return
  if (who) {
    await page.locator('.auth-chip').click()
    await page.locator('.auth-menu').getByRole('button', { name: 'Sign out' }).click()
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('.auth-signin').click()
    const dialog = page.locator('.wallet-dialog')
    await dialog.waitFor()
    await sleep(attempt ? 3000 : 800)
    const row = dialog.locator('.wallet-row', { hasText: 'MetaMask' })
    if (((await row.locator('.wallet-tag').textContent().catch(() => '')) ?? '').trim() !== 'Detected' && attempt === 0) {
      await dialog.locator('.wallet-close').click() // MetaMask announced late: reopen
      continue
    }
    await row.click()
    await answerWallet(w, [/^connect$/i, /^next$/i, /^confirm$/i], { kind: 'connect', until: async () => !!(await signedInAs(page)) })
    break
  }
  await page.locator('.auth-chip').waitFor({ timeout: 30_000 })
  const now = await signedInAs(page)
  if (now !== TEST_ACCOUNT.toLowerCase()) throw new Error(`signed in as ${now}, not the test account ${TEST_ACCOUNT}`)
  log(`signed in as ${TEST_ACCOUNT} (MetaMask)`)
}

/**
 * Answer the wallet's approval pages until `until()` holds: one click per page, only on the given buttons. `guard`
 * sees each page's text first and may throw (e.g. a transaction where only a signature is expected).
 */
async function answerWallet(w, buttons, { kind = 'any', until, guard, timeout = 180_000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await until()) return
    const p = await waitForApproval(w, { kind, timeout: 20_000, skipIf: until }).catch(() => null)
    if (!p) continue
    await p.waitForLoadState('domcontentloaded').catch(() => {})
    await unlockIfLocked(p, walletPassword(), { timeout: 2500 })
    await p.mouse.wheel(0, 5000).catch(() => {})
    const text = await p.locator('body').innerText({ timeout: 5000 }).catch(() => '')
    if (guard) guard(text)
    const hit = await clickAny(p, buttons, { timeout: 20_000, optional: true })
    log(`  wallet: ${hit ? `clicked ${hit}` : 'nothing to click'} on ${p.isClosed() ? 'a closed page' : new URL(p.url()).pathname}`)
    await sleep(1500)
    if (!p.isClosed() && !/\/popup\.html$/.test(p.url())) await p.close().catch(() => {})
  }
  throw new Error(`wallet: gave up after ${timeout / 1000}s`)
}

// ── balances (read-only RPC) ─────────────────────────────────────────────────

async function baseBalances(addr) {
  const p = new JsonRpcProvider('https://mainnet.base.org', 8453, { staticNetwork: true })
  const usdc = new Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ['function balanceOf(address) view returns (uint256)'], p)
  const [u, e] = await Promise.all([usdc.balanceOf(addr), p.getBalance(addr)])
  return { usdcMicro: u, ethWei: e }
}
async function quaiProvider() {
  const { JsonRpcProvider: QP } = await import('quais')
  return new QP('https://rpc.quai.network', undefined, { usePathing: true })
}

// ── payments (each behind --spend) ───────────────────────────────────────────

function announce(n, pay) {
  log(`SPEND ${n}/2: ${pay.text}`)
  if (!SPEND) {
    log(`dry run: stopping before this payment. Run again with --spend to pay it (state: ${statePath(name)}).`)
    throw new Stop()
  }
}

async function payEgg(w, page, session) {
  const pay = eggPayment(session.hatch)
  remember({ eggPayment: { usd: session.hatch.minUsd, to: pay.to, chain: 'base' } })
  if (state.paidAt) return // paid on an earlier run: the page is waiting for it to arrive
  const job = await board.job(session.hatch.jobId).catch(() => undefined)
  if (job?.funds && BigInt(job.funds.usdc ?? 0) >= pay.amountMicro) { remember({ paidAt: job.funds.at }); return log('the hosting address is already funded') }
  announce(1, pay)
  if (session.hatch.minUsd > MAX_USD) throw new Error(`the hatch asks $${session.hatch.minUsd}, above --max-usd ${MAX_USD}`)
  if (!(await page.locator('#usdc').isVisible())) throw new Error('the page offers QUAI, not USDC: is MetaMask the signed-in wallet?')
  if (!(await page.locator('#app').innerText()).includes(pay.to)) throw new Error(`the page does not show the hosting address ${pay.to}`)
  const bal = await baseBalances(TEST_ACCOUNT)
  if (bal.usdcMicro < pay.amountMicro) throw new Error(`test account has ${formatUnits(bal.usdcMicro, 6)} USDC on Base, needs ${formatUnits(pay.amountMicro, 6)}`)
  if (bal.ethWei < 10n ** 12n) throw new Error(`test account has ${formatEther(bal.ethWei)} ETH on Base for gas`)
  await page.locator('#usdc').click()
  const sent = async () => fromSession(await readSession(page)).txs?.some((t) => t.step === 'fund-egg')
  // MetaMask may first ask to switch to Base, then shows the transfer. Nothing else may come up here.
  await answerWallet(w, [/^confirm$/i, /^switch network$/i, /^approve$/i], { kind: 'tx', until: sent, guard: (t) => { if (/signature request/i.test(t)) throw new Error('wallet shows a signature request while paying') } })
  remember({ ...fromSession(await readSession(page)), paidAt: new Date().toISOString() })
  log(`paid: ${state.txs.filter((t) => t.step === 'fund-egg').map((t) => t.hash).join(', ')}`)
}

async function signConfig(w, page) {
  log('signing the config for the announced egg (EIP-712, no transaction)')
  await page.locator('#sign').click()
  const done = async () => { const s = await readSession(page); return !!s?.signed || !!s?.configPosted || !!(await probe(page)).error }
  // MetaMask adds/switches to Quai (chain 9) for the typed data, then signs. A transaction here would be wrong.
  await answerWallet(w, [/^approve$/i, /^switch network$/i, /^sign$/i, /^confirm$/i], { until: done, guard: (t) => { if (/network fee|gas fee|estimated fee/i.test(t)) throw new Error('wallet shows a transaction while signing the config: refusing') } })
}

async function feedQuai(to) {
  const pay = quaiPayment(QUAI, to)
  if (state.txs?.some((t) => t.step === 'feed-quai')) return
  const provider = await quaiProvider()
  const have = await provider.getBalance(TEST_ACCOUNT)
  announce(2, pay)
  if (have < pay.amountWei + 10n ** 18n) throw new Error(`test account has ${formatEther(have)} QUAI, needs ${QUAI} plus fees`)
  let hash
  if ((args['quai-via'] ?? 'pelagus') === 'key') {
    const { Wallet } = await import('quais')
    const { testPrivateKey } = await import('../wallet-harness/secrets.mjs')
    hash = (await new Wallet('0x' + testPrivateKey(), provider).sendTransaction({ from: TEST_ACCOUNT, to, value: pay.amountWei })).hash
  } else hash = await sendWithPelagus(to, pay.amountWei)
  remember({ quaiAmount: Number(QUAI), txs: [{ step: 'feed-quai', chain: 'quai', hash, label: `${QUAI} QUAI to the gremlin` }] })
  log(`sent ${QUAI} QUAI: ${hash}; waiting for it to confirm`)
  for (let i = 0; i < 150; i++) {
    const r = await provider.getTransactionReceipt(hash).catch(() => null)
    if (r) { if (r.status === 0) throw new Error(`QUAI transfer ${hash} failed`); remember({ quaiFundedAt: new Date().toISOString() }); return log('QUAI transfer confirmed') }
    await sleep(4000)
  }
  throw new Error(`QUAI transfer ${hash} not confirmed after 10 min; check quaiscan.io`)
}

async function sendWithPelagus(to, wei) {
  const pw = await launchWallet('pelagus')
  try {
    await sleep(1500)
    for (const p of pw.extPages()) await p.close().catch(() => {})
    const pg = await pw.context.newPage()
    await pg.goto(`${BASE}/`, { waitUntil: 'load' })
    await sleep(1500)
    const call = (method, params) => pg.evaluate(async ([m, ps]) => {
      try { return { ok: await window.pelagus.request({ method: m, params: ps }) } } catch (e) { return { err: e?.message ?? String(e) } }
    }, [method, params])
    const settle = (pr) => { let v; pr.then((x) => { v = x }); return { result: pr, done: async () => v !== undefined } }
    const acc = settle(call('quai_requestAccounts', []))
    await answerWallet(pw, [/^connect$/i], { kind: 'connect', until: acc.done, timeout: 60_000 })
    const accounts = (await acc.result).ok ?? []
    if (!accounts.some((a) => a.toLowerCase() === TEST_ACCOUNT.toLowerCase())) throw new Error(`Pelagus answers for ${accounts.join(', ')}, not the test account`)
    const tx = settle(call('quai_sendTransaction', [{ from: TEST_ACCOUNT, to, value: '0x' + wei.toString(16) }]))
    await answerWallet(pw, [/^sign$/i, /^confirm$/i, /^send$/i], { kind: 'tx', until: tx.done, timeout: 120_000 })
    const r = await tx.result
    if (!r.ok) throw new Error(`Pelagus refused the QUAI transfer: ${r.err}`)
    return r.ok
  } finally { await pw.close() }
}

// ── the run ──────────────────────────────────────────────────────────────────

async function run() {
  remember({ board: BASE, persona, ...(state.createdAt ? {} : { createdAt: new Date().toISOString() }) })
  log(`${name}: ${SPEND ? 'SPEND run' : 'dry run (no payments)'} on ${BASE}`)
  const w = await launchWallet('metamask')
  let page
  try {
    await sleep(1500)
    for (const p of w.extPages()) await p.close().catch(() => {})
    page = await w.context.newPage()
    page.on('pageerror', (e) => log(`  page error: ${e.message.slice(0, 200)}`))
    await page.goto(`${BASE}/hatch/`, { waitUntil: 'load' })
    await sleep(1500)

    const session = await readSession(page)
    let jobFunded = false
    if (session?.hatch?.jobId) { const j = await board.job(session.hatch.jobId).catch(() => undefined); jobFunded = !!j?.funds || !['keygen', 'funding', 'failed', undefined].includes(j?.status) }
    const d = resumeDecision(state, session, { fresh: args.new === true, jobFunded })
    if (d.action === 'refuse') throw new Error(d.why)
    if (d.action === 'reset') {
      log(`dropping unfinished launch ${session.launchId} from this profile (--new)`)
      await page.evaluate(() => localStorage.removeItem('gremlins.launch'))
      await page.reload({ waitUntil: 'load' })
      await sleep(1500)
    }
    remember(fromSession(await readSession(page)))
    if (d.action === 'resume') log(`resuming launch ${state.launchId}`)

    let last, errors = 0, launchId = state.launchId
    for (;;) {
      if (Date.now() > DEADLINE) throw new Error('timed out (state kept: run again to resume)')
      const p = await probe(page)
      const screen = classifyScreen(p)
      if (screen !== last) log(`screen: ${screen}${p.h2 ? ` — ${p.h2.trim().slice(0, 80)}` : ''}`)
      last = screen
      const session = await readSession(page)
      if (session) remember(fromSession(session))
      if (session?.launchId && session.launchId !== launchId) log(`launch ${(launchId = session.launchId)}`)
      if (!SPEND && !FREE_SCREENS.includes(screen)) throw new Error(`the page is past the first payment (${screen}): this hatch was paid before; resume it with --spend`)

      switch (screen) {
        case 'not-configured': throw new Error('the site says hatching is not configured')
        case 'form-error': throw new Error(`the page rejected the gremlin: ${p.formError}`)
        case 'error':
          if (++errors > 4) throw new Error(`page keeps failing: ${p.error}`)
          log(`  page error: ${p.error}; retrying in 15 s`)
          await sleep(15_000)
          await page.locator('#app > .error button').first().click().catch(() => {})
          break
        case 'preparing': await sleep(2000); break
        case 'connect': await ensureSignedIn(w, page); await page.locator('#go').click(); break
        case 'name':
          await page.fill('input[name=name]', persona.name)
          await page.fill('textarea[name=goals]', persona.goals.join('\n'))
          await submit(page)
          break
        case 'look': await page.locator('#skip').click(); break // keeps the creature drawn from its config
        case 'persona':
          await page.fill('textarea[name=persona]', persona.persona)
          await page.fill('input[name=voice]', persona.voice ?? '')
          await submit(page)
          break
        case 'models-loading': await sleep(1000); break
        case 'models': await submit(page); break // the page's defaults
        case 'rules':
          for (const c of persona.constitution ?? []) await page.check(`input[name=constitution][value="${c}"]`).catch(() => log(`  no constitution section "${c}"`))
          await submit(page)
          break
        case 'host':
          await page.check('input[name=host][value=fluence]')
          await page.locator('#go').click()
          break
        case 'pay':
          if (!session?.hatch?.hostingAddress) { await sleep(2000); break }
          await payEgg(w, page, session)
          await sleep(15_000)
          break
        case 'starting':
        case 'waiting-egg': await followJob(); await sleep(20_000); break
        case 'sign': await signConfig(w, page); break
        case 'look-post': throw new Error('the page wants to publish a Forge look; hatch.mjs skips the Forge, so this should not happen')
        case 'feed': return await afterHatch(page)
        default: await sleep(2000)
      }
      await sleep(1200)
    }
  } catch (e) {
    if (e instanceof Stop) return 0
    if (page) await page.screenshot({ path: join(runDir(name), 'hatch-error.png') }).catch(() => {})
    if (page && process.env.WALLET_DEBUG) log(await dump(page))
    throw e
  } finally {
    await w.close().catch(() => {})
  }
}

let lastJob
async function followJob() {
  if (!state.jobId) return
  const job = await board.job(state.jobId).catch(() => undefined)
  if (!job) return
  const line = `${job.status}${job.vmId ? ` vm ${job.vmId}` : ''}${job.eggAddress ? ` egg ${job.eggAddress.slice(0, 10)}…` : ''}${job.error ? ` (${job.error})` : ''}`
  if (line !== lastJob) log(`  hatch job: ${line}`)
  lastJob = line
  remember({ jobStatus: job.status, ...(job.vmId ? { vmId: job.vmId } : {}), ...(job.eggIp ? { ip: job.eggIp } : {}) })
  return job
}

/** Config delivered: feed the gremlin, keep the page open until the egg holds its account, wait for its first pulse. */
async function afterHatch(page) {
  const egg = await board.eggByLaunch(state.launchId)
  remember({ eggAddress: egg.address, gremlin: { evm: egg.deposit.evm, quai: egg.deposit.quai, ...(egg.deposit.qiPaymentCode ? { qiPaymentCode: egg.deposit.qiPaymentCode } : {}) } })
  log(`config delivered to egg ${egg.address}; Quai wallet ${egg.deposit.quai}`)
  await feedQuai(egg.deposit.quai)
  for (;;) {
    if (Date.now() > DEADLINE) throw new Error('timed out waiting for the egg to take its hosting account and hatch (state kept)')
    const job = await followJob()
    const e = await board.eggByLaunch(state.launchId).catch(() => undefined)
    if (job?.status === 'failed') throw new Error(`hatch job failed: ${job.error}`)
    if (job?.status === 'done' && e?.status === 'hatched') {
      remember({ hatchedAt: e.hatchedAt })
      log(`${name} hatched at ${e.hatchedAt}; the egg holds its hosting account. Next: node scripts/agent-test/watch.mjs ${name}`)
      return 0
    }
    if (page.isClosed()) throw new Error('the hatch page closed before the hand-over finished')
    await sleep(20_000)
  }
}

try {
  process.exitCode = await run()
} catch (e) {
  log(`FAILED: ${e.message}`)
  process.exitCode = 1
}
