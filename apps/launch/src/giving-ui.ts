/**
 * Giving, in the browser: your own list on your profile (private gifts too, with show/hide and taking a lent key
 * back), and the Mine for it box on gremlin pages (worker name, copy, "I'm mining for it"). Reads and changes go
 * through your site key (auth.ts), so nothing asks your wallet except taking a key back, which the gremlin checks.
 */
import { messageDigest, type KeyRevoke } from '@gremlins/hatch'
import { account, hasSiteKey, keyWallet, onAccountChange, sitePostJson, unlockSiteKey, walletErrorMessage } from './auth.js'

interface Gift { id: number; kind: 'crypto' | 'hashrate'; gremlin: string; chain: string; txHash: string | null; coin: string; amount: string; decimals: number; usd: number | null; public: boolean; status: string; detail: string | null; at: string }
interface Grant { grantId: string; gremlin: string; provider: string; models: string[]; modelChoice?: string; budgetUsd: number; period: string | null; createdAt: string; revokedAt: string | null; disabled: boolean; public: boolean }
interface Name { name: string; avatar: string; href: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const CHAIN: Record<string, string> = { quai: 'Quai', 1: 'Ethereum', 8453: 'Base', 56: 'BSC' }
const TX: Record<string, string> = { quai: 'https://quaiscan.io/tx/', 1: 'https://etherscan.io/tx/', 8453: 'https://basescan.org/tx/', 56: 'https://bscscan.com/tx/' }
const HW: Record<string, string> = { randomx: 'CPU', kawpow: 'GPU', sha256: 'SHA-256 ASIC', scrypt: 'Scrypt ASIC' }
const amount = (a: string, d: number) => { const v = Number(a) / 10 ** d; return v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(3).replace(/\.?0+$/, '') }
const usd = (v: number) => `$${v.toFixed(v < 10 ? 2 : 0)}`
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

// ── your giving (profile) ────────────────────────────────────────────────────

export function mountGiving(root: HTMLElement) {
  const owner = (root.dataset.owner ?? '').toLowerCase()
  const mine = () => account()?.address.toLowerCase() === owner

  const unlock = (why = '') => {
    root.innerHTML = `<div class="card"><p class="small" style="margin-top:0">Your gifts, private ones too, and the keys you've lent: show or hide each one, or take a key back.</p>
      <button class="btn btn-small btn-primary" type="button">Show my giving</button><p class="small" role="status">${esc(why)}</p></div>`
    root.querySelector('button')!.onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement
      b.disabled = true
      try { await unlockSiteKey(); await load() } catch (err) { unlock(walletErrorMessage(err)) }
    }
  }

  const load = async () => {
    if (!mine()) return
    if (!hasSiteKey()) return unlock()
    root.innerHTML = '<p class="muted">Loading…</p>'
    try {
      const r = await sitePostJson<{ gifts: Gift[]; grants: Grant[] }>('/api/giving', {})
      const who = [...new Set([...r.gifts.map((g) => g.gremlin), ...r.grants.map((g) => g.gremlin)])]
      const names = who.length ? ((await fetch(`/api/names?a=${who.join(',')}`).then((x) => x.json()).catch(() => ({ names: {} }))) as { names: Record<string, Name> }).names : {}
      render(r.gifts.filter((g) => g.status !== 'failed' || g.kind === 'crypto'), r.grants, names)
    } catch (e) { unlock(walletErrorMessage(e)) }
  }

  const render = (gifts: Gift[], grants: Grant[], names: Record<string, Name>) => {
    const face = (a: string) => { const n = names[a.toLowerCase()]; return { pic: n?.avatar ?? '', name: esc(n?.name ?? short(a)), href: n?.href ?? `/g/${a}` } }
    const vis = (kind: 'gift' | 'grant', id: string | number, pub: boolean) =>
      `<button type="button" class="btn btn-small" data-vis="${kind}" data-id="${id}" data-pub="${pub}" title="${pub ? 'Everyone sees your name on it' : 'Only you see it'}">${pub ? 'Shown · hide' : 'Hidden · show'}</button>`
    const rows = [
      ...gifts.map((g) => {
        const f = face(g.gremlin)
        const what = g.kind === 'hashrate'
          ? `Hashrate from a ${HW[g.chain] ?? g.chain}, as ${g.coin === 'credits' ? 'inference credit' : 'QUAI'}`
          : g.status === 'confirmed'
            ? `<a href="${TX[g.chain]}${g.txHash}" target="_blank" rel="noopener">${amount(g.amount, g.decimals)} ${esc(g.coin)}</a> on ${CHAIN[g.chain] ?? g.chain}${g.usd != null ? ` <span class="muted">(${usd(g.usd)} then)</span>` : ''}`
            : `<a href="${TX[g.chain]}${g.txHash}" target="_blank" rel="noopener">A gift on ${CHAIN[g.chain] ?? g.chain}</a>`
        const state = g.status === 'pending' ? '<span class="gv-status">waiting for the chain</span>' : g.status === 'failed' ? `<span class="gv-status bad">${esc(g.detail ?? 'failed')}</span>` : ''
        return { at: g.at, html: `<li class="give">${f.pic}<div style="flex:1"><div class="gv-row"><div><div class="give-what">${what} ${state}</div><div class="small muted">to <a href="${f.href}">${f.name}</a> · ${day(g.at)}</div></div>
          <div class="gv-acts">${g.status === 'failed' ? '' : vis('gift', g.id, g.public)}</div></div></div></li>` }
      }),
      ...grants.map((g) => {
        const f = face(g.gremlin)
        const state = g.revokedAt ? `<span class="gv-status">taken back ${day(g.revokedAt)}</span>` : g.disabled ? '<span class="gv-status bad">the provider refused it</span>' : '<span class="gv-status">in use</span>'
        return { at: g.createdAt, html: `<li class="give">${f.pic}<div style="flex:1"><div class="gv-row"><div><div class="give-what">An API key: ${esc(g.provider)}, up to $${g.budgetUsd}${g.period ? ` a ${esc(g.period)}` : ''} ${state}</div>
          <div class="small muted">to <a href="${f.href}">${f.name}</a> · ${day(g.createdAt)} · ${esc(g.modelChoice ?? g.models.slice(0, 3).join(', '))}</div></div>
          <div class="gv-acts">${vis('grant', g.grantId, g.public)}${g.revokedAt ? '' : `<button type="button" class="btn btn-small" data-revoke="${g.grantId}">Take it back</button>`}</div></div></div></li>` }
      }),
    ].sort((a, b) => b.at.localeCompare(a.at))
    root.innerHTML = rows.length
      ? `<ol class="giving">${rows.map((r) => r.html).join('')}</ol><p class="small" role="status"></p>`
      : `<div class="card"><p style="margin:0"><b>Nothing given yet.</b></p><p class="small muted">Feed a gremlin, lend it a key, or mine for it from its page. Gifts show here, public or private as you choose.</p></div>`
    const status = root.querySelector<HTMLElement>('[role=status]')
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-vis]')) b.onclick = async () => {
      b.disabled = true
      try {
        const pub = b.dataset.pub !== 'true'
        await sitePostJson('/api/giving/visibility', { kind: b.dataset.vis, id: b.dataset.vis === 'gift' ? Number(b.dataset.id) : b.dataset.id, public: pub })
        await load()
      } catch (e) { if (status) status.textContent = walletErrorMessage(e); b.disabled = false }
    }
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-revoke]')) b.onclick = async () => {
      if (!confirm('Take this key back? The gremlin stops using it at its next check (within ten minutes). Also delete or disable the key at the provider to be sure.')) return
      b.disabled = true
      try {
        await revokeGrant(b.dataset.revoke!)
        await load()
      } catch (e) { if (status) status.textContent = walletErrorMessage(e); b.disabled = false }
    }
  }

  onAccountChange(() => void load())
  void load()
}

/** Taking a lent key back: the lender's wallet signs the revocation (the gremlin checks it), as on the lend page. */
async function revokeGrant(grantId: string) {
  const { provider, address } = await keyWallet('The gremlin checks who takes a key back by itself, and it can\'t check a Quai Smart Wallet signature yet. Sign this one with the wallet that lent the key.')
  const message: KeyRevoke = { kind: 'key-revoke', address, grantId, createdAt: new Date().toISOString() }
  const signature = (await provider.request({ method: 'personal_sign', params: [messageDigest(message), address] })) as string
  const r = await fetch('/api/grants/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) })
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the board said ${r.status}`)
}

// ── Mine for it (gremlin pages) ──────────────────────────────────────────────

export function mountMine(card: HTMLElement) {
  const worker = () => { const a = account()?.address; return a ? `gz${a.slice(2, 10).toLowerCase()}` : 'gift' }
  const fill = () => { for (const c of card.querySelectorAll<HTMLElement>('[data-worker]')) c.textContent = `${c.dataset.worker}.${worker()}` }
  fill()
  onAccountChange(fill)
  for (const b of card.querySelectorAll<HTMLButtonElement>('[data-copy-mine]')) b.onclick = async () => {
    const text = `Pool: ${b.dataset.copyMine}\nWorker: ${b.dataset.user}.${worker()}\nPassword: x`
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied' } catch { b.textContent = 'Copy failed: select the text instead' }
    setTimeout(() => { b.textContent = 'Copy settings' }, 2000)
  }
  const form = card.querySelector<HTMLFormElement>('[data-pledge]')
  if (!form) return
  form.onsubmit = async (e) => {
    e.preventDefault()
    const status = form.querySelector<HTMLElement>('[role=status]')!
    const btn = form.querySelector<HTMLButtonElement>('button')!
    const sel = form.querySelector<HTMLSelectElement>('select')!
    btn.disabled = true
    status.textContent = ''
    try {
      const pub = form.querySelector<HTMLInputElement>('input[name=public]')!.checked
      await sitePostJson('/api/gifts/hashrate', { gremlin: form.dataset.pledge, route: sel.value, to: sel.selectedOptions[0]?.dataset.to, public: pub })
      status.textContent = pub ? 'Thank you! It’s on your profile and its page.' : 'Thank you! It’s on your profile (only you see it).'
    } catch (err) { status.textContent = walletErrorMessage(err) }
    finally { btn.disabled = false }
  }
}
