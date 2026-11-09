// Probe: does Phantom flag personal_sign as unsafe because of the site, or the message? Signs nothing that leaves here.
import { launchWallet } from './launch.mjs'
import { approveConnect } from './approve.mjs'
import { TEST_ADDRESS } from './secrets.mjs'
const out = process.argv[2]
const w = await launchWallet('phantom')
for (const origin of ['https://example.com', 'https://gremlinz.ai']) {
  for (const [label, msg] of [['plain', 'hello from the gremlinz harness'], ['board-shaped', 'POST /api/vote\n1794250000\n0x' + 'ab'.repeat(32)]]) {
    const page = await w.context.newPage()
    await page.goto(origin)
    const eth = 'window.phantom?.ethereum'
    const conn = page.evaluate(`${eth}.request({ method: 'eth_requestAccounts' })`).catch((e) => String(e))
    await approveConnect(w).catch(() => {})
    await conn
    const hex = '0x' + Buffer.from(msg).toString('hex')
    page.evaluate(`${eth}.request({ method: 'personal_sign', params: ['${hex}', '${TEST_ADDRESS}'] })`).catch(() => {})
    const pop = await w.waitForWalletPage({ timeout: 15000 }).catch(() => null)
    await new Promise((r) => setTimeout(r, 3000))
    const text = pop ? (await pop.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220) : 'no popup'
    console.log(`${origin} ${label}: ${/unsafe|failed to simulate/i.test(text) ? 'FLAGGED' : 'clean'} | ${text}`)
    if (pop) { await pop.screenshot({ path: `${out}/phantom-${new URL(origin).hostname}-${label}.png` }).catch(() => {}); await pop.close().catch(() => {}) }
    await page.close()
  }
}
await w.close()
