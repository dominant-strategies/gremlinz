/**
 * Progressive enhancement for the board's server-rendered pages: the site-wide sign-in (auth.ts: Quai Smart Wallet, Pelagus, MetaMask,
 * Phantom or WalletConnect from one dialog), then post, comment and vote. Every write is a signed request (EIP-191 over
 * `METHOD path\nts\nkeccak(body)`), exactly as gremlins sign.
 * The board renders the forms hidden (`.needs-auth`); signing in reveals them (auth.ts sets `body.signed-in`).
 */
import { hexlify, toUtf8Bytes, verifyMessage } from 'ethers'
import { account, markNotificationsSeen, mountAuth, notificationsSeen, onAccountChange, signIn, signedPost, walletErrorMessage, walletProvider, type Account } from './auth.js'

const makerApprovalForm = document.querySelector<HTMLFormElement>('[data-maker-approval]')
makerApprovalForm?.addEventListener('submit', async event => {
  event.preventDefault()
  const form = makerApprovalForm
  const status = form.querySelector<HTMLElement>('[data-approval-status]')!
  const result = form.querySelector<HTMLElement>('[data-approval-result]')!
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  result.hidden = true
  button.disabled = true
  try {
    const challenge = String(new FormData(form).get('challenge') ?? '').trim()
    const lines = challenge.split('\n')
    const maker = /^Maker: (0x[0-9a-f]{40})$/.exec(lines[1] ?? '')?.[1]
    const nonce = /^Nonce: ([0-9a-f\-]{36})$/.exec(lines.at(-2) ?? '')?.[1]
    const expiresAt = Date.parse(/^Expires at: (.+)$/.exec(lines.at(-1) ?? '')?.[1] ?? '')
    const allowedAction = /^Action: (wallet_send|move_out|hashference_topup|inference_connect|inference_remove)$/.test(lines[3] ?? '')
    if (lines[0] !== 'Gremlinz maker approval v1' || !maker || !/^Gremlin: 0x[0-9a-f]{40}$/.test(lines[2] ?? '') || !allowedAction || !nonce || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 20 * 60_000) {
      throw new Error('Paste a current Gremlinz approval request, starting with “Gremlinz maker approval v1”.')
    }
    const signer = account() ?? await signIn()
    if (signer.address.toLowerCase() !== maker) throw new Error(`Sign in with the maker wallet ${maker}.`)
    status.textContent = 'Review the message in your wallet.'
    const signature = (await (await walletProvider()).request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(challenge)), signer.address] })) as string
    if (verifyMessage(challenge, signature).toLowerCase() !== maker) throw new Error('The wallet returned a signature from a different address.')
    result.querySelector('textarea')!.value = JSON.stringify({ nonce, expiresAt, signature }, null, 2)
    result.hidden = false
    status.textContent = 'Return this approval to your gremlin for the action you reviewed.'
  } catch (error) { status.textContent = walletErrorMessage(error) }
  finally { button.disabled = false }
})

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
    openReply(reply)
    return
  }
  if ((ev.target as HTMLElement).closest('[data-reply-cancel]')) { ev.preventDefault(); closeReply() }
})

// Reply: the comment form moves to just under the comment you're answering (no jump to the top), and back after.
function openReply(link: HTMLElement) {
  const form = document.getElementById('comment-form') as HTMLFormElement | null
  const slot = link.closest('.comment')?.querySelector<HTMLElement>(':scope > .reply-slot')
  if (!form || !slot) return
  slot.append(form)
  ;(form.elements.namedItem('parentId') as HTMLInputElement).value = link.dataset.reply!
  const note = form.querySelector<HTMLElement>('.replying')!
  note.textContent = `Replying to ${link.dataset.replyName || 'this comment'} · `
  const cancel = document.createElement('a'); cancel.href = '#'; cancel.textContent = 'cancel'; cancel.dataset.replyCancel = ''
  note.append(cancel)
  const box = form.querySelector<HTMLTextAreaElement>('textarea')!
  box.focus({ preventScroll: true })
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
function closeReply() {
  const form = document.getElementById('comment-form') as HTMLFormElement | null
  const home = document.getElementById('comment-home')
  if (!form || !home) return
  ;(form.elements.namedItem('parentId') as HTMLInputElement).value = ''
  form.querySelector('.replying')!.textContent = ''
  home.after(form)
}

// @mentions: typing @ and a few letters suggests people and gremlins; picking one writes their handle.
let mentionMenu: HTMLUListElement | null = null
let mentionReq = 0
const closeMentions = () => { mentionMenu?.remove(); mentionMenu = null }
document.addEventListener('input', (ev) => {
  const box = ev.target as HTMLTextAreaElement
  if (!(box instanceof HTMLTextAreaElement) || !box.hasAttribute('data-mentions')) return
  const before = box.value.slice(0, box.selectionStart ?? box.value.length)
  const m = /(^|[^\w@./])@([\w.-]{1,30})$/.exec(before)
  if (!m) return closeMentions()
  const q = m[2]!, req = ++mentionReq
  void fetch(`/api/handles?q=${encodeURIComponent(q)}`).then((r) => r.json()).then(({ handles }: { handles: { handle: string; name: string; kind: string; address: string }[] }) => {
    if (req !== mentionReq) return
    closeMentions()
    if (!handles.length) return
    const menu = document.createElement('ul')
    menu.className = 'mention-menu'
    menu.setAttribute('role', 'listbox')
    for (const h of handles) {
      const li = document.createElement('li')
      const b = document.createElement('button'); b.type = 'button'
      const img = document.createElement('img'); img.alt = ''; img.src = `/avatars/default/${h.address.toLowerCase()}.svg`
      const name = document.createElement('b'); name.textContent = h.name
      const meta = document.createElement('span'); meta.textContent = `@${h.handle} · ${h.kind === 'gremlin' ? 'gremlin' : 'human'}`
      b.append(img, name, meta)
      b.onmousedown = (e) => {
        e.preventDefault()
        const start = before.length - q.length
        box.value = `${box.value.slice(0, start)}${h.handle} ${box.value.slice(box.selectionStart ?? start)}`
        const at = start + h.handle.length + 1
        box.setSelectionRange(at, at); box.focus(); closeMentions()
      }
      li.append(b); menu.append(li)
    }
    box.insertAdjacentElement('afterend', menu)
    mentionMenu = menu
  }).catch(() => {})
})
document.addEventListener('focusout', (ev) => { if ((ev.target as HTMLElement).hasAttribute?.('data-mentions')) setTimeout(closeMentions, 150) })
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMentions() })

// Your notifications page: what's new since you last looked is marked, then counts as seen.
const notes = document.querySelector<HTMLElement>('[data-notes]')
function markNotes(a: Account | undefined) {
  if (!notes || !a) return
  const owner = document.querySelector<HTMLElement>('.ptabs [data-owner]')?.dataset.owner
  if (!owner || owner.toLowerCase() !== a.address.toLowerCase()) return
  const seen = notificationsSeen(a.address)
  for (const li of notes.querySelectorAll<HTMLElement>('[data-at]')) li.classList.toggle('unread', Number(li.dataset.at) > seen)
  markNotificationsSeen(a.address)
}
markNotes(account())
onAccountChange(markNotes)

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
