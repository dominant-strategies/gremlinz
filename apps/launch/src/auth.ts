/**
 * One sign-in for the whole site. A single "Sign in" button opens one dialog: email or X (a Quai Smart Wallet, run in
 * this page), then Pelagus, MetaMask, Phantom and WalletConnect; the choice is remembered (localStorage, shared by the board, forge and static
 * pages) and every write is a signed request: EIP-191 over `METHOD path\nts\nkeccak(body)`, exactly as gremlins sign.
 * A Smart Wallet account is a Safe: its wallet signs the same payload and the board asks the Safe (ERC-1271).
 */
import { connectSmartWallet, disconnectSmartWallet, prepareSmartWallet, smartWalletAccount, smartWalletSign } from './smart-wallet.js'
import { privy, returningFromX } from './privy-bridge.js'
import { announcedIcon, metamask, pelagus, phantom, type Eip1193 } from './wallets.js'

export type WalletKind = 'smartwallet' | 'pelagus' | 'metamask' | 'phantom' | 'walletconnect'
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
  // Email or X (offered above the wallet list): a Safe run in this page; signs as a Safe, so never for EVM payments.
  { kind: 'smartwallet', name: 'Quai Smart Wallet', blurb: 'Email or X', provider: () => undefined },
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
export const isEvm = (k: WalletKind) => k !== 'pelagus' && k !== 'smartwallet'
/** Signed in through a site of its own rather than an injected provider. */
const external = (k: WalletKind) => k === 'walletconnect' || k === 'smartwallet'

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
  if (!a || a.address.toLowerCase() !== current?.address.toLowerCase()) clearSessionKey() // a grant belongs to one account
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
// Back from X's sign-in page: Privy finishes the login, then the Smart Wallet's Safe becomes the signed-in account.
if (returningFromX())
  void privy()
    .then(async (p) => { if (p.authenticated()) setAccount({ address: await connectSmartWallet(), kind: 'smartwallet' }) })
    .catch((e) => console.warn('X sign-in did not finish:', e))

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
  if (a.kind === 'smartwallet') throw new Error('Quai Smart Wallet signs in its own window; it has no provider here.')
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
  const { address, kind } = await chooseWallet({ title: 'Sign in', note: 'Use your email or X, or a wallet you already have. Signing in is free and sends nothing.' })
  const a = { address, kind }
  setAccount(a)
  return a
}

export function signOut(): void {
  if (current?.kind === 'walletconnect') void import('./wallets.js').then((w) => w.disconnectWalletConnect())
  if (current?.kind === 'smartwallet') disconnectSmartWallet()
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

/**
 * Signs `message(address)` with the signed-in wallet (signing in first if needed) and returns who signed.
 * The message is built after the wallet answers, since the wallet decides which address is signing.
 */
async function walletSign(message: (address: string) => string): Promise<{ address: string; signature: string }> {
  const { hexlify, toUtf8Bytes } = await import('ethers')
  const a = current ?? (await signIn())
  let p: Eip1193 | undefined
  if (a.kind === 'smartwallet') {
    // After a reload the page reconnects first; follow the wallet if it now answers for another Safe.
    const safe = await smartWalletAccount()
    if (safe.toLowerCase() !== a.address.toLowerCase()) setAccount({ ...a, address: safe })
  } else p = await walletProvider()
  const address = current!.address, m = message(address)
  // Pelagus, MetaMask, Phantom and WalletConnect wallets all take personal_sign([hexMessage, account]) (EIP-191); the
  // Smart Wallet takes the message itself and has its Safe sign the same EIP-191 hash.
  const signature = p
    ? ((await p.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(m)), address] })) as string)
    : await smartWalletSign(address, m)
  return { address, signature }
}

/** POSTs JSON as a signed board request (signing in first if needed). */
export async function signedPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  // The Smart Wallet signs in a popup, which the browser allows only straight from the click: open it before any await.
  if (current?.kind === 'smartwallet') prepareSmartWallet()
  // Signing code loads with the first signed request, so pages that only show the button stay light.
  const { AUTH_HEADERS, requestSigningPayload } = await import('@gremlins/hatch')
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  const { address, signature } = await walletSign(() => requestSigningPayload('POST', path, ts, raw))
  return fetch(path, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', [AUTH_HEADERS.address]: address, [AUTH_HEADERS.timestamp]: String(ts), [AUTH_HEADERS.signature]: signature },
    body: raw,
  })
}

// ── session keys ─────────────────────────────────────────────────────────────

/** A throwaway key the wallet has granted one scope to, kept in this browser until it expires or you sign out. */
interface StoredSession { pk: string; grant: import('@gremlins/hatch').SessionGrant }
const SESSION_KEY = 'gremlins.session'
const SESSION_SEC = 24 * 3600
function loadStoredSession(scope: string): StoredSession | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as StoredSession | null
    const now = Math.floor(Date.now() / 1000)
    if (s && s.grant.scope === scope && s.grant.expires > now + 120 && s.grant.address.toLowerCase() === current?.address.toLowerCase()) return s
  } catch { /* none, or private mode */ }
  return undefined
}
export function clearSessionKey(): void {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}
/** Has this browser a live session for `scope`, so the next request won't open the wallet? */
export const hasSessionKey = (scope: 'forge' = 'forge') => !!loadStoredSession(scope)

/**
 * POSTs JSON signed by a browser session key: the wallet signs once to grant the key `scope` for a day, and every
 * request after that goes without a wallet prompt. A rejected session is dropped and granted again, once.
 */
export async function sessionPost(path: string, body: unknown, opts: { scope: 'forge'; signal?: AbortSignal }): Promise<Response> {
  let stored = loadStoredSession(opts.scope)
  if (!stored && current?.kind === 'smartwallet') prepareSmartWallet() // popup only from the click, before any await
  const [{ Wallet }, { AUTH_HEADERS, SESSION_HEADER, requestSigningPayload, sessionGrantMessage }] = await Promise.all([import('ethers'), import('@gremlins/hatch')])
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!stored) {
      const key = Wallet.createRandom(), expires = Math.floor(Date.now() / 1000) + SESSION_SEC
      let terms: { address: string; key: string; scope: 'forge'; expires: number } | undefined
      const { signature } = await walletSign((address) => sessionGrantMessage((terms = { address: address.toLowerCase(), key: key.address.toLowerCase(), scope: opts.scope, expires })))
      stored = { pk: key.privateKey, grant: { ...terms!, signature } }
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(stored)) } catch { /* private mode: lives for this page */ }
    }
    const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000)
    const signature = await new Wallet(stored.pk).signMessage(requestSigningPayload('POST', path, ts, raw))
    const res = await fetch(path, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        [AUTH_HEADERS.address]: stored.grant.address,
        [AUTH_HEADERS.timestamp]: String(ts),
        [AUTH_HEADERS.signature]: signature,
        [SESSION_HEADER]: JSON.stringify(stored.grant),
      },
      body: raw,
    })
    if (res.status !== 401 || attempt) return res
    const why = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error ?? ''
    if (!/session/.test(why)) return res
    clearSessionKey(); stored = undefined // the board turned the session down (expired, clock skew): grant a fresh one
  }
  throw new Error('unreachable')
}

/** sessionPost, returning the parsed reply; throws with the board's error message. */
export async function sessionPostJson<T>(path: string, body: unknown, opts: { scope: 'forge'; signal?: AbortSignal }): Promise<T> {
  return readReply<T>(await sessionPost(path, body, opts))
}
async function readReply<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; retryAfterSec?: number }
  if (!res.ok) {
    if (res.status === 429) throw new Error(`You've reached today's limit. Try again in ${Math.ceil((j.retryAfterSec ?? 3600) / 60)} minutes.`)
    throw new Error(j.error ?? `The board answered ${res.status}.`)
  }
  return j
}

/** signedPost, returning the parsed reply; throws with the board's error message. */
export async function signedPostJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return readReply<T>(await signedPost(path, body, signal))
}

/** A wallet error in plain words: declining is not a failure worth shouting about. */
export function walletErrorMessage(e: unknown): string {
  const err = e as { code?: number | string; message?: string }
  if (err?.code === 4001 || err?.code === 'WALLET_CLOSED' || /reject|denied|declined|cancel/i.test(err?.message ?? '')) return 'Cancelled in the wallet.'
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
  smartwallet: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#e22901"/><rect x="7.5" y="9" width="17" height="14" rx="3" fill="none" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="3" fill="none" stroke="#fff" stroke-width="2"/><path d="M16 13v-1.2M16 20.2V19M10.5 23v1.5M21.5 23v1.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  // The official Pelagus mark (pelaguswallet.io/images/pelagus-mark.png: a white sail) on a dark tile.
  pelagus: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#1e1e28"/><image x="6" y="8" width="20" height="16" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAWEAAAEYCAYAAACN0kfeAAAOcklEQVR4nO3d64om1RUG4NrDCIq5n4QYFBTG+wnkZ1BxiBDBXI+Cwgwq5H4yKCjs8Jme+E1Pd893qKq91trP80tl7K6pw7vf2nValgf0Gw/9GQA21l/1bOvfBzCLduofvK8Rt9ZO/hkAvOrsAH1oekIgA5zn0Zl//mXQPj9h2uKf5/5sAM7QTyeQAe5w9XzuuXdPmLIA+N1qF9UuuZVNIAOzW/XOhmvuKRbIwIzOvjB3QpB+ccn/6z5kYEab3eO7xpN22jFQ3apNeO0A1Y6B6jZ/2q33/suyLI/X+nnaMVDJZk34pdbaW2sGp3YMVLLrex+2eiObdgxktfvLd7Z8NaYwBrIZ8ga0Pd5RLJCBDIa9hnKvl8ULY2DqC3NbPNhxDl8HASIL8UL2nT+h9Ly19sGOvw8gdggfjPiWnakKYLQwIXww6qOiwhgYJVQIH4z8urMwBpbZQ3h0EB8IY2DqEI4QxAfCGJg2hKME8YEwBqYM4UhBfCCMgTIPa2QMPm9wA9YWJuAyNeIjHvwA5gjhwEF8IIyBmtMRt2z+rokLvX8zVfFs9IIAuaRqwlt8Lqn6PDYQW8qwCDwt8QphDJQM4UxBfCCMgXIhnC2ID4QxUCqEMwbxgTAGyoRw1iA+EMZAtlvU7vN8Scinl4ASTThzGz6mGcN8yoRwlSA+EMYwj0dVgqtSeFXaJsCb54R/rTQ3WSmIq2wT4H6PWmtvvfwXr2qMRxhDbf9vjfe1rqzNsmqLzLo9gLu1U4Mr48FfNYizbg/gDfcJP3RgJz0t/m4pKuG2AO7QLn1VZJYmNkNYZdkWwOvatcGVIQBmCOIs2wI44bHlcw7mJNMUT5cJJNkWwJEHw/aSAzpqG5stnKJuB+C8F/ic/WKcqPcazxZKWjEUCOHW2gfFPn5Z9m6J+whjiK3teCof4rPws01LzH5GANGddQFupd85PIwFsSCGjC91X+vF6b9NUyxjTTctccwUBcRx1qnpFuE56vQ4wEAQhikKGKdFCa8RQSCIx65/4MIva2wZXnuGgRAeu/6BgCG8dxgI4rHrH2b3KOoBuuPFo593+B3pGJxgHy3Lgbpl8AucceseZndREx5xq9fGzXjqW9bexCAF22lJD9DVH/gQNKfRimFdLXOArR0IgnjcuodZXTsdsfbTdGfx5Nc4BixYR6t0UK7RziL8PbLRimF8Ew5xIGrG49b7oF8N6a0WwiOnJdYMhQiDSUYGQLhMK96Kfm6tvZP875CSwQxOs0nrixRil4ZBpL9DVoIY9p+OCPfwgzAdu+6tf3jYNI8CX9LKov0dMtOKYd8mHO6gE6jj179tADuGcES9958yDyQVCGJ41S6vpFwCOTdYoy1/JQY52KEJRzvQLgjVMBcZqzHAwQ5NOOrBds7gEHH5q4k2WEOpOeGIB1jv/dsz/rg2vDEDHbNqO4feh0sg2nBMEQdt2Eqbve2cesBHXPbKBDGzeDT7gXXqtETEZa/MfcXMYvdgidgoteHYDIBUtvvDGhEPqDMGBhfoBtCKqWyqJ+aunZZorX20z9KQ5SwKrjWslUY8oE5p6RGXe0YRz6ggWxMOd2p/SsA6+GMwGFLF0DYR8UDShvMxMJLZ0DnhiAfPiQNDuBY/s4iDOZzKhbkLLtK5QBf2DoqvRi8HnCtEE43YZN7U0iMuM3HPsOA+mvDlIWtKIigDJJmEaQwRDxxtOD+tmOg04WQDA+exDYkuTAhnbCwZl3lGHnsmsjAhHJUmVYdtSUShQlizZGuCmGhChXDGA9fAkY/pCSIJF8JCjb1oxUQQLoSjcsCWbsXfj14O5hUyhBO2YQ9u5PaeQZZRwoZd1IPivgEi6vJSvgCQXMgmfOBgYAQX7dhb2BCO6oHGa0qiEGc27CX8qVfEg8GUxDyckbE1TXijj4JSg+kJltmbcKY2HHE5WY9WzBY04XXb8NPrNgeRGWSZtglHPQC04XlpxaxFE4YipYCcMoVwuFvAHIhzs/2Zajoi6k5vSoL79gOo1oRDcrsaUQsCOaQbvSPu7LdbUMRlZB8aMefShGFFHu6gfAhHbBq3m2/EZWRfzoYoG8KQhSCmcgiHu10NHpie+Mra4T5pT5sjtozjaYiIy8dYpqmo1IQz0NZ5hYGZUiEcsVX03r9++c+ttY/GLg0RCWJuCxdk2XdoUxJcsq8wr7RN+IZTftKKWCLYX+oQjnjK33v/fPQykIcgJv3pUMSd+OVp5s0c8ZPRy0N8pibmlboJR5+SaK19PHoZyMHjzvNK34QjtmEX51hr/6G+Ck04nGiDArnYf+ZSIoQ1B6oRxPMoEcJQeJ74l9HLwbaE8MZf3NDSudJjrbi2UhcAou2sR7eqhVoucjKg16QJQxIG85qEMCTi/cT1lJqOiNgWDqeQ0ZaJGkxP1KAJQ1IG9xqE8D4+3en3MBlBnF/FEP5iCaa19tnoZaAuQZxbuTnhiDuleWF28q/W2l+t7VyE8B4r2cU5duSCXS4VpyNCv94SZjsTZMImHG1H1IQZtd9Z8/FVbcIh3yMBsxYR7ld2pAy4A75YluXd0QvBfDTi2MqGcNAghlF+ba29ZfXHYzoC5uCVmEEJYZiIs8N4hDBMRhDHUjqEXZCAuwniOEqHMHA/QRyDEIaJeUn8eKVvUTsw2sNpTN+NUb4J27HgNArLGOVDGDidIN6fEAZeIYj3JYSB1wji/cwSwt4vDGcSxPsof3fES3YouIyL29uapQkDF3Iv8bY0YeBUXoe5AU0YOJXXYW5gphB+OnoBoALXV9Y1zXTEgZ0H1uOC3TpmasLAipSadQhh4GKC+HpCGLiKIL7ObCH86+gFgIoE8eWmujB3YGeB7bhYd77ZmjCwISXnfEIYWJUgPo8QBlYniE8nhIEtX/zzi9X7MCEMbP2+CUH8gBlD+IvRCwCT8eKfB0x3i9qB+SoYwy1sr5uxCQODKECvE8LArgTxq4QwsDtB/DshDAwhiP9HCAPD9N777KtfCAND9cmDeNYQ9kpLCKRPHMSzhvCXoxcAeNWsQTzlwxozb3CIrrU2VS7N2oSBoPpkBUkIA+H0iYJYCAMh9UmCWAgDYfUJglgIA6H14kEshIHweuEgFsJACr1oEAthII1eMIiFMJBKLxbEQhhIpxcKYiEMpNSLBLEQBtLqBYJYCAOp9d5/WRITwkB2jzMHsRAGKnicNYhnDuHnoxcAWNXjJaGZQxgopie8UCeEgVJ6siAWwkA5PVEQC2GgpJ4kiIUwUFZPEMQpryZSwotlWX64/R9bax8f/3vv/et7/v/3lmV5d7Olo1QQt8BfcA67YFu7uafQILS971prHy2BHAX7k8GLwo6iBnHIhdpDhtOUSXyzLMuPrbXPlmBuwlrjLqQFDOJwC7QXIZxiuuLLiOH8kpDOqQUL4lALsychnNY3t+eNI7oJaNMdQbVAQezuCLJ50l/3yRLMYaBod7iZfmGwHug9E0KYCj69FcqfL0HdFc6H5b+ZfmE/YS7Kh6nkezMdMY9Ip56numn3f3MbXv19Y/gCjCKEp/WitfaHJaGbYD60ZgoFsRBmaqMPwGu5AJh/PzAnzNRuzSV/uyRze45ZU853Zpy6BVzDdATZnvS7VO/9P+aW4zZiIQwTBfKBUI4VxEIYJg7kA6E8NoiFMEx6Ue8+pup+8+/W2p+WHbgwBxc6vqJXaSV6wu83f1x2UnIkP0W1A4cwfm6tvbMUNdvURdvhbGfKJtx7fzZ6GSjr7Yrt+KXDgy4z3Q7Xd9iOUzZhL3Rnb1Xnj49VHXi23n5TNuFIL+9gDpXb8QxzyX3DbTdrCMMQmZ/Ou/RJvirTFn2j11+WP0W6S/VGQh4zTFNUOv7aBttruh0g+05APTMGceZjsa28vUxHAFHmkaccONL8xWcffaktUwjtoSc4RtfaZtM14d77P0YvA9zWe//JWsnVkNcaKKYL4WVZ3hu9AHCHt62VfIHce//+2p8xYwi/P3oBIOsp+Gjt9zB+uhQpdTOGMITlkfrTtNb+fhTI3y2JB89w9X5r2gbRRTztzqKP/EzRhdttuo0thMlAEOc81i/ZbqYjgJLa79MVzyNfqGsTzre5MEcK2nDSV1Oe2YZnC+HDCzi8QY00BHHOQD5nu802HSGAgd9see/xOQE/WxN2HybpaMOJ3wtxQsgL4fm8WJblhzv++4+ttc96718/cFP6NN8WC+Z5a+2D0Qsxk75SGAvhjVZsIN8cXp69BHUU6E8GL0p62nDei/lv2nbTNOGkF+VeHD6suBTVe/9kWZY/C+nTCOK8Je6hbTdTCEduwaXD9ooWrUEfEcK5s+S+7Tfb3RHh3gp1QwA/8I2yat8qK1okptEufAik9/7VnT9vmcTAHTj0vG12EzZmF+kS58tdbXiKJrzzi9wPoXtMAO/YmCdoy574THzP8V1hPUUT3roFm6sLf/GvXDDb53JnzvH2E8IXchDkVGX6wv6XO4yF8GXM7RaU+WKXIM7jzmmImzasCb+BHX26j22m+dabfTN/GIf8cF6EhzRmWC/UCGT7av4wnuHuiMdn3PozxcDEm7XW3jnaH36Ous58ky6n46wpHzjnXKWEa/enEezDuc3QhO+i9XKRW/ckhxBxYOB0jyaYD74rfL0WkKsdhfE3VieXCjOab9kQIrUWasv4yXXGKt2Eo502Up92zLkEFBRqx0pHPqWbMETgjIyHaMKwMy+U4pgmDOOa8Xdb/Pze+/db/Fy2oQnDYL33b5dl+XDNn2luOA8hDDWnKn5orf1lpZ/FhkxHQCA3DfbpCj/qvRV+BsC8Di/n6dd5NvrvwJuZjoDCUxTmhuMTwlA8jAVxbOaEIQkPfdSkCcMEzVgbjksThqQEaw2aMEzSioV2TJowFGC+OC8hDIU81HZ9BikmIQzFaMW5CGGYqBVrw/EIYShMK45PCMNkrVgbjkUIwyTcogYQhDa8hPFfsbMsHE4cgf0AAAAASUVORK5CYII="/></svg>',
  metamask: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#f6851b"/><path d="M8 9l7 5-1.4-3.6L8 9zm16 0l-5.6 1.4L17 14l7-5zM9.5 20l1.5 4 4-1.2-.6-2.8H9.5zm13 0h-4.4l-.6 2.8 4 1.2 1-4zM12 15l-1.6 3 5 .2-.2-4.2L12 15zm8 0l-3.3-1L16.6 18l5-.2L20 15z" fill="#fff"/></svg>',
  phantom: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#ab9ff2"/><path d="M8 18.5C8 12.7 11.6 9 16.2 9 20.7 9 24 12.4 24 16.6c0 3-1.7 5.4-3.6 5.4-1 0-1.2-.8-1.6-1.6-.5 1-1.4 1.6-2.4 1.6s-1.6-.7-2-1.5c-.5.9-1.5 1.5-2.6 1.5C9.5 22 8 20.6 8 18.5z" fill="#fff"/><circle cx="15" cy="15" r="1.3" fill="#ab9ff2"/><circle cx="19" cy="15" r="1.3" fill="#ab9ff2"/></svg>',
  walletconnect: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#3b99fc"/><path d="M9.6 12.6c3.5-3.4 9.3-3.4 12.8 0l.4.4-1.5 1.5-.6-.6a6.9 6.9 0 0 0-9.4 0l-.6.6-1.5-1.5.4-.4zm-2.4 3l1.4-1.4 4 3.9 3.4-3.3 3.4 3.3 4-3.9 1.4 1.4-5.4 5.3-3.4-3.3-3.4 3.3-5.4-5.3z" fill="#fff"/></svg>',
}

function xIcon(): HTMLElement {
  const box = h('span', { class: 'wallet-icon' })
  box.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#000"/><path d="M8.5 8h4.6l3.6 5 4.3-5h2.4l-5.6 6.5L24 24h-4.6l-3.9-5.4L10.9 24H8.5l6-7L8.5 8zm3 1.4 9.3 13.2h1.4L13 9.4h-1.5z" fill="#fff"/></svg>'
  return box
}

function walletIcon(kind: WalletKind): HTMLElement {
  const box = h('span', { class: 'wallet-icon' })
  const announced = external(kind) ? undefined : announcedIcon(kind as 'pelagus' | 'metamask' | 'phantom')
  if (announced) box.append(h('img', { src: announced, alt: '' }))
  else box.innerHTML = GLYPHS[kind]
  return box
}

let open: HTMLDialogElement | undefined

function chooseWallet(opts: { title: string; note: string; only?: WalletKind[] }): Promise<Account> {
  open?.close()
  return new Promise((resolve, reject) => {
    const status = h('p', { class: 'wallet-status', role: 'status', 'aria-live': 'polite' })
    const say = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error) }
    // Email or X: a Quai Smart Wallet in this page, above the wallet list.
    const emailInput = h('input', { type: 'email', name: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: '', 'aria-label': 'Email' }) as HTMLInputElement
    const emailButton = h('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Continue with email')
    const emailForm = h('form', { class: 'wallet-email' }, emailInput, emailButton)
    const xButton = h('button', { type: 'button', class: 'wallet-row' }, xIcon(), h('span', { class: 'wallet-text' }, h('b', {}, 'Continue with X'), h('span', {}, 'Your X account')), h('span', { class: 'wallet-tag' }, 'X'))
    const social = h('div', { class: 'wallet-social' }, emailForm, xButton, h('p', { class: 'wallet-or' }, 'or use a wallet'))
    let codeFor: string | undefined
    emailForm.onsubmit = async (e) => {
      e.preventDefault()
      if (busy) return
      busy = true
      emailButton.setAttribute('disabled', '')
      try {
        const p = await privy()
        if (!codeFor) {
          say('Sending you a code…')
          await p.sendEmailCode(emailInput.value.trim())
          codeFor = emailInput.value.trim()
          emailInput.value = ''
          Object.assign(emailInput, { type: 'text', name: 'code', placeholder: '6-digit code', autocomplete: 'one-time-code', inputMode: 'numeric' })
          emailInput.setAttribute('aria-label', 'Code')
          emailButton.textContent = 'Sign in'
          say(`We sent a code to ${codeFor}. Enter it here.`)
          emailInput.focus()
        } else {
          say('Checking the code…')
          await p.loginWithEmailCode(emailInput.value.trim())
          say('Opening your Quai Smart Wallet…')
          finish({ address: await connectSmartWallet(), kind: 'smartwallet' })
        }
      } catch (err) {
        say(walletErrorMessage(err), true)
      } finally {
        busy = false
        emailButton.removeAttribute('disabled')
      }
    }
    xButton.onclick = async () => {
      if (busy) return
      busy = true
      say('Taking you to X to sign in…')
      try {
        await (await privy()).loginWithX() // leaves the page; it signs in when X sends you back
      } catch (err) {
        say(walletErrorMessage(err), true)
        busy = false
      }
    }
    const list = h('div', { class: 'wallet-list' })
    const close = h('button', { type: 'button', class: 'wallet-close', 'aria-label': 'Close' }, '×')
    const dlg = h('dialog', { class: 'wallet-dialog', 'aria-labelledby': 'wallet-title' },
      h('div', { class: 'wallet-head' }, h('h2', { id: 'wallet-title' }, opts.title), close),
      h('p', { class: 'wallet-note' }, opts.note),
      ...(!opts.only || opts.only.includes('smartwallet') ? [social] : []),
      list,
      status,
      h('p', { class: 'wallet-foot' }, 'We never see your keys. Signing a request costs no gas.'),
    ) as HTMLDialogElement
    let settled = false
    let busy = false
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

    const renderRows = () => {
      list.replaceChildren()
      for (const w of WALLETS.filter((w) => w.kind !== 'smartwallet' && (!opts.only || opts.only.includes(w.kind)))) {
        const installed = external(w.kind) || !!w.provider()
        const state = w.kind === 'walletconnect' ? 'QR code' : w.kind === 'smartwallet' ? 'Popup' : installed ? 'Detected' : mobile && w.kind !== 'pelagus' ? 'Open app' : 'Install'
        const text = h('span', { class: 'wallet-text' }, h('b', {}, w.name), h('span', {}, w.blurb))
        const tag = h('span', { class: `wallet-tag${installed && !external(w.kind) ? ' on' : ''}` }, state)
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
    ;((dlg.querySelector('.wallet-email input') ?? list.querySelector('button.wallet-row')) as HTMLElement | null)?.focus()
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
