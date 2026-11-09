// End-to-end sign-in smoke test on gremlinz.ai with a real wallet extension (onboard it first).
//   node scripts/wallet-harness/smoke.mjs <pelagus|metamask|phantom> [--base https://gremlinz.ai] [--out DIR] [--sign [--accept-unsafe]]
// Signs in through the header dialog, checks the address chip and the board's comment form, then signs out.
// Posts nothing, sends nothing. --sign additionally asks the wallet for a personal_sign of a fixed test message and
// checks the signature locally (it is never sent anywhere). --accept-unsafe clicks through Phantom's
// "Proceeding is unsafe" warning for that signature.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifyMessage, hexlify, toUtf8Bytes } from 'ethers'
import { launchWallet, WALLETS, CACHE } from './launch.mjs'
import { TEST_ADDRESS } from './secrets.mjs'
import { approveConnect, approveSign } from './approve.mjs'
import { sleep } from './ui.mjs'

const args = process.argv.slice(2)
const name = args[0]
const opt = (k, d) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d }
if (!WALLETS[name]) { console.error(`usage: smoke.mjs <${Object.keys(WALLETS).join('|')}> [--base URL] [--out DIR] [--sign]`); process.exit(2) }
const BASE = opt('--base', 'https://gremlinz.ai').replace(/\/$/, '')
const OUT = opt('--out', process.env.WALLET_SHOTS ?? join(CACHE, 'shots'))
mkdirSync(OUT, { recursive: true })

const results = []
const check = (label, ok, detail = '') => { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); return ok }
const shot = (page, step) => page.screenshot({ path: join(OUT, `smoke-${name}-${step}.png`) }).catch(() => {})
const label = { pelagus: 'Pelagus', metamask: 'MetaMask', phantom: 'Phantom' }[name]

const w = await launchWallet(name)
let site
try {
  await sleep(1500)
  for (const p of w.extPages()) await p.close().catch(() => {}) // startup tabs some wallets open (onInstalled)
  site = await w.context.newPage()
  const errors = []
  site.on('pageerror', (e) => errors.push(e.message))

  await site.goto(`${BASE}/`, { waitUntil: 'load' })
  await sleep(1000) // wallets inject/announce their providers a little after load
  // A previous run may have left the site signed in (localStorage in the persistent profile).
  if (await site.locator('.auth-chip').isVisible({ timeout: 3000 }).catch(() => false)) {
    await site.locator('.auth-chip').click()
    await site.locator('.auth-menu').getByRole('button', { name: 'Sign out' }).click()
  }

  // 1. header Sign in → dialog lists this wallet as Detected
  await site.locator('.auth-signin').click()
  const dialog = site.locator('.wallet-dialog')
  await dialog.waitFor()
  await sleep(500)
  const row = dialog.locator('.wallet-row', { hasText: label })
  let tag = (await row.locator('.wallet-tag').textContent().catch(() => '')).trim() // innerText is CSS-uppercased
  if (tag !== 'Detected') {
    // The dialog lists wallets once, when it opens; a provider announced later isn't picked up until it reopens.
    console.log(`      ${label} shown as "${tag}" on first open; reopening the dialog`)
    await shot(site, '1-dialog-first')
    await dialog.locator('.wallet-close').click()
    await sleep(3000)
    await site.locator('.auth-signin').click()
    await dialog.waitFor()
    tag = (await row.locator('.wallet-tag').textContent().catch(() => '')).trim()
  }
  check(`dialog shows ${label} as Detected`, tag === 'Detected', `tag "${tag}"`)
  const others = await dialog.locator('.wallet-row').evaluateAll((rows) => rows.map((r) => `${r.querySelector('b')?.textContent}: ${r.querySelector('.wallet-tag')?.textContent}`))
  console.log('      dialog rows:', others.join(', '))
  await shot(site, '1-dialog')

  // 2. pick it → approve in the wallet → header shows the address chip
  await row.click()
  const chip = site.locator('.auth-chip')
  const res = await approveConnect(w, { skipIf: () => chip.isVisible() })
  console.log('      wallet popup:', res ? `clicked ${res.clicked}` : 'none needed (site already permitted)')
  await chip.waitFor({ timeout: 30_000 }).catch(() => {})
  const title = await chip.getAttribute('title').catch(() => null)
  check('header shows the address chip', !!title, title ?? (await site.locator('.wallet-status').innerText().catch(() => '')))
  check('chip address is the test account', title?.toLowerCase() === TEST_ADDRESS.toLowerCase(), title ?? '')
  await shot(site, '2-signed-in')

  // 3. optional: a free off-chain signature through the signed-in provider
  if (args.includes('--sign')) {
    const msg = `gremlinz wallet harness check ${new Date().toISOString()}`
    const sig = site.evaluate(async ([m, addr, kind]) => {
      const p = kind === 'pelagus' ? window.pelagus
        : kind === 'phantom' ? window.phantom?.ethereum
        : (window.ethereum?.providers?.find((x) => x.isMetaMask && !x.isPhantom) ?? window.ethereum)
      try { return { sig: await p.request({ method: 'personal_sign', params: [m, addr] }) } }
      catch (e) { return { err: JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})) } }
    }, [hexlify(toUtf8Bytes(msg)), title, name])
    const settled = sig.then((r) => r, (e) => ({ err: e.message }))
    const approved = approveSign(w, { acceptUnsafe: args.includes('--accept-unsafe'), skipIf: async () => !!(await Promise.race([settled, sleep(1).then(() => null)])) }).catch((e) => ({ error: e.message }))
    const r = await settled
    const a = await approved
    if (a?.error) console.log('      wallet:', a.error.split('\n')[0])
    if (a?.acceptedUnsafe) console.log('      wallet: clicked through the "unsafe" warning (--accept-unsafe)')
    check('personal_sign recovers the test account', !!r.sig && verifyMessage(msg, r.sig).toLowerCase() === TEST_ADDRESS.toLowerCase(), r.err ?? '')
  }

  // 4. board: open a post; signed-in visitors get the comment form (nothing is typed or posted).
  //    With no posts on the site yet, fall back to the community's new-post form (same .needs-auth gate).
  let href = null
  for (const path of ['/board', '/c/general', '/c/markets', '/c/hatchery']) {
    await site.goto(BASE + path, { waitUntil: 'domcontentloaded' })
    href = await site.locator('a[href^="/p/"]').first().getAttribute('href', { timeout: 3000 }).catch(() => null)
    if (href) break
  }
  if (href) {
    await site.goto(new URL(href, BASE).href, { waitUntil: 'domcontentloaded' })
    await site.locator('.auth-chip').waitFor({ timeout: 15_000 }).catch(() => {})
    check('body.signed-in on the post page', (await site.locator('body.signed-in').count()) > 0, href)
    check('comment form is visible', await site.locator('#comment-form').isVisible({ timeout: 10_000 }).catch(() => false))
  } else {
    console.log('      no posts on the board yet: checking the c/general new-post form instead of #comment-form')
    await site.goto(`${BASE}/c/general`, { waitUntil: 'domcontentloaded' })
    await site.locator('.auth-chip').waitFor({ timeout: 15_000 }).catch(() => {})
    check('body.signed-in on c/general', (await site.locator('body.signed-in').count()) > 0)
    check('new-post form (.needs-auth) is visible', await site.locator('form.needs-auth').first().isVisible().catch(() => false))
  }
  await shot(site, '3-board')

  // 5. sign out through the chip menu
  await site.locator('.auth-chip').click()
  await site.locator('.auth-menu').getByRole('button', { name: 'Sign out' }).click()
  check('signed out (Sign in button back)', await site.locator('.auth-signin').isVisible({ timeout: 10_000 }).catch(() => false))
  check('signed-in-only forms hidden after sign-out', !(await site.locator('form.needs-auth').first().isVisible().catch(() => false)))
  await shot(site, '4-signed-out')
  if (errors.length) console.log('      page errors:', errors.slice(0, 5))
} catch (e) {
  check(`unexpected error: ${e.message.split('\n')[0]}`, false)
  if (site) await shot(site, 'error')
} finally {
  await w.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`${name}: ${results.length - failed}/${results.length} checks passed; screenshots in ${OUT}`)
process.exitCode = failed ? 1 : 0
