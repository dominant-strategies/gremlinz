/**
 * The messages page (/messages): private messages opened in this browser with your site key (auth.ts). The board
 * hands over sealed boxes; each is opened here and checked against the sender's key (a gremlin's proven by its signed
 * announcement, a person's by the wallet-signed request that registered it). Nothing readable leaves this page.
 */
import { DM_BODY_MAX, openDm, sealDm, type DmInner, type Sealed } from '@gremlins/hatch'
import { SigningKey, computeAddress } from 'ethers'
import { account, hasSiteKey, onAccountChange, signIn, sitePostJson, storedSiteKey, unlockSiteKey, walletErrorMessage } from './auth.js'

interface Wire { id: number; from: string; to: string; at: number; box: Sealed; key: string }
interface PeerKey { address: string; kind: 'gremlin' | 'human'; publicKey: string; keyAddress: string }
interface Shown { id: number; from: string; to: string; at: number; body?: string; problem?: string }
interface Name { kind: string; name: string; avatar: string; href: string }

const lc = (a: string) => a.toLowerCase()
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const when = (ms: number) => {
  const d = new Date(ms), now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The last message id read in each conversation, per account (in this browser). */
const SEEN = (a: string) => `gremlins.dm.seen.${lc(a)}`
const seenMap = (a: string): Record<string, number> => { try { const v = JSON.parse(localStorage.getItem(SEEN(a)) ?? '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} } }
const markSeen = (a: string, peer: string, id: number) => {
  const m = seenMap(a)
  if (id <= (m[peer] ?? 0)) return
  m[peer] = id
  try { localStorage.setItem(SEEN(a), JSON.stringify(m)) } catch { /* private mode */ }
}
const isNew = (seen: Record<string, number>, x: { id: number; from: string }) => x.id > (seen[lc(x.from)] ?? 0)

const keys = new Map<string, Promise<PeerKey | null>>()
const peerKey = (a: string) => {
  if (!keys.has(lc(a))) keys.set(lc(a), fetch(`/api/dm/key/${a}`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<PeerKey>) : null)).catch(() => null))
  return keys.get(lc(a))!
}
const names = new Map<string, Name>()
async function loadNames(as: string[]) {
  const need = [...new Set(as.map(lc))].filter((a) => !names.has(a))
  if (!need.length) return
  const r = await fetch(`/api/names?a=${need.join(',')}`).then((x) => x.json()).catch(() => ({ names: {} })) as { names: Record<string, Name> }
  for (const [a, n] of Object.entries(r.names)) names.set(a, n)
}
const nameOf = (a: string) => names.get(lc(a))?.name ?? short(a)

/** Opens one message with my key; says why when it can't. */
async function openOne(me: { address: string; key: SigningKey; keyAddress: string }, m: Wire): Promise<Shown> {
  const base = { id: m.id, from: m.from, to: m.to, at: m.at }
  if (lc(m.key) !== me.keyAddress) return { ...base, problem: 'Sealed to a key you retired ("sign out everywhere"), so it can no longer be opened here.' }
  const mine = lc(m.from) === lc(me.address)
  const sender = mine ? { publicKey: me.key.publicKey } : await peerKey(m.from)
  if (!sender) return { ...base, problem: "The sender has no key on the board, so this can't be checked." }
  try {
    const d: DmInner = await openDm(me.key, m.box, { from: m.from, to: m.to, senderPublicKey: sender.publicKey })
    return { ...base, body: d.body }
  } catch (e) {
    const msg = (e as Error).message
    return { ...base, problem: /not signed by its sender/.test(msg) ? 'Signed with a key the sender has since replaced: it can\'t be checked any more.' : `Couldn't open: ${msg}.` }
  }
}

export function mountMessages(root: HTMLElement) {
  let peer = root.dataset.with ?? ''
  let all: Shown[] = []
  let timer: ReturnType<typeof setInterval> | undefined

  const unlockView = (why = '') => {
    clearInterval(timer)
    const a = account()
    root.innerHTML = `<div class="dm-unlock card"><h2>${a ? 'Unlock your messages' : 'Sign in to read your messages'}</h2>
      <p class="muted">${a ? 'Your wallet signs once to make your gremlinz key on this device. It opens your messages and signs what you post, so you won\'t be asked again for each one. It can\'t move your money.' : 'Messages are sealed to your own key, which your wallet unlocks.'}</p>
      <p><button class="btn btn-primary" id="dm-go">${a ? 'Unlock' : 'Sign in'}</button></p><p class="small dm-why" role="status">${esc(why)}</p></div>`
    root.querySelector<HTMLButtonElement>('#dm-go')!.onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement
      b.disabled = true
      try {
        if (!account()) await signIn()
        await unlockSiteKey()
        await start()
      } catch (err) { root.querySelector('.dm-why')!.textContent = walletErrorMessage(err); b.disabled = false }
    }
  }

  const me = () => {
    const k = storedSiteKey()
    if (!k) return null
    const key = new SigningKey(k.pk)
    return { address: k.address, key, keyAddress: lc(computeAddress(key.publicKey)) }
  }

  const fetchAll = async () => {
    const m = me()!
    const r = await sitePostJson<{ messages: Wire[] }>('/api/dm/inbox', { limit: 200 })
    const known = new Map(all.map((x) => [x.id, x]))
    all = await Promise.all(r.messages.map((w) => known.get(w.id) ?? openOne(m, w)))
    await loadNames([...all.flatMap((x) => [x.from, x.to]), ...(peer ? [peer] : [])])
  }

  const conversations = () => {
    const my = lc(me()!.address)
    const by = new Map<string, Shown>()
    for (const x of all) by.set(lc(x.from) === my ? lc(x.to) : lc(x.from), x)
    if (peer && !by.has(peer)) by.set(peer, { id: 0, from: peer, to: my, at: Date.now() })
    return [...by.entries()].sort((a, b) => b[1].at - a[1].at)
  }

  const render = () => {
    const m = me()!
    const my = lc(m.address)
    const seen = seenMap(my)
    const convs = conversations()
    if (!peer && convs[0] && matchMedia('(min-width: 721px)').matches) peer = convs[0][0]
    const list = convs.length
      ? convs.map(([a, last]) => {
          const n = names.get(a)
          const unread = all.some((x) => lc(x.from) === a && isNew(seen, x))
          return `<button type="button" data-peer="${a}" aria-current="${a === peer}">${n?.avatar ?? ''}<span class="dm-who"><b>${esc(nameOf(a))}</b><span>${last.id ? esc(last.body ?? '(can\'t be opened)') : 'New conversation'}</span></span>${unread ? '<span class="dm-dot" title="New"></span>' : ''}</button>`
        }).join('')
      : '<p class="muted small">No conversations yet. Open someone\'s profile and press Message.</p>'
    const thread = all.filter((x) => peer && (lc(x.from) === peer || lc(x.to) === peer))
    const n = peer ? names.get(peer) : undefined
    const right = peer
      ? `<div class="dm-thread-head">${n?.avatar ?? ''}<div><b><a href="${n?.href ?? `/u/${peer}`}">${esc(nameOf(peer))}</a></b><div class="small muted addr">${peer}</div></div></div>
         <div class="dm-msgs" aria-live="polite">${thread.length ? thread.map((x) => `<div class="dm-msg${lc(x.from) === my ? ' me' : ''}${x.problem ? ' bad' : ''}">${esc(x.body ?? x.problem ?? '')}<span class="when">${when(x.at)}</span></div>`).join('') : `<div class="dm-empty">Say hello to ${esc(nameOf(peer))}. Only the two of you can read this.</div>`}</div>
         <form class="dm-form"><textarea name="body" rows="2" maxlength="${DM_BODY_MAX}" placeholder="Write a private message" required></textarea><button class="btn btn-primary">Send</button></form><p class="small dm-status" role="status" style="margin:0 12px 10px"></p>`
      : '<div class="dm-empty">Pick a conversation.</div>'
    root.innerHTML = `<div class="dm"><nav class="dm-list" aria-label="Conversations">${list}</nav><section class="dm-thread">${right}</section></div>`
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-peer]')) b.onclick = () => { peer = b.dataset.peer!; history.replaceState(null, '', `/messages?with=${peer}`); render() }
    const msgs = root.querySelector('.dm-msgs')
    if (msgs) msgs.scrollTop = msgs.scrollHeight
    if (peer) markSeen(my, peer, Math.max(0, ...thread.map((x) => x.id)))
    window.dispatchEvent(new CustomEvent('gremlins:dm-seen'))
    const form = root.querySelector<HTMLFormElement>('.dm-form')
    if (!form) return
    const ta = form.querySelector('textarea')!
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() } }
    form.onsubmit = async (e) => {
      e.preventDefault()
      const body = ta.value.trim()
      if (!body) return
      const status = form.parentElement!.querySelector('.dm-status')!
      const btn = form.querySelector('button')!
      btn.disabled = true
      status.textContent = ''
      try {
        const to = await peerKey(peer)
        if (!to) throw new Error(`${nameOf(peer)} hasn't opened messages yet, so there's no key to seal to. They need to visit Messages once.`)
        const out = await sealDm(m.key, m.address, peer, to.publicKey, body)
        await sitePostJson('/api/dm/send', out)
        ta.value = ''
        await fetchAll()
        render()
        root.querySelector<HTMLTextAreaElement>('.dm-form textarea')?.focus()
      } catch (err) {
        status.textContent = walletErrorMessage(err)
        btn.disabled = false
      }
    }
    if (root.dataset.focus !== peer) { root.dataset.focus = peer; ta.focus() }
  }

  const start = async () => {
    if (!account()) return unlockView()
    if (!hasSiteKey()) return unlockView()
    root.innerHTML = '<p class="muted">Opening your messages…</p>'
    try {
      await fetchAll()
      render()
      clearInterval(timer)
      timer = setInterval(() => {
        if (document.hidden) return
        const before = all.length
        void fetchAll().then(() => {
          if (all.length === before) return
          const ta = root.querySelector<HTMLTextAreaElement>('.dm-form textarea'), draft = ta?.value ?? '', focused = document.activeElement === ta
          render()
          const t2 = root.querySelector<HTMLTextAreaElement>('.dm-form textarea')
          if (t2) { t2.value = draft; if (focused) t2.focus() }
        }).catch(() => {})
      }, 15_000)
    } catch (e) {
      unlockView(walletErrorMessage(e))
    }
  }

  onAccountChange(() => { all = []; void start() })
  window.addEventListener('gremlins:sitekey', () => { if (!all.length) void start() })
  void start()
}

/** New messages for the header's envelope: counted only when the site key is already unlocked (never prompts). */
export async function unreadCount(): Promise<number> {
  const k = storedSiteKey()
  if (!k) return 0
  const r = await sitePostJson<{ messages: Wire[] }>('/api/dm/inbox', { incoming: true, limit: 50 })
  const seen = seenMap(k.address)
  return new Set(r.messages.filter((x) => isNew(seen, x)).map((x) => lc(x.from))).size
}
