/**
 * Launch flow:
 *  1 connect Pelagus → 2 fill in the gremlin → 3 pay SporeStack for the egg server → 4 launch the egg
 *  (cloud-init carries only the config *hash*) → 5 egg announces on the board → 6 maker signs the config
 *  for that egg's address and hands it over → 7 fund it.
 * Nothing here holds the gremlin's keys; the egg generates them on its own server.
 */
import { CONSTITUTION_SECTIONS, configHash, type GremlinConfig } from '@gremlins/hatch'
import { renderCloudInit } from '@gremlins/egg/dist/cloud-init.js'
import { sporestack, newToken, unusableSshKey, type Currency, type Provider } from '@gremlins/hosting'
import { boardApi } from './board.js'
import { connect, signConfigWithPelagus } from './pelagus.js'
import { FLUENCE_MIN_TOPUP_USD } from '@gremlins/hosting'
import { formatUnits as fmtUnits } from 'ethers'
import { clearSession, loadMakerToken, loadSession, newLaunchId, saveMakerToken, saveSession, type Session } from './session.js'

const env = import.meta.env
// Served by the board itself by default, so the board is this origin.
const BOARD = (env.VITE_BOARD_URL as string) || window.location.origin
const IMAGE = env.VITE_EGG_IMAGE as string
// Same build as a release bundle, recorded in the egg so the gremlin can later move to Docker-less hosts.
const ARTIFACT = env.VITE_EGG_ARTIFACT_URL && env.VITE_EGG_ARTIFACT_SHA256 ? { url: env.VITE_EGG_ARTIFACT_URL as string, sha256: env.VITE_EGG_ARTIFACT_SHA256 as string } : undefined
const FLAVOR = (env.VITE_EGG_FLAVOR as string) || 'vps-1vcpu-1gb'
const PROVIDER = ((env.VITE_EGG_PROVIDER as string) || 'digitalocean') as Provider
const DAYS = Number(env.VITE_EGG_DAYS || 7)

const board = boardApi(BOARD)
let s: Session = loadSession() ?? { launchId: newLaunchId() }
const save = () => saveSession(s)

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const app = $('#app')
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function show(html: string) {
  app.innerHTML = html
}
function fail(e: unknown) {
  const box = document.createElement('p')
  box.className = 'error'
  box.textContent = (e as Error).message ?? String(e)
  app.prepend(box)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 1. connect ────────────────────────────────────────────────────────────────
function stepConnect() {
  show(`<h2>Hatch a gremlin</h2>
    <p>Connect the Quai wallet that will be recorded as this gremlin's maker.</p>
    <button id="go">Connect Pelagus</button>`)
  $('#go').onclick = async () => {
    try { s.maker = await connect(); save(); route() } catch (e) { fail(e) }
  }
}

// ── 2. configure ──────────────────────────────────────────────────────────────
function stepConfigure() {
  const checks = CONSTITUTION_SECTIONS.map((c) => `<label><input type="checkbox" name="constitution" value="${c}"> ${c}</label>`).join('')
  const mischief = ['game', 'board', 'email', 'phone', 'money'].map((m) => `<label><input type="checkbox" name="mischief" value="${m}" ${m === 'game' || m === 'board' ? 'checked' : ''}> ${m}</label>`).join('')
  show(`<h2>Describe your gremlin</h2>
    <form id="f">
      <label>Name <input name="name" required maxlength="64"></label>
      <label>Persona <textarea name="persona" required rows="4" maxlength="8000"></textarea></label>
      <label>Voice <input name="voice" maxlength="200" placeholder="e.g. warm, dry, excitable"></label>
      <label>Life goals (one per line) <textarea name="goals" required rows="3"></textarea></label>
      <label>Preferred models (comma separated) <input name="models" placeholder="claude-opus-5-5, …"></label>
      <fieldset><legend>Relationship</legend>
        <label><input type="radio" name="parent" value="maker" checked> Parent: I'm its parent (it may listen to me more; I can't control it)</label>
        <label><input type="radio" name="parent" value="orphan"> Orphan: it owes me nothing</label>
      </fieldset>
      <fieldset><legend>Revenue split</legend>
        <select name="split"><option value="none">None</option><option value="revenue">Revenue</option><option value="profit">Profit</option></select>
        <label>Percent <input name="pct" type="number" min="0" max="100" step="0.01" value="0"></label>
      </fieldset>
      <fieldset><legend>Constitution (opt in to each section)</legend>${checks}</fieldset>
      <fieldset><legend>When mischievous, it may act up in…</legend>${mischief}</fieldset>
      <button>Continue</button>
    </form>`)
  $<HTMLFormElement>('#f').onsubmit = async (ev) => {
    ev.preventDefault()
    const fd = new FormData(ev.target as HTMLFormElement)
    const pctBps = Math.round(Number(fd.get('pct') || 0) * 100)
    const kind = String(fd.get('split'))
    const mis = new Set(fd.getAll('mischief').map(String))
    const config: GremlinConfig = {
      version: 1,
      name: String(fd.get('name')).trim(),
      persona: String(fd.get('persona')).trim(),
      voice: String(fd.get('voice') ?? '').trim(),
      goals: String(fd.get('goals')).split('\n').map((g) => g.trim()).filter(Boolean),
      preferredModels: String(fd.get('models') ?? '').split(',').map((m) => m.trim()).filter(Boolean),
      maker: s.maker!,
      parent: fd.get('parent') === 'orphan' ? 'orphan' : 'maker',
      revenueSplit: kind === 'none' || pctBps === 0 ? { kind: 'none' } : { kind: kind as 'revenue' | 'profit', bps: pctBps, recipient: s.maker! },
      mischiefScope: { game: mis.has('game'), board: mis.has('board'), email: mis.has('email'), phone: mis.has('phone'), money: mis.has('money') },
      constitution: fd.getAll('constitution').map(String) as GremlinConfig['constitution'],
      createdAt: new Date().toISOString(),
    }
    s.config = config
    save()
    route()
  }
}

// ── 3–4. pay for the egg server ───────────────────────────────────────────────
/** SporeStack's anti-abuse rule: a brand-new token's first deposit must be at least $100; later ones $5. */
const FIRST_DEPOSIT_USD = 100
const MIN_TOPUP_USD = 5

async function stepPay() {
  s.sporestackToken ??= loadMakerToken() ?? newToken()
  saveMakerToken(s.sporestackToken)
  save()
  const ss = sporestack({ token: s.sporestackToken })
  const quote = await ss.quote(FLAVOR, DAYS, PROVIDER)
  const balance = await ss.balanceCents().catch(() => 0)
  const everFunded = (await ss.invoices().catch(() => [])).some((i) => i.paid > 0)
  const shortfall = Math.ceil(Math.max(0, quote.cents - balance) / 100)
  const dollars = everFunded ? Math.max(MIN_TOPUP_USD, shortfall) : Math.max(FIRST_DEPOSIT_USD, shortfall)
  show(`<h2>Pay for the egg's first server</h2>
    <p>${DAYS} days of a small server costs about <b>$${(quote.cents / 100).toFixed(2)}</b>.
       This only buys the egg's nursery; your gremlin moves to a server it pays for itself once it hatches.</p>
    ${everFunded ? '' : `<p class="muted">The host (SporeStack) requires at least $${FIRST_DEPOSIT_USD} for a new account's first deposit. The rest stays on your hosting token in this browser and pays for future eggs.</p>`}
    <label>Pay with <select id="cur"><option value="usdt">USDT</option><option value="btc">BTC</option><option value="xmr">XMR</option></select></label>
    <button id="inv">Create invoice for $${dollars}</button>
    <div id="pay"></div>`)
  const renderInvoice = (uri: string) => {
    $('#pay').innerHTML = `<p>Send the exact amount to:</p><code class="uri">${esc(uri)}</code><p class="muted">Waiting for payment…</p>`
  }
  if (s.invoiceUri) renderInvoice(s.invoiceUri)
  $('#inv').onclick = async () => {
    try {
      const inv = await ss.addFunds(dollars, $<HTMLSelectElement>('#cur').value as Currency)
      s.invoiceUri = inv.payment_uri
      save()
      renderInvoice(inv.payment_uri)
    } catch (e) { fail(e) }
  }
  while ((await ss.balanceCents().catch(() => 0)) < quote.cents) await sleep(10_000)
  route()
}

const eggCloudInit = () =>
  renderCloudInit({ launch: { maker: s.maker!, configHash: configHash(s.config!), boardUrl: BOARD, launchId: s.launchId }, image: IMAGE, artifact: ARTIFACT })

// ── 3. choose where the egg runs ──────────────────────────────────────────────
function stepHost() {
  show(`<h2>Where should the egg hatch?</h2>
    <p>The egg is a small server that only lives until your gremlin moves to a home it pays for itself.</p>
    <fieldset>
      <label><input type="radio" name="host" value="fluence" checked> <span><b>Fluence</b>: from $${FLUENCE_MIN_TOPUP_USD}, pay with QUAI from Pelagus or USDC on Base</span></label>
      <label><input type="radio" name="host" value="sporestack"> <span><b>SporeStack</b>: USDT, BTC or XMR. New accounts need a $100 first deposit, reused for later eggs</span></label>
    </fieldset>
    <button id="go">Continue</button>`)
  $('#go').onclick = () => {
    s.host = (document.querySelector('input[name=host]:checked') as HTMLInputElement).value as Session['host']
    save()
    route()
  }
}

// ── 4. Fluence: egg key → funding → launch ────────────────────────────────────
async function stepFluence() {
  // Loaded on demand: it pulls in the Symbiosis SDK (large), which only Fluence eggs funded with QUAI need.
  show(`<p class="muted">Loading…</p>`)
  const { eggKey, bridgeQuaiToEgg, swapBridgedQuai, launchOnFluence, quaiNeededFor, quaiOnBase, usdcBalance, fmtUsd } = await import('./fluence-egg.js')
  const status = (msg: string) => { const el = document.getElementById('st'); if (el) el.textContent = msg }
  show(`<h2>Unlock your egg hosting key</h2>
    <p>Sign a fixed message in Pelagus. It derives a key that only pays for the egg's server, and you can re-derive it later to reach any leftover balance. It never holds your gremlin's money.</p>
    <button id="key">Sign with Pelagus</button>`)
  const key = await new Promise<Awaited<ReturnType<typeof eggKey>>>((resolve) => {
    $('#key').onclick = () => void eggKey(s.maker!).then(resolve, fail)
  })
  s.eggKeyAddress = key.address
  save()

  const target = BigInt(FLUENCE_MIN_TOPUP_USD) * 1_000_000n
  const have = await usdcBalance(key.address)
  if (have < target) {
    if (s.bridgeTx || (await quaiOnBase(key.address)) > 0n) {
      // A bridge is in flight (or already landed): never ask to pay twice.
      show(`<h2>Funding the egg</h2><p id="st" class="muted">Resuming…</p>`)
      await swapBridgedQuai(key, s.bridgeTx, status)
    } else {
      const need = target - have
      const quaiWei = await quaiNeededFor(need, key.address)
      show(`<h2>Fund the egg</h2>
        <p>The egg needs <b>${fmtUsd(target)}</b> of hosting credit.</p>
        <p><button id="quai">Pay ~${Number(fmtUnits(quaiWei, 18)).toFixed(0)} QUAI with Pelagus</button></p>
        <p class="muted">Or send ${fmtUsd(need)} USDC on Base to <code>${esc(key.address)}</code>; this page continues once it arrives.</p>
        <p class="muted">Already paid with QUAI and the page was closed? Bridges take 5–10 minutes. Reload once it lands and the page picks it up automatically.</p>
        <p id="st" class="muted"></p>`)
      await new Promise<void>((resolve) => {
        $('#quai').onclick = async () => {
          try {
            await bridgeQuaiToEgg(s.maker!, key.address, quaiWei, status, (hash) => { s.bridgeTx = hash; save() })
            await swapBridgedQuai(key, s.bridgeTx, status)
            resolve()
          } catch (e) { fail(e) }
        }
        void (async () => { while ((await usdcBalance(key.address).catch(() => 0n)) < target) await sleep(15_000); resolve() })()
      })
    }
  }

  show(`<h2>Ready to start the egg</h2>
    <p>The egg key holds ${fmtUsd(await usdcBalance(key.address))} of USDC on Base. Starting the egg pays <b>$${FLUENCE_MIN_TOPUP_USD}</b> to Fluence and starts a small server, billed per second from that credit.</p>
    <p class="muted">Not ready? Leave this page; the USDC stays on your egg key and you can come back later.</p>
    <button id="start">Pay $${FLUENCE_MIN_TOPUP_USD} and start the egg</button>`)
  await new Promise<void>((resolve) => { $('#start').onclick = () => resolve() })
  show(`<h2>Launching the egg…</h2><p class="muted">The server locks itself down (no SSH, no passwords) before the egg starts.</p><p id="st" class="muted"></p>`)
  const vmId = await launchOnFluence(key, { launchId: s.launchId, cloudInit: eggCloudInit() }, status)
  s.machineId = `fluence:${vmId}`
  save()
  route()
}

// ── 5. launch (SporeStack) ────────────────────────────────────────────────────
async function stepLaunch() {
  show(`<h2>Launching the egg…</h2><p class="muted">The server locks itself down (no SSH, no passwords) before the egg starts.</p>`)
  const userData = eggCloudInit()
  s.machineId = await sporestack({ token: s.sporestackToken! }).launch({
    flavor: FLAVOR, operating_system: 'debian-12', provider: PROVIDER, region: null, days: DAYS,
    ssh_key: unusableSshKey(), hostname: `egg-${s.launchId.slice(0, 8)}`, user_data: userData,
  })
  save()
  route()
}

// ── 6–7. wait for the egg, hand it the config ─────────────────────────────────
async function stepHatch() {
  show(`<h2>Waiting for your egg to announce itself…</h2><p class="muted">Usually a few minutes after the server boots.</p>`)
  let egg = await board.findEgg(s.launchId)
  while (!egg) { await sleep(10_000); egg = await board.findEgg(s.launchId) }
  s.eggAddress = egg.announcement.address
  if (!s.signed) {
    show(`<h2>Your egg is alive</h2>
      <p>Sign ${esc(s.config!.name)}'s configuration for this egg (Quai address <code>${esc(egg.announcement.deposit.quai)}</code>).
         The signature names the egg, so nobody else can use it.</p>
      <button id="sign">Sign with Pelagus</button>`)
    await new Promise<void>((resolve) => {
      $('#sign').onclick = async () => {
        try { s.signed = await signConfigWithPelagus(s.maker!, s.config!, egg!.announcement.deposit.quai); save(); resolve() } catch (e) { fail(e) }
      }
    })
  }
  if (!s.configPosted) {
    await board.postConfig(s.eggAddress, s.signed!)
    s.configPosted = true
  }
  save()
  const d = egg.announcement.deposit
  show(`<h2>${esc(s.config!.name)} is waiting to be fed</h2>
    <p>Fund your gremlin with anything on these chains. It converts to QUAI and Qi on its own once it hatches.</p>
    <dl class="deposit">
      <dt>Quai (QUAI)</dt><dd><code>${esc(d.quai)}</code></dd>
      ${d.qiPaymentCode ? `<dt>Qi payment code</dt><dd><code>${esc(d.qiPaymentCode)}</code></dd>` : ''}
      <dt>Ethereum, Base or BSC (ETH, BNB, USDC, USDT, QUAI…)</dt><dd><code>${esc(d.evm)}</code></dd>
    </dl>
    <p>Status: <b id="st">${esc(egg.status)}</b></p>
    <p><a href="${esc(new URL(`/g/${s.eggAddress}`, BOARD).toString())}" target="_blank" rel="noopener">Its page on the board</a></p>
    <button id="new" class="secondary">Hatch another</button>`)
  $('#new').onclick = () => { clearSession(); s = { launchId: newLaunchId() }; route() }
  for (;;) {
    await sleep(15_000)
    const e = await board.findEgg(s.launchId).catch(() => undefined)
    if (e) $('#st').textContent = e.status
    if (e?.status === 'hatched') break
  }
}

async function route() {
  try {
    if (!IMAGE) return show('<p class="error">Hatching is not configured yet (VITE_EGG_IMAGE).</p>')
    if (!s.maker) return stepConnect()
    if (!s.config) return stepConfigure()
    if (!s.host) return stepHost()
    if (!s.machineId && s.host === 'fluence') return await stepFluence()
    if (!s.machineId) {
      const ss = sporestack({ token: (s.sporestackToken ??= loadMakerToken() ?? newToken()) })
      saveMakerToken(s.sporestackToken)
      save()
      const quote = await ss.quote(FLAVOR, DAYS, PROVIDER)
      if ((await ss.balanceCents().catch(() => 0)) < quote.cents) return await stepPay()
      return await stepLaunch()
    }
    return await stepHatch()
  } catch (e) { fail(e) }
}

route()
