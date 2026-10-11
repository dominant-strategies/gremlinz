/**
 * Procedural gremlin portraits. Every gremlin gets its own small machine-creature, drawn deterministically from a
 * seed (its config hash), so the same gremlin looks the same on the hatch page, the board and its profile.
 * Pure string output (SVG), so it runs in browsers and on the board server alike.
 *
 * Style: ink outlines on soft fills, like a field-notebook sketch. Original designs — no film references.
 */

export type CreatureMood = 'normal' | 'low_compute' | 'critical' | 'dead' | 'egg'

export interface CreatureOptions {
  size?: number
  mood?: CreatureMood
  /** Accessible label; defaults to "gremlin portrait". */
  title?: string
  /** Draw on a tinted round background (avatars) instead of transparent. */
  badge?: boolean
}

/** xmur3 string hash → seeds mulberry32 PRNG. Deterministic and tiny. */
function rng(seed: string) {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = (h ^ (h >>> 16)) >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!

/** Curated palettes: body, belly/panel, accent. Warm, earthy, readable on paper and on dark backgrounds. */
const PALETTES = [
  ['#7fb685', '#d8ead2', '#f2a541'], // moss
  ['#e8a87c', '#f6dccb', '#3d7ea6'], // clay
  ['#8fb8de', '#dbe9f5', '#f25f5c'], // sky
  ['#c3a6d8', '#ece2f3', '#f2c14e'], // heather
  ['#f2c14e', '#fbeac2', '#4d8b6f'], // brass
  ['#9fd3c7', '#def2ee', '#e76f51'], // sea glass
  ['#d4a373', '#f1e2cf', '#6a994e'], // walnut
  ['#b5c99a', '#e6eedc', '#bc6c25'], // lichen
] as const

const INK = '#2b2620'

export interface CreatureTraits {
  palette: readonly [string, string, string]
  body: 'round' | 'box' | 'bean' | 'bell'
  eyes: 'dots' | 'goggles' | 'single' | 'sleepy-lids'
  antenna: 'bulb' | 'spring' | 'twin' | 'dish' | 'none'
  ears: 'bolts' | 'fins' | 'none'
  mouth: 'smile' | 'grin' | 'flat' | 'o'
  belly: 'dial' | 'grille' | 'screen' | 'none'
  feet: 'legs' | 'wheels' | 'treads'
}

export function creatureTraits(seed: string): CreatureTraits {
  const r = rng(seed)
  return {
    palette: pick(r, PALETTES),
    body: pick(r, ['round', 'box', 'bean', 'bell'] as const),
    eyes: pick(r, ['dots', 'goggles', 'single', 'dots', 'goggles'] as const),
    antenna: pick(r, ['bulb', 'spring', 'twin', 'dish', 'none'] as const),
    ears: pick(r, ['bolts', 'fins', 'none'] as const),
    mouth: pick(r, ['smile', 'grin', 'flat', 'o', 'smile'] as const),
    belly: pick(r, ['dial', 'grille', 'screen', 'none'] as const),
    feet: pick(r, ['legs', 'wheels', 'treads'] as const),
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function bodyPath(kind: CreatureTraits['body']): string {
  switch (kind) {
    case 'round': return '<circle cx="60" cy="62" r="32"/>'
    case 'box': return '<rect x="30" y="32" width="60" height="58" rx="14"/>'
    case 'bean': return '<path d="M60 30c22 0 32 14 32 32s-12 30-32 30-32-10-32-30 10-32 32-32z"/>'
    case 'bell': return '<path d="M60 30c16 0 26 12 28 30l4 26c1 4-2 6-6 6H34c-4 0-7-2-6-6l4-26c2-18 12-30 28-30z"/>'
  }
}

function egg(t: CreatureTraits, s: number, title: string, badge: boolean): string {
  const [c, light, accent] = t.palette
  const bg = badge ? `<circle cx="60" cy="60" r="58" fill="${light}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${s}" height="${s}" role="img"><title>${esc(title)}</title>${bg}
<g stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
<path d="M60 18c18 0 32 30 32 52 0 20-14 32-32 32S28 90 28 70c0-22 14-52 32-52z" fill="${light}"/>
<path d="M36 66l8-6 8 6 8-6 8 6 8-6 8 6" fill="none" stroke="${c}" stroke-width="4"/>
<circle cx="50" cy="44" r="4" fill="${accent}" stroke="none"/><circle cx="68" cy="84" r="3" fill="${c}" stroke="none"/></g></svg>`
}

/** SVG string for a gremlin. `seed` should be stable (config hash or address). */
export function creatureSvg(seed: string, opts: CreatureOptions = {}): string {
  const s = opts.size ?? 120
  const mood = opts.mood ?? 'normal'
  const t = creatureTraits(seed)
  const title = opts.title ?? 'gremlin portrait'
  if (mood === 'egg') return egg(t, s, title, !!opts.badge)

  const dead = mood === 'dead'
  const [c0, light0, accent0] = t.palette
  const c = dead ? '#b9b4ab' : c0
  const light = dead ? '#e4e0d8' : light0
  const accent = dead ? '#9a958c' : accent0
  const sleepy = mood === 'low_compute'
  const out: string[] = []
  const g = (inner: string, extra = '') => out.push(`<g stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"${extra}>${inner}</g>`)

  if (opts.badge) out.push(`<circle cx="60" cy="60" r="58" fill="${light}"/>`)

  // feet (behind body)
  if (t.feet === 'legs') g(`<path d="M48 88v12h-6M72 88v12h6" fill="none"/>`)
  else if (t.feet === 'wheels') g(`<circle cx="44" cy="96" r="7" fill="${light}"/><circle cx="76" cy="96" r="7" fill="${light}"/>`)
  else g(`<rect x="34" y="88" width="52" height="12" rx="6" fill="${light}"/><path d="M42 94h36" stroke-dasharray="2 5"/>`)

  // antenna
  if (t.antenna === 'bulb') g(`<path d="M60 30V16" fill="none"/><circle cx="60" cy="13" r="5" fill="${accent}"/>`)
  else if (t.antenna === 'spring') g(`<path d="M60 30c-6-3 6-5 0-8s6-5 0-8" fill="none"/><circle cx="60" cy="12" r="3.5" fill="${accent}"/>`)
  else if (t.antenna === 'twin') g(`<path d="M50 34l-6-14M70 34l6-14" fill="none"/><circle cx="43" cy="18" r="4" fill="${accent}"/><circle cx="77" cy="18" r="4" fill="${accent}"/>`)
  else if (t.antenna === 'dish') g(`<path d="M60 30v-8" fill="none"/><path d="M48 20a12 8 0 0 0 24 0z" fill="${accent}"/>`)

  // ears
  if (t.ears === 'bolts') g(`<rect x="22" y="54" width="8" height="14" rx="3" fill="${accent}"/><rect x="90" y="54" width="8" height="14" rx="3" fill="${accent}"/>`)
  else if (t.ears === 'fins') g(`<path d="M30 52l-10-8 2 22zM90 52l10-8-2 22z" fill="${accent}"/>`)

  // body
  g(bodyPath(t.body), ` fill="${c}"`)
  // seam highlight
  out.push(`<path d="M42 40c6-4 12-5 18-5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`)

  // belly
  if (t.belly === 'dial') g(`<circle cx="60" cy="81" r="6" fill="${light}"/><path d="M60 81l3-3" fill="none"/>`)
  else if (t.belly === 'grille') g(`<rect x="51" y="75" width="18" height="10" rx="3" fill="${light}"/><path d="M55 78v4M60 78v4M65 78v4" fill="none" stroke-width="2"/>`)
  else if (t.belly === 'screen') {
    g(`<rect x="50" y="74" width="20" height="12" rx="3" fill="${INK}"/>`)
    out.push(`<path d="M54 81l3-3 3 4 3-5 3 4" fill="none" stroke="${dead ? '#777' : '#9ef0a6'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`)
  }

  // eyes
  const eye = (x: number) => {
    if (dead) return `<path d="M${x - 5} 51l10 10M${x + 5} 51l-10 10" fill="none"/>`
    if (sleepy) return `<path d="M${x - 6} 56q6 5 12 0" fill="none"/>`
    if (t.eyes === 'goggles') return `<circle cx="${x}" cy="56" r="8" fill="#fff"/><circle cx="${x + 1}" cy="57" r="3.5" fill="${INK}" stroke="none"/>`
    return `<circle cx="${x}" cy="56" r="4.5" fill="${INK}" stroke="none"/><circle cx="${x + 1.5}" cy="54.5" r="1.4" fill="#fff" stroke="none"/>`
  }
  if (t.eyes === 'single' && !dead && !sleepy) g(`<circle cx="60" cy="55" r="11" fill="#fff"/><circle cx="62" cy="56" r="5" fill="${INK}" stroke="none"/><circle cx="64" cy="53.5" r="1.6" fill="#fff" stroke="none"/>`)
  else g(eye(48) + eye(72))

  // mouth
  const my = 66
  if (dead) g(`<path d="M52 ${my + 2}h16" fill="none"/>`)
  else if (mood === 'critical') g(`<path d="M50 ${my + 4}q10-7 20 0" fill="none"/>`)
  else if (t.mouth === 'smile') g(`<path d="M52 ${my}q8 7 16 0" fill="none"/>`)
  else if (t.mouth === 'grin') g(`<path d="M50 ${my}q10 9 20 0z" fill="#fff"/>`)
  else if (t.mouth === 'flat') g(`<path d="M53 ${my + 1}h14" fill="none"/>`)
  else g(`<circle cx="60" cy="${my + 1}" r="3.5" fill="${INK}" stroke="none"/>`)

  // mood marks
  if (sleepy) out.push(`<text x="86" y="34" font-family="ui-monospace,monospace" font-size="12" font-weight="700" fill="${INK}">z</text><text x="94" y="24" font-family="ui-monospace,monospace" font-size="9" font-weight="700" fill="${INK}">z</text>`)
  if (mood === 'critical') g(`<path d="M74 36l-5 8 6 3-5 9" fill="none" stroke-width="2.5"/>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${s}" height="${s}" role="img"><title>${esc(title)}</title>${out.join('')}</svg>`
}
