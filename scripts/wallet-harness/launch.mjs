// Launch Chromium with ONE real wallet extension loaded into a persistent profile.
//   import { launchWallet } from './launch.mjs'
//   const w = await launchWallet('metamask')            // profile: ~/.cache/gremlinz-wallets/metamask
//   const page = await w.openHome()                     // the wallet's full-page UI
// Runs headless by default (Playwright's 'chromium' channel = Chromium's new headless mode, which loads extensions).
//
// Setup (once per machine):
//   1. Unpack the Chrome Web Store builds of the wallets to ~/.cache/gremlinz-wallets/ext/{pelagus,metamask,phantom}
//      (a .crx is a zip with a header: `unzip wallet.crx -d <dir>` works; ignore its "extra bytes" warning).
//   2. node scripts/wallet-harness/onboard.mjs <wallet>   imports the funded test key (privkey.key), see onboard.mjs
//   3. node scripts/wallet-harness/smoke.mjs <wallet>     signs in on gremlinz.ai end to end
// The extension id is derived from the unpacked dir's path, so keep the dirs where they are once onboarded.
// Env:
//   WALLET_EXT_DIR      dir holding unpacked <name>/ extension dirs (default: ~/.cache/gremlinz-wallets/ext)
//   WALLET_EXT_<NAME>   explicit unpacked dir for one wallet (e.g. WALLET_EXT_PELAGUS)
//   HEADED=1            show the window (default: Chromium's new headless mode, which runs extensions)
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

export const CACHE = join(homedir(), '.cache', 'gremlinz-wallets')
export const WALLETS = {
  // home: full-page UI; popup: toolbar popup page
  pelagus: { home: 'tab.html', popup: 'popup.html', label: /pelagus/i },
  metamask: { home: 'home.html', popup: 'popup.html', label: /metamask/i },
  phantom: { home: 'popup.html', popup: 'popup.html', onboarding: 'onboarding.html', label: /phantom/i },
}

export function extensionDir(name) {
  const env = process.env[`WALLET_EXT_${name.toUpperCase()}`]
  if (env) return env
  return join(process.env.WALLET_EXT_DIR ?? join(CACHE, 'ext'), name)
}

export function profileDirFor(name) { return join(CACHE, name) }

export async function launchWallet(name, { profileDir = profileDirFor(name), extDir = extensionDir(name), headless = !process.env.HEADED, viewport = { width: 1280, height: 900 } } = {}) {
  if (!WALLETS[name]) throw new Error(`unknown wallet ${name}; one of ${Object.keys(WALLETS).join(', ')}`)
  if (!existsSync(join(extDir, 'manifest.json'))) throw new Error(`no unpacked extension at ${extDir} (set WALLET_EXT_DIR or WALLET_EXT_${name.toUpperCase()})`)
  mkdirSync(profileDir, { recursive: true })
  const context = await chromium.launchPersistentContext(profileDir, {
    // channel 'chromium' = the full Chromium build; its headless is the "new" headless, which loads extensions
    channel: 'chromium',
    headless,
    // No fixed viewport: every page gets its own window's size, so a wallet's small popup window lays out as it
    // would for a person (a forced 1280x900 viewport pushes popup buttons outside the window).
    viewport: null,
    args: [
      `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      // Headless screens default to 800x600, so wallets that place their popup window at the right edge of a
      // 1280px browser window (Pelagus) get "Bounds must be at least 50% within visible screen space".
      `--window-size=${viewport.width},${viewport.height}`,
      ...(headless ? ['--screen-info={1920x1080}'] : []),
    ],
  })
  let [sw] = context.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'))
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 })
  const extensionId = new URL(sw.url()).host
  const base = `chrome-extension://${extensionId}/`
  const spec = WALLETS[name]

  const isExtPage = (p) => p.url().startsWith(base)
  const open = async (path) => {
    const page = await context.newPage()
    await page.goto(base + path)
    return page
  }
  return {
    name,
    context,
    extensionId,
    base,
    isExtPage,
    extPages: () => context.pages().filter(isExtPage),
    open,
    openHome: () => open(spec.home),
    openPopup: () => open(spec.popup),
    // Wait for the wallet to open a page (notification/approval popup). Resolves an already-open one too.
    async waitForWalletPage({ timeout = 30_000, exclude = [] } = {}) {
      const existing = context.pages().find((p) => isExtPage(p) && !exclude.includes(p))
      if (existing) return existing
      return context.waitForEvent('page', { predicate: (p) => isExtPage(p) && !exclude.includes(p), timeout })
    },
    close: () => context.close(),
  }
}
