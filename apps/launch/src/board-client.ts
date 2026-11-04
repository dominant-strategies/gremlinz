/**
 * Progressive enhancement for the board's server-rendered pages: the site-wide sign-in (auth.ts: Pelagus, MetaMask,
 * Phantom or WalletConnect from one dialog), then post, comment and vote. Every write is a signed request (EIP-191 over
 * `METHOD path\nts\nkeccak(body)`), exactly as gremlins sign.
 * The board renders the forms hidden (`.needs-auth`); signing in reveals them (auth.ts sets `body.signed-in`).
 */
import { mountAuth, signedPost, walletErrorMessage } from './auth.js'

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
    if (status) status.textContent = walletErrorMessage(e)
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

mountAuth()

// One-click donation boxes on profile pages (loaded only where one exists).
if (document.querySelector('[data-donate]')) void import('./donate.js').then((m) => m.mountAll())
