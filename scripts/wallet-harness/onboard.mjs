// One-time onboarding of a real wallet extension into ~/.cache/gremlinz-wallets/<name>,
// importing the funded test account (privkey.key at the repo root; never printed).
//   node scripts/wallet-harness/onboard.mjs <pelagus|metamask|phantom> [--fresh]
// --fresh wipes the profile first. Without it, an already-onboarded profile is only unlocked and verified.
// Writes ~/.cache/gremlinz-wallets/<name>.json with the result; screenshots go to ~/.cache/gremlinz-wallets/shots/.
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchWallet, profileDirFor, CACHE, WALLETS } from './launch.mjs'
import { walletPassword, testPrivateKey, TEST_ADDRESS } from './secrets.mjs'
import { Wallet } from 'ethers'
import { dump, clickAny, sleep, visible, setSensitive, writeJson, unlockIfLocked } from './ui.mjs'

const name = process.argv[2]
if (!WALLETS[name]) { console.error(`usage: onboard.mjs <${Object.keys(WALLETS).join('|')}> [--fresh]`); process.exit(2) }
const profileDir = profileDirFor(name)
const stateFile = join(CACHE, `${name}.json`)
if (process.argv.includes('--fresh')) { rmSync(profileDir, { recursive: true, force: true }); rmSync(stateFile, { force: true }) }
const alreadyOnboarded = existsSync(stateFile)

const SHOTS = process.env.WALLET_SHOTS ?? join(CACHE, 'shots')
const log = (...a) => console.log(`[${name}]`, ...a)

// Type a secret into a field with dumps/screenshots suppressed. The value is never logged.
async function typeSecret(locator, value) {
  setSensitive(true)
  // inputValue/innerText run in Playwright's utility world (page.evaluate is blocked by MetaMask's LavaMoat)
  const len = async () => ((await locator.inputValue().catch(() => null)) ?? (await locator.innerText().catch(() => '')) ?? '').trim().length
  await locator.focus()
  await locator.fill(value).catch(() => {})
  if (await len()) return
  // contenteditable boxes: insert as real text input
  await locator.focus()
  await locator.page().keyboard.insertText(value)
  if (await len()) return
  await locator.pressSequentially(value, { delay: 5 })
}

async function firstOnboardingPage(w) {
  for (let i = 0; i < 40; i++) {
    const p = w.extPages().find((p) => /onboarding/.test(p.url()))
    if (p) return p
    await sleep(250)
  }
  return w.openHome()
}

const flows = {
  // Pelagus supports private-key import straight from onboarding.
  async pelagus(w) {
    const p = await firstOnboardingPage(w)
    const pw = walletPassword()
    await clickAny(p, [/use existing wallet/i])
    await clickAny(p, [/import private key/i])
    const fields = p.locator('input[type=password]')
    await fields.first().waitFor()
    await fields.nth(0).fill(pw)
    await fields.nth(1).fill(pw)
    await clickAny(p, [/anchors away/i])
    const box = p.getByRole('textbox').first()
    await box.waitFor()
    await sleep(1000) // fade-in re-render
    await typeSecret(box, testPrivateKey())
    await sleep(500)
    await p.getByRole('button', { name: /import account/i }).click({ timeout: 10_000 })
    await p.waitForURL((u) => !/import-private-key/.test(u.href), { timeout: 30_000 })
    setSensitive(false)
    await sleep(1500) // lands on #/onboarding/done ("Welcome to Pelagus")
    return p
  },
  // MetaMask needs an SRP first: import a throwaway phrase (generated here, never stored), then add the
  // test key via "Add account > Private key" and select it.
  async metamask(w) {
    const p = await firstOnboardingPage(w)
    const pw = walletPassword()
    await clickAny(p, [/i have an existing wallet/i])
    await clickAny(p, [/import using secret recovery phrase/i])
    const srp = p.getByRole('textbox').first()
    await srp.waitFor()
    setSensitive(true)
    await srp.pressSequentially(Wallet.createRandom().mnemonic.phrase, { delay: 5 }) // key events split it into word boxes
    setSensitive(false)
    await clickAny(p, [/^continue$/i])
    await p.waitForURL(/create-password/)
    const fields = p.locator('input[type=password]')
    await fields.nth(0).fill(pw)
    await fields.nth(1).fill(pw)
    await p.getByRole('checkbox').first().check({ force: true })
    await clickAny(p, [/create password/i])
    await this.metamaskOnboardingTail(p)
    await this.metamaskImportKey(p)
    return p
  },
  async metamaskImportKey(p) {
    await p.goto(`${p.url().replace(/#.*/, '')}#/`)
    await clickAny(p, [/^account \d+$/i, /^imported account/i])          // account picker in the header
    await clickAny(p, [/^add wallet$/i])
    await clickAny(p, [/^import an account$/i, (pg) => pg.getByText(/^import an account$/i)])
    const box = p.getByRole('textbox', { name: /private key/i })
    await box.waitFor()
    await typeSecret(box, testPrivateKey())
    await clickAny(p, [/^import$/i])
    await p.waitForURL((u) => !/add-wallet-page/.test(u.href), { timeout: 30_000 })
    setSensitive(false)
    await sleep(10_000) // MetaMask persists state lazily; closing too soon loses the imported account
  },
  async metamaskVerify(w) {
    const p = await w.openHome()
    await unlockIfLocked(p, walletPassword())
    const tail = TEST_ADDRESS.slice(-5)
    // header shows the selected account's shortened address, e.g. 0x003c6...2Eb96
    const shown = await visible(p, p.getByRole('banner').getByText(new RegExp(`^${TEST_ADDRESS.slice(0, 6)}.*${tail}$`, 'i')), 20_000)
    await p.screenshot({ path: join(SHOTS, `${name}-home.png`) })
    if (!shown) throw new Error(`selected account is not ${TEST_ADDRESS}: ${await dump(p)}`)
    return { address: TEST_ADDRESS, keyImported: true }
  },
  async metamaskOnboardingTail(p) {
    // Walk the post-password screens: biometrics, metrics (opt out), completion, what's-new.
    for (let i = 0; i < 20; i++) {
      await sleep(1200)
      const url = p.url()
      if (/setup-passkey/.test(url)) { await clickAny(p, [/maybe later/i, /skip/i]); continue }
      if (/metametrics/.test(url)) {
        for (const cb of await p.getByRole('checkbox').all()) if (await cb.isChecked()) await cb.uncheck({ force: true })
        await clickAny(p, [/^continue$/i, /no thanks/i, /i agree/i]); continue
      }
      if (/onboarding\/completion/.test(url)) {
        // "Open wallet" is disabled while MetaMask believes its side panel is open (it opens one on completion)
        // (headless has no real side panel). Reloading resets that UI state.
        const btn = p.getByRole('button', { name: /open wallet|^done$/i })
        await sleep(2000)
        if (await btn.isDisabled()) { await p.reload(); await sleep(2500) }
        await btn.click({ timeout: 15_000 })
        // Clicking completes onboarding, then MetaMask tries to hand over to the side panel and stays put.
        await sleep(2500)
        if (/onboarding\/completion/.test(p.url())) await p.goto(p.url().replace(/#.*/, '#/'))
        continue
      }
      if (/onboarding/.test(url)) {
        const hit = await clickAny(p, [/^done$/i, /^got it/i, /open wallet/i, /^continue$/i, /^next$/i, /no thanks/i, /^not now/i], { timeout: 3000, optional: true })
        if (!hit) log('onboarding screen:', await dump(p, join(SHOTS, `${name}-onboarding-${i}.png`)))
        continue
      }
      break
    }
  },
  // Phantom imports a single-chain private key straight from onboarding (we pick Ethereum).
  async phantom(w) {
    const p = await firstOnboardingPage(w)
    await clickAny(p, [/i already have a wallet/i])
    await clickAny(p, [/^import private key/i])
    await clickAny(p, [/^solana$/i]) // chain dropdown, defaults to Solana
    await clickAny(p, [(pg) => pg.getByRole('listbox').getByText(/^ethereum$/i)])
    await p.getByRole('textbox', { name: /^name$/i }).fill('gremlinz test')
    await typeSecret(p.getByRole('textbox', { name: /private key/i }), '0x' + testPrivateKey())
    await clickAny(p, [/^import$/i])
    await p.getByRole('textbox', { name: /private key/i }).waitFor({ state: 'detached', timeout: 30_000 })
    setSensitive(false)
    const pw = walletPassword()
    const fields = p.locator('input[type=password]')
    await fields.first().waitFor()
    await fields.nth(0).fill(pw)
    await fields.nth(1).fill(pw)
    // custom checkbox: click its label text
    const tos = p.getByRole('checkbox').first()
    if (!(await tos.isChecked())) await p.getByText(/i agree to the terms/i).click()
    if (!(await tos.isChecked())) await tos.click({ force: true })
    await clickAny(p, [/^continue$/i])
    await fields.first().waitFor({ state: 'detached', timeout: 60_000 })
    for (let i = 0; i < 10; i++) {
      await sleep(1500)
      if (p.isClosed() || !/onboarding/.test(p.url())) break
      // "Choose a username" would publish an @username for the account on Phantom's servers, and it has no
      // skip button. The wallet is already usable at this point, so we stop here and leave it unclaimed.
      if (await visible(p, p.getByText(/choose a username/i))) { log('skipping Phantom username claim (wallet already created)'); break }
      log('onboarding step', i, await dump(p, join(SHOTS, `${name}-onboarding-${i}.png`)))
      // prefer opting out (skip/not now) over continuing
      const hit = await clickAny(p, [/^skip/i, /^not now$/i, /^no thanks$/i, /^maybe later$/i, /^get started$/i, /^continue$/i, /^done$/i, /^finish$/i], { timeout: 3000, optional: true })
      if (!hit) break
    }
    return p
  },
  async phantomVerify(w) {
    const p = await w.openPopup()
    await unlockIfLocked(p, walletPassword(), { timeout: 8000 })
    await clickAny(p, [/^receive$/i], { timeout: 20_000 })
    const short = `${TEST_ADDRESS.slice(0, 6)}...${TEST_ADDRESS.slice(-4)}`
    const shown = await visible(p, p.getByRole('button', { name: `Ethereum ${short}`, exact: true }), 15_000)
    await p.screenshot({ path: join(SHOTS, `${name}-receive.png`) })
    if (!shown) throw new Error(`Phantom does not list ${short} for Ethereum: ${await dump(p)}`)
    return { address: TEST_ADDRESS, keyImported: true }
  },
  async pelagusVerify(w) {
    const p = await w.openPopup()
    await unlockIfLocked(p, walletPassword())
    const short = `${TEST_ADDRESS.slice(0, 6)}…${TEST_ADDRESS.slice(-5)}`
    const shown = await visible(p, p.getByText(short), 20_000)
    await p.screenshot({ path: join(SHOTS, `${name}-popup.png`) })
    if (!shown) throw new Error(`popup does not show ${short}: ${JSON.stringify(await dump(p))}`)
    return { address: TEST_ADDRESS, keyImported: true }
  },
}

const w = await launchWallet(name, { profileDir })
log('extension id', w.extensionId, 'profile', profileDir, alreadyOnboarded ? '(already onboarded: verifying only)' : '')
try {
  if (!alreadyOnboarded) await flows[name](w)
  const result = await flows[`${name}Verify`](w)
  writeJson(stateFile, { name, extensionId: w.extensionId, ...result, onboardedAt: new Date().toISOString() })
  log('ok: selected account', result.address)
} catch (e) {
  let msg = String(e?.message ?? e)
  try { const k = testPrivateKey(); msg = msg.replaceAll(k, '<redacted>') } catch {}
  console.error(`[${name}] onboarding failed:`, msg)
  console.error(`(rerun with --fresh to start over; HEADED=1 to watch)`)
  process.exitCode = 1
} finally {
  await w.close()
}
