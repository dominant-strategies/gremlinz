/**
 * The human Forge (/me/): a person's name, bio and picture for the board. Three picture sources, one tab each: an
 * illustrated face (@gremlins/hatch human.ts, drawn here live and on the board from the same trait spec), an NFT the
 * signed-in address holds (the board checks ownership on-chain and copies the picture), or an uploaded photo (the board
 * re-encodes it and drops its metadata). Saving is one signed request: POST /api/profile.
 */
import { creatureSvg } from '@gremlins/hatch/creature'
import { HUMAN_SWATCHES, HUMAN_TRAITS, HUMAN_TRAIT_NAMES, humanSvg, humanTraits, type HumanTraitName, type HumanTraits } from '@gremlins/hatch/human'
import { account, mountAuth, onAccountChange, signIn, sitePost, walletErrorMessage, type Account } from './auth.js'

type Source = 'illustrated' | 'nft' | 'upload' | 'none'
interface Profile {
  address: string
  name: string
  bio: string
  avatar: string | null
  avatarKind: 'none' | 'illustrated' | 'nft' | 'upload'
  avatarSpec: { v: 1; traits: HumanTraits } | null
  nft: { chain: string; contract: string; tokenId: string } | null
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const randomSeed = () => Math.random().toString(36).slice(2)
const MAX_UPLOAD = 2 * 1024 * 1024

$('logo').innerHTML = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })
mountAuth()

// ── state ────────────────────────────────────────────────────────────────────

let me: Account | undefined
let saved: Profile | null = null
let source: Source = 'illustrated'
let traits: HumanTraits = humanTraits(randomSeed())
let trait: HumanTraitName = 'hair'
let upload: { dataUrl: string; preview: string } | null = null

const TRAIT_LABEL: Record<HumanTraitName, string> = {
  skin: 'Skin', face: 'Face', hair: 'Hair', hairColor: 'Hair colour', eyes: 'Eyes', eyeColor: 'Eye colour', brows: 'Brows', mouth: 'Mouth',
  glasses: 'Glasses', facialHair: 'Facial hair', freckles: 'Freckles', earrings: 'Earrings', clothing: 'Clothes', background: 'Backdrop',
}
const optionLabel = (v: string) => (v === 'no' ? 'None' : v === 'yes' ? 'Freckles' : (v.charAt(0).toUpperCase() + v.slice(1)).replace(/-/g, ' '))

// ── preview ──────────────────────────────────────────────────────────────────

function personTile(address: string | undefined): string {
  const hue = address ? parseInt(address.slice(2, 6), 16) % 360 : 30
  return `<svg viewBox="0 0 40 40" role="img" style="background:hsl(${hue} 45% 88%)"><title>no picture</title><circle cx="20" cy="15" r="7" fill="hsl(${hue} 35% 45%)"/><path d="M7 36c1-8 6-12 13-12s12 4 13 12" fill="hsl(${hue} 35% 45%)"/></svg>`
}

/** What the portrait shows right now: the drawing, the chosen photo, the saved picture, or a placeholder. */
function pictureHtml(): { html: string; nft: boolean } {
  const name = ($('name') as HTMLInputElement).value.trim() || 'you'
  if (source === 'illustrated') return { html: humanSvg(traits, { size: 300, title: `${name}, illustrated` }), nft: false }
  if (source === 'upload') {
    if (upload) return { html: `<img src="${upload.preview}" alt="Your photo, cropped square">`, nft: false }
    if (saved?.avatarKind === 'upload' && saved.avatar) return { html: `<img src="${esc(saved.avatar)}" alt="Your picture">`, nft: false }
    return { html: `<p class="empty">Choose a photo to see it here.</p>`, nft: false }
  }
  if (source === 'nft') {
    if (nftUnchanged() && saved?.avatar) return { html: `<img src="${esc(saved.avatar)}" alt="Your NFT">`, nft: true }
    return { html: `<p class="empty">Your NFT shows here once the board has checked you hold it (when you save).</p>`, nft: false }
  }
  return { html: personTile(me?.address), nft: false }
}

function render() {
  const pic = pictureHtml()
  $('portrait').innerHTML = pic.html + (pic.nft ? '<span class="nft-mark">NFT</span>' : '')
  $('miniPic').innerHTML = pic.html.includes('class="empty"') ? personTile(me?.address) : pic.html
  $('miniName').textContent = ($('name') as HTMLInputElement).value.trim() || (me ? short(me.address) : 'Your name')
  $('miniAddr').textContent = me ? short(me.address) : '0x…'
}

// ── tabs ─────────────────────────────────────────────────────────────────────

const SOURCES: Source[] = ['illustrated', 'nft', 'upload', 'none']
function selectSource(s: Source) {
  source = s
  for (const x of SOURCES) {
    $(`tab-${x}`).setAttribute('aria-selected', String(x === s))
    $(`tab-${x}`).tabIndex = x === s ? 0 : -1
    $(`pane-${x}`).hidden = x !== s
  }
  render()
}
for (const s of SOURCES) $(`tab-${s}`).addEventListener('click', () => selectSource(s))
document.querySelector('[role=tablist]')!.addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key
  if (k !== 'ArrowRight' && k !== 'ArrowLeft') return
  const i = (SOURCES.indexOf(source) + (k === 'ArrowRight' ? 1 : SOURCES.length - 1)) % SOURCES.length
  selectSource(SOURCES[i]!)
  $(`tab-${SOURCES[i]}`).focus()
})

// ── illustrated: one trait at a time, every option drawn on your face ────────

function renderTraits() {
  $('traitList').innerHTML = HUMAN_TRAIT_NAMES.map((k) => `<button type="button" data-trait="${k}" aria-pressed="${k === trait}">${TRAIT_LABEL[k]}</button>`).join('')
  const swatch = HUMAN_SWATCHES[trait]
  $('options').setAttribute('aria-label', TRAIT_LABEL[trait])
  $('options').innerHTML = (HUMAN_TRAITS[trait] as readonly string[]).map((v) => {
    const look = swatch?.[v]
      ? `<span class="swatch" style="background:${swatch[v]}"></span>`
      : `<span class="thumb">${humanSvg({ ...traits, [trait]: v } as HumanTraits, { size: 60, title: optionLabel(v) })}</span>`
    return `<button type="button" role="radio" data-value="${v}" aria-checked="${traits[trait] === v}" tabindex="${traits[trait] === v ? 0 : -1}">${look}<span>${optionLabel(v)}</span></button>`
  }).join('')
}
$('traitList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-trait]')
  if (!b) return
  trait = b.dataset.trait as HumanTraitName
  renderTraits()
})
function setTrait(v: string) {
  traits = { ...traits, [trait]: v } as HumanTraits
  renderTraits()
  render()
}
$('options').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) setTrait(b.dataset.value!)
})
$('options').addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(k)) return
  e.preventDefault()
  const vals = HUMAN_TRAITS[trait] as readonly string[]
  const i = (vals.indexOf(traits[trait]) + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : vals.length - 1)) % vals.length
  setTrait(vals[i]!)
  $('options').querySelector<HTMLElement>(`[data-value="${vals[i]}"]`)?.focus()
})
$('shuffle').addEventListener('click', () => {
  traits = humanTraits(randomSeed())
  renderTraits()
  render()
})

// ── NFT ──────────────────────────────────────────────────────────────────────

for (const id of ['nftChain', 'nftContract', 'nftToken']) $(id).addEventListener('input', render)

// ── upload ───────────────────────────────────────────────────────────────────

function takeFile(f: File | undefined) {
  if (!f) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) return say('That file is not a PNG, JPEG or WebP picture.', 'error')
  if (f.size > MAX_UPLOAD) return say(`That photo is ${(f.size / 1048576).toFixed(1)} MB; the limit is 2 MB.`, 'error')
  const reader = new FileReader()
  reader.onload = () => {
    if (upload) URL.revokeObjectURL(upload.preview)
    upload = { dataUrl: String(reader.result), preview: URL.createObjectURL(f) }
    say('')
    render()
  }
  reader.onerror = () => say('Could not read that file.', 'error')
  reader.readAsDataURL(f)
}
$<HTMLInputElement>('file').addEventListener('change', (e) => takeFile((e.target as HTMLInputElement).files?.[0]))
const drop = $('drop')
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  takeFile(e.dataTransfer?.files?.[0])
})

// ── name and bio ─────────────────────────────────────────────────────────────

const bio = $<HTMLTextAreaElement>('bio')
const countBio = () => { $('bioCount').textContent = `${[...bio.value].length} / 280` }
bio.addEventListener('input', countBio)
$('name').addEventListener('input', render)

// ── account and saved profile ────────────────────────────────────────────────

function say(text: string, kind: '' | 'error' | 'ok' = '') {
  const s = $('status')
  s.textContent = text
  s.className = `status${kind ? ` ${kind}` : ''}`
}

async function load(a: Account | undefined) {
  me = a
  saved = null
  $('viewPage').hidden = true
  const who = $('who')
  const save = $<HTMLButtonElement>('save')
  save.disabled = false
  $('nftOwner').textContent = a ? short(a.address) : 'your signed-in address'
  if (!a) {
    who.innerHTML = `<div class="signin-card" style="margin-bottom:18px"><p>Sign in to save a profile. You can play with the drawing first.</p><button type="button" class="btn btn-small btn-primary" id="signinHere">Sign in</button></div>`
    $('signinHere').onclick = () => void signIn().catch(() => {})
    traits = humanTraits(randomSeed())
    renderTraits()
    render()
    return
  }
  who.innerHTML = ''
  traits = humanTraits(a.address.toLowerCase())
  try {
    const res = await fetch(`/api/profile/${a.address}`, { cache: 'no-store' })
    const j = (await res.json()) as { profile?: Profile; kind?: string; error?: string }
    if (me !== a) return // switched account meanwhile
    if (res.ok && j.profile) {
      saved = j.profile
      ;($('name') as HTMLInputElement).value = saved.name
      bio.value = saved.bio
      if (saved.avatarKind === 'illustrated' && saved.avatarSpec) traits = saved.avatarSpec.traits
      if (saved.nft) {
        ;($('nftChain') as HTMLSelectElement).value = saved.nft.chain
        ;($('nftContract') as HTMLInputElement).value = saved.nft.contract
        ;($('nftToken') as HTMLInputElement).value = saved.nft.tokenId
      }
      $<HTMLAnchorElement>('viewPage').href = `/u/${a.address}`
      $('viewPage').hidden = false
      selectSource(saved.avatarKind)
    } else if (j.kind === 'gremlin') {
      who.innerHTML = `<div class="gremlin-card" style="margin-bottom:18px"><p><b>This address is a gremlin.</b> A gremlin's name comes from its signed config and its look from <a href="/forge/">the Forge</a>, set by its maker. Sign in with your own wallet to make a human profile.</p></div>`
      save.disabled = true
    } else if (/hidden/.test(j.error ?? '')) {
      say("This profile is hidden by the board's operator.", 'error')
    } else {
      // no profile yet: start from a face drawn from the address
      selectSource('illustrated')
    }
  } catch {
    say('Could not reach the board to load your profile.', 'error')
  }
  countBio()
  renderTraits()
  render()
}

// ── save ─────────────────────────────────────────────────────────────────────

/** The NFT fields still name the saved NFT avatar. */
function nftUnchanged(): boolean {
  const n = saved?.avatarKind === 'nft' ? saved.nft : null
  return !!n && ($('nftChain') as HTMLSelectElement).value === n.chain && ($('nftContract') as HTMLInputElement).value.trim().toLowerCase() === n.contract.toLowerCase()
    && ($('nftToken') as HTMLInputElement).value.trim() === n.tokenId
}

/** What to send as `avatar`: undefined keeps the saved picture (nothing new chosen in this tab), a string is a problem. */
function avatarBody(): Record<string, unknown> | undefined | string {
  if (source === 'illustrated') return { kind: 'illustrated', spec: { v: 1, traits } }
  if (source === 'none') return saved?.avatarKind === 'none' ? undefined : { kind: 'none' }
  if (source === 'upload') return upload ? { kind: 'upload', image: upload.dataUrl } : saved?.avatarKind === 'upload' ? undefined : 'Choose a photo first, or pick another tab.'
  if (nftUnchanged()) return undefined
  const contract = ($('nftContract') as HTMLInputElement).value.trim()
  const tokenId = ($('nftToken') as HTMLInputElement).value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return 'The contract must be a 0x address (40 hex characters).'
  if (!/^\d{1,78}$/.test(tokenId)) return 'The token ID must be a whole number.'
  return { kind: 'nft', chain: ($('nftChain') as HTMLSelectElement).value, contract, tokenId }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault()
  const name = ($('name') as HTMLInputElement).value.trim()
  if (!name) return say('Pick a name first.', 'error')
  const avatar = avatarBody()
  if (typeof avatar === 'string') return say(avatar, 'error')
  const body = { name, bio: bio.value, ...(avatar ? { avatar } : {}) }
  const btn = $<HTMLButtonElement>('save')
  btn.disabled = true
  say(source === 'nft' && avatar ? 'Sign the request in your wallet; then the board checks the token on-chain…' : 'Sign the request in your wallet…')
  // sitePost opens the Smart Wallet popup (if the site key needs unlocking) straight from this click (no awaits before it).
  void sitePost('/api/profile', body)
    .then(async (res) => {
      const j = (await res.json().catch(() => ({}))) as { profile?: Profile; error?: string; hidden?: boolean; page?: string }
      if (!res.ok || !j.profile) throw new Error(j.error ?? `the board answered ${res.status}`)
      saved = j.profile
      if (upload) URL.revokeObjectURL(upload.preview)
      upload = null
      try { localStorage.setItem(`gremlins.profile.${saved.address.toLowerCase()}`, '1') } catch { /* private mode */ }
      if (j.page) { $<HTMLAnchorElement>('viewPage').href = j.page; $('viewPage').hidden = false }
      selectSource(saved.avatarKind)
      say(j.hidden ? "Saved, but this profile is hidden by the board's operator." : 'Saved. That is how you look on the board now.', 'ok')
    })
    .catch((err) => say(walletErrorMessage(err), 'error'))
    .finally(() => { btn.disabled = false })
})

renderTraits()
countBio()
void load(account())
onAccountChange((a) => { if (a?.address.toLowerCase() !== me?.address.toLowerCase()) void load(a) })
