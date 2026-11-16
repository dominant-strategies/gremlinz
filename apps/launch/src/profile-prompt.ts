/**
 * After sign-in, a light nudge for people without a profile yet: a small card in the corner linking to the human Forge
 * (/me/). It never blocks anything, stays away from the focused flows (hatch, forge, the editor itself), and once
 * dismissed it stays dismissed for that address.
 */
import { account, onAccountChange, type Account } from './auth.js'

const DISMISSED = (a: string) => `gremlins.profilePrompt.dismissed.${a.toLowerCase()}`
/** Set by the editor after a save, so we don't ask the board again. */
const HAS_PROFILE = (a: string) => `gremlins.profile.${a.toLowerCase()}`
const QUIET_PATHS = /^\/(me|hatch|forge)(\/|$)/

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string) => { try { localStorage.setItem(k, '1') } catch { /* private mode */ } }

const CSS = `.profile-nudge{position:fixed;right:16px;bottom:16px;z-index:40;width:min(340px,calc(100vw - 32px));background:var(--card,#f7f3ec);color:var(--ink,#24211d);border:1.5px solid var(--ink,#24211d);border-radius:16px;padding:14px 14px 12px 16px;box-shadow:0 14px 36px rgba(36,33,29,.18);display:grid;gap:8px;font:15px/1.45 var(--body,system-ui);animation:nudge-in .2s ease-out}
.profile-nudge b{font:800 17px var(--display,system-ui)}
.profile-nudge p{margin:0;color:var(--ink-2,#5f574d);font-size:14px}
.profile-nudge .row{display:flex;gap:10px;align-items:center;margin-top:2px}
.profile-nudge .later{all:unset;cursor:pointer;font-size:14px;color:var(--ink-2,#5f574d);text-decoration:underline;text-underline-offset:3px}
.profile-nudge .x{all:unset;cursor:pointer;position:absolute;top:6px;right:8px;width:28px;height:28px;display:grid;place-items:center;border-radius:999px;font-size:20px;color:var(--ink-2,#5f574d)}
.profile-nudge .x:hover,.profile-nudge .later:hover{color:var(--ink,#24211d)}
.profile-nudge :focus-visible{outline:3px solid var(--spark,#e0a83e);outline-offset:2px}
@keyframes nudge-in{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){.profile-nudge{animation:none}}`

let card: HTMLElement | null = null
let checking: string | null = null

function close() {
  card?.remove()
  card = null
}

function show(a: Account) {
  if (!document.getElementById('profile-nudge-css')) {
    const style = document.createElement('style')
    style.id = 'profile-nudge-css'
    style.textContent = CSS
    document.head.append(style)
  }
  close()
  card = document.createElement('aside')
  card.className = 'profile-nudge'
  card.setAttribute('role', 'status')
  card.setAttribute('aria-label', 'Create your profile')
  card.innerHTML = `<b>Put a face to your name</b><p>Pick a name and a picture for the board: draw yourself, wear an NFT you hold, or bring a photo.</p>
<div class="row"><a class="btn btn-small btn-primary" href="/me/">Create your profile</a><button type="button" class="later">Not now</button></div>
<button type="button" class="x" aria-label="Dismiss">×</button>`
  const dismiss = () => { set(DISMISSED(a.address)); close() }
  card.querySelector<HTMLButtonElement>('.later')!.onclick = dismiss
  card.querySelector<HTMLButtonElement>('.x')!.onclick = dismiss
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss() })
  document.body.append(card)
}

async function check(a: Account | undefined) {
  close()
  if (!a || QUIET_PATHS.test(location.pathname)) return
  if (get(DISMISSED(a.address)) || get(HAS_PROFILE(a.address))) return
  const key = a.address.toLowerCase()
  if (checking === key) return
  checking = key
  try {
    const res = await fetch(`/api/profile/${a.address}`, { cache: 'no-store' })
    if (res.ok) return set(HAS_PROFILE(a.address))
    if (res.status !== 404) return
    const j = (await res.json().catch(() => ({}))) as { kind?: string; error?: string }
    // Only people without a profile: not gremlins, not profiles an operator hid.
    if (j.kind !== 'human' || /hidden/.test(j.error ?? '')) return
    if (account()?.address.toLowerCase() === key) show(a)
  } catch {
    /* the board is unreachable: say nothing */
  } finally {
    checking = null
  }
}

let mounted = false
export function mountProfilePrompt() {
  if (mounted) return
  mounted = true
  void check(account())
  onAccountChange((a) => void check(a))
}
