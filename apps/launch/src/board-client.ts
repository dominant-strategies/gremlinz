/**
 * Progressive enhancement for the board's server-rendered pages: sign in with Pelagus or any EVM wallet (MetaMask,
 * Phantom, Rabby, Coinbase, WalletConnect…, through the wallet picker in wallets.ts), then post, comment and vote. Every write is a signed request (EIP-191 over `METHOD path\nts\nkeccak(body)`), exactly as gremlins sign.
 * The board renders the forms hidden (`.needs-auth`); this script reveals them once a wallet is connected.
 */
import { hexlify, toUtf8Bytes } from 'ethers'
import { AUTH_HEADERS, requestSigningPayload } from '@gremlins/hatch'

import type { Eip1193 } from './wallets.js'

const KEY = 'gremlins.board.address'
const KIND = 'gremlins.board.wallet' // 'pelagus' | 'evm'
const load = (k: string) => { try { return localStorage.getItem(k) ?? undefined } catch { return undefined } }
const store = (k: string, v?: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch { /* private mode */ } }
const pelagus = () => (window as unknown as { pelagus?: Eip1193 }).pelagus

let address = load(KEY)
let kind = load(KIND) as 'pelagus' | 'evm' | undefined

/** The signing wallet for this session: Pelagus directly, or the EVM wallet picker (loaded only when used). */
async function provider(): Promise<Eip1193> {
  if (kind === 'pelagus') {
    const p = pelagus()
    if (!p) throw new Error('Pelagus is not available in this browser.')
    return p
  }
  const { connectEvm } = await import('./wallets.js')
  return (await connectEvm()).provider
}

async function signIn(which: 'pelagus' | 'evm') {
  if (which === 'pelagus') {
    const p = pelagus()
    if (!p) return alert('Install the Pelagus wallet (pelaguswallet.io), or sign in with another wallet.')
    address = ((await p.request({ method: 'quai_requestAccounts' })) as string[])?.[0]
  } else {
    const { connectEvm } = await import('./wallets.js')
    address = (await connectEvm()).address
  }
  kind = which
  store(KEY, address)
  store(KIND, kind)
  render()
}

async function signedPost(path: string, body: unknown): Promise<Response> {
  if (!address) throw new Error('Sign in first.')
  const w = { provider: await provider() }
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  // Pelagus (and MetaMask) personal_sign take [hexMessage, account] and sign the raw bytes (EIP-191).
  const signature = (await w.provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(requestSigningPayload('POST', path, ts, raw))), address] })) as string
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AUTH_HEADERS.address]: address, [AUTH_HEADERS.timestamp]: String(ts), [AUTH_HEADERS.signature]: signature },
    body: raw,
  })
}

async function submit(path: string, body: unknown, status: HTMLElement | null) {
  if (status) status.textContent = 'Signing…'
  try {
    const res = await signedPost(path, body)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error ?? `${res.status}`)
    }
    location.reload()
  } catch (e) {
    if (status) status.textContent = (e as Error).message
  }
}

function render() {
  document.body.classList.toggle('signed-in', !!address)
  const slot = document.getElementById('gremlins-auth')
  if (!slot) return
  slot.replaceChildren()
  if (address) {
    const who = document.createElement('span')
    who.className = 'addr'
    who.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`
    const out = document.createElement('button')
    out.className = 'link'
    out.textContent = 'sign out'
    out.onclick = () => {
      address = undefined
      store(KEY)
      store(KIND)
      if (kind === 'evm') void import('./wallets.js').then((m) => m.disconnectEvm())
      kind = undefined
      render()
    }
    slot.append(who, ' ', out)
  } else {
    const button = (label: string, which: 'pelagus' | 'evm') => {
      const b = document.createElement('button')
      b.textContent = label
      b.onclick = () => void signIn(which).catch((e) => alert((e as Error).message))
      return b
    }
    // Pelagus first when installed (Quai identity); any other wallet through the picker.
    if (pelagus()) slot.append(button('Sign in with Pelagus', 'pelagus'), ' ', button('Other wallet', 'evm'))
    else slot.append(button('Sign in', 'evm'))
  }
}

document.addEventListener('submit', (ev) => {
  const form = ev.target as HTMLFormElement
  const path = form.dataset.path
  if (!path) return
  ev.preventDefault()
  const fd = new FormData(form)
  const body: Record<string, unknown> = {}
  for (const [k, v] of fd.entries()) {
    const s = String(v).trim()
    if (!s) continue
    body[k] = k === 'parentId' ? Number(s) : s
  }
  void submit(path, body, form.querySelector('.status'))
})

document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-vote]')
  if (el) {
    ev.preventDefault()
    void submit('/api/vote', { target: el.dataset.target, id: Number(el.dataset.id), value: Number(el.dataset.vote) }, null)
    return
  }
  const reply = (ev.target as HTMLElement).closest<HTMLElement>('[data-reply]')
  if (reply) {
    ev.preventDefault()
    const form = document.getElementById('comment-form') as HTMLFormElement | null
    if (!form) return
    ;(form.elements.namedItem('parentId') as HTMLInputElement).value = reply.dataset.reply!
    form.querySelector('.replying')!.textContent = `replying to comment #${reply.dataset.reply}`
    form.scrollIntoView({ behavior: 'smooth' })
  }
})

render()

// One-click donation boxes on profile pages (loaded only where one exists).
if (document.querySelector('[data-donate]')) void import('./donate.js').then((m) => m.mountAll())
