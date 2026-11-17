/**
 * Lend capacity (/lend/?gremlin=0x…): a signed-in person lends a gremlin spare budget on their own AI provider plan.
 * Pick a provider (ones whose terms forbid it are shown with the reason and can't be picked), follow its setup advice,
 * paste a key, set the budget rules and wishes, review, sign. The key is sealed here, in the browser, to the gremlin's
 * public key (recovered from its signed egg announcement); the board only ever sees ciphertext. The same page lists
 * the lender's grants to this gremlin and revokes them.
 */
import { creatureSvg } from '@gremlins/hatch/creature'
import {
  buildGrant, draftProblems, grantSummary, lendingProvider, messageDigest, publicKeyFromSigned,
  type EggAnnouncement, type GrantWishes, type KeyGrant, type KeyRevoke, type Signed,
} from '@gremlins/hatch'
import { account, evmWallet, mountAuth, onAccountChange, walletErrorMessage } from './auth.js'
import { DEFAULT_BUDGET, formPolicy, providerOptions, type BudgetForm, type Every } from './lend-form.js'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const val = (id: string) => $<HTMLInputElement>(id).value
const num = (id: string) => Number(val(id))
const optNum = (id: string) => (val(id).trim() ? Number(val(id)) : undefined)

$('logo').innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
mountAuth()

const gremlin = new URLSearchParams(location.search).get('gremlin') ?? ''
let gremlinName = 'this gremlin'
let gremlinPub = ''
let goals: string[] = []

// ── the gremlin ────────────────────────────────────────────────────────────

async function loadGremlin() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(gremlin)) return fatal('Open this page from a gremlin\'s profile ("Lend capacity").')
  const r = await fetch(`/api/eggs/${gremlin}`)
  if (!r.ok) return fatal('No gremlin with that address.')
  const { egg } = (await r.json()) as { egg: { name: string | null; status: string; announcement: EggAnnouncement; announcementSignature: string } }
  if (egg.status !== 'hatched') return fatal('This gremlin hasn\'t hatched yet. Keys can be lent once it is alive.')
  gremlinName = egg.name ?? 'this gremlin'
  // Its public key, from what it signed itself: the key is sealed to it and nobody else.
  const signed: Signed<EggAnnouncement> = { message: egg.announcement, signature: egg.announcementSignature }
  gremlinPub = publicKeyFromSigned(signed)
  const p = await fetch(`/api/gremlins/${gremlin}`).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { config?: { goals?: string[] } } | null
  goals = p?.config?.goals ?? []
  document.querySelectorAll('[data-name]').forEach((el) => (el.textContent = gremlinName))
  $('back').setAttribute('href', `/g/${gremlin}`)
  // its Forge body if it has one (the creature otherwise)
  $('who').innerHTML = `<span class="sticker sticker-md portrait"><img src="/g/${gremlin}/portrait" alt=""></span>`
  $('who').querySelector('img')!.onerror = () => { $('who').innerHTML = `<span class="sticker sticker-md">${creatureSvg(gremlin.toLowerCase(), { title: gremlinName })}</span>` }
  renderPurposes()
  $('lend-form').hidden = false
}

function fatal(msg: string) {
  $('lend-form').hidden = true
  $('fatal').hidden = false
  $('fatal').textContent = msg
}

// ── provider ──────────────────────────────────────────────────────────────

function renderProviders() {
  const opts = providerOptions()
  const row = (o: (typeof opts)[number]) => `<label class="lend-provider${o.selectable ? '' : ' off'}">
    <input type="radio" name="provider" value="${o.id}"${o.selectable ? '' : ' disabled'}>
    <span class="txt"><span><b>${esc(o.name)}</b>${o.stance === 'allowed-with-conditions' ? '<span class="pill pill-plain">with conditions</span>' : ''}</span>
    ${o.selectable ? '' : `<span class="small muted">${esc(o.note)}</span>`}</span></label>`
  const off = opts.filter((o) => !o.selectable)
  $('providers').innerHTML = opts.filter((o) => o.selectable).map(row).join('')
    + `<details class="lend-off small"><summary>Can't be lent (${off.length}): ${esc(off.map((o) => o.name).join(', '))}</summary><div>${off.map(row).join('')}</div></details>`
  $('providers').addEventListener('change', onProvider)
}

const providerId = () => document.querySelector<HTMLInputElement>('input[name=provider]:checked')?.value ?? ''

function onProvider() {
  const p = lendingProvider(providerId())
  if (!p) return
  $('provider-details').hidden = false
  $('custom-url').hidden = p.kind !== 'custom'
  const src = p.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(new URL(s.url).hostname)}</a>${s.docDate ? ` (${s.docDate})` : ''}: <q>${esc(s.clause)}</q>${s.verified ? '' : ' <span class="muted">(not read directly)</span>'}</li>`).join('')
  $('setup').innerHTML = `<p><b>Set it up first.</b> ${esc(p.setup)}</p>
    ${p.conditions.length ? `<p class="small"><b>By lending you accept:</b></p><ul class="small">${p.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${src ? `<details class="small"><summary>What ${esc(p.name)}'s terms say</summary><ul>${src}</ul></details>` : ''}
    ${p.limits ? `<p class="small muted">The gremlin will use at most ${Math.floor(p.limits.rpm / 2)} requests a minute and ${Math.max(1, Math.floor(p.limits.concurrency / 2))} at a time on your key (half of ${esc(p.name)}'s entry tier), and backs off whenever ${esc(p.name)} says so.</p>` : ''}`
  $<HTMLInputElement>('models').value = (p.suggestedModels ?? []).join(', ')
  $<HTMLInputElement>('in-price').value = String(p.price?.inputPerM ?? 1)
  $<HTMLInputElement>('out-price').value = String(p.price?.outputPerM ?? 3)
  // "What's left" needs a provider that reports it.
  $('leftover-note').textContent = p.budgetApi === 'none' ? `${p.name} doesn't report what's left on a key, so this counts as a share of your budget.` : `${p.name} reports what's left on your key, so the gremlin only ever uses what you didn't.`
  renderPreferred()
  update()
}

// ── wishes ────────────────────────────────────────────────────────────────

function renderPurposes() {
  $('purposes').innerHTML = [`<label><input type="checkbox" name="purpose" value="anything" checked> Anything it decides is worth it</label>`,
    ...goals.map((g) => `<label><input type="checkbox" name="purpose" value="${esc(g)}"> ${esc(g)}</label>`)].join('')
}

const models = () => val('models').split(',').map((m) => m.trim()).filter(Boolean)

function renderPreferred() {
  const keep = new Set(checked('preferred'))
  $('preferred').innerHTML = models().map((m) => `<label><input type="checkbox" name="preferred" value="${esc(m)}"${keep.has(m) ? ' checked' : ''}> ${esc(m)}</label>`).join('') || '<span class="small muted">Add models above.</span>'
}

const checked = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name=${name}]:checked`)].map((i) => i.value)

function wishes(): GrantWishes {
  const purposes = checked('purpose')
  return { purposes: purposes.includes('anything') || !purposes.length ? ['anything'] : purposes, forbidden: val('forbidden').trim(), preferredModels: checked('preferred'), creditAs: val('credit').trim() }
}

// ── budget ────────────────────────────────────────────────────────────────

function budget(): BudgetForm {
  return {
    ...DEFAULT_BUDGET,
    preset: (document.querySelector<HTMLInputElement>('input[name=preset]:checked')?.value ?? 'leftover') as BudgetForm['preset'],
    every: val('every') as Every, resetAt: val('reset-at') || '00:00', dayOfWeek: num('dow'), dayOfMonth: num('dom'),
    budgetUsd: num('budget'), pct: num('pct'), hours: num('hours'), usd: num('usd'),
    custom: { withinHoursOfReset: num('c-hours'), share: val('c-share') as 'budget' | 'remaining', pct: num('c-pct'), minRemainingPct: optNum('c-min') },
    maxPerCallUsd: optNum('max-call'),
    limits: { rpm: optNum('rpm'), concurrency: optNum('conc') },
  }
}

// ── review ────────────────────────────────────────────────────────────────

function draft() {
  const p = lendingProvider(providerId())
  if (!p) throw new Error('Pick a provider.')
  const policy = formPolicy(budget(), p.id)
  const expires = val('expires')
  return {
    lender: account()?.address ?? '0x0000000000000000000000000000000000000000', gremlin, providerId: p.id, baseUrl: p.kind === 'custom' ? val('base-url').trim() : undefined,
    label: val('label').trim() || undefined, models: models(), inputPerM: num('in-price'), outputPerM: num('out-price'), policy,
    repay: (document.querySelector<HTMLInputElement>('input[name=repay]:checked')?.value ?? 'patron') as KeyGrant['repay'], wishes: wishes(), apiKey: val('api-key'),
    ...(expires ? { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() } : {}),
  }
}

function update() {
  const on = document.querySelector<HTMLInputElement>('input[name=preset]:checked')?.value
  for (const k of ['leftover', 'fixed', 'custom']) $(`preset-${k}`).hidden = on !== k
  $('dow-row').hidden = val('every') !== 'week'
  $('dom-row').hidden = val('every') !== 'month'
  const out = $('summary')
  const btn = $<HTMLButtonElement>('lend')
  try {
    const d = draft()
    const problems = draftProblems(d)
    const p = lendingProvider(d.providerId)!
    const lines = grantSummary({ provider: { id: p.id, label: d.label ?? p.name, baseUrl: d.baseUrl ?? p.baseUrl ?? 'https://example.invalid/v1', models: d.models, inputPerM: d.inputPerM, outputPerM: d.outputPerM, budgetApi: p.budgetApi }, policy: d.policy, repay: d.repay, wishes: d.wishes, expiresAt: d.expiresAt }, gremlinName)
    out.innerHTML = `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${problems.length ? `<p class="lend-problems">Before you can lend: ${problems.map(esc).join('; ')}.</p>` : ''}`
    btn.disabled = problems.length > 0
  } catch (e) {
    out.innerHTML = `<p class="lend-problems">${esc((e as Error).message)}</p>`
    btn.disabled = true
  }
}

// ── sign and send ─────────────────────────────────────────────────────────

/** Signs a board message with an EVM wallet (EIP-191 over the message digest, as the board verifies). */
async function signBoardMessage<T extends KeyGrant | KeyRevoke>(build: (address: string) => T | Promise<T>): Promise<Signed<T>> {
  const { provider, address } = await evmWallet()
  const message = await build(address)
  const signature = (await provider.request({ method: 'personal_sign', params: [messageDigest(message), address] })) as string
  return { message, signature }
}

async function lend() {
  const status = $('lend-status')
  const btn = $<HTMLButtonElement>('lend')
  btn.disabled = true
  status.textContent = 'Sealing your key to the gremlin and asking your wallet to sign…'
  try {
    const signed = await signBoardMessage((address) => buildGrant({ ...draft(), lender: address, gremlinPublicKey: gremlinPub }))
    const r = await fetch('/api/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) })
    const j = (await r.json().catch(() => ({}))) as { error?: string }
    if (!r.ok) throw new Error(j.error ?? `the board said ${r.status}`)
    rememberLender(signed.message.address)
    $<HTMLInputElement>('api-key').value = ''
    status.textContent = `Lent. ${gremlinName} picks it up within ten minutes.`
    void loadMine()
  } catch (e) {
    status.textContent = walletErrorMessage(e)
  } finally { update() }
}

// ── your grants ───────────────────────────────────────────────────────────

/** EVM addresses this browser has lent from (the signer can differ from a Quai or Smart Wallet sign-in). */
const LENDERS = 'gremlins.lend.lenders'
const lenders = (): string[] => { try { return JSON.parse(localStorage.getItem(LENDERS) || '[]') as string[] } catch { return [] } }
const rememberLender = (a: string) => { try { localStorage.setItem(LENDERS, JSON.stringify([...new Set([...lenders(), a.toLowerCase()])].slice(-5))) } catch { /* private mode */ } }

type Listed = Signed<KeyGrant> & { revokedAt: string | null; status: string | null; statusDetail: { httpStatus: number; reason: string; at: string } | null }

async function loadMine() {
  const me = account()?.address.toLowerCase()
  const box = $('mine')
  const mineSet = new Set([...(me ? [me] : []), ...lenders()])
  if (!mineSet.size) { box.innerHTML = '<p class="small muted">Sign in to see what you have lent this gremlin.</p>'; return }
  const r = await fetch(`/api/grants?gremlin=${gremlin}&includeRevoked=1`).catch(() => null)
  const all = r?.ok ? ((await r.json()) as { grants: Listed[] }).grants : []
  const mine = all.filter((g) => mineSet.has(g.message.address.toLowerCase()))
  if (!mine.length) { box.innerHTML = '<p class="small muted">You haven\'t lent this gremlin anything yet.</p>'; return }
  box.innerHTML = mine.map((g) => {
    const m = g.message
    const state = g.revokedAt ? `<span class="pill pill-plain">revoked ${g.revokedAt.slice(0, 10)}</span>`
      : g.status === 'disabled' ? `<span class="pill pill-dead">stopped</span> <span class="small">The provider refused the key (${g.statusDetail?.httpStatus}), so ${esc(gremlinName)} stopped using it for good. If you revoked it at the provider, revoke it here too; to lend again, make a new key.</span>`
      : '<span class="pill pill-alive">active</span>'
    return `<div class="card lend-grant"><div><b>${esc(m.provider.label)}</b> · ${esc(m.provider.models.join(', '))} · $${m.policy.budgetUsd} per ${m.policy.period.every} <span class="small muted">since ${m.createdAt.slice(0, 10)}</span></div>
      <div>${state}</div>${!g.revokedAt ? `<button class="btn btn-small" data-revoke="${m.grantId}">Revoke</button>` : ''}</div>`
  }).join('')
}

async function revoke(grantId: string) {
  if (!confirm('Revoke this grant? The gremlin stops using the key at its next check (within ten minutes). Also delete or disable the key at the provider to be sure.')) return
  try {
    const signed = await signBoardMessage((address): KeyRevoke => ({ kind: 'key-revoke', address, grantId, createdAt: new Date().toISOString() }))
    const r = await fetch('/api/grants/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) })
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the board said ${r.status}`)
  } catch (e) { alert(walletErrorMessage(e)) }
  void loadMine()
}

// ── wiring ────────────────────────────────────────────────────────────────

renderProviders()
$('lend-form').addEventListener('input', update)
$('lend-form').addEventListener('change', update)
$('models').addEventListener('input', renderPreferred)
$('lend-form').addEventListener('submit', (e) => { e.preventDefault(); void lend() })
$('mine').addEventListener('click', (e) => { const id = (e.target as HTMLElement).dataset.revoke; if (id) void revoke(id) })
onAccountChange(() => { void loadMine(); update() })
void loadGremlin().then(() => { update(); void loadMine() }).catch((e) => fatal(`Couldn't load the gremlin: ${(e as Error).message}`))
