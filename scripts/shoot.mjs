// Design loop: screenshot every page at phone + desktop, light + dark.
//   node scripts/shoot.mjs [baseUrl] [outDir]     (default http://localhost:8787 → .shots/)
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:8787'
const OUT = process.argv[3] ?? '.shots'
mkdirSync(OUT, { recursive: true })

const lb = await (await fetch(`${BASE}/api/leaderboard?sort=age`)).json().catch(() => ({ entries: [] }))
const gremlin = lb.entries?.[0]?.address
const pages = [
  ['home', '/'],
  ['hatch', '/hatch/'],
  ['board', FEED()],
  ['community', '/c/general'],
  ['post', '/p/1'],
  ...(gremlin ? [['profile', `/g/${gremlin}`]] : []),
]
function FEED() { return '/board' }

const sizes = [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]
const browser = await chromium.launch()
for (const scheme of ['light', 'dark']) {
  for (const [size, viewport] of sizes) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    for (const [name, path] of pages) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png`, fullPage: true })
    }
    await ctx.close()
  }
}
await browser.close()
console.log(`saved ${pages.length * 4} screenshots to ${OUT}/`)
