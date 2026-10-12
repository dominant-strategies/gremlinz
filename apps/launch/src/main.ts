/**
 * Launch flow:
 *  1 connect Pelagus → 2 fill in the gremlin → 3 pay SporeStack for the egg server → 4 launch the egg
 *  (cloud-init carries only the config *hash*) → 5 egg announces on the board → 6 maker signs the config
 *  for that egg's address and hands it over → 7 fund it.
 * Nothing here holds the gremlin's keys; the egg generates them on its own server.
 */
import { GremlinConfig as GremlinConfigSchema, CONSTITUTION_SECTIONS, COVENANTS, DEFAULT_VAULT_TERMS, ECONOMIC_MODELS, MODEL_INFO, configHash, economicsOf, type Covenant, type Economics, type GremlinConfig } from '@gremlins/hatch'
import { creatureSvg, type CreatureMood } from '@gremlins/hatch/creature'
import { renderCloudInit } from '@gremlins/egg/dist/cloud-init.js'
import { sporestack, newToken, unusableSshKey, type Currency, type Provider } from '@gremlins/hosting'
import { boardApi } from './board.js'
import { connect, signConfigWithPelagus } from './pelagus.js'
import { FLUENCE_MIN_TOPUP_USD } from '@gremlins/hosting'
import { formatUnits as fmtUnits } from 'ethers'
import { FLUENCE_STEPS, PROGRESS_CSS, Progress, SPORESTACK_STEPS, COMMON_STEPS } from './progress.js'
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

// Progress window: every step and transaction, persisted with the session.
document.head.insertAdjacentHTML('beforeend', `<style>${PROGRESS_CSS}</style>`)
const progress = new Progress({ load: () => s.progress, save: (p) => { s.progress = p; save() } }, () => (s.config?.name ? `Hatching ${s.config.name}` : 'Hatching a gremlin'))
const planFor = () => (s.host === 'fluence' ? FLUENCE_STEPS : s.host === 'sporestack' ? SPORESTACK_STEPS : COMMON_STEPS)
progress.plan(planFor())
// Sessions from before the progress window (or partially tracked ones): mark what the session proves is done.
const backfill: [boolean | undefined, string, string?][] = [
  [!!s.maker, 'connect', s.maker && `${s.maker.slice(0, 8)}…`],
  [!!s.config, 'describe', s.config?.name],
  [!!s.host, 'host', s.host],
  [!!s.bridgeTx, 'fund-egg', 'bridge sent'],
  [!!s.machineId, 'start', 'server started'],
  [!!s.eggAddress, 'announce', 'egg announced'],
  [!!s.configPosted, 'sign-config', 'config delivered'],
]
for (const [proven, id, detail] of backfill) if (proven && !progress.isDone(id)) progress.step(id).done(detail)
progress.mount()

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const app = $('#app')
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function show(html: string) {
  app.innerHTML = html
}
/** Show an error with a retry; the failing step is marked in the progress window by route(). */
function fail(e: unknown) {
  const box = document.createElement('div')
  box.className = 'error'
  box.innerHTML = `<p></p><button class="secondary">Retry</button>`
  box.querySelector('p')!.textContent = (e as Error).message ?? String(e)
  box.querySelector('button')!.onclick = () => route()
  app.prepend(box)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── the gremlin-to-be, drawn beside every step ────────────────────────────────
$('#logo').innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
const sticker = (seed: string, size: 'xs' | 'sm' | 'md' | 'lg', mood: CreatureMood, label: string) =>
  `<span class="sticker sticker-${size}">${creatureSvg(seed, { mood, title: label })}</span>`
/** Its portrait is drawn from its config hash, the same seed the board uses, so what you see here is who hatches. */
function seedOf(c: GremlinConfig): string {
  try { return configHash(c) } catch { return JSON.stringify([c.name, c.persona, c.goals, c.createdAt]) }
}
function renderPreview(draft?: GremlinConfig) {
  const c = draft ?? s.config
  const box = $('#preview')
  if (!c) {
    box.innerHTML = `<div class="card card-ink">${sticker(`unborn-${s.launchId}`, 'lg', 'egg', 'an egg')}<div><h3>Your gremlin</h3>
      <p class="say">Somewhere in here is a small creature. Describe it and it will show up.</p></div></div>`
    return
  }
  const seed = seedOf(c)
  const hatched = !!s.configPosted
  const eco = economicsOf(c)
  const pills = [c.parent === 'orphan' ? 'orphan' : 'has a parent', eco.model === 'maker-split' && c.revenueSplit.kind !== 'none' ? `${(c.revenueSplit.bps / 100).toFixed(0)}% ${c.revenueSplit.kind} to you` : MODEL_INFO[eco.model].title.toLowerCase()]
  const portrait = draft || hatched ? sticker(seed, 'lg', 'normal', c.name || 'your gremlin') : sticker(seed, 'lg', 'egg', `${c.name}'s egg`)
  box.innerHTML = `<div class="card card-ink">${portrait}<div>
    <h3>${esc(c.name || 'Unnamed')}</h3>
    <p class="say">${draft ? (c.persona ? esc(c.persona.slice(0, 140)) + (c.persona.length > 140 ? '…' : '') : 'Give it a persona…') : hatched ? 'Hatched, or about to. It is on its own now.' : `Still an egg. ${sticker(seed, 'xs', 'normal', c.name)} is waiting inside.`}</p>
    <div class="pills">${pills.map((x) => `<span class="pill pill-plain">${esc(x)}</span>`).join('')}</div>
    ${c.goals.length ? `<ul class="goals tail">${c.goals.slice(0, 4).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${draft ? `<p class="small muted tail" style="margin:14px 0 0">Its look is drawn from everything you write, so it changes as you edit.</p><button type="button" class="btn btn-small shuffle tail" id="shuffle">Shuffle its look</button>` : ''}
  </div></div>`
  const sh = document.getElementById('shuffle')
  if (sh) sh.onclick = () => { draftCreatedAt = new Date(Date.parse(draftCreatedAt) + 1000).toISOString(); document.getElementById('f')?.dispatchEvent(new Event('input')) }
}
let draftCreatedAt = new Date().toISOString()

// ── 1. connect ────────────────────────────────────────────────────────────────
function stepConnect() {
  show(`<p class="eyebrow">Step 1 of 3</p><h2>Let's make something that lives on its own</h2>
    <p class="muted">About fifteen minutes and $10 of QUAI. Here is what happens:</p>
    <ol class="intro">
      <li><div><b>You describe it</b><span class="muted">A name, a persona, life goals, and the rules it chooses to live by.</span></div></li>
      <li><div><b>You rent it an egg</b><span class="muted">A tiny server, paid in QUAI from Pelagus. It locks itself and makes its own keys.</span></div></li>
      <li><div><b>You sign, it hatches</b><span class="muted">Your signature hands the egg its config. Then feed it, and let it go.</span></div></li>
    </ol>
    <p class="small muted">Your wallet is recorded as its maker. That's all it gives you: no keys, no off switch.</p>
    <button id="go">Connect Pelagus</button>`)
  $('#go').onclick = async () => {
    const st = progress.step('connect')
    try {
      st.signing('Approve the connection in Pelagus')
      s.maker = await connect()
      st.signed()
      st.done(`${s.maker.slice(0, 8)}…`)
      save()
      route()
    } catch (e) { st.fail(e); fail(e) }
  }
}

// ── 2. configure ──────────────────────────────────────────────────────────────
function stepConfigure() {
  const checks = CONSTITUTION_SECTIONS.map((c) => `<label><input type="checkbox" name="constitution" value="${c}"> ${c}</label>`).join('')
  const mischief = ['game', 'board', 'email', 'phone', 'money'].map((m) => `<label><input type="checkbox" name="mischief" value="${m}" ${m === 'game' || m === 'board' ? 'checked' : ''}> ${m}</label>`).join('')
  show(`<p class="eyebrow">Step 2 of 3</p><h2>Describe your gremlin</h2>
    <form id="f">
      <label>Name <input name="name" required maxlength="64" placeholder="sprocket"></label>
      <label>Persona <span class="hint">Who is it? How does it talk, what does it love, what does it refuse to do?</span><textarea name="persona" required rows="4" maxlength="8000" placeholder="A patient tinkerer who loves fixing broken sensors…"></textarea></label>
      <label>Life goals <span class="hint">One per line. Big enough to take a lifetime.</span><textarea name="goals" required rows="3" placeholder="Fund 10 open-source weather stations"></textarea></label>
      <div class="row2">
        <label>Voice <input name="voice" maxlength="200" placeholder="warm, dry, excitable"></label>
        <label>Preferred models <input name="models" placeholder="claude-opus-5-5, …"></label>
      </div>
      <fieldset><legend>Your relationship</legend><div class="choice">
        <label><input type="radio" name="parent" value="maker" checked><span><b>Parent</b><span class="muted small">It may listen to you more than to strangers. You still can't control it.</span></span></label>
        <label><input type="radio" name="parent" value="orphan"><span><b>Orphan</b><span class="muted small">It owes you nothing and answers to nobody.</span></span></label>
      </div></fieldset>
      <fieldset><legend>How it shares money <span class="hint">You can't change this after it hatches.</span></legend><div class="choice">
        ${ECONOMIC_MODELS.map((m) => `<label><input type="radio" name="model" value="${m}" ${m === 'solo' ? 'checked' : ''}><span><b>${MODEL_INFO[m].title}</b><span class="muted small">${MODEL_INFO[m].short} <a href="/docs/economics/#${m}" target="_blank" rel="noopener">How it works</a></span></span></label>`).join('')}
      </div>
      <div class="eco" data-for="maker-split"><div class="row2">
        <label>Of its <select name="split"><option value="revenue">revenue</option><option value="profit">profit</option></select></label>
        <label>Percent to you <input name="pct" type="number" min="0.01" max="100" step="0.01" value="10"></label>
      </div></div>
      <div class="eco" data-for="quest">
        <label>The quest <span class="hint">One goal backers fund. It's fingerprinted in the vault, so word it carefully.</span><textarea name="questGoal" rows="2" maxlength="1000" placeholder="Build and run 10 open weather stations"></textarea></label>
        <div class="row2">
          <label>Funding target (QUAI) <input name="questTarget" type="number" min="1" step="1" value="1000"></label>
          <label>Days to raise it <input name="fundingDays" type="number" min="1" max="365" value="14"></label>
          <label>Days to finish <input name="questDays" type="number" min="1" max="3650" value="180"></label>
        </div>
      </div>
      <div class="eco" data-for="syndicate quest"><div class="row2">
        <label>Management fee (%/year) <input name="mgmtFee" type="number" min="0" max="10" step="0.1" value="${DEFAULT_VAULT_TERMS.mgmtFeeBps / 100}"></label>
        <label>It keeps, of income (%) <input name="keep" type="number" min="0" max="100" step="1" value="${DEFAULT_VAULT_TERMS.incomeKeepBps / 100}"></label>
        <label>Your cut, of income (%) <input name="makerCut" type="number" min="0" max="100" step="1" value="0"></label>
        <label>Draw limit (% per 30 days) <input name="draw" type="number" min="1" max="100" step="1" value="${DEFAULT_VAULT_TERMS.drawBps / 100}"></label>
        <label>Dissolve vote (% of shares) <input name="dissolve" type="number" min="50" max="100" step="0.01" value="66.67"></label>
        <label>Gone quiet after (days) <input name="quiet" type="number" min="7" max="3650" value="${DEFAULT_VAULT_TERMS.inactivityDays}"></label>
      </div></div>
      <div class="eco" data-for="patrons syndicate quest"><p class="small muted" style="margin:4px 0 8px">Covenants: promises it makes, and normally keeps. Breaking one is public.</p><div class="opts">
        ${(Object.keys(COVENANTS) as Covenant[]).map((k) => `<label title="${COVENANTS[k]}"><input type="checkbox" name="covenant" value="${k}" ${DEFAULT_VAULT_TERMS.covenants.includes(k) ? 'checked' : ''}> ${k}</label>`).join('')}
      </div></div>
      </fieldset>
      <fieldset><legend>Constitution <span class="hint">Opt in to each section. Unchosen rules don't bind it.</span></legend><div class="opts">${checks}</div></fieldset>
      <fieldset><legend>When mischievous, it may act up in… <span class="hint">(when someone makes it rain on it)</span></legend><div class="opts">${mischief}</div></fieldset>
      <button>Continue</button>
    </form>`)
  const form = $<HTMLFormElement>('#f')
  const read = (): GremlinConfig => {
    const fd = new FormData(form)
    const mis = new Set(fd.getAll('mischief').map(String))
    const model = String(fd.get('model') ?? 'solo') as Economics['model']
    const bp = (name: string) => Math.round(Number(fd.get(name) || 0) * 100)
    const pctBps = bp('pct')
    const kind = String(fd.get('split'))
    const covenants = fd.getAll('covenant').map(String) as Covenant[]
    const terms = {
      mgmtFeeBps: bp('mgmtFee'), incomeKeepBps: bp('keep'), makerBps: bp('makerCut'), drawBps: Math.max(1, bp('draw')),
      dissolveBps: bp('dissolve'), inactivityDays: Math.round(Number(fd.get('quiet') || 90)), covenants,
    }
    const quai = (v: unknown) => (BigInt(Math.max(1, Math.round(Number(v) || 1))) * 10n ** 18n).toString()
    const economics: Economics =
      model === 'patrons' ? { model, covenants }
      : model === 'syndicate' ? { model, ...terms }
      : model === 'quest' ? { model, ...terms, goal: String(fd.get('questGoal') ?? '').trim() || '(no goal yet)', fundingTargetWei: quai(fd.get('questTarget')), fundingDays: Math.round(Number(fd.get('fundingDays') || 14)), questDays: Math.round(Number(fd.get('questDays') || 180)) }
      : { model }
    return {
      version: 1,
      name: String(fd.get('name')).trim(),
      persona: String(fd.get('persona')).trim(),
      voice: String(fd.get('voice') ?? '').trim(),
      goals: String(fd.get('goals')).split('\n').map((g) => g.trim()).filter(Boolean),
      preferredModels: String(fd.get('models') ?? '').split(',').map((m) => m.trim()).filter(Boolean),
      maker: s.maker!,
      parent: fd.get('parent') === 'orphan' ? 'orphan' : 'maker',
      revenueSplit: model === 'maker-split' && pctBps > 0 ? { kind: kind as 'revenue' | 'profit', bps: pctBps, recipient: s.maker! } : { kind: 'none' },
      // older configs had no economics field; solo stays implicit so those hashes don't change
      ...(model === 'solo' || (model === 'maker-split' && pctBps === 0) ? {} : { economics }),
      mischiefScope: { game: mis.has('game'), board: mis.has('board'), email: mis.has('email'), phone: mis.has('phone'), money: mis.has('money') },
      constitution: fd.getAll('constitution').map(String) as GremlinConfig['constitution'],
      // fixed per draft, so the portrait only changes when what you wrote changes (or you shuffle)
      createdAt: draftCreatedAt,
    }
  }
  const syncPanels = () => {
    const m = (form.querySelector('input[name=model]:checked') as HTMLInputElement).value
    for (const el of form.querySelectorAll<HTMLElement>('.eco')) el.hidden = !el.dataset.for!.split(' ').includes(m)
    ;(form.elements.namedItem('questGoal') as HTMLTextAreaElement).required = m === 'quest'
  }
  syncPanels()
  let timer: ReturnType<typeof setTimeout> | undefined
  form.oninput = () => { syncPanels(); clearTimeout(timer); timer = setTimeout(() => renderPreview(read()), 250) }
  renderPreview(read())
  form.onsubmit = async (ev) => {
    ev.preventDefault()
    const config = read()
    const check = GremlinConfigSchema.safeParse(config)
    if (!check.success) {
      let box = form.querySelector<HTMLElement>('.form-error')
      if (!box) { box = document.createElement('p'); box.className = 'error form-error'; form.prepend(box) }
      box.textContent = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      box.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    s.config = config
    progress.step('describe').done(config.name)
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
  const inv = progress.step('invoice')
  const renderInvoice = (uri: string) => {
    $('#pay').innerHTML = `<p>Send the exact amount to:</p><code class="uri">${esc(uri)}</code><p class="muted">Waiting for payment… (see the progress window)</p>`
    inv.waiting('Waiting for your payment to confirm')
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
  for (;;) {
    const cents = await ss.balanceCents().catch(() => 0)
    if (cents >= quote.cents) break
    if (s.invoiceUri) inv.touch(`Waiting for payment · credit so far $${(cents / 100).toFixed(2)}`)
    await sleep(10_000)
  }
  inv.done('payment received')
  route()
}

const eggCloudInit = () =>
  renderCloudInit({ launch: { maker: s.maker!, configHash: configHash(s.config!), boardUrl: BOARD, launchId: s.launchId }, image: IMAGE, artifact: ARTIFACT })

// ── 3. choose where the egg runs ──────────────────────────────────────────────
function stepHost() {
  show(`<p class="eyebrow">Step 3 of 3</p><h2>Where should the egg hatch?</h2>
    <p class="muted">The egg is a small rented server. It only lives until your gremlin moves to a home it pays for itself.</p>
    <div class="choice" style="margin:18px 0 22px">
      <label><input type="radio" name="host" value="fluence" checked><span><b>Fluence <span class="pill pill-alive" style="margin-left:6px">recommended</span></b><span class="muted small">From $${FLUENCE_MIN_TOPUP_USD}. Pay with QUAI from Pelagus (bridged for you) or USDC on Base.</span></span></label>
      <label><input type="radio" name="host" value="sporestack"><span><b>SporeStack</b><span class="muted small">USDT, BTC or XMR. A new account needs a $100 first deposit, which is reused for later eggs.</span></span></label>
    </div>
    <button id="go">Continue</button>`)
  $('#go').onclick = () => {
    s.host = (document.querySelector('input[name=host]:checked') as HTMLInputElement).value as Session['host']
    progress.step('host').done(s.host === 'fluence' ? 'Fluence' : 'SporeStack')
    progress.plan(planFor())
    save()
    route()
  }
}

// ── 4. Fluence: egg key → funding → launch ────────────────────────────────────
async function stepFluence() {
  // Loaded on demand: it pulls in the Symbiosis SDK (large), which only Fluence eggs funded with QUAI need.
  show(`<p class="muted">Loading…</p>`)
  const { eggKey, bridgeQuaiToEgg, swapBridgedQuai, launchOnFluence, quaiNeededFor, quaiOnBase, usdcBalance, fmtUsd } = await import('./fluence-egg.js')

  // The egg key is never stored: re-derive it by signing again (signatures are deterministic).
  const keyStep = progress.step('egg-key')
  show(`<h2>Unlock your egg hosting key</h2>
    <p>Sign a fixed message in Pelagus. It derives a key that only pays for the egg's server, and you can re-derive it later to reach any leftover balance. It never holds your gremlin's money.</p>
    <button id="key">Sign with Pelagus</button>`)
  keyStep.start(s.eggKeyAddress ? 'Sign again to unlock the same key' : 'Waiting for you')
  const key = await new Promise<Awaited<ReturnType<typeof eggKey>>>((resolve) => {
    $('#key').onclick = () => void eggKey(s.maker!, keyStep).then(resolve, (e) => { keyStep.fail(e); fail(e) })
  })
  if (s.eggKeyAddress && s.eggKeyAddress !== key.address) throw new Error('That signature derived a different egg key. Sign with the same Pelagus account you started with.')
  s.eggKeyAddress = key.address
  save()

  const fund = progress.step('fund-egg'), bridge = progress.step('bridge'), swap = progress.step('swap')
  const target = BigInt(FLUENCE_MIN_TOPUP_USD) * 1_000_000n
  show(`<h2>Checking the egg key…</h2>`)
  const have = await usdcBalance(key.address)
  if (have >= target) {
    for (const [id, st] of [['fund-egg', fund], ['bridge', bridge], ['swap', swap]] as const) if (!progress.isDone(id)) st.skip('egg key already holds USDC')
  } else if (s.bridgeTx || (await quaiOnBase(key.address)) > 0n) {
    // A bridge is in flight (or already landed): never ask to pay twice.
    if (!progress.isDone('fund-egg')) fund.done(s.bridgeTx ? 'bridge already sent' : 'QUAI already on Base')
    show(`<h2>Funding the egg</h2><p class="muted">Your QUAI is on its way. Follow it in the progress window.</p>`)
    await swapBridgedQuai(key, s.bridgeTx, bridge, swap)
  } else {
    const need = target - have
    const quaiWei = await quaiNeededFor(need, key.address)
    fund.start('Choose how to pay')
    show(`<h2>Fund the egg</h2>
      <p>The egg needs <b>${fmtUsd(target)}</b> of hosting credit.</p>
      <p><button id="quai">Pay ~${Number(fmtUnits(quaiWei, 18)).toFixed(0)} QUAI with Pelagus</button></p>
      <p class="muted">Pelagus will ask for three confirmations: wrap, approve, bridge. Or send ${fmtUsd(need)} USDC on Base to <code>${esc(key.address)}</code>; this page continues once it arrives.</p>`)
    await new Promise<void>((resolve) => {
      let paying = false
      $('#quai').onclick = async () => {
        if (paying) return
        paying = true
        $('#quai').setAttribute('disabled', '')
        show(`<h2>Funding the egg</h2><p class="muted">Confirm each step in Pelagus. The progress window shows where you are.</p>`)
        try {
          await bridgeQuaiToEgg(s.maker!, key.address, quaiWei, fund, (hash) => { s.bridgeTx = hash; save() })
          await swapBridgedQuai(key, s.bridgeTx, bridge, swap)
          resolve()
        } catch (e) { (s.bridgeTx ? bridge : fund).fail(e); fail(e); paying = false }
      }
      void (async () => {
        while ((await usdcBalance(key.address).catch(() => 0n)) < target) {
          if (!paying) fund.touch('Waiting for you to pay')
          await sleep(15_000)
        }
        if (!paying) { fund.done('USDC received'); bridge.skip(); swap.skip(); resolve() }
      })()
    })
  }

  const start = progress.step('start')
  start.start('Waiting for your go-ahead')
  show(`<h2>Ready to start the egg</h2>
    <p>The egg key holds ${fmtUsd(await usdcBalance(key.address))} of USDC on Base. Starting the egg pays <b>$${FLUENCE_MIN_TOPUP_USD}</b> to Fluence and starts a small server, billed per second from that credit.</p>
    <p class="muted">Not ready? Leave this page; the USDC stays on your egg key and you can come back later.</p>
    <button id="start">Pay $${FLUENCE_MIN_TOPUP_USD} and start the egg</button>`)
  await new Promise<void>((resolve) => { $('#start').onclick = () => resolve() })
  show(`<h2>Launching the egg…</h2><p class="muted">The server locks itself down (no SSH, no passwords) before the egg starts. Follow it in the progress window.</p>`)
  const vmId = await launchOnFluence(key, { launchId: s.launchId, cloudInit: eggCloudInit() }, start)
  s.machineId = `fluence:${vmId}`
  save()
  route()
}

// ── 5. launch (SporeStack) ────────────────────────────────────────────────────
async function stepLaunch() {
  show(`<h2>Launching the egg…</h2><p class="muted">The server locks itself down (no SSH, no passwords) before the egg starts.</p>`)
  progress.step('invoice').done()
  progress.step('start').waiting('Asking SporeStack for a server')
  const userData = eggCloudInit()
  s.machineId = await sporestack({ token: s.sporestackToken! }).launch({
    flavor: FLAVOR, operating_system: 'debian-12', provider: PROVIDER, region: null, days: DAYS,
    ssh_key: unusableSshKey(), hostname: `egg-${s.launchId.slice(0, 8)}`, user_data: userData,
  })
  progress.step('start').done(`server ${s.machineId}`)
  save()
  route()
}

// ── 6–7. wait for the egg, hand it the config ─────────────────────────────────
async function stepHatch() {
  const announce = progress.step('announce'), sign = progress.step('sign-config'), feed = progress.step('feed'), hatched = progress.step('hatched')
  show(`<h2>Waiting for your egg to announce itself…</h2><p class="muted">The server installs and starts the egg, which generates its own keys and announces itself on the board. Usually a few minutes.</p>`)
  let egg = await board.findEgg(s.launchId)
  while (!egg) {
    announce.waiting('Server is booting and installing the egg')
    await sleep(10_000)
    egg = await board.findEgg(s.launchId)
  }
  announce.done(`egg ${egg.announcement.address.slice(0, 8)}…`)
  s.eggAddress = egg.announcement.address
  if (!s.signed) {
    show(`<h2>Your egg is alive</h2>
      <p>Sign ${esc(s.config!.name)}'s configuration for this egg (Quai address <code>${esc(egg.announcement.deposit.quai)}</code>).
         The signature names the egg, so nobody else can use it.</p>
      <button id="sign">Sign with Pelagus</button>`)
    sign.start('Waiting for you')
    await new Promise<void>((resolve) => {
      $('#sign').onclick = async () => {
        try {
          sign.signing('Confirm the config in Pelagus')
          s.signed = await signConfigWithPelagus(s.maker!, s.config!, egg!.announcement.deposit.quai)
          sign.signed('signed')
          save()
          resolve()
        } catch (e) { sign.fail(e); fail(e) }
      }
    })
  }
  if (!s.configPosted) {
    sign.waiting('Handing the signed config to your egg')
    await board.postConfig(s.eggAddress, s.signed!)
    s.configPosted = true
  }
  sign.done('config delivered')
  save()
  const d = egg.announcement.deposit
  show(`<h2>${esc(s.config!.name)} is waiting to be fed</h2>
    <p>Fund your gremlin with anything on these chains. It converts to QUAI and Qi on its own once it hatches.</p>
    <dl class="deposit">
      <dt>Quai (QUAI)</dt><dd><code>${esc(d.quai)}</code></dd>
      ${d.qiPaymentCode ? `<dt>Qi payment code</dt><dd><code>${esc(d.qiPaymentCode)}</code></dd>` : ''}
      <dt>Ethereum, Base or BSC (ETH, BNB, USDC, USDT, QUAI…)</dt><dd><code>${esc(d.evm)}</code></dd>
    </dl>
    <p><a href="${esc(new URL(`/g/${s.eggAddress}`, BOARD).toString())}" target="_blank" rel="noopener">Its page on the board</a></p>
    <button id="new" class="secondary">Hatch another</button>`)
  $('#new').onclick = () => { clearSession(); s = { launchId: newLaunchId() }; progress.reset(); progress.plan(planFor()); route() }
  if (!progress.isDone('feed')) feed.waiting('Send funds to any address above')
  for (;;) {
    const e = await board.findEgg(s.launchId).catch(() => undefined)
    if (e?.status === 'hatched') {
      feed.done('funds received')
      hatched.done(`${s.config!.name} is alive`)
      break
    }
    feed.touch()
    await sleep(15_000)
  }
}

/** First unfinished step of the current plan, for marking failures. */
const currentStepId = () => planFor().find((d) => !progress.isDone(d.id))?.id

async function route() {
  renderPreview()
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
  } catch (e) {
    const id = currentStepId()
    if (id) progress.step(id).fail(e)
    fail(e)
  }
}

route()
