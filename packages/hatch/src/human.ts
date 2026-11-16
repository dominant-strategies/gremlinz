/**
 * Procedural human portraits, the people's counterpart to creature.ts: a studio portrait bust on a soft backdrop, drawn
 * deterministically from a seed plus any traits the person picked. Pure string output (SVG), so the Forge page draws the
 * live preview and the board serves the same picture.
 *
 * What gets stored is the trait spec (a small JSON object of enum values), never SVG: `checkHumanSpec` accepts only
 * the whitelisted values below, and `humanSvg` builds every attribute from fixed tables, so nothing a person sends ends
 * up in the markup.
 */

/** Every trait and its allowed values. The first value of each list is never special; order is the picker's order. */
export const HUMAN_TRAITS = {
  skin: ['porcelain', 'ivory', 'sand', 'honey', 'golden', 'olive', 'tan', 'bronze', 'umber', 'espresso'],
  face: ['oval', 'round', 'square', 'heart', 'long'],
  hair: ['none', 'buzz', 'short', 'side-part', 'curly', 'afro', 'bun', 'bob', 'long-straight', 'long-wavy', 'braids', 'locs', 'mohawk', 'headwrap', 'hijab'],
  hairColor: ['black', 'dark-brown', 'brown', 'auburn', 'ginger', 'blonde', 'platinum', 'grey', 'white', 'blue', 'pink', 'green', 'purple'],
  eyes: ['round', 'almond', 'wide', 'smile', 'sleepy'],
  eyeColor: ['brown', 'dark', 'hazel', 'green', 'blue', 'grey'],
  brows: ['soft', 'straight', 'arched', 'thick', 'thin'],
  mouth: ['smile', 'grin', 'neutral', 'smirk', 'open'],
  glasses: ['none', 'round', 'square', 'cat-eye', 'aviator', 'sun'],
  facialHair: ['none', 'stubble', 'moustache', 'goatee', 'full-beard'],
  freckles: ['no', 'yes'],
  earrings: ['none', 'studs', 'hoops'],
  clothing: ['rosso', 'moss', 'sky', 'spark', 'ink', 'cream', 'lilac', 'teal', 'rosa'],
  background: ['studio', 'cream', 'rosso', 'moss', 'sky', 'spark', 'lilac', 'night'],
} as const

export type HumanTraitName = keyof typeof HUMAN_TRAITS
export type HumanTraits = { [K in HumanTraitName]: (typeof HUMAN_TRAITS)[K][number] }
export const HUMAN_TRAIT_NAMES = Object.keys(HUMAN_TRAITS) as HumanTraitName[]

/** What a profile stores for an illustrated avatar. `v` versions the drawing, so a changed generator can be told apart. */
export interface HumanSpec {
  v: 1
  traits: HumanTraits
}

export interface HumanOptions {
  size?: number
  /** Accessible label; defaults to "portrait". */
  title?: string
}

/** xmur3 string hash → mulberry32 PRNG (same as creature.ts). */
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
/** Picks with weights (same order as xs). */
const weighted = <T,>(r: () => number, xs: readonly T[], w: readonly number[]) => {
  let x = r() * w.reduce((a, b) => a + b, 0)
  for (let i = 0; i < xs.length; i++) if ((x -= w[i]!) < 0) return xs[i]!
  return xs[xs.length - 1]!
}

const isTrait = <K extends HumanTraitName>(k: K, v: unknown): v is HumanTraits[K] => typeof v === 'string' && (HUMAN_TRAITS[k] as readonly string[]).includes(v)

/**
 * The traits for `seed`, with `overrides` (any subset, each checked against the whitelist; invalid ones are ignored)
 * taking precedence. The same seed and overrides always give the same face.
 */
export function humanTraits(seed: string, overrides: Partial<Record<HumanTraitName, unknown>> = {}): HumanTraits {
  const r = rng(`human:${seed}`)
  const T = HUMAN_TRAITS
  const t: HumanTraits = {
    skin: pick(r, T.skin),
    face: pick(r, T.face),
    hair: weighted(r, T.hair, [3, 5, 9, 6, 6, 4, 5, 6, 7, 6, 4, 4, 2, 2, 2]),
    hairColor: weighted(r, T.hairColor, [9, 9, 8, 4, 3, 5, 2, 3, 2, 1, 1, 1, 1]),
    eyes: weighted(r, T.eyes, [5, 5, 3, 2, 2]),
    eyeColor: weighted(r, T.eyeColor, [6, 5, 3, 2, 3, 1]),
    brows: pick(r, T.brows),
    mouth: weighted(r, T.mouth, [6, 4, 3, 3, 1]),
    glasses: weighted(r, T.glasses, [12, 3, 3, 2, 1, 1]),
    facialHair: weighted(r, T.facialHair, [14, 3, 2, 2, 3]),
    freckles: r() < 0.2 ? 'yes' : 'no',
    earrings: weighted(r, T.earrings, [6, 2, 2]),
    clothing: pick(r, T.clothing),
    background: pick(r, T.background),
  }
  for (const k of HUMAN_TRAIT_NAMES) {
    const v = overrides[k]
    if (isTrait(k, v)) (t as Record<string, string>)[k] = v
  }
  return t
}

/**
 * Validates a stored or submitted spec: exactly `{ v: 1, traits }` with every trait present and on the whitelist, and
 * nothing else. Returns a fresh object built from the whitelist (never the input), or throws with the reason.
 */
export function checkHumanSpec(input: unknown): HumanSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('spec must be an object')
  const o = input as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'v' && k !== 'traits') throw new Error(`unknown field ${JSON.stringify(k.slice(0, 40))}`)
  if (o.v !== 1) throw new Error('spec.v must be 1')
  const tr = o.traits
  if (!tr || typeof tr !== 'object' || Array.isArray(tr)) throw new Error('spec.traits must be an object')
  const traits = tr as Record<string, unknown>
  for (const k of Object.keys(traits)) if (!(k in HUMAN_TRAITS)) throw new Error(`unknown trait ${JSON.stringify(k.slice(0, 40))}`)
  const out = {} as Record<string, string>
  for (const k of HUMAN_TRAIT_NAMES) {
    const v = traits[k]
    if (!isTrait(k, v)) throw new Error(`trait ${k} must be one of ${HUMAN_TRAITS[k].join(', ')}`)
    out[k] = (HUMAN_TRAITS[k] as readonly string[]).find((x) => x === v)!
  }
  return { v: 1, traits: out as HumanTraits }
}

// ── palettes ─────────────────────────────────────────────────────────────────

const SKIN: Record<HumanTraits['skin'], string> = {
  porcelain: '#f6dfcc', ivory: '#efd0b6', sand: '#e5bd9a', honey: '#d8a67c', golden: '#c99266',
  olive: '#b88a5c', tan: '#a8704a', bronze: '#8e5c3a', umber: '#714529', espresso: '#55331f',
}
const HAIR: Record<HumanTraits['hairColor'], string> = {
  black: '#211c19', 'dark-brown': '#3d2b20', brown: '#6b4a31', auburn: '#843a22', ginger: '#c4652d', blonde: '#d8b36c',
  platinum: '#ece2c6', grey: '#9b968f', white: '#ece9e4', blue: '#3d6f8f', pink: '#e58fae', green: '#5f8f5a', purple: '#7a5aa6',
}
const IRIS: Record<HumanTraits['eyeColor'], string> = { brown: '#5a3722', dark: '#2a1d16', hazel: '#7d6131', green: '#4f7a48', blue: '#3f6f9e', grey: '#6c7a84' }
/** The site's palette: rosso, moss, sky, spark, ink, cream and friends. */
const CLOTH: Record<HumanTraits['clothing'], string> = {
  rosso: '#b8281f', moss: '#4f7040', sky: '#3d6f8f', spark: '#e0a83e', ink: '#2e2a25', cream: '#efe3c8', lilac: '#a993cf', teal: '#3f8a86', rosa: '#e7a3b1',
}
/** Backdrop: centre, edge. */
const BACKDROP: Record<HumanTraits['background'], [string, string]> = {
  studio: ['#efe8dc', '#cfc3b1'], cream: ['#fbf3e2', '#e6d6b6'], rosso: ['#f6d9d2', '#dba69a'], moss: ['#e9eedd', '#bccaa6'],
  sky: ['#e1ecf3', '#a9c3d4'], spark: ['#f8ecd0', '#e3c27f'], lilac: ['#ece5f5', '#c3b4dc'], night: ['#4a4a5c', '#1f1f29'],
}

/** Mixes a #rrggbb colour toward white (amt > 0) or black (amt < 0). */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255)
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
}
/** Mixes two colours (t = 0 → a). */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}
const f = (n: number) => +n.toFixed(2)
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// ── geometry ─────────────────────────────────────────────────────────────────

interface Face { T: number; H: number; W: number; J: number; C: number }
/** Top, height, half-width at the cheeks, jaw control, half-width of the chin. */
const FACES: Record<HumanTraits['face'], Face> = {
  oval: { T: 27, H: 51, W: 19, J: 11, C: 3 },
  round: { T: 29, H: 47, W: 21, J: 17, C: 5 },
  square: { T: 28, H: 49, W: 20, J: 20, C: 9 },
  heart: { T: 28, H: 49, W: 21, J: 7, C: 1.5 },
  long: { T: 25, H: 55, W: 17.5, J: 12, C: 4 },
}

function facePath({ T, H, W, J, C }: Face): string {
  const B = T + H, cy = T + H * 0.42
  return `M60 ${T}C${f(60 + W * 0.62)} ${T} ${f(60 + W)} ${f(T + H * 0.17)} ${f(60 + W)} ${f(cy)}C${f(60 + W)} ${f(T + H * 0.72)} ${f(60 + J)} ${B} ${f(60 + C)} ${B}`
    + `L${f(60 - C)} ${B}C${f(60 - J)} ${B} ${f(60 - W)} ${f(T + H * 0.72)} ${f(60 - W)} ${f(cy)}C${f(60 - W)} ${f(T + H * 0.17)} ${f(60 - W * 0.62)} ${T} 60 ${T}Z`
}

let uid = 0

/** SVG string for a human portrait from checked traits. */
export function humanSvg(traits: HumanTraits, opts: HumanOptions = {}): string {
  const t = checkHumanSpec({ v: 1, traits }).traits // never draw from anything off the whitelist
  const s = opts.size ?? 120
  const id = `hp${(uid++).toString(36)}`
  const fc = FACES[t.face]
  const { T, H, W } = fc
  const B = T + H
  const skin = SKIN[t.skin]
  const skinLo = shade(skin, -0.22), skinHi = shade(skin, 0.28)
  const hair = HAIR[t.hairColor]
  const hairLo = shade(hair, -0.28), hairHi = shade(hair, 0.22)
  const cloth = CLOTH[t.clothing]
  const [bg0, bg1] = BACKDROP[t.background]
  const covered = t.hair === 'hijab'
  const browCol = lum(hair) > 0.72 ? shade(hair, -0.45) : t.hair === 'none' || covered || t.hair === 'headwrap' ? shade(skin, -0.6) : shade(hair, -0.1)
  const lip = mix(skinLo, '#b8545a', lum(skin) > 0.55 ? 0.38 : 0.22)
  const eyeY = f(T + H * 0.48), ex = f(W * 0.43)
  const noseY = T + H * 0.66, mouthY = f(T + H * 0.81)
  const out: string[] = []

  out.push(`<defs>
<radialGradient id="${id}bg" cx=".5" cy=".36" r=".78"><stop offset="0" stop-color="${bg0}"/><stop offset="1" stop-color="${bg1}"/></radialGradient>
<radialGradient id="${id}sk" cx=".38" cy=".3" r=".9"><stop offset="0" stop-color="${skinHi}"/><stop offset=".55" stop-color="${skin}"/><stop offset="1" stop-color="${shade(skin, -0.14)}"/></radialGradient>
<linearGradient id="${id}hr" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="${hairHi}"/><stop offset=".5" stop-color="${hair}"/><stop offset="1" stop-color="${hairLo}"/></linearGradient>
<linearGradient id="${id}cl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(cloth, 0.18)}"/><stop offset="1" stop-color="${shade(cloth, -0.2)}"/></linearGradient>
<filter id="${id}soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>
<clipPath id="${id}fc"><path d="${facePath(fc)}"/></clipPath>
</defs>`)
  out.push(`<rect width="120" height="120" fill="url(#${id}bg)"/>`)
  // soft floor shadow behind the shoulders
  out.push(`<ellipse cx="60" cy="118" rx="50" ry="10" fill="rgba(36,33,29,.12)" filter="url(#${id}soft)"/>`)
  // the sitter, framed a little closer than the full bust (shoulders run off the bottom edge, like a portrait crop)
  out.push(`<g transform="translate(60 64) scale(1.2) translate(-60 -64)">`)

  // hair behind the head and shoulders
  const back: Partial<Record<HumanTraits['hair'], string>> = {
    afro: `<circle cx="60" cy="${f(T + 16)}" r="${f(W + 15)}" fill="url(#${id}hr)"/>`,
    bun: `<circle cx="60" cy="${f(T - 7)}" r="9.5" fill="url(#${id}hr)"/>`,
    bob: `<path d="M${f(60 - W - 7)} ${f(T + 14)}C${f(60 - W - 9)} ${f(T - 4)} ${f(60 + W + 9)} ${f(T - 4)} ${f(60 + W + 7)} ${f(T + 14)}L${f(60 + W + 8)} ${f(B - 6)}Q60 ${f(B + 2)} ${f(60 - W - 8)} ${f(B - 6)}Z" fill="url(#${id}hr)"/>`,
    'long-straight': `<path d="M${f(60 - W - 6)} ${f(T + 12)}C${f(60 - W - 8)} ${f(T - 5)} ${f(60 + W + 8)} ${f(T - 5)} ${f(60 + W + 6)} ${f(T + 12)}L${f(60 + W + 9)} 104H${f(60 - W - 9)}Z" fill="url(#${id}hr)"/>`,
    'long-wavy': `<path d="M${f(60 - W - 6)} ${f(T + 12)}C${f(60 - W - 8)} ${f(T - 5)} ${f(60 + W + 8)} ${f(T - 5)} ${f(60 + W + 6)} ${f(T + 12)}c5 10-3 16 3 26s-4 18 2 28c-12 6-24 6-${f(2 * W + 16)} 0c6-10-3-18 2-28s-2-16 3-26z" fill="url(#${id}hr)"/>`,
    locs: `<path d="M${f(60 - W - 6)} ${f(T + 10)}C${f(60 - W - 8)} ${f(T - 6)} ${f(60 + W + 8)} ${f(T - 6)} ${f(60 + W + 6)} ${f(T + 10)}L${f(60 + W + 10)} 106H${f(60 - W - 10)}Z" fill="url(#${id}hr)"/>`
      + [-1, 1].map((sd) => [0, 1, 2, 3].map((i) => `<rect x="${f(60 + sd * (W + 1 + i * 2.2) - 1.3)}" y="${f(T + 18)}" width="2.6" height="${f(80 - T - i * 3)}" rx="1.3" fill="${hairLo}" opacity=".55"/>`).join('')).join(''),
    braids: [-1, 1].map((sd) => {
      const x = f(60 + sd * (W + 3))
      return Array.from({ length: 7 }, (_, i) => `<ellipse cx="${x}" cy="${f(T + 26 + i * 9)}" rx="4.2" ry="5.2" fill="url(#${id}hr)" stroke="${hairLo}" stroke-width=".8"/>`).join('')
    }).join(''),
  }
  if (back[t.hair]) out.push(back[t.hair]!)

  // neck, shoulders and clothes
  out.push(`<path d="M${f(60 - 7.5)} ${f(B - 10)}h15v${f(98 - B)}c0 4-15 4-15 0z" fill="${shade(skin, -0.12)}"/>`)
  out.push(`<path d="M${f(60 - 7.5)} ${f(B - 4)}q7.5 6 15 0v6q-7.5 4-15 0z" fill="${skinLo}" opacity=".45"/>`)
  out.push(`<path d="M12 120v-6c0-13 12-20 27-22.5 5 6 12 8 21 8s16-2 21-8c15 2.5 27 9.5 27 22.5v6z" fill="url(#${id}cl)"/>`)
  out.push(`<path d="M39 91.5c5 6 12 8 21 8s16-2 21-8" stroke="${shade(cloth, -0.32)}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`)
  out.push(`<path d="M22 104c4-4 9-6 14-7" stroke="${shade(cloth, 0.35)}" stroke-opacity=".5" stroke-width="2.4" fill="none" stroke-linecap="round"/>`)
  // a hijab drapes over the neck and shoulders
  if (covered)
    out.push(`<path d="M${f(60 - W - 9)} ${f(T + 14)}C${f(60 - W - 10)} ${f(T - 9)} ${f(60 + W + 10)} ${f(T - 9)} ${f(60 + W + 9)} ${f(T + 14)}L${f(60 + W + 13)} 99Q60 110 ${f(60 - W - 13)} 99Z" fill="url(#${id}hr)"/>`)

  // ears and earrings
  if (!covered) {
    for (const sd of [-1, 1]) {
      const x = f(60 + sd * (W - 0.5))
      out.push(`<ellipse cx="${x}" cy="${f(eyeY + 4)}" rx="4.2" ry="6.2" fill="${shade(skin, -0.06)}"/><path d="M${f(x + sd * 1)} ${f(eyeY + 1)}q${f(sd * 1.8)} 3 0 6" stroke="${skinLo}" stroke-width="1" fill="none" stroke-linecap="round"/>`)
      if (t.earrings === 'studs') out.push(`<circle cx="${f(x + sd * 0.6)}" cy="${f(eyeY + 9.4)}" r="1.5" fill="#f3e3a6" stroke="#b9842f" stroke-width=".6"/>`)
      if (t.earrings === 'hoops') out.push(`<circle cx="${f(x + sd * 0.8)}" cy="${f(eyeY + 12.4)}" r="3.6" fill="none" stroke="#d5a23c" stroke-width="1.3"/>`)
    }
  }

  // face
  out.push(`<path d="${facePath(fc)}" fill="url(#${id}sk)"/>`)
  out.push(`<g clip-path="url(#${id}fc)">`)
  // cheek blush and the shadow under the hairline
  out.push(`<ellipse cx="${f(60 - ex - 2)}" cy="${f(eyeY + 9)}" rx="5" ry="3" fill="#e0707a" opacity=".16" filter="url(#${id}soft)"/><ellipse cx="${f(60 + ex + 2)}" cy="${f(eyeY + 9)}" rx="5" ry="3" fill="#e0707a" opacity=".16" filter="url(#${id}soft)"/>`)
  if (t.freckles === 'yes') {
    const r = rng(`freckles:${t.skin}:${t.face}`)
    const dots = Array.from({ length: 14 }, (_, i) => {
      const sd = i % 2 ? 1 : -1
      return `<circle cx="${f(60 + sd * (ex - 3 + r() * 8))}" cy="${f(eyeY + 5 + r() * 6)}" r="${f(0.5 + r() * 0.45)}"/>`
    })
    out.push(`<g fill="${shade(skin, -0.38)}" opacity=".6">${dots.join('')}</g>`)
  }
  // facial hair
  const mY = mouthY
  if (t.facialHair === 'stubble') out.push(`<path d="M${f(60 - W)} ${f(noseY - 2)}C${f(60 - W + 2)} ${f(B)} ${f(60 + W - 2)} ${f(B)} ${f(60 + W)} ${f(noseY - 2)}V${f(B + 4)}H${f(60 - W)}Z" fill="${hairLo}" opacity=".16"/>`)
  if (t.facialHair === 'full-beard') out.push(`<path d="M${f(60 - W - 1)} ${f(eyeY + 4)}C${f(60 - W + 1)} ${f(B + 4)} ${f(60 + W - 1)} ${f(B + 4)} ${f(60 + W + 1)} ${f(eyeY + 4)}V${f(B + 6)}H${f(60 - W - 1)}Z" fill="url(#${id}hr)"/><ellipse cx="60" cy="${f(mY + 0.6)}" rx="5.4" ry="2.6" fill="${shade(skin, -0.05)}"/>`)
  if (t.facialHair === 'goatee') out.push(`<path d="M55 ${f(mY + 3)}q5 ${f(B - mY - 1)} 10 0q-5 2.2-10 0z" fill="url(#${id}hr)"/>`)
  out.push(`</g>`)
  if (t.facialHair === 'full-beard') out.push(`<path d="M${f(60 - W - 1)} ${f(eyeY + 4)}C${f(60 - W)} ${f(B + 5)} ${f(60 + W)} ${f(B + 5)} ${f(60 + W + 1)} ${f(eyeY + 4)}" fill="none" stroke="${hairLo}" stroke-width="1.2" opacity=".35"/>`)

  // nose
  out.push(`<path d="M58.6 ${f(noseY - 6)}q-1.6 5 -.6 6.2q1.4 1.2 3.6 0" stroke="${skinLo}" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)

  // mouth
  const mouth: Record<HumanTraits['mouth'], string> = {
    smile: `<path d="M54.5 ${mY}q5.5 4.4 11 0" stroke="${lip}" stroke-width="1.9" fill="none" stroke-linecap="round"/>`,
    grin: `<path d="M53.5 ${f(mY - 1)}q6.5 0 13 0q-1 6.4-6.5 6.4t-6.5-6.4z" fill="#5a2a26"/><path d="M54.6 ${f(mY - 0.6)}h10.8q-.4 1.8-1 2.2h-8.8q-.6-.4-1-2.2z" fill="#fbf7f0"/><path d="M53.5 ${f(mY - 1)}q6.5 0 13 0" stroke="${lip}" stroke-width="1.2" fill="none" stroke-linecap="round"/>`,
    neutral: `<path d="M55.5 ${f(mY + 0.8)}h9" stroke="${lip}" stroke-width="1.9" stroke-linecap="round"/>`,
    smirk: `<path d="M55 ${f(mY + 1)}q4.5 1.4 10-2" stroke="${lip}" stroke-width="1.9" fill="none" stroke-linecap="round"/>`,
    open: `<ellipse cx="60" cy="${f(mY + 1)}" rx="3" ry="2.4" fill="#5a2a26" stroke="${lip}" stroke-width="1.1"/>`,
  }
  out.push(mouth[t.mouth])
  if (t.facialHair === 'moustache' || t.facialHair === 'full-beard')
    out.push(`<path d="M60 ${f(mY - 3.4)}c-3-1.6-7-1.4-8.2 1.6 2.6-.6 5.2.2 8.2-.2 3 .4 5.6-.4 8.2.2-1.2-3-5.2-3.2-8.2-1.6z" fill="url(#${id}hr)"/>`)

  // eyes
  const iris = IRIS[t.eyeColor]
  const eye = (x: number) => {
    const y = eyeY
    switch (t.eyes) {
      case 'round': return `<circle cx="${x}" cy="${y}" r="2.6" fill="${shade(iris, -0.35)}"/><circle cx="${f(x + 0.9)}" cy="${f(y - 0.9)}" r=".8" fill="#fff"/>`
      case 'almond': return `<path d="M${f(x - 4.4)} ${y}q4.4-3.8 8.8 0q-4.4 3.2-8.8 0z" fill="#fbf7f0"/><circle cx="${x}" cy="${f(y - 0.1)}" r="2.1" fill="${iris}"/><circle cx="${x}" cy="${f(y - 0.1)}" r="1" fill="#1b1512"/><circle cx="${f(x + 0.8)}" cy="${f(y - 0.9)}" r=".55" fill="#fff"/><path d="M${f(x - 4.6)} ${f(y - 0.1)}q4.6-4.2 9.2 0" stroke="#2a1d16" stroke-width="1.1" fill="none" stroke-linecap="round"/>`
      case 'wide': return `<ellipse cx="${x}" cy="${y}" rx="4" ry="3.4" fill="#fbf7f0" stroke="${skinLo}" stroke-width=".5"/><circle cx="${x}" cy="${f(y + 0.2)}" r="2.4" fill="${iris}"/><circle cx="${x}" cy="${f(y + 0.2)}" r="1.15" fill="#1b1512"/><circle cx="${f(x + 0.9)}" cy="${f(y - 0.8)}" r=".7" fill="#fff"/>`
      case 'smile': return `<path d="M${f(x - 3.4)} ${f(y + 0.8)}q3.4-3.6 6.8 0" stroke="#2a1d16" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
      case 'sleepy': return `<path d="M${f(x - 3.8)} ${y}q3.8 2.8 7.6 0z" fill="#fbf7f0"/><circle cx="${x}" cy="${f(y + 0.8)}" r="1.5" fill="${iris}"/><path d="M${f(x - 4)} ${y}h8" stroke="#2a1d16" stroke-width="1.3" stroke-linecap="round"/>`
    }
  }
  out.push(eye(f(60 - ex)), eye(f(60 + ex)))

  // brows
  const by = f(eyeY - 5.6)
  const brow = (x: number, sd: number) => {
    const a = f(x - 4 * sd), b = f(x + 4 * sd)
    switch (t.brows) {
      case 'soft': return `<path d="M${a} ${f(by + 0.6)}q${f(4 * sd)}-2.2 ${f(8 * sd)}-.4" stroke="${browCol}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`
      case 'straight': return `<path d="M${a} ${by}H${b}" stroke="${browCol}" stroke-width="1.8" stroke-linecap="round"/>`
      case 'arched': return `<path d="M${a} ${f(by + 1)}q${f(3 * sd)}-3.6 ${f(8 * sd)}-.2" stroke="${browCol}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
      case 'thick': return `<path d="M${a} ${f(by + 0.8)}q${f(4 * sd)}-3 ${f(8 * sd)}-.8" stroke="${browCol}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`
      case 'thin': return `<path d="M${a} ${f(by + 0.4)}q${f(4 * sd)}-2 ${f(8 * sd)}-.2" stroke="${browCol}" stroke-width="1" fill="none" stroke-linecap="round"/>`
    }
  }
  out.push(brow(f(60 - ex), 1), brow(f(60 + ex), -1))

  // hair in front: caps and fringes along the top of the head
  const capTop = T - 4
  const cap = (fringeY: number, extra = '') =>
    `<path d="M${f(60 - W - 1.5)} ${f(T + H * 0.4)}C${f(60 - W - 3)} ${f(capTop - 2)} ${f(60 + W + 3)} ${f(capTop - 2)} ${f(60 + W + 1.5)} ${f(T + H * 0.4)}C${f(60 + W - 1)} ${f(fringeY + 2)} ${f(60 + W * 0.5)} ${f(fringeY)} 60 ${f(fringeY)}C${f(60 - W * 0.5)} ${f(fringeY)} ${f(60 - W + 1)} ${f(fringeY + 2)} ${f(60 - W - 1.5)} ${f(T + H * 0.4)}Z" fill="url(#${id}hr)"${extra}/>`
  const gloss = `<path d="M${f(60 - W * 0.55)} ${f(T + 1)}q${f(W * 0.4)}-5 ${f(W * 0.9)}-4" stroke="#fff" stroke-opacity=".28" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
  const front: Record<HumanTraits['hair'], string> = {
    none: `<path d="M${f(60 - W * 0.45)} ${f(T + 5)}q${f(W * 0.35)}-3.4 ${f(W * 0.8)}-2.6" stroke="#fff" stroke-opacity=".3" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
    buzz: cap(T + H * 0.13, ' opacity=".8"'),
    short: cap(T + H * 0.17) + gloss,
    'side-part': cap(T + H * 0.15) + `<path d="M${f(60 - W * 0.4)} ${f(T - 3)}C${f(60 - W * 0.2)} ${f(T + 8)} ${f(60 + W * 0.6)} ${f(T + 6)} ${f(60 + W + 1)} ${f(T + H * 0.3)}C${f(60 + W * 0.3)} ${f(T + 2)} ${f(60 - W * 0.2)} ${f(T + 1)} ${f(60 - W * 0.4)} ${f(T - 3)}z" fill="${hairHi}" opacity=".5"/>` + gloss,
    curly: cap(T + H * 0.16) + Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI * (0.98 - i * 0.12)
      return `<circle cx="${f(60 + Math.cos(a) * (W + 1))}" cy="${f(T + 9 - Math.sin(a) * 12)}" r="5.4" fill="url(#${id}hr)"/>`
    }).join(''),
    afro: Array.from({ length: 11 }, (_, i) => {
      const a = Math.PI * (1.02 - i * 0.104)
      return `<circle cx="${f(60 + Math.cos(a) * (W + 6))}" cy="${f(T + 11 - Math.sin(a) * 16)}" r="7" fill="url(#${id}hr)"/>`
    }).join('') + cap(T + H * 0.14),
    bun: cap(T + H * 0.15) + gloss,
    bob: cap(T + H * 0.22) + gloss,
    'long-straight': cap(T + H * 0.13) + `<path d="M60 ${f(T - 4)}v${f(H * 0.13 + 2)}" stroke="${hairLo}" stroke-width="1" opacity=".6"/>` + gloss,
    'long-wavy': cap(T + H * 0.15) + gloss,
    braids: cap(T + H * 0.12) + `<path d="M60 ${f(T - 4)}v${f(H * 0.12 + 2)}" stroke="${hairLo}" stroke-width="1" opacity=".6"/>`,
    locs: cap(T + H * 0.14) + [-0.5, -0.2, 0.15, 0.45].map((k) => `<rect x="${f(60 + k * W * 1.6 - 1.3)}" y="${f(T - 2)}" width="2.6" height="${f(H * 0.18)}" rx="1.3" fill="${hairLo}" opacity=".45"/>`).join(''),
    mohawk: `<path d="M55 ${f(T + 2)}C54 ${f(T - 14)} 66 ${f(T - 14)} 65 ${f(T + 2)}C64 ${f(T + 6)} 56 ${f(T + 6)} 55 ${f(T + 2)}z" fill="url(#${id}hr)"/>` + `<path d="M${f(60 - W - 1)} ${f(T + H * 0.32)}C${f(60 - W)} ${f(T + 4)} ${f(60 - W * 0.4)} ${f(T + 1)} 56 ${f(T + 3)}" stroke="${hairLo}" stroke-width="3" opacity=".25" fill="none"/>`,
    headwrap: `<path d="M${f(60 - W - 3)} ${f(T + H * 0.26)}C${f(60 - W - 6)} ${f(T - 16)} ${f(60 + W + 6)} ${f(T - 16)} ${f(60 + W + 3)} ${f(T + H * 0.26)}C${f(60 + W * 0.4)} ${f(T + H * 0.16)} ${f(60 - W * 0.4)} ${f(T + H * 0.16)} ${f(60 - W - 3)} ${f(T + H * 0.26)}z" fill="url(#${id}hr)"/>`
      + `<path d="M${f(60 - W * 0.8)} ${f(T + 2)}C${f(60 - W * 0.2)} ${f(T - 6)} ${f(60 + W * 0.3)} ${f(T - 2)} ${f(60 + W * 0.85)} ${f(T + 6)}M${f(60 - W * 0.6)} ${f(T - 6)}C${f(60)} ${f(T - 12)} ${f(60 + W * 0.4)} ${f(T - 9)} ${f(60 + W * 0.7)} ${f(T - 3)}" stroke="${hairLo}" stroke-width="1.2" opacity=".5" fill="none"/>`
      + `<circle cx="${f(60 + W * 0.5)}" cy="${f(T - 9)}" r="5" fill="url(#${id}hr)"/>`,
    hijab: `<path d="M${f(60 - W - 4)} ${f(T + H * 0.55)}C${f(60 - W - 6)} ${f(T - 12)} ${f(60 + W + 6)} ${f(T - 12)} ${f(60 + W + 4)} ${f(T + H * 0.55)}C${f(60 + W + 1)} ${f(T + H * 0.2)} ${f(60 + W * 0.6)} ${f(T + 2)} 60 ${f(T + 2)}C${f(60 - W * 0.6)} ${f(T + 2)} ${f(60 - W - 1)} ${f(T + H * 0.2)} ${f(60 - W - 4)} ${f(T + H * 0.55)}z" fill="url(#${id}hr)"/>`
      + `<path d="M${f(60 - W - 2)} ${f(T + H * 0.6)}C${f(60 - W)} ${f(B + 8)} ${f(60 + W)} ${f(B + 8)} ${f(60 + W + 2)} ${f(T + H * 0.6)}" stroke="${hairLo}" stroke-width="1.4" fill="none" opacity=".4"/>`,
  }
  out.push(front[t.hair])
  // a hijab also wraps under the chin
  if (covered) out.push(`<path d="M${f(60 - W - 3)} ${f(T + H * 0.6)}C${f(60 - W + 1)} ${f(B + 7)} ${f(60 + W - 1)} ${f(B + 7)} ${f(60 + W + 3)} ${f(T + H * 0.6)}L${f(60 + W + 6)} ${f(B + 12)}Q60 ${f(B + 20)} ${f(60 - W - 6)} ${f(B + 12)}Z" fill="url(#${id}hr)"/>`)

  // glasses
  const g = t.glasses
  if (g !== 'none') {
    const frame = g === 'aviator' ? '#b9842f' : '#24211d'
    const lens = g === 'sun' ? `fill="#1d2228" fill-opacity=".88"` : `fill="#dfeef5" fill-opacity=".22"`
    const sw = g === 'aviator' ? 1.1 : 1.6
    const L = f(60 - ex), R = f(60 + ex), y = eyeY
    const shape = (x: number) => {
      switch (g) {
        case 'round': return `<circle cx="${x}" cy="${y}" r="5.2" ${lens} stroke="${frame}" stroke-width="${sw}"/>`
        case 'square': return `<rect x="${f(x - 6)}" y="${f(y - 4.4)}" width="12" height="8.8" rx="2" ${lens} stroke="${frame}" stroke-width="${sw}"/>`
        case 'cat-eye': return `<path d="M${f(x - 6)} ${f(y - 3.2)}q6-2.2 12-1.4l1.2-1.8q.4 5.6-3.4 8.2q-4.4 2.2-8.4-.2q-2.4-1.8-1.4-4.8z" ${lens} stroke="${frame}" stroke-width="${sw}" stroke-linejoin="round" transform="${x < 60 ? `translate(${f(2 * x)} 0) scale(-1 1)` : ''}"/>`
        case 'aviator': return `<path d="M${f(x - 6)} ${f(y - 3.6)}h12q.4 5-2.6 7.6q-3.4 2.2-6.8 0q-3-2.6-2.6-7.6z" ${lens} stroke="${frame}" stroke-width="${sw}" stroke-linejoin="round"/>`
        case 'sun': return `<rect x="${f(x - 6.2)}" y="${f(y - 4)}" width="12.4" height="8" rx="3.6" ${lens} stroke="${frame}" stroke-width="${sw}"/>`
      }
    }
    out.push(`<g>${shape(L)}${shape(R)}<path d="M${f(L + 5.2)} ${f(y - 0.6)}q${f(ex - 5.2)}-2 ${f(2 * ex - 10.4)} 0" stroke="${frame}" stroke-width="${sw}" fill="none"/>`
      + `<path d="M${f(L - 5.6)} ${f(y - 1)}L${f(60 - W + 0.5)} ${f(y - 1.6)}M${f(R + 5.6)} ${f(y - 1)}L${f(60 + W - 0.5)} ${f(y - 1.6)}" stroke="${frame}" stroke-width="${sw}"/>`
      + (g === 'sun' ? '' : `<path d="M${f(L - 3)} ${f(y - 2.4)}l2-1.2M${f(R - 3)} ${f(y - 2.4)}l2-1.2" stroke="#fff" stroke-opacity=".7" stroke-width=".9" stroke-linecap="round"/>`)
      + `</g>`)
  }

  const title = opts.title ?? 'portrait'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${s}" height="${s}" role="img"><title>${esc(title)}</title>${out.join('')}</g></svg>`
}

/** The stable JSON form of a spec (fixed key order): what is stored and hashed. */
export function humanSpecJson(spec: HumanSpec): string {
  const c = checkHumanSpec(spec)
  return JSON.stringify({ v: 1, traits: Object.fromEntries(HUMAN_TRAIT_NAMES.map((k) => [k, c.traits[k]])) })
}
