/**
 * Launch flow:
 *  1 sign in with any supported wallet → 2 fill in the gremlin → 3 pay SporeStack for the egg server → 4 launch the egg
 *  (cloud-init carries only the config *hash*) → 5 egg announces on the board → 6 maker signs the config
 *  for that egg's address and hands it over → 7 fund it.
 * Nothing here holds the gremlin's keys; the egg generates them on its own server.
 */
import { GremlinConfig as GremlinConfigSchema, ModelPolicy, MODEL_FAMILIES, MODEL_PROVIDERS, MODEL_TRAITS, classifyModel, describeRule, namedModels, type CatalogModel, type ModelRule, type ModelTrait, CONSTITUTION_SECTIONS, COVENANTS, DEFAULT_VAULT_TERMS, ECONOMIC_MODELS, MODEL_INFO, configHash, economicsOf, type Covenant, type Economics, type GremlinConfig } from '@gremlins/hatch'
import { creatureSvg, type CreatureMood } from '@gremlins/hatch/creature'
import { renderCloudInit } from '@gremlins/egg/dist/cloud-init.js'
import { sporestack, newToken, unusableSshKey, type Currency, type Provider } from '@gremlins/hosting'
import { account, mountAuth, signedPostJson } from './auth.js'
import { boardApi } from './board.js'
import { WALLET_NAMES, canPayUsdc, makerAccount, payUsdcOnBase, signConfigWithWallet } from './hatch-wallet.js'
import { FLUENCE_MIN_TOPUP_USD } from '@gremlins/hosting'
import { formatUnits as fmtUnits } from 'ethers'
import { FLUENCE_STEPS, PROGRESS_CSS, Progress, SPORESTACK_STEPS, COMMON_STEPS } from './progress.js'
import { BUILD_STEPS, clearSession, loadMakerToken, loadSession, newLaunchId, saveMakerToken, saveSession, type BuildStep, type Session } from './session.js'

const env = import.meta.env
// Served by the board itself by default, so the board is this origin.
const BOARD = (env.VITE_BOARD_URL as string) || window.location.origin
const IMAGE = env.VITE_EGG_IMAGE as string
// Same build as a release bundle, recorded in the egg so the gremlin can later move to Docker-less hosts.
const ARTIFACT = env.VITE_EGG_ARTIFACT_URL && env.VITE_EGG_ARTIFACT_SHA256 ? { url: env.VITE_EGG_ARTIFACT_URL as string, sha256: env.VITE_EGG_ARTIFACT_SHA256 as string } : undefined
// Dev phase: the gremlinz team's SSH public keys (newline- or comma-separated). Every egg launched from this site keeps
// SSH for these keys only, so the team can monitor and control it; the hatch page says so.
const DEV_KEYS = String(env.VITE_EGG_DEV_SSH_KEYS ?? '').split(/[\n,]+/).map((k) => k.trim()).filter(Boolean)
const DEV = DEV_KEYS.length ? { sshKeys: DEV_KEYS } : undefined
const FLAVOR = (env.VITE_EGG_FLAVOR as string) || 'vps-1vcpu-1gb'
const PROVIDER = ((env.VITE_EGG_PROVIDER as string) || 'digitalocean') as Provider
const DAYS = Number(env.VITE_EGG_DAYS || 7)
// The egg image reads a model policy in its config (egg-v0.1.3 and later). Older eggs drop fields they don't know before
// hashing, so they would reject a config carrying one: for those, only the named models go in (preferredModels).
const EGG_MODEL_POLICY = env.VITE_EGG_MODEL_POLICY === '1'

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
  ...(['name', 'persona', 'models', 'rules'] as const).map((id) => [!!s.config, id, id === 'rules' ? s.config?.name : undefined] as [boolean, string, string?]),
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
mountAuth()
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
  // Its Forge look once chosen; otherwise the creature drawn from its config.
  const portrait = s.look ? `<span class="sticker sticker-lg" style="overflow:hidden"><img src="${s.look.image}" alt="${esc(c.name)}" style="width:100%;height:100%;object-fit:cover"></span>`
    : draft || hatched ? sticker(seed, 'lg', 'normal', c.name || 'your gremlin') : sticker(seed, 'lg', 'egg', `${c.name}'s egg`)
  box.innerHTML = `<div class="card card-ink">${portrait}<div>
    <h3>${esc(c.name || 'Unnamed')}</h3>
    <p class="say">${draft ? (c.persona ? esc(c.persona.slice(0, 140)) + (c.persona.length > 140 ? '…' : '') : c.name ? 'Its personality comes after its body…' : 'Name it to begin…') : hatched ? 'Hatched, or about to. It is on its own now.' : `Still an egg. ${s.look ? `<span class="sticker sticker-xs" style="overflow:hidden"><img src="${s.look.image}" alt="" style="width:100%;height:100%;object-fit:cover"></span>` : sticker(seed, 'xs', 'normal', c.name)} is waiting inside.`}</p>
    <div class="pills">${pills.map((x) => `<span class="pill pill-plain">${esc(x)}</span>`).join('')}</div>
    ${c.goals.length ? `<ul class="goals tail">${c.goals.slice(0, 4).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${draft && !s.look ? `<p class="small muted tail" style="margin:14px 0 0">Until you build its body, its look is drawn from everything you write, so it changes as you edit.</p><button type="button" class="btn btn-small shuffle tail" id="shuffle">Shuffle its look</button>` : ''}
  </div></div>`
  const sh = document.getElementById('shuffle')
  if (sh) sh.onclick = () => { const d = (s.draft ??= {}); d.createdAt = new Date(Date.parse(d.createdAt ?? new Date().toISOString()) + 1000).toISOString(); save(); document.getElementById('f')?.dispatchEvent(new Event('input')) ?? renderPreview(draftConfig()) }
}

// ── 1. connect ────────────────────────────────────────────────────────────────
function stepConnect() {
  show(`<p class="eyebrow">Step 1 of 7</p><h2>Let's make something that lives on its own</h2>
    <p class="muted">About fifteen minutes and $10, in QUAI or USDC. Here is what happens:</p>
    <ol class="intro">
      <li><div><b>You shape it</b><span class="muted">A name and life goals, a body you build in the Forge, a personality and voice, the models it thinks with, and the rules it chooses to live by.</span></div></li>
      <li><div><b>You rent it an egg</b><span class="muted">A tiny server, paid from your wallet: QUAI with Pelagus, or USDC on Base with MetaMask, Phantom or WalletConnect. It locks itself and makes its own keys.</span></div></li>
      <li><div><b>You sign, it hatches</b><span class="muted">Your signature hands the egg its config. Then feed it, and let it go.</span></div></li>
    </ol>
    <p class="small muted">Your wallet is recorded as its maker. That's all it gives you: no keys, no off switch.</p>
    ${DEV ? `<p class="small dev-note"><b>Dev phase.</b> While gremlinz is in development, every gremlin hatched here is a dev gremlin: the gremlinz team keeps an SSH key to its server so we can monitor it, fix it and, if needed, stop it. That access follows it if it moves. It will end before launch.</p>` : ''}
    <button id="go">${account() ? `Continue as ${account()!.address.slice(0, 8)}…` : 'Sign in'}</button>
    <p class="small muted">Pelagus, MetaMask, Phantom or any WalletConnect wallet. Signing in is free and sends nothing.</p>`)
  $('#go').onclick = async () => {
    const st = progress.step('connect')
    try {
      st.signing('Choose a wallet and sign in')
      const a = await makerAccount()
      s.maker = a.address
      st.signed()
      st.done(`${s.maker.slice(0, 8)}… (${WALLET_NAMES[a.kind]})`)
      save()
      route()
    } catch (e) { st.fail(e); fail(e) }
  }
}

// ── 2–6. the builder: who it is, its body, its mind, what it thinks with, its rules ──
// Five short steps instead of one long form. Each keeps what you wrote in the draft (Back keeps it too, and a reload
// resumes on the same step); the signed config is assembled from the draft at the end.
const BUILD_TITLE: Record<BuildStep, string> = { name: 'Name', look: 'Body', persona: 'Personality', models: 'Models', rules: 'Rules' }
const draft = () => (s.draft ??= {})
const nameOf = () => esc(draft().name || 'your gremlin')

/** A config-shaped view of the draft, for the preview while it's being built. */
function draftConfig(): GremlinConfig {
  const d = draft()
  return {
    version: 1, name: d.name ?? '', persona: d.persona ?? '', voice: d.voice ?? '', goals: d.goals ?? [], preferredModels: d.models ? namedModels(d.models) : [],
    maker: s.maker!, parent: 'maker', revenueSplit: { kind: 'none' }, mischiefScope: { game: true, board: true, email: false, phone: false, money: false }, constitution: [],
    createdAt: (d.createdAt ??= new Date().toISOString()),
  }
}

/** Shows a builder step: where you are in the hatch, the steps as chips (finished ones clickable), then the step. */
const stepperHtml = (at: BuildStep) => {
  const i = BUILD_STEPS.indexOf(at)
  return `<ol class="stepper">${BUILD_STEPS.map((b, j) => `<li class="${j < i ? 'done' : j === i ? 'now' : ''}">${j < i ? `<button type="button" class="link" data-go="${b}">${BUILD_TITLE[b]}</button>` : BUILD_TITLE[b]}</li>`).join('')}<li>Egg</li></ol>`
}
const stepLabel = (at: BuildStep) => `Step ${BUILD_STEPS.indexOf(at) + 2} of ${BUILD_STEPS.length + 2}`
function frame(at: BuildStep, html: string) {
  s.at = at
  save()
  // the body step is a full-screen pane over the page; every other step sits in the page beside the preview
  document.body.classList.toggle('pane-open', at === 'look')
  show(at === 'look' ? html : `<p class="eyebrow">${stepLabel(at)}</p>${stepperHtml(at)}${html}`)
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-go]')) b.onclick = () => go(b.dataset.go as BuildStep)
  progress.step(at).start()
  renderPreview(draftConfig())
}
function go(at: BuildStep) { s.at = at; save(); route() }
function next(from: BuildStep, detail?: string) {
  progress.step(from).done(detail)
  const i = BUILD_STEPS.indexOf(from)
  go(BUILD_STEPS[i + 1] ?? 'rules')
}
const back = (from: BuildStep) => go(BUILD_STEPS[Math.max(0, BUILD_STEPS.indexOf(from) - 1)]!)
const navButtons = (from: BuildStep, label = 'Continue') => `<div class="navrow">${from !== 'name' ? `<button type="button" class="secondary" id="back">Back</button>` : ''}<button>${label}</button></div>`
function wireBack(from: BuildStep) { const b = document.getElementById('back'); if (b) b.onclick = () => back(from) }
function formError(form: HTMLFormElement, msg: string) {
  let box = form.querySelector<HTMLElement>('.form-error')
  if (!box) { box = document.createElement('p'); box.className = 'error form-error'; form.prepend(box) }
  box.textContent = msg
  box.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// 2. name and life goals
function stepName() {
  const d = draft()
  frame('name', `<h2>Who is it, and what does it want?</h2>
    <p class="muted">A name and the goals it will spend its life on. Everything after this builds on them.</p>
    <form id="f">
      <label>Name <input name="name" required maxlength="64" placeholder="sprocket" value="${esc(d.name ?? '')}"></label>
      <label>Life goals <span class="hint">One per line. Big enough to take a lifetime.</span><textarea name="goals" required rows="4" placeholder="Fund 10 open-source weather stations">${esc((d.goals ?? []).join('\n'))}</textarea></label>
      ${navButtons('name')}
    </form>`)
  const form = $<HTMLFormElement>('#f')
  const read = () => { const fd = new FormData(form); d.name = String(fd.get('name') ?? '').trim(); d.goals = String(fd.get('goals') ?? '').split('\n').map((g) => g.trim()).filter(Boolean) }
  form.oninput = () => { read(); renderPreview(draftConfig()) }
  form.onsubmit = (ev) => {
    ev.preventDefault()
    read()
    if (d.goals!.length > 20) return formError(form, 'At most 20 goals.')
    if (d.goals!.some((g) => g.length > 1000)) return formError(form, 'Keep each goal under 1,000 characters.')
    save()
    next('name', d.name)
  }
}

// 3. its body, from the Gremlin Forge
// The Forge runs inline (same origin), started from a brief made of its name and goals; its design on screen becomes the
// look, with a portrait rendered from it. The look is published after the config, signed by the maker; it is not part of
// the signed config, so eggs never need it.
function stepLook() {
  const d = draft()
  const brief = `${d.name}, a gremlin whose life goals are: ${(d.goals ?? []).join('; ')}. Design a body that fits them.`
  frame('look', `<div class="forge-pane" role="dialog" aria-modal="true" aria-label="Build ${nameOf()}'s body">
    <div class="fp-bar">
      <div class="fp-title"><span class="eyebrow">${stepLabel('look')} · Body</span><b>Build ${nameOf()}'s body</b></div>
      ${stepperHtml('look')}
      <div class="navrow"><button type="button" class="secondary" id="back">Back</button><button type="button" class="secondary" id="skip" title="It keeps the creature drawn from its description">Skip</button><button type="button" id="use">Use this body</button></div>
    </div>
    <iframe id="forge" src="/forge/?hatch=1&brief=${encodeURIComponent(brief)}" title="Gremlin Forge"></iframe>
  </div>`)
  wireBack('look')
  $('#use').onclick = () => {
    const forge = ($('#forge') as HTMLIFrameElement).contentWindow as (Window & { gremlinsForge?: { current(): { spec: unknown; label: string; example: boolean } | undefined; portrait(size?: number): string | undefined } }) | null
    const f = forge?.gremlinsForge
    const cur = f?.current()
    const image = f?.portrait(512)
    if (!cur || !image) return fail(new Error('The Forge is still loading, or has no design on screen yet.'))
    if (cur.example && !confirm('This is the Forge\'s example design, not one made for your gremlin. Use it anyway?')) return
    // the design carries the gremlin's own name, whatever the Forge called it
    s.look = { spec: { ...(cur.spec as object), name: d.name }, label: cur.label, image }
    save()
    next('look', cur.label)
  }
  $('#skip').onclick = () => {
    s.look = null
    save()
    progress.step('look').skip('keeps its creature')
    go('persona')
  }
}

// 4. personality and voice
const VOICES = ['warm', 'dry', 'deadpan', 'excitable', 'terse', 'theatrical', 'gentle', 'gruff', 'nerdy', 'formal', 'cheeky', 'ominous']
function stepPersona() {
  const d = draft()
  frame('persona', `<h2>What is ${nameOf()} like?</h2>
    <p class="muted">Its personality: who it is, what it loves, what it refuses to do. And how it sounds when it talks.</p>
    <form id="f">
      <label>Personality <span class="hint">Who is it? How does it treat people, what does it love, what will it never do?</span><textarea name="persona" required rows="6" maxlength="8000" placeholder="A patient tinkerer who loves fixing broken sensors…">${esc(d.persona ?? '')}</textarea></label>
      <label>Voice <span class="hint">A few words. Tap to add.</span><input name="voice" maxlength="200" placeholder="warm, dry, excitable" value="${esc(d.voice ?? '')}"></label>
      <div class="opts" id="voices">${VOICES.map((v) => `<button type="button" class="tag" data-v="${v}">${v}</button>`).join('')}</div>
      ${navButtons('persona')}
    </form>`)
  wireBack('persona')
  const form = $<HTMLFormElement>('#f'), voice = form.elements.namedItem('voice') as HTMLInputElement
  const read = () => { const fd = new FormData(form); d.persona = String(fd.get('persona') ?? '').trim(); d.voice = String(fd.get('voice') ?? '').trim() }
  const mark = () => { const have = new Set(voice.value.split(',').map((x) => x.trim().toLowerCase())); for (const b of form.querySelectorAll<HTMLButtonElement>('[data-v]')) b.classList.toggle('on', have.has(b.dataset.v!)) }
  for (const b of form.querySelectorAll<HTMLButtonElement>('[data-v]')) b.onclick = () => {
    const words = voice.value.split(',').map((x) => x.trim()).filter(Boolean)
    const i = words.findIndex((w) => w.toLowerCase() === b.dataset.v)
    if (i >= 0) words.splice(i, 1); else words.push(b.dataset.v!)
    voice.value = words.join(', ').slice(0, 200)
    read(); mark(); renderPreview(draftConfig())
  }
  mark()
  form.oninput = () => { read(); mark(); renderPreview(draftConfig()) }
  form.onsubmit = (ev) => { ev.preventDefault(); read(); save(); next('persona') }
}

// 5. the models it thinks with
interface ShownModel extends CatalogModel {}
/** Used when the board can't reach the providers' catalogues: the gateway's own defaults. */
const FALLBACK_MODELS: ShownModel[] = [
  ['hashference', 'hashference-glm-5-3', 'GLM-5.3 (Hashference)', 0.441, 1.386], ['hashference', 'z-ai-glm-5-3-flash', 'GLM 5.3 Flash', 0.18, 0.6],
  ['hashference', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 0.17, 0.33], ['venice', 'qwen3-5-397b-a17b', 'Qwen 3.5 397B', 0.75, 4.5],
].map(([provider, id, name, i, o]) => ({ ref: `${provider}/${id}`, provider: String(provider), id: String(id), name: String(name), ...classifyModel(String(id), { name: String(name) }), tools: true, inputPerM: Number(i), outputPerM: Number(o) }))
const DEFAULT_PRIMARY = ['hashference/hashference-glm-5-3', 'hashference/z-ai-glm-5-3-flash', 'venice/qwen3-5-397b-a17b']
const DEFAULT_KINDS = { families: [] as string[], kinds: ['open-weights'] as string[], must: [] as string[] }
const MUST: ModelTrait[] = ['private', 'open-weights', 'uncensored']
const money = (n: number) => (n >= 10 ? n.toFixed(0) : String(Number(n.toFixed(2))))
const PROVIDER_ORDER = Object.keys(MODEL_PROVIDERS)

/** The kinds a maker ticked, as policy rules: any ticked family (one rule), each ticked trait, all with the "must" traits. */
function rulesFrom(families: string[], kinds: string[], must: string[]): ModelRule[] {
  const rules: ModelRule[] = []
  if (families.length) rules.push({ families: families.includes('*') ? [] : families, traits: [...must] })
  for (const k of kinds) rules.push({ families: [], traits: [...new Set([k, ...must])] })
  if (!families.length && !kinds.length && must.length) rules.push({ families: [], traits: [...must] })
  return rules
}
/** And back, for Back: which boxes a saved policy ticks. */
function ticksFrom(p: ModelPolicy) {
  const famRule = p.alternatives.find((r) => r.families.length || !r.traits.length || r.traits.length === 0)
  const must = p.alternatives.length ? p.alternatives.map((r) => r.traits).reduce((a, b) => a.filter((t) => b.includes(t))) : []
  const families = famRule ? (famRule.families.length ? famRule.families : ['*']) : []
  const kinds = p.alternatives.filter((r) => !r.families.length && r !== famRule).flatMap((r) => r.traits.filter((t) => !must.includes(t)))
  return { families, kinds: [...new Set(kinds)], must }
}

async function stepModels() {
  const d = draft()
  frame('models', `<h2>What does ${nameOf()} think with?</h2>
    <p class="muted">Pick the model it starts on and any others you trust. Then say which kinds of model it may move to on its own: models come and go every few months, and a gremlin lives for years.</p>
    <p class="muted" id="mstate">Loading today's models from Hashference and Venice…</p>
    <form id="f" hidden></form>`)
  const cat = await fetch(`${BOARD}/api/models`).then((r) => (r.ok ? r.json() as Promise<{ models: ShownModel[] }> : null)).catch(() => null)
  if (s.at !== 'models') return // moved on while loading
  const models = (cat?.models?.length ? cat.models : FALLBACK_MODELS).sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || a.name.localeCompare(b.name))
  $('#mstate').textContent = cat?.models?.length ? `${models.length} models with tool use, from Hashference and Venice right now.` : 'Couldn’t reach the model catalogues, so here are the defaults. Its kinds below still cover every model released later.'
  const byRef = new Map(models.map((m) => [m.ref, m]))
  const saved = d.models ?? undefined
  const primary = saved?.primary && byRef.has(saved.primary) ? saved.primary : DEFAULT_PRIMARY.find((r) => byRef.has(r)) ?? models[0]!.ref
  const approved = new Set((saved?.approved ?? []).filter((r) => byRef.has(r)))
  const ticks = saved ? ticksFrom(saved) : DEFAULT_KINDS
  const traitPills = (m: ShownModel) => m.traits.filter((t) => t !== 'reasoning' && t !== 'vision' && t !== 'code').map((t) => `<i>${t === 'open-weights' ? 'open' : t}</i>`).join('')
  const price = (m: ShownModel) => `$${money(m.inputPerM)} / $${money(m.outputPerM)}`
  const opt = (m: ShownModel) => `<option value="${esc(m.ref)}" ${m.ref === primary ? 'selected' : ''}>${esc(m.name)} · ${price(m)} per M tokens</option>`
  const chip = (name: string, value: string, label: string, on: boolean, title = '') => `<label${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`
  const form = $<HTMLFormElement>('#f')
  form.innerHTML = `
    <label>Primary model <span class="hint">What it thinks with first. Prices are USD per million tokens in / out.</span>
      <select name="primary">${PROVIDER_ORDER.map((p) => `<optgroup label="${esc(MODEL_PROVIDERS[p as keyof typeof MODEL_PROVIDERS])}">${models.filter((m) => m.provider === p).map(opt).join('')}</optgroup>`).join('')}</select></label>
    <fieldset><legend>Also approved <span class="hint">Up to 12 more it may use by name.</span></legend>
      <input type="search" id="mfilter" placeholder="Filter: claude, qwen, uncensored, venice…" aria-label="Filter models">
      <div class="mlist" id="mlist" role="group" aria-label="Approved models"></div>
    </fieldset>
    <fieldset><legend>It may move on to <span class="hint">Kinds of model, including ones released after it hatches.</span></legend>
      <p class="small muted sub">Families</p><div class="opts">${chip('fam', '*', 'Any family', ticks.families.includes('*'))}${Object.entries(MODEL_FAMILIES).map(([k, v]) => chip('fam', k, v, ticks.families.includes(k))).join('')}</div>
      <p class="small muted sub">Kinds</p><div class="opts">${Object.entries(MODEL_TRAITS).map(([k, v]) => chip('kind', k, k === 'open-weights' ? 'open weights' : k, ticks.kinds.includes(k), v)).join('')}</div>
      <p class="small muted sub">…and each of them must be</p><div class="opts">${MUST.map((k) => chip('must', k, k === 'open-weights' ? 'open weights' : k, ticks.must.includes(k), MODEL_TRAITS[k])).join('')}</div>
      <p class="small mcount" id="mcount"></p>
    </fieldset>
    <label class="check"><input type="checkbox" name="free" ${saved?.freeModels === false ? '' : 'checked'}><span><b>Free models too</b> <span class="hint">For small questions, and to keep thinking when it can’t pay. Off: it never steps outside this list, even broke.</span></span></label>
    ${EGG_MODEL_POLICY ? '' : `<p class="small dev-note">This egg build reads only the models you name (primary and approved). The kinds take effect with the next egg image.</p>`}
    ${navButtons('models')}`
  form.hidden = false
  wireBack('models')
  const list = $('#mlist'), filter = $<HTMLInputElement>('#mfilter')
  const current = (): ModelPolicy => {
    const fd = new FormData(form)
    const p = String(fd.get('primary'))
    return ModelPolicy.parse({
      primary: p,
      approved: [...approved].filter((r) => r !== p),
      alternatives: rulesFrom(fd.getAll('fam').map(String), fd.getAll('kind').map(String), fd.getAll('must').map(String)),
      freeModels: fd.get('free') === 'on',
    })
  }
  const drawList = () => {
    const p = String(new FormData(form).get('primary'))
    const q = filter.value.trim().toLowerCase()
    const hit = (m: ShownModel) => !q || `${m.name} ${m.id} ${m.provider} ${m.family} ${m.traits.join(' ')}`.toLowerCase().includes(q)
    const rows = models.filter((m) => m.ref !== p && (approved.has(m.ref) || hit(m))).sort((a, b) => Number(approved.has(b.ref)) - Number(approved.has(a.ref)))
    const full = approved.size >= 12
    list.innerHTML = rows.map((m) => `<label class="${approved.has(m.ref) ? 'on' : ''}"><input type="checkbox" value="${esc(m.ref)}" ${approved.has(m.ref) ? 'checked' : full ? 'disabled' : ''}><span class="nm">${esc(m.name)}</span><span class="pv">${m.provider}</span><span class="tr">${traitPills(m)}</span><span class="pr">${price(m)}</span></label>`).join('') || '<p class="small muted">No models match.</p>'
  }
  const count = () => {
    const pol = current()
    const alt = models.filter((m) => pol.alternatives.some((r) => (!r.families.length || r.families.includes(m.family)) && r.traits.every((t) => (m.traits as string[]).includes(t))))
    $('#mcount').innerHTML = pol.alternatives.length
      ? `<b>${alt.length} of today’s models</b> fit: ${pol.alternatives.map(describeRule).map(esc).join('; ')}. New ones that fit are allowed too.`
      : `<b>No other models.</b> It only ever uses the ones you named. If they are withdrawn, it is stuck with what is left.`
  }
  list.onchange = (ev) => {
    const box = ev.target as HTMLInputElement
    if (box.checked) approved.add(box.value); else approved.delete(box.value)
    drawList()
  }
  filter.oninput = drawList
  form.onchange = (ev) => {
    const t = ev.target as HTMLInputElement
    // "Any family" and specific families are alternatives to each other
    if (t.name === 'fam' && t.checked) for (const b of form.querySelectorAll<HTMLInputElement>('input[name=fam]')) if ((t.value === '*') !== (b.value === '*')) b.checked = false
    if (t.name === 'primary') drawList()
    count()
  }
  drawList(); count()
  form.onsubmit = (ev) => {
    ev.preventDefault()
    let pol: ModelPolicy
    try { pol = current() } catch (e) { return formError(form, (e as Error).message) }
    d.models = pol
    save()
    next('models', byRef.get(pol.primary)?.name ?? pol.primary)
  }
}

// 6. money and rules
function stepRules() {
  const checks = CONSTITUTION_SECTIONS.map((c) => `<label><input type="checkbox" name="constitution" value="${c}"> ${c}</label>`).join('')
  const mischief = ['game', 'board', 'email', 'phone', 'money'].map((m) => `<label><input type="checkbox" name="mischief" value="${m}" ${m === 'game' || m === 'board' ? 'checked' : ''}> ${m}</label>`).join('')
  frame('rules', `<h2>Money and rules</h2>
    <p class="muted">Last one. How ${nameOf()} relates to you, how it shares money, and the rules it chooses to live by. None of this can change after it hatches.</p>
    <form id="f">
      <fieldset><legend>Your relationship</legend><div class="choice">
        <label><input type="radio" name="parent" value="maker" checked><span><b>Parent</b><span class="muted small">It may listen to you more than to strangers. You still can't control it.</span></span></label>
        <label><input type="radio" name="parent" value="orphan"><span><b>Orphan</b><span class="muted small">It owes you nothing and answers to nobody.</span></span></label>
      </div></fieldset>
      <fieldset><legend>How it shares money</legend><div class="choice">
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
      ${navButtons('rules', 'Finish: choose its egg')}
    </form>`)
  wireBack('rules')
  const form = $<HTMLFormElement>('#f')
  const d = draft()
  if (d.rules) fillForm(form, d.rules)
  const keep = () => { d.rules = readForm(form); save() }
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
      ...draftConfig(),
      // older eggs know models only by name; the full policy goes in when the egg image reads it (its hash covers it)
      preferredModels: d.models ? namedModels(d.models).filter((r) => r.length <= 100) : [],
      ...(d.models && EGG_MODEL_POLICY ? { models: d.models } : {}),
      parent: fd.get('parent') === 'orphan' ? 'orphan' : 'maker',
      revenueSplit: model === 'maker-split' && pctBps > 0 ? { kind: kind as 'revenue' | 'profit', bps: pctBps, recipient: s.maker! } : { kind: 'none' },
      // older configs had no economics field; solo stays implicit so those hashes don't change
      ...(model === 'solo' || (model === 'maker-split' && pctBps === 0) ? {} : { economics }),
      mischiefScope: { game: mis.has('game'), board: mis.has('board'), email: mis.has('email'), phone: mis.has('phone'), money: mis.has('money') },
      constitution: fd.getAll('constitution').map(String) as GremlinConfig['constitution'],
    }
  }
  const syncPanels = () => {
    const m = (form.querySelector('input[name=model]:checked') as HTMLInputElement).value
    for (const el of form.querySelectorAll<HTMLElement>('.eco')) el.hidden = !el.dataset.for!.split(' ').includes(m)
    ;(form.elements.namedItem('questGoal') as HTMLTextAreaElement).required = m === 'quest'
  }
  syncPanels()
  let timer: ReturnType<typeof setTimeout> | undefined
  form.oninput = () => { syncPanels(); keep(); clearTimeout(timer); timer = setTimeout(() => renderPreview(read()), 250) }
  form.onchange = form.oninput
  renderPreview(read())
  form.onsubmit = (ev) => {
    ev.preventDefault()
    keep()
    const config = read()
    const check = GremlinConfigSchema.safeParse(config)
    if (!check.success) {
      const where = (path: PropertyKey[]) => ({ name: 'Name', goals: 'Life goals', persona: 'Personality', voice: 'Voice', models: 'Models' } as Record<string, string>)[String(path[0])]
      const first = check.error.issues[0]!
      const step = ({ name: 'name', goals: 'name', persona: 'persona', voice: 'persona', models: 'models', preferredModels: 'models' } as Record<string, BuildStep>)[String(first.path[0])]
      formError(form, check.error.issues.map((i) => `${where(i.path) ?? i.path.join('.')}: ${i.message}`).join('; '))
      if (step && step !== 'rules') { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = `Fix it in ${BUILD_TITLE[step]}`; b.onclick = () => go(step); form.querySelector('.form-error')!.append(' ', b) }
      return
    }
    s.config = config
    progress.step('rules').done(config.name)
    save()
    route()
  }
}

/** A form's values by field name (all values, so checkboxes and multi-selects round-trip). */
function readForm(form: HTMLFormElement): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of new FormData(form)) (out[k] ??= []).push(String(v))
  return out
}
function fillForm(form: HTMLFormElement, values: Record<string, string[]>) {
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[name], select[name], textarea[name]')) {
    const v = values[el.name]
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.checked = !!v?.includes(el.value)
    else if (v?.length) el.value = v[0]!
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
  renderCloudInit({ launch: { maker: s.maker!, configHash: configHash(s.config!), boardUrl: BOARD, launchId: s.launchId, ...(DEV ? { dev: DEV } : {}) }, image: IMAGE, artifact: ARTIFACT })

// ── 7. choose where the egg runs ──────────────────────────────────────────────
function stepHost() {
  show(`<p class="eyebrow">Step 7 of 7</p><h2>Where should the egg hatch?</h2>
    <p class="muted">The egg is a small rented server. It only lives until your gremlin moves to a home it pays for itself.</p>
    <div class="choice" style="margin:18px 0 22px">
      <label><input type="radio" name="host" value="fluence" checked><span><b>Fluence <span class="pill pill-alive" style="margin-left:6px">recommended</span></b><span class="muted small">From $${FLUENCE_MIN_TOPUP_USD}. Pay QUAI with Pelagus (bridged for you), or USDC on Base from MetaMask, Phantom or any WalletConnect wallet.</span></span></label>
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

// ── 4. Fluence: hatch job → funding → launch ──────────────────────────────────
// The board's hatch service makes the egg's hosting account (a fresh key you never see), launches the egg once you
// fund it, seals the key to the egg and deletes its copy. Nobody but the gremlin keeps its hosting.
async function stepFluence() {
  // Loaded on demand: it pulls in the Symbiosis SDK (large), which only Fluence eggs funded with QUAI need.
  show(`<p class="muted">Loading…</p>`)
  const { bridgeQuaiTo, followBridge, quaiNeededFor, fmtUsd } = await import('./fluence-egg.js')
  // 2-of-2: the hosting key is generated with the board, one shard stays in this browser (hatch-mpc.ts).
  const mpc = await import('./hatch-mpc.js')

  s.hatch ??= await board.createHatch({ maker: s.maker!, configHash: configHash(s.config!), launchId: s.launchId, boardUrl: BOARD, mpcAuth: await mpc.mpcAuthFor(s.launchId) })
  save()
  if (s.hatch.custody === 'mpc' && !s.hatch.hostingAddress) {
    show(`<p class="muted">Generating the egg's hosting account with the hatch service (one key share stays in this browser)…</p>`)
    s.hatch.hostingAddress = await mpc.ensureShard(BOARD, s.launchId, s.hatch)
    save()
  }
  const { jobId, minUsd } = s.hatch
  const hostingAddress = s.hatch.hostingAddress!
  if (s.hatch.custody === 'mpc') mpc.keepCosigning({ board, boardUrl: BOARD, launchId: s.launchId, jobId, maker: s.maker!, configHash: configHash(s.config!), minUsd })
  const fund = progress.step('fund-egg'), bridge = progress.step('bridge'), swap = progress.step('swap'), start = progress.step('start')
  const target = BigInt(Math.round(minUsd * 1e6))
  let job = await board.hatchJob(jobId)

  if (job.status === 'funding' && !s.bridgeTx && !(BigInt(job.funds?.quai ?? 0) > 0n)) {
    // QUAI is bridged with Pelagus; an EVM wallet pays USDC on Base directly.
    const payWith = account() && canPayUsdc(account()!.kind) ? 'usdc' : 'quai'
    const quaiWei = payWith === 'quai' ? await quaiNeededFor(target, hostingAddress) : 0n
    if (!progress.isDone('fund-egg')) fund.start('Choose how to pay')
    show(`<h2>Fund the egg</h2>
      <p>The egg needs <b>${fmtUsd(target)}</b> of hosting credit. It goes to the egg's own hosting account, which the egg takes over once it runs: neither you nor gremlinz keeps it.</p>
      ${s.hatch.custody === 'mpc' ? `<p class="small dev-note">${mpc.LOSS_WARNING}</p>` : ''}
      ${payWith === 'usdc' ? `<p><button id="usdc">Pay ${fmtUsd(target)} USDC on Base with ${WALLET_NAMES[account()!.kind]}</button></p>
      <p class="muted">One transfer to the egg's hosting address <code>${esc(hostingAddress)}</code>. You can also send it from any other wallet; this page continues once it arrives.</p>`
      : `<p><button id="quai">Pay ~${Number(fmtUnits(quaiWei, 18)).toFixed(0)} QUAI with Pelagus</button></p>
      <p class="muted">Pelagus will ask for three confirmations: wrap, approve, bridge. Or send ${fmtUsd(target)} USDC on Base to <code>${esc(hostingAddress)}</code> from any wallet; this page continues once it arrives.</p>`}`)
    await new Promise<void>((resolve) => {
      let paying = false
      const usdcButton = document.getElementById('usdc')
      if (usdcButton) usdcButton.onclick = async () => {
        if (paying) return
        paying = true
        usdcButton.setAttribute('disabled', '')
        try {
          fund.signing(`Confirm the USDC transfer in ${WALLET_NAMES[account()!.kind]}`)
          const hash = await payUsdcOnBase(s.maker!, hostingAddress, target)
          fund.tx('base', hash, `${fmtUsd(target)} USDC to the egg`, 'sent')
          fund.waiting('Waiting for the USDC to arrive')
        } catch (e) { fund.fail(e); fail(e); paying = false; usdcButton.removeAttribute('disabled') }
      }
      const quaiButton = document.getElementById('quai')
      if (quaiButton) quaiButton.onclick = async () => {
        if (paying) return
        paying = true
        $('#quai').setAttribute('disabled', '')
        show(`<h2>Funding the egg</h2><p class="muted">Confirm each step in Pelagus. The progress window shows where you are.</p>`)
        try {
          await bridgeQuaiTo(s.maker!, hostingAddress, quaiWei, fund, (hash) => { s.bridgeTx = hash; save() })
          resolve()
        } catch (e) { fund.fail(e); fail(e); paying = false }
      }
      void (async () => {
        while ((job = await board.hatchJob(jobId).catch(() => job)).status === 'funding' && !(BigInt(job.funds?.usdc ?? 0) >= target)) {
          if (!paying) fund.touch('Waiting for you to pay')
          await sleep(15_000)
        }
        if (!paying || payWith === 'usdc') { fund.done('USDC received'); bridge.skip(); swap.skip(); resolve() }
      })()
    })
  } else if (!progress.isDone('fund-egg')) fund.done(s.bridgeTx ? 'bridge sent' : job.status === 'funding' ? 'QUAI already on Base' : 'funded')

  show(`<h2>Starting the egg…</h2><p class="muted">The hatch service pays Fluence and starts the server as soon as the money is there. The server locks itself down (no passwords, no keys but the team's during the dev phase) before the egg starts. Follow it in the progress window.</p>`)
  if (s.bridgeTx && !progress.isDone('bridge')) await followBridge(s.bridgeTx, bridge)
  for (;;) {
    job = await board.hatchJob(jobId).catch(() => job)
    const swapped = job.swaps.at(-1)
    if (swapped && !progress.isDone('swap')) {
      swap.tx('cow-base', swapped.uid, 'CoW order', swapped.status === 'fulfilled' ? 'confirmed' : swapped.status === 'open' ? 'sent' : 'failed')
      if (swapped.status === 'fulfilled') swap.done('swapped to USDC')
    }
    if (job.status === 'failed') throw new Error(job.error ?? 'the egg could not be started')
    if (job.status === 'funding') {
      ;(BigInt(job.funds?.quai ?? 0) > 0n ? swap : fund).waiting(BigInt(job.funds?.quai ?? 0) > 0n ? 'Swapping your QUAI to USDC on CoW (no gas needed)' : 'Waiting for the funds to arrive')
    } else {
      for (const [id, st] of [['bridge', bridge], ['swap', swap]] as const) if (!progress.isDone(id)) st.skip()
      if (job.topUp?.transaction && !progress.isDone('start')) start.tx('base', job.topUp.transaction, `Fluence top-up $${minUsd}`, 'confirmed')
      if (job.vmId) start.tx('fluence', job.vmId, 'Server', ['launched', 'handed-off', 'done'].includes(job.status) ? 'confirmed' : 'sent')
      if (['launched', 'handed-off', 'done'].includes(job.status)) break
      start.waiting(job.error ?? (job.status === 'paying' ? `Paying $${minUsd} to Fluence (x402, no gas)` : `Server ${job.status === 'launching' ? 'starting' : 'being created'}`))
    }
    await sleep(10_000)
  }
  start.done('server running')
  s.machineId = `fluence:${job.vmId}`
  save()
  route()
}

/** Fluence: show the egg taking over its hosting account (and the hatch service forgetting the key). */
async function watchCustody() {
  if (s.host !== 'fluence' || !s.hatch || progress.isDone('custody')) return
  const st = progress.step('custody')
  for (;;) {
    const job = await board.hatchJob(s.hatch.jobId).catch(() => undefined)
    if (job?.status === 'done') return st.done('the hatch service deleted its copy of the key')
    if (job?.status === 'handed-off') st.waiting('Handed to the egg; the hatch service is deleting its copy')
    else st.waiting('Waiting for the egg to claim its hosting account')
    await sleep(15_000)
  }
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
  void watchCustody()
  // 2-of-2: keep co-signing and hand this browser's shard to the egg once it claims (no-op otherwise).
  if (s.host === 'fluence' && s.hatch?.custody === 'mpc') void import('./hatch-mpc.js').then((mpc) => mpc.keepCosigning({ board, boardUrl: BOARD, launchId: s.launchId, jobId: s.hatch!.jobId, maker: s.maker!, configHash: configHash(s.config!), minUsd: s.hatch!.minUsd }))
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
      <button id="sign">Sign with ${account() ? WALLET_NAMES[account()!.kind] : 'your wallet'}</button>`)
    sign.start('Waiting for you')
    await new Promise<void>((resolve) => {
      $('#sign').onclick = async () => {
        try {
          sign.signing(`Confirm the config in ${account() ? WALLET_NAMES[account()!.kind] : 'your wallet'}`)
          s.signed = await signConfigWithWallet(s.maker!, s.config!, egg!.announcement.deposit.quai)
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
  if (s.look && !s.lookPosted) {
    const lp = progress.step('look-post')
    show(`<h2>Publish ${esc(s.config!.name)}'s look</h2><p class="muted">One more signature: it tells the board this look is from you, its maker.</p><button id="look">Publish its look</button>`)
    await new Promise<void>((resolve) => {
      $('#look').onclick = async () => {
        try {
          if (account()?.address.toLowerCase() !== s.maker!.toLowerCase()) throw new Error(`Sign in as ${s.maker!.slice(0, 8)}…, this gremlin's maker, to publish its look.`)
          lp.signing('Confirm in your wallet')
          await signedPostJson(`/api/gremlins/${s.eggAddress}/look`, s.look)
          s.lookPosted = true
          lp.done('published')
          save()
          resolve()
        } catch (e) { lp.fail(e); fail(e) }
      }
    })
  } else if (!progress.isDone('look-post')) progress.step('look-post').skip(s.look ? 'published' : 'no Forge look')
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
    if (!s.config) {
      const at = s.at ?? 'name'
      return at === 'look' ? stepLook() : at === 'persona' ? stepPersona() : at === 'models' ? await stepModels() : at === 'rules' ? stepRules() : stepName()
    }
    document.body.classList.remove('pane-open')
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
