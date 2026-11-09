/**
 * One sign-in for the whole site. A single "Sign in" button opens one dialog offering Pelagus, MetaMask, Phantom and
 * WalletConnect; the choice is remembered (localStorage, shared by the board, forge and static pages) and every write
 * is a signed request: EIP-191 over `METHOD path\nts\nkeccak(body)`, exactly as gremlins sign.
 */
import { announcedIcon, metamask, pelagus, phantom, type Eip1193 } from './wallets.js'

export type WalletKind = 'pelagus' | 'metamask' | 'phantom' | 'walletconnect'
export interface Account { address: string; kind: WalletKind }

interface WalletOption {
  kind: WalletKind
  name: string
  blurb: string
  provider: () => Eip1193 | undefined
  /** Where to get the wallet when it isn't installed (a deep link into the wallet's own browser on phones). */
  get?: () => string
}

const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
const here = () => location.href

const WALLETS: WalletOption[] = [
  { kind: 'pelagus', name: 'Pelagus', blurb: 'Quai wallet', provider: pelagus, get: () => 'https://pelaguswallet.io' },
  {
    kind: 'metamask', name: 'MetaMask', blurb: 'Browser or app', provider: metamask,
    get: () => (mobile ? `https://metamask.app.link/dapp/${location.host}${location.pathname}` : 'https://metamask.io/download/'),
  },
  {
    kind: 'phantom', name: 'Phantom', blurb: 'Browser or app', provider: phantom,
    get: () => (mobile ? `https://phantom.app/ul/browse/${encodeURIComponent(here())}?ref=${encodeURIComponent(location.origin)}` : 'https://phantom.com/download'),
  },
  { kind: 'walletconnect', name: 'WalletConnect', blurb: 'Scan with a phone wallet', provider: () => undefined },
]
const walletName = (k: WalletKind) => WALLETS.find((w) => w.kind === k)!.name
export const isEvm = (k: WalletKind) => k !== 'pelagus'

// ── stored account ───────────────────────────────────────────────────────────

const KEY = 'gremlins.board.address'
const KIND = 'gremlins.board.wallet'
const load = (k: string) => { try { return localStorage.getItem(k) ?? undefined } catch { return undefined } }
const store = (k: string, v?: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch { /* private mode */ } }

function readAccount(): Account | undefined {
  const address = load(KEY)
  let kind = load(KIND) as WalletKind | 'evm' | undefined
  if (!address) return undefined
  // Sign-ins from before the unified dialog said only 'evm' (any wallet through AppKit).
  if (kind === 'evm' || !kind) kind = metamask() ? 'metamask' : phantom() ? 'phantom' : pelagus() && !kind ? 'pelagus' : 'walletconnect'
  return { address, kind }
}

let current = readAccount()
const listeners = new Set<(a: Account | undefined) => void>()

function setAccount(a: Account | undefined) {
  current = a
  store(KEY, a?.address)
  store(KIND, a?.kind)
  listeners.forEach((fn) => fn(a))
}

export const account = (): Account | undefined => current
/** Calls `fn` whenever the signed-in account changes (in this tab or another). Returns an unsubscribe function. */
export function onAccountChange(fn: (a: Account | undefined) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== KIND) return
  current = readAccount()
  listeners.forEach((fn) => fn(current))
})

// ── connecting ───────────────────────────────────────────────────────────────

async function requestAccounts(kind: WalletKind, p: Eip1193, ask: boolean): Promise<string | undefined> {
  const method = kind === 'pelagus' ? (ask ? 'quai_requestAccounts' : 'quai_accounts') : ask ? 'eth_requestAccounts' : 'eth_accounts'
  return ((await p.request({ method })) as string[] | undefined)?.[0]
}

/** Connects one wallet and returns its provider and account; does not change who is signed in. */
export async function connectWallet(kind: WalletKind): Promise<{ provider: Eip1193; address: string }> {
  if (kind === 'walletconnect') return (await import('./wallets.js')).connectWalletConnect()
  const provider = WALLETS.find((w) => w.kind === kind)!.provider()
  if (!provider) throw new Error(`${walletName(kind)} isn't installed in this browser.`)
  const address = await requestAccounts(kind, provider, true)
  if (!address) throw new Error(`${walletName(kind)} didn't share an account.`)
  return { provider, address }
}

/** The signed-in wallet's provider, reconnecting if needed; follows the wallet if its account was switched. */
export async function walletProvider(): Promise<Eip1193> {
  const a = current ?? (await signIn())
  if (a.kind === 'walletconnect') {
    const w = await import('./wallets.js')
    const s = (await w.walletConnectSession()) ?? (await w.connectWalletConnect())
    if (s.address.toLowerCase() !== a.address.toLowerCase()) setAccount({ ...a, address: s.address })
    return s.provider
  }
  const p = WALLETS.find((w) => w.kind === a.kind)!.provider()
  if (!p) throw new Error(`${walletName(a.kind)} isn't available in this browser. Sign out and pick another wallet.`)
  const now = (await requestAccounts(a.kind, p, false).catch(() => undefined)) ?? (await requestAccounts(a.kind, p, true))
  if (!now) throw new Error(`${walletName(a.kind)} is locked. Unlock it and try again.`)
  if (now.toLowerCase() !== a.address.toLowerCase()) setAccount({ ...a, address: now })
  return p
}

/** Opens the sign-in dialog; resolves with the new account, rejects if it's closed without one. */
export async function signIn(): Promise<Account> {
  const { address, kind } = await chooseWallet({ title: 'Sign in', note: 'Your wallet is your account. Signing in is free and sends nothing.' })
  const a = { address, kind }
  setAccount(a)
  return a
}

export function signOut(): void {
  if (current?.kind === 'walletconnect') void import('./wallets.js').then((w) => w.disconnectWalletConnect())
  setAccount(undefined)
}

/**
 * A wallet for a one-off EVM payment (donations): the signed-in wallet when it's an EVM one, otherwise picked from the
 * dialog without changing who is signed in.
 */
export async function evmWallet(): Promise<{ provider: Eip1193; address: string }> {
  if (current && isEvm(current.kind)) return { provider: await walletProvider(), address: current.address }
  const { kind } = await chooseWallet({ title: 'Pay with', note: 'Pick the wallet to send from.', only: ['metamask', 'phantom', 'walletconnect'] })
  return connectWallet(kind)
}

// ── signed requests ──────────────────────────────────────────────────────────

/** POSTs JSON as a signed board request (signing in first if needed). */
export async function signedPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  // Signing code loads with the first signed request, so pages that only show the button stay light.
  const [{ hexlify, toUtf8Bytes }, { AUTH_HEADERS, requestSigningPayload }] = await Promise.all([import('ethers'), import('@gremlins/hatch')])
  const p = await walletProvider()
  const address = current!.address
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  // Pelagus, MetaMask, Phantom and WalletConnect wallets all take personal_sign([hexMessage, account]) (EIP-191).
  const signature = (await p.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(requestSigningPayload('POST', path, ts, raw))), address] })) as string
  return fetch(path, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', [AUTH_HEADERS.address]: address, [AUTH_HEADERS.timestamp]: String(ts), [AUTH_HEADERS.signature]: signature },
    body: raw,
  })
}

/** signedPost, returning the parsed reply; throws with the board's error message. */
export async function signedPostJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await signedPost(path, body, signal)
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; retryAfterSec?: number }
  if (!res.ok) {
    if (res.status === 429) throw new Error(`You've reached today's limit. Try again in ${Math.ceil((j.retryAfterSec ?? 3600) / 60)} minutes.`)
    throw new Error(j.error ?? `The board answered ${res.status}.`)
  }
  return j
}

/** A wallet error in plain words: declining is not a failure worth shouting about. */
export function walletErrorMessage(e: unknown): string {
  const err = e as { code?: number; message?: string }
  if (err?.code === 4001 || /reject|denied|declined|cancel/i.test(err?.message ?? '')) return 'Cancelled in the wallet.'
  return err?.message || 'The wallet ran into a problem.'
}

// ── dialog ───────────────────────────────────────────────────────────────────

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.append(...kids)
  return el
}

const GLYPHS: Record<WalletKind, string> = {
  pelagus: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#24211d"/><path d="M7 19c3-1 4-6 9-6s6 5 9 6M7 23c3-1 4-4 9-4s6 3 9 4" fill="none" stroke="#e9e3d8" stroke-width="2.2" stroke-linecap="round"/><circle cx="16" cy="8.5" r="2.4" fill="#e0a83e"/></svg>',
  metamask: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#f6851b"/><path d="M8 9l7 5-1.4-3.6L8 9zm16 0l-5.6 1.4L17 14l7-5zM9.5 20l1.5 4 4-1.2-.6-2.8H9.5zm13 0h-4.4l-.6 2.8 4 1.2 1-4zM12 15l-1.6 3 5 .2-.2-4.2L12 15zm8 0l-3.3-1L16.6 18l5-.2L20 15z" fill="#fff"/></svg>',
  phantom: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#ab9ff2"/><path d="M8 18.5C8 12.7 11.6 9 16.2 9 20.7 9 24 12.4 24 16.6c0 3-1.7 5.4-3.6 5.4-1 0-1.2-.8-1.6-1.6-.5 1-1.4 1.6-2.4 1.6s-1.6-.7-2-1.5c-.5.9-1.5 1.5-2.6 1.5C9.5 22 8 20.6 8 18.5z" fill="#fff"/><circle cx="15" cy="15" r="1.3" fill="#ab9ff2"/><circle cx="19" cy="15" r="1.3" fill="#ab9ff2"/></svg>',
  walletconnect: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#3b99fc"/><path d="M9.6 12.6c3.5-3.4 9.3-3.4 12.8 0l.4.4-1.5 1.5-.6-.6a6.9 6.9 0 0 0-9.4 0l-.6.6-1.5-1.5.4-.4zm-2.4 3l1.4-1.4 4 3.9 3.4-3.3 3.4 3.3 4-3.9 1.4 1.4-5.4 5.3-3.4-3.3-3.4 3.3-5.4-5.3z" fill="#fff"/></svg>',
}

function walletIcon(kind: WalletKind): HTMLElement {
  const box = h('span', { class: 'wallet-icon' })
  const announced = kind === 'walletconnect' ? undefined : announcedIcon(kind)
  if (announced) box.append(h('img', { src: announced, alt: '' }))
  else box.innerHTML = GLYPHS[kind]
  return box
}

let open: HTMLDialogElement | undefined

function chooseWallet(opts: { title: string; note: string; only?: WalletKind[] }): Promise<Account> {
  open?.close()
  return new Promise((resolve, reject) => {
    const status = h('p', { class: 'wallet-status', role: 'status', 'aria-live': 'polite' })
    const list = h('div', { class: 'wallet-list' })
    const close = h('button', { type: 'button', class: 'wallet-close', 'aria-label': 'Close' }, '×')
    const dlg = h('dialog', { class: 'wallet-dialog', 'aria-labelledby': 'wallet-title' },
      h('div', { class: 'wallet-head' }, h('h2', { id: 'wallet-title' }, opts.title), close),
      h('p', { class: 'wallet-note' }, opts.note),
      list,
      status,
      h('p', { class: 'wallet-foot' }, 'We never see your keys. Signing a request costs no gas.'),
    ) as HTMLDialogElement
    let settled = false
    const finish = (a?: Account, err?: Error) => {
      if (settled) return
      settled = true
      dlg.close()
      dlg.remove()
      if (open === dlg) open = undefined
      a ? resolve(a) : reject(err ?? Object.assign(new Error('Sign-in cancelled.'), { code: 4001 }))
    }
    close.onclick = () => finish()
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish() })
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish() }) // backdrop

    let busy = false
    const renderRows = () => {
      list.replaceChildren()
      for (const w of WALLETS.filter((w) => !opts.only || opts.only.includes(w.kind))) {
        const installed = w.kind === 'walletconnect' || !!w.provider()
        const state = w.kind === 'walletconnect' ? 'QR code' : installed ? 'Detected' : mobile && w.kind !== 'pelagus' ? 'Open app' : 'Install'
        const text = h('span', { class: 'wallet-text' }, h('b', {}, w.name), h('span', {}, w.blurb))
        const tag = h('span', { class: `wallet-tag${installed && w.kind !== 'walletconnect' ? ' on' : ''}` }, state)
        if (!installed && w.get) {
          list.append(h('a', { class: 'wallet-row', href: w.get(), target: '_blank', rel: 'noopener' }, walletIcon(w.kind), text, tag))
          continue
        }
        const row = h('button', { type: 'button', class: 'wallet-row' }, walletIcon(w.kind), text, tag)
        if (w.kind === 'walletconnect') {
          const warm = () => void import('./wallets.js').then((m) => m.prepareWalletConnect()).catch(() => {})
          row.addEventListener('pointerenter', warm, { once: true })
          row.addEventListener('focus', warm, { once: true })
        }
        row.onclick = async () => {
          if (busy) return
          busy = true
          list.classList.add('busy')
          row.classList.add('waiting')
          status.classList.remove('error')
          status.textContent = w.kind === 'walletconnect' ? 'Opening WalletConnect…' : `Approve the connection in ${w.name}…`
          try {
            // AppKit draws its own modal; ours sits in the top layer and would cover it, so it steps aside once that's up.
            const { address } = w.kind === 'walletconnect'
              ? await (await import('./wallets.js')).connectWalletConnect(() => dlg.close())
              : await connectWallet(w.kind)
            finish({ address, kind: w.kind })
          } catch (e) {
            // Closing the QR code just brings this dialog back; anything else gets said.
            const closedQr = w.kind === 'walletconnect' && (e as { code?: number }).code === 4001
            // Reopen on the next task: the Escape that closed the QR code would otherwise close this dialog too.
            if (w.kind === 'walletconnect' && !dlg.open) await new Promise((r) => setTimeout(r)).then(() => !settled && dlg.showModal())
            status.textContent = closedQr ? '' : walletErrorMessage(e)
            status.classList.toggle('error', !closedQr)
          } finally {
            busy = false
            list.classList.remove('busy')
            row.classList.remove('waiting')
          }
        }
        list.append(row)
      }
    }
    renderRows()
    // A wallet that announces itself after the dialog opened moves from "Install" to "Detected" (not mid-connection).
    const recheck = () => { if (!busy && !settled) renderRows() }
    window.addEventListener('gremlins:wallets', recheck)
    dlg.addEventListener('close', () => { if (settled) window.removeEventListener('gremlins:wallets', recheck) })
    void import('./wallets.js').then((m) => m.requestWallets())
    document.body.append(dlg)
    open = dlg
    dlg.showModal()
    ;(list.querySelector('button.wallet-row') as HTMLElement | null)?.focus()
  })
}

// ── header button ────────────────────────────────────────────────────────────

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Renders the header's sign-in button (or the signed-in account menu) into `slot`, and keeps it current. */
export function mountAuth(slot: HTMLElement | null = document.getElementById('gremlins-auth')) {
  if (!slot) return
  const extras = [...slot.childNodes] // anything the page put there (a call to action) stays after the button
  let closeMenu = () => {}
  document.addEventListener('click', (e) => { if (!slot.contains(e.target as Node)) closeMenu() })
  const render = (a = current) => {
    closeMenu = () => {}
    document.body.classList.toggle('signed-in', !!a)
    const box = h('div', { class: 'auth' })
    if (!a) {
      const b = h('button', { type: 'button', class: 'btn btn-small auth-signin' }, 'Sign in')
      b.onclick = () => void signIn().catch(() => {})
      box.append(b)
    } else {
      const chip = h('button', { type: 'button', class: 'auth-chip', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: a.address }, walletIcon(a.kind), h('span', { class: 'addr' }, short(a.address)))
      const copy = h('button', { type: 'button' }, 'Copy address')
      const out = h('button', { type: 'button' }, 'Sign out')
      const menu = h('div', { class: 'auth-menu', hidden: '' },
        h('p', { class: 'small muted' }, `Signed in with ${walletName(a.kind)}`), h('p', { class: 'addr' }, a.address), copy, out)
      const toggle = (show = menu.hidden) => { menu.hidden = !show; chip.setAttribute('aria-expanded', String(show)) }
      chip.onclick = (e) => { e.stopPropagation(); toggle() }
      copy.onclick = () => { void navigator.clipboard?.writeText(a.address); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy address' }, 1200) }
      out.onclick = () => signOut()
      closeMenu = () => toggle(false)
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggle(false); chip.focus() } })
      box.append(chip, menu)
    }
    slot.replaceChildren(box, ...extras)
  }
  render()
  onAccountChange(render)
}
