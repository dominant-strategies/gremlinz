// Prove the WebAssembly build works in a real browser: headless Chromium runs both parties of key generation and a
// signature (packages/hosting/dist/cbmpc.js, as bundlers load it), and Node checks the results.
//   npx tsc -b packages/hosting && node packages/hosting/cbmpc/browser-check.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pw from 'playwright'
import { SigningKey, computeAddress, keccak256, recoverAddress, toUtf8Bytes } from 'ethers'

const root = fileURLToPath(new URL('..', import.meta.url)) // packages/hosting
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' }
const page = `<!doctype html><script type="module">
import { CbmpcRun, cbmpcPublicKey, cbmpcPrivateShare } from '/dist/cbmpc.js'
const names = { p1: 'browser-check:board', p2: 'browser-check:maker' }
async function relay(a, b) {
  let ra = await a.step([]), rb
  for (let i = 0; i < 50; i++) {
    if (!rb?.done) rb = await b.step(ra.out)
    if (ra.done && rb.done) return [ra.result, rb.result]
    if (!ra.done) ra = await a.step(rb.out)
    if (ra.done && rb.done) return [ra.result, rb.result]
  }
  throw new Error('stuck')
}
const hex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
window.check = async (hashHex) => {
  const t0 = performance.now()
  const [k1, k2] = await relay(CbmpcRun.dkg({ self: 0, ...names }), CbmpcRun.dkg({ self: 1, ...names }))
  const t1 = performance.now()
  const hash = Uint8Array.from(hashHex.slice(2).match(/../g).map((h) => parseInt(h, 16)))
  const [der] = await relay(CbmpcRun.sign({ self: 0, ...names }, k1, hash), CbmpcRun.sign({ self: 1, ...names }, k2, hash))
  const t2 = performance.now()
  return { pub: hex(await cbmpcPublicKey(k1)), pub2: hex(await cbmpcPublicKey(k2)), der: hex(der), x1: hex(await cbmpcPrivateShare(k1)), x2: hex(await cbmpcPrivateShare(k2)), keygenMs: t1 - t0, signMs: t2 - t1, ua: navigator.userAgent }
}
window.ready = true
</script>`

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page)
  const file = normalize(join(root, path))
  if (!file.startsWith(root)) return res.writeHead(403).end()
  try {
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file))
  } catch {
    res.writeHead(404).end()
  }
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const browser = await pw[process.env.BROWSER ?? 'chromium'].launch() // BROWSER=webkit|firefox if installed
try {
  const tab = await browser.newPage()
  tab.on('pageerror', (e) => console.error('page error:', e))
  await tab.goto(`http://127.0.0.1:${server.address().port}/`)
  await tab.waitForFunction(() => window.ready)
  const hash = keccak256(toUtf8Bytes('gremlins browser check'))
  const r = await tab.evaluate((h) => window.check(h), hash)
  const address = computeAddress(SigningKey.computePublicKey(r.pub, false))
  if (r.pub2 !== r.pub) throw new Error('parties disagree on the public key')
  // DER → r, s (low s), then recover
  const der = Buffer.from(r.der.slice(2), 'hex')
  let i = 2
  const int = () => { const n = der[i + 1]; const v = BigInt('0x' + der.subarray(i + 2, i + 2 + n).toString('hex')); i += 2 + n; return v }
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const R = int(); let S = int(); if (S > N / 2n) S = N - S
  const rs = '0x' + R.toString(16).padStart(64, '0') + S.toString(16).padStart(64, '0')
  const ok = [27, 28].some((v) => recoverAddress(hash, rs + v.toString(16)) === address)
  const key = '0x' + ((BigInt(r.x1) + BigInt(r.x2)) % N).toString(16).padStart(64, '0')
  if (!ok) throw new Error('browser signature does not recover to the joint address')
  if (computeAddress(key) !== address) throw new Error('shares do not add up to the key')
  console.log(`browser ok: ${r.ua}\n  address ${address}\n  keygen ${r.keygenMs.toFixed(0)} ms, sign ${r.signMs.toFixed(0)} ms (both parties in one tab)`)
} finally {
  await browser.close()
  server.close()
}
