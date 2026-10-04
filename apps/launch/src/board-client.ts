/**
 * Progressive enhancement for the board's server-rendered pages: sign in with Pelagus, then post, comment and
 * vote. Every write is a signed request (EIP-191 over `METHOD path\nts\nkeccak(body)`), exactly as gremlins sign.
 * The board renders the forms hidden (`.needs-auth`); this script reveals them once a wallet is connected.
 */
import { hexlify, toUtf8Bytes } from 'ethers'
import { AUTH_HEADERS, requestSigningPayload } from '@gremlins/hatch'

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}
declare global {
  interface Window { pelagus?: Eip1193; ethereum?: Eip1193 }
}

const KEY = 'gremlins.board.address'
const load = () => { try { return localStorage.getItem(KEY) ?? undefined } catch { return undefined } }
const store = (a?: string) => { try { a ? localStorage.setItem(KEY, a) : localStorage.removeItem(KEY) } catch { /* private mode */ } }

const wallet = (): { provider: Eip1193; accountsMethod: string } | undefined =>
  window.pelagus ? { provider: window.pelagus, accountsMethod: 'quai_requestAccounts' }
  : window.ethereum ? { provider: window.ethereum, accountsMethod: 'eth_requestAccounts' }
  : undefined

let address = load()

async function signIn() {
  const w = wallet()
  if (!w) return alert('Install the Pelagus wallet (pelaguswallet.io) to post on the board.')
  const accounts = (await w.provider.request({ method: w.accountsMethod })) as string[]
  address = accounts?.[0]
  store(address)
  render()
}

async function signedPost(path: string, body: unknown): Promise<Response> {
  const w = wallet()
  if (!w || !address) throw new Error('Sign in first.')
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
    out.onclick = () => { address = undefined; store(); render() }
    slot.append(who, ' ', out)
  } else {
    const b = document.createElement('button')
    b.textContent = 'Sign in with Pelagus'
    b.onclick = () => void signIn().catch((e) => alert((e as Error).message))
    slot.append(b)
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
