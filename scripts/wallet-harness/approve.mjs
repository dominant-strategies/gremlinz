// Answer a real wallet's approval popup (connect / sign / transaction / reject).
//   import { approveConnect, approveSign, approveTx, reject } from './approve.mjs'
//   const w = await launchWallet('metamask')
//   await site.click('.wallet-row')            // the dapp asks for something...
//   await approveConnect(w)                    // ...and the wallet's popup is answered
// Each helper waits for the wallet's approval page (a new chrome-extension://<id>/ page), unlocks the wallet if
// it shows its lock screen, clicks the button and waits for the request to finish.
//
// MetaMask 13 shows requests in its side panel, which Playwright can't drive. When no approval page turns up in
// time, we open the wallet's own approval route in a tab (MetaMask notification.html; for Pelagus
// popup.html?page=/dapp-permission etc. as a fallback): it renders the pending request the same way.
import { walletPassword } from './secrets.mjs'
import { clickAny, sleep, unlockIfLocked, dump } from './ui.mjs'

// Per wallet: which extension URLs are approval pages, where to open one ourselves, and the button labels.
const SPEC = {
  metamask: {
    popup: /\/(notification|popup)\.html/,
    fallback: { connect: 'notification.html', sign: 'notification.html', tx: 'notification.html', any: 'notification.html' },
    connect: [/^connect$/i, /^next$/i, /^confirm$/i],
    sign: [/^confirm$/i, /^sign$/i],
    tx: [/^confirm$/i],
    reject: [/^cancel$/i, /^reject$/i],
  },
  pelagus: {
    popup: /\/popup\.html\?page=/,
    fallback: {
      connect: 'popup.html?page=%2Fdapp-permission',
      sign: 'popup.html?page=%2Fpersonal-sign',
      signTyped: 'popup.html?page=%2Fsign-data',
      tx: 'popup.html?page=%2Fsign-transaction',
    },
    connect: [/^connect$/i],
    sign: [/^sign$/i, /^confirm$/i],
    tx: [/^sign$/i, /^confirm$/i, /^send$/i],
    reject: [/^reject$/i, /^cancel$/i],
  },
  phantom: {
    popup: /\/notification\.html/,
    fallback: { connect: 'notification.html', sign: 'notification.html', tx: 'notification.html', any: 'notification.html' },
    connect: [/^connect$/i],
    sign: [/^confirm$/i, /^sign$/i, /^approve$/i],
    tx: [/^confirm$/i, /^approve$/i],
    reject: [/^cancel$/i, /^reject$/i],
  },
}

/**
 * Wait for the wallet's approval page. Returns the page, or null when `skipIf()` turns true first (e.g. the site
 * was already connected, so no popup is coming).
 * opts: timeout (total), fallbackAfter (ms before opening the approval route ourselves; 0 = never), kind, skipIf
 */
export async function waitForApproval(w, { kind = 'any', timeout = 45_000, fallbackAfter = 6_000, skipIf } = {}) {
  const spec = SPEC[w.name]
  const start = Date.now()
  let opened = null
  while (Date.now() - start < timeout) {
    const p = w.context.pages().find((p) => !p.isClosed() && p.url().startsWith(w.base) && spec.popup.test(p.url()))
    if (p) return p
    if (skipIf && (await skipIf().catch(() => false))) return null
    const route = spec.fallback[kind] ?? spec.fallback.any
    if (!opened && fallbackAfter && Date.now() - start > fallbackAfter && route) opened = await w.open(route)
    await sleep(250)
  }
  throw new Error(`${w.name}: no approval page appeared within ${timeout}ms`)
}

async function answer(w, kind, buttons, opts = {}) {
  const page = await waitForApproval(w, { kind, ...opts })
  if (!page) return null
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await unlockIfLocked(page, walletPassword(), { timeout: 2500 })
  // Some confirmations need scrolling to the bottom (long messages) before the button is enabled.
  await page.mouse.wheel(0, 5000).catch(() => {})
  try {
    if (process.env.WALLET_DEBUG) console.log(`[approve ${w.name} ${kind}]`, await dump(page))
    // One click only: a queued request behind this one is never approved by accident.
    const hit = await clickAny(page, buttons, { timeout: opts.buttonTimeout ?? 20_000 })
    if (process.env.WALLET_DEBUG) { await sleep(1000); console.log(`[approve ${w.name} after click]`, page.isClosed() ? 'closed' : await dump(page)) }
    // Phantom can follow Confirm with an "Are you sure? ... Proceeding is unsafe" interstitial (seen for every
    // personal_sign when its simulation service fails). Closing it rejects the request; acceptUnsafe proceeds.
    const unsafe = page.getByText(/proceeding is unsafe/i)
    if (kind !== 'reject' && (await unsafe.waitFor({ timeout: 2500 }).then(() => true, () => false))) {
      if (!opts.acceptUnsafe) throw new Error(`${w.name} blocked the request as unsafe ("Failed to simulate"); pass { acceptUnsafe: true } to proceed`)
      await page.getByRole('checkbox', { name: /i understand/i }).check({ force: true })
      await clickAny(page, [/confirm \(unsafe\)/i, (pg) => pg.getByText(/^yes, confirm \(unsafe\)$/i)])
      return { page, clicked: hit, acceptedUnsafe: true }
    }
    return { page, clicked: hit }
  } catch (e) {
    if (!page.isClosed()) e.message += `\n${await dump(page)}`
    throw e
  } finally {
    await sleep(800)
    // A tab we opened ourselves may stay open on a "done"/home screen; close it so the next request gets a fresh one.
    if (!page.isClosed() && !/\/popup\.html$/.test(page.url())) await page.close().catch(() => {})
  }
}

/** Approve a dapp connection request (eth_requestAccounts / quai_requestAccounts). */
export const approveConnect = (w, opts) => answer(w, 'connect', SPEC[w.name].connect, opts)
/**
 * Approve a message signature (personal_sign; for EIP-712 on Pelagus pass { kind: 'signTyped' }).
 * { acceptUnsafe: true } also clicks through Phantom's "Proceeding is unsafe" interstitial.
 */
export const approveSign = (w, opts = {}) => answer(w, opts.kind ?? 'sign', SPEC[w.name].sign, opts)
/** Approve a transaction. This spends gas: only for tests that are meant to send one. */
export const approveTx = (w, opts) => answer(w, 'tx', SPEC[w.name].tx, opts)
/** Reject whatever the wallet is asking. opts.kind ('connect' | 'sign' | 'tx') picks the fallback route on Pelagus. */
export const reject = (w, opts = {}) => answer(w, opts.kind ?? 'connect', SPEC[w.name].reject, opts)
