// Small UI helpers shared by onboard/approve/smoke.
import { writeFileSync } from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// While true, debug dumps/screenshots are suppressed (a secret may be on screen).
let sensitive = false
export const setSensitive = (v) => { sensitive = v }

// Describe what's visible on a page (for debugging failures). Never while sensitive.
export async function dump(page, shotPath) {
  if (sensitive) return { url: page.url(), note: 'suppressed (sensitive screen)' }
  if (shotPath) await page.screenshot({ path: shotPath }).catch(() => {})
  // ariaSnapshot runs in Playwright's utility world, so it works on LavaMoat-scuttled pages (MetaMask) too.
  let aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch((e) => `ERR ${e.message}`)
  aria = aria.replace(/\n\s*- option "[^\n]*/g, '') // drop long <select> option lists
  // never echo field contents (passwords, keys, phrases): textbox values appear inline or as a "- text:" child
  aria = aria.replace(/^(\s*- textbox[^\n]*?):( .+)$/gm, '$1: «redacted»')
    .replace(/^(\s*- textbox[^\n]*:\n(?:\s+- \/placeholder[^\n]*\n)?)(\s+- text:)[^\n]*/gm, '$1$2 «redacted»')
  return `${page.url()}\n${aria.slice(0, 4000)}`
}

// Click the first visible element among candidates (role/text based). Returns the label that matched or null.
export async function clickAny(page, candidates, { timeout = 10_000, optional = false } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = typeof c === 'function' ? c(page) : page.getByRole('button', { name: c })
      const n = await loc.count().catch(() => 0)
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i)
        if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
          try { await el.click() } catch (e) {
            if (!page.isClosed()) throw e // a wallet popup that closes itself on the click is a success
          }
          return String(c)
        }
      }
    }
    await sleep(250)
  }
  if (optional) return null
  throw new Error(`none of [${candidates.map(String).join(' | ')}] clickable on ${page.url()}`)
}

export async function visible(page, loc, timeout = 0) {
  if (!timeout) return loc.first().isVisible().catch(() => false)
  return loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
}

export function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2)) }

// If the wallet page shows its lock screen, type the password and unlock. Returns true if it unlocked.
export async function unlockIfLocked(page, password, { timeout = 4000 } = {}) {
  const field = page.locator('input[type=password]').first()
  if (!(await visible(page, field, timeout))) return false
  await field.fill(password)
  const btn = page.getByRole('button', { name: /^(unlock|log ?in|sign in)$/i }).first()
  if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 5000 }).catch(() => field.press('Enter'))
  else await field.press('Enter')
  await field.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  return true
}
