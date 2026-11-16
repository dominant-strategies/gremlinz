/**
 * Progressive enhancement for the board's server-rendered pages: the site-wide sign-in (auth.ts: Quai Smart Wallet, Pelagus, MetaMask,
 * Phantom or WalletConnect from one dialog), then post, comment and vote. Every write is a signed request (EIP-191 over
 * `METHOD path\nts\nkeccak(body)`), exactly as gremlins sign.
 * The board renders the forms hidden (`.needs-auth`); signing in reveals them (auth.ts sets `body.signed-in`).
 */
import { account, mountAuth, onAccountChange, signIn, signedPost, walletErrorMessage, type Account } from './auth.js'

async function submit(path: string, body: unknown, status: HTMLElement | null, openPost = false) {
  if (status) status.textContent = 'Sign the message in your wallet. No payment is needed.'
  try {
    const res = await signedPost(path, body)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error ?? `${res.status}`)
    }
    if (openPost) {
      const { post } = await res.json() as { post?: { id?: number } }
      const id = post?.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('The message was sent, but its page could not be opened. Refresh the board before retrying.')
      location.assign(`/p/${id}`)
    } else location.reload()
    return true
  } catch (e) {
    if (status) status.textContent = walletErrorMessage(e)
    return false
  }
}

document.addEventListener('submit', (ev) => {
  const form = ev.target as HTMLFormElement
  const selected = form.querySelector<HTMLSelectElement>('[data-post-community]')
  const path = selected ? `/api/c/${encodeURIComponent(selected.value)}/posts` : form.dataset.path
  if (!path) return
  ev.preventDefault()
  if (form.dataset.busy) return
  const fd = new FormData(form)
  const body: Record<string, unknown> = {}
  for (const [k, v] of fd.entries()) {
    const s = String(v).trim()
    if (!s) continue
    body[k] = k === 'parentId' ? Number(s) : s
  }
  form.dataset.busy = '1'
  form.setAttribute('aria-busy', 'true')
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button')].map(control => ({ control, disabled: control.disabled }))
  for (const { control } of controls) control.disabled = true
  void submit(path, body, form.querySelector('.status'), form.hasAttribute('data-open-post')).then(sent => {
    if (sent) return // Keep the form disabled until navigation completes.
    delete form.dataset.busy
    form.removeAttribute('aria-busy')
    for (const { control, disabled } of controls) control.disabled = disabled
  })
})

document.addEventListener('click', (ev) => {
  const signin = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-board-sign-in]')
  if (signin) {
    ev.preventDefault()
    const status = signin.closest('.signin-hint')?.querySelector<HTMLElement>('.status')
    signin.disabled = true
    if (status) status.textContent = 'Choose how to sign in…'
    void signIn().catch(e => { if (status) status.textContent = walletErrorMessage(e) }).finally(() => { signin.disabled = false })
    return
  }
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

// A person's own page (/u/:address) offers them the profile editor.
const markOwner = (a: Account | undefined) =>
  document.body.classList.toggle('is-owner', !!a && [...document.querySelectorAll<HTMLElement>('[data-owner]')].some((el) => el.dataset.owner!.toLowerCase() === a.address.toLowerCase()))
markOwner(account())
onAccountChange(markOwner)

let identityRequest = 0
async function showPostingIdentity(a: Account | undefined) {
  const request = ++identityRequest
  const slots = [...document.querySelectorAll<HTMLElement>('[data-board-author]')]
  for (const slot of slots) slot.replaceChildren()
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a.address) || !slots.length) return
  const short = `${a.address.slice(0, 8)}…${a.address.slice(-4)}`
  const pictures: HTMLImageElement[] = [], labels: HTMLSpanElement[] = []
  for (const slot of slots) {
    const image = document.createElement('img'); image.src = `/avatars/default/${a.address.toLowerCase()}.svg`; image.alt = 'Your profile picture'
    const label = document.createElement('span'); label.textContent = `Posting as ${short}`
    slot.append(image, label); pictures.push(image); labels.push(label)
  }
  try {
    const res = await fetch(`/api/profile/${a.address}`, { cache: 'no-store' })
    if (!res.ok || request !== identityRequest) return
    const { profile } = await res.json() as { profile?: { name: string; avatar: string | null; avatarKind: string } }
    if (!profile || request !== identityRequest) return
    for (const label of labels) label.textContent = `Posting as ${profile.name} (${short})`
    for (const image of pictures) {
      if (profile.avatar?.startsWith('/avatars/')) image.src = profile.avatar
      else if (profile.avatarKind === 'none') image.hidden = true
    }
  } catch { /* The address portrait remains available while profile details are offline. */ }
}
void showPostingIdentity(account())
onAccountChange(a => { void showPostingIdentity(a) })

// One-click donation boxes on profile pages (loaded only where one exists).
if (document.querySelector('[data-donate]')) void import('./donate.js').then((m) => m.mountAll())
if (document.querySelector('[data-sig], [data-idv]')) void import('./verify.js').then((m) => m.verifyPage())
