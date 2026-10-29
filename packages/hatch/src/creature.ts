/**
 * Procedural gremlin portraits. Every gremlin gets its own small robot, drawn deterministically from a seed (its config
 * hash), so the same gremlin looks the same on the hatch page, the board and its profile. Pure string output (SVG), so
 * it runs in browsers and on the board server alike.
 *
 * Style: the Gremlin Forge's "Atomic Appliances" line, as a portrait bust. Glossy 1950s appliance enamel, chrome bezels
 * and trim, a dark glass visor with eyes glowing from inside, knobs, dials and antennae. Original designs.
 */

export type CreatureMood = 'normal' | 'low_compute' | 'critical' | 'dead' | 'egg'

export interface CreatureOptions {
  size?: number
  mood?: CreatureMood
  /** Accessible label; defaults to "gremlin portrait". */
  title?: string
  /** Draw on the studio-backdrop disc (avatars) instead of transparent. */
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

/** Enamel, accent enamel, glow, trim metal: the forge's appliance colours. */
const PALETTES = [
  ['#efe3c8', '#c9302c', '#ffb347', 'chrome'], // cream and rosso
  ['#a8c8e0', '#efe3c8', '#7fe6ff', 'chrome'], // pastel blue
  ['#a9d8c4', '#c9302c', '#ffb347', 'brass'], // pastel green, foreman
  ['#f1b9c4', '#5b6168', '#ffb347', 'chrome'], // rosa
  ['#c9302c', '#efe3c8', '#ffb347', 'chrome'], // rosso
  ['#e5b54a', '#5b6168', '#7fe6ff', 'chrome'], // mustard
  ['#5b6168', '#e5b54a', '#ff3b30', 'brass'], // gunmetal
  ['#2b2b2e', '#c9302c', '#ff3b30', 'chrome'], // matte black, the octopod
  ['#efe3c8', '#3d6f8f', '#9dff7a', 'brass'], // cream and teal
  ['#c7b8e0', '#efe3c8', '#c58bff', 'chrome'], // lilac
] as const

export interface CreatureTraits {
  palette: readonly [string, string, string, 'chrome' | 'brass']
  head: 'dome' | 'capsule' | 'can' | 'bell' | 'orb'
  visor: 'slot' | 'porthole' | 'screen'
  eyes: 'pills' | 'dots' | 'ring' | 'bar' | 'slits'
  smile: boolean
  antenna: 'bulb' | 'twin' | 'dish' | 'stack' | 'none'
  ears: 'knobs' | 'dials' | 'fins' | 'none'
  chest: 'dial' | 'vents' | 'rivets' | 'gauge'
}

const LOGO: CreatureTraits = { palette: PALETTES[0], head: 'capsule', visor: 'slot', eyes: 'pills', smile: true, antenna: 'bulb', ears: 'knobs', chest: 'vents' }

export function creatureTraits(seed: string): CreatureTraits {
  if (seed === 'gremlinz-logo-v1') return LOGO
  const r = rng(seed)
  const head = pick(r, ['dome', 'capsule', 'can', 'bell', 'orb'] as const)
  const visor = head === 'orb' ? 'porthole' : pick(r, ['slot', 'slot', 'porthole', 'screen'] as const)
  const eyes = visor === 'porthole' ? pick(r, ['ring', 'dots', 'pills'] as const) : pick(r, ['pills', 'dots', 'bar', 'slits', 'pills'] as const)
  return {
    palette: pick(r, PALETTES),
    head,
    visor,
    eyes,
    smile: eyes !== 'slits' && eyes !== 'ring' && r() < 0.55,
    antenna: pick(r, ['bulb', 'twin', 'dish', 'stack', 'none', 'bulb'] as const),
    ears: pick(r, ['knobs', 'dials', 'fins', 'none', 'knobs'] as const),
    chest: pick(r, ['dial', 'vents', 'rivets', 'gauge'] as const),
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Mixes a #rrggbb colour toward white (amt > 0) or black (amt < 0). */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255)
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
}

let uidCounter = 0
const EDGE = 'rgba(36,33,29,.55)'

/** Head silhouettes, centred on x=60; each returns its path and where its visor and top sit. */
function headShape(kind: CreatureTraits['head']): { d: string; cy: number; top: number; w: number } {
  switch (kind) {
    case 'dome': return { d: 'M60 18c21 0 34 15 34 33 0 15-9 25-22 27H48c-13-2-22-12-22-27 0-18 13-33 34-33z', cy: 50, top: 18, w: 68 }
    case 'capsule': return { d: 'M42 26h36a22 22 0 0 1 0 44H42a22 22 0 0 1 0-44z', cy: 48, top: 26, w: 80 }
    case 'can': return { d: 'M40 20h40c7 0 12 5 12 12v34c0 7-5 12-12 12H40c-7 0-12-5-12-12V32c0-7 5-12 12-12z', cy: 50, top: 20, w: 64 }
    case 'bell': return { d: 'M60 16c15 0 24 11 26 26l4 26c1 6-3 10-9 10H39c-6 0-10-4-9-10l4-26c2-15 11-26 26-26z', cy: 52, top: 16, w: 60 }
    case 'orb': return { d: 'M60 16a32 32 0 1 1 0 64 32 32 0 0 1 0-64z', cy: 48, top: 16, w: 64 }
  }
}

function eggSvg(t: CreatureTraits, s: number, title: string, badge: boolean, id: string): string {
  const [enamel, accent, glow, trim] = t.palette
  const metal = trim === 'brass' ? `url(#${id}b)` : `url(#${id}c)`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${s}" height="${s}" role="img"><title>${esc(title)}</title>
<defs>${gradients(id, enamel)}</defs>
${badge ? `<circle cx="60" cy="60" r="58" fill="#d8cebf"/>` : ''}
<ellipse cx="60" cy="108" rx="26" ry="5" fill="rgba(36,33,29,.18)"/>
<path d="M44 104h32l-4-8H48z" fill="${metal}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M60 14c19 0 32 30 32 52 0 20-14 32-32 32S28 86 28 66c0-22 13-52 32-52z" fill="url(#${id}e)" stroke="${EDGE}" stroke-width="1.5"/>
<clipPath id="${id}k"><path d="M60 14c19 0 32 30 32 52 0 20-14 32-32 32S28 86 28 66c0-22 13-52 32-52z"/></clipPath><rect x="26" y="57" width="68" height="6" fill="${metal}" clip-path="url(#${id}k)"/>
<circle cx="60" cy="76" r="9" fill="url(#${id}g)" stroke="${metal}" stroke-width="3"/>
<circle cx="60" cy="76" r="5" fill="${glow}" opacity=".35" filter="url(#${id}f)"/><circle cx="60" cy="76" r="2.4" fill="${shade(glow, 0.55)}"/>
<path d="M44 34c4-8 9-12 15-13" stroke="#fff" stroke-opacity=".75" stroke-width="4" fill="none" stroke-linecap="round"/>
<circle cx="72" cy="42" r="3" fill="${accent}" opacity=".9"/></svg>`
}

function gradients(id: string, enamel: string): string {
  return `<radialGradient id="${id}e" cx=".34" cy=".26" r=".85"><stop offset="0" stop-color="${shade(enamel, 0.5)}"/><stop offset=".38" stop-color="${enamel}"/><stop offset="1" stop-color="${shade(enamel, -0.32)}"/></radialGradient>
<linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfb"/><stop offset=".42" stop-color="#9aa1a8"/><stop offset=".5" stop-color="#f4f6f7"/><stop offset=".72" stop-color="#5e646b"/><stop offset="1" stop-color="#d4d8dc"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe3a8"/><stop offset=".45" stop-color="#b9842f"/><stop offset=".55" stop-color="#f6d58a"/><stop offset="1" stop-color="#8a5f1c"/></linearGradient>
<radialGradient id="${id}g" cx=".4" cy=".3" r=".9"><stop offset="0" stop-color="#2a3644"/><stop offset=".6" stop-color="#0d131a"/><stop offset="1" stop-color="#05080b"/></radialGradient>
<filter id="${id}f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.6"/></filter>`
}

/** SVG string for a gremlin. `seed` should be stable (config hash or address). */
export function creatureSvg(seed: string, opts: CreatureOptions = {}): string {
  const s = opts.size ?? 120
  const mood = opts.mood ?? 'normal'
  const t = creatureTraits(seed)
  const title = opts.title ?? 'gremlin portrait'
  const id = `gc${(uidCounter++).toString(36)}${seed.length.toString(36)}`
  if (mood === 'egg') return eggSvg(t, s, title, !!opts.badge, id)

  const dead = mood === 'dead', sleepy = mood === 'low_compute', critical = mood === 'critical'
  const [enamel0, accent0, glow0, trim] = t.palette
  const enamel = dead ? '#b8b2a8' : enamel0
  const accent = dead ? '#8f8a82' : accent0
  const glow = critical ? '#ff3b30' : glow0
  const metal = trim === 'brass' && !dead ? `url(#${id}b)` : `url(#${id}c)`
  const knob = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${metal}" stroke="${EDGE}" stroke-width="1"/><circle cx="${x - r * 0.3}" cy="${y - r * 0.35}" r="${r * 0.32}" fill="#fff" opacity=".8"/>`
  // Straight chrome parts are thin rects, not stroked lines: a gradient can't paint a zero-width bounding box.
  const bar = (x: number, y: number, w: number, hh: number) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${metal}"/>`
  const h = headShape(t.head)
  const out: string[] = []

  out.push(`<defs>${gradients(id, enamel)}<clipPath id="${id}h"><path d="${h.d}"/></clipPath></defs>`)
  if (opts.badge) out.push(`<circle cx="60" cy="60" r="58" fill="#d8cebf"/>`)

  // antenna (behind the head)
  const top = h.top
  if (t.antenna === 'bulb') out.push(`${bar(58.5, top - 9, 3, 11)}${knob(60, top - 11, 4.5).replace(metal, dead ? metal : accent)}`)
  else if (t.antenna === 'twin') out.push(`<path d="M50 ${top + 4}l-7-14M70 ${top + 4}l7-14" stroke="${metal}" stroke-width="2.6" stroke-linecap="round"/>${knob(42, top - 11, 3.6)}${knob(78, top - 11, 3.6)}`)
  else if (t.antenna === 'dish') out.push(`${bar(58.5, top - 5, 3, 7)}<path d="M47 ${top - 6}a13 7 0 0 0 26 0z" fill="${metal}" stroke="${EDGE}" stroke-width="1"/>`)
  else if (t.antenna === 'stack') out.push(`<rect x="70" y="${top - 12}" width="9" height="${18}" fill="url(#${id}b)" stroke="${EDGE}" stroke-width="1"/><rect x="68" y="${top - 15}" width="13" height="5" rx="1.5" fill="url(#${id}b)" stroke="${EDGE}" stroke-width="1"/>`)

  // ears
  const half = h.w / 2
  if (t.ears === 'knobs') out.push(knob(60 - half - 2, h.cy, 6), knob(60 + half + 2, h.cy, 6))
  else if (t.ears === 'dials') for (const x of [60 - half - 1, 60 + half + 1]) out.push(`<circle cx="${x}" cy="${h.cy}" r="7.5" fill="${metal}" stroke="${EDGE}" stroke-width="1"/><circle cx="${x}" cy="${h.cy}" r="5" fill="#f4ecd8"/><path d="M${x} ${h.cy}l2.6-2.6" stroke="#24211d" stroke-width="1.4" stroke-linecap="round"/>`)
  else if (t.ears === 'fins') out.push(`<path d="M${60 - half + 3} ${h.cy - 8}l-13-9 2 25z" fill="${accent}" stroke="${EDGE}" stroke-width="1.2" stroke-linejoin="round"/><path d="M${60 + half - 3} ${h.cy - 8}l13-9-2 25z" fill="${accent}" stroke="${EDGE}" stroke-width="1.2" stroke-linejoin="round"/>`)

  // torso, collar and neck
  out.push(`<path d="M18 120v-16c0-9 7-15 16-15h52c9 0 16 6 16 15v16z" fill="url(#${id}e)" stroke="${EDGE}" stroke-width="1.5"/>`)
  out.push(`<rect x="50" y="76" width="20" height="15" fill="${metal}" stroke="${EDGE}" stroke-width="1"/>`)
  out.push(bar(19, 101.5, 82, 5))
  if (t.chest === 'dial') out.push(`<circle cx="74" cy="113" r="5.5" fill="${metal}" stroke="${EDGE}" stroke-width="1"/><circle cx="74" cy="113" r="3.6" fill="#f4ecd8"/>`)
  else if (t.chest === 'vents') out.push(`<path d="M48 111h24M48 115.5h24" stroke="#3a3f45" stroke-width="2.2" stroke-linecap="round"/>`)
  else if (t.chest === 'rivets') for (let x = 28; x <= 92; x += 8) out.push(`<circle cx="${x}" cy="98" r="1.4" fill="url(#${id}b)"/>`)
  else out.push(`<circle cx="44" cy="113" r="5" fill="url(#${id}g)" stroke="${metal}" stroke-width="2"/><circle cx="44" cy="113" r="1.6" fill="${dead ? '#555' : glow}"/>`)

  // head
  out.push(`<path d="${h.d}" fill="url(#${id}e)" stroke="${EDGE}" stroke-width="1.5"/>`)
  if (t.head === 'can') out.push(bar(28.5, 28, 63, 4))
  if (t.head === 'capsule' || t.head === 'dome') out.push(`<g clip-path="url(#${id}h)">${bar(20, h.cy + 18.25, 80, 3.5)}</g>`)
  // weathering when critical or dead
  if (critical || dead) {
    const r = rng(seed + ':rust')
    const spots = Array.from({ length: 7 }, () => `<ellipse cx="${(30 + r() * 60).toFixed(1)}" cy="${(h.top + 6 + r() * 52).toFixed(1)}" rx="${(2 + r() * 4).toFixed(1)}" ry="${(1.5 + r() * 3).toFixed(1)}" fill="${r() < 0.5 ? '#8a3a16' : '#b4561f'}" opacity=".85"/>`)
    out.push(`<g clip-path="url(#${id}h)">${spots.join('')}</g>`)
  }
  // gloss
  out.push(`<path d="M${60 - half * 0.62} ${h.top + 14}c5-7 12-10 19-10" stroke="#fff" stroke-opacity=".7" stroke-width="4" fill="none" stroke-linecap="round"/>`)

  // visor
  const vy = h.cy + (t.head === 'bell' ? 4 : 0)
  let vis = ''
  let eyeY = vy, ex = 11
  if (t.visor === 'slot') {
    const w = Math.min(54, h.w - 16), hh = 24
    vis = `<rect x="${60 - w / 2}" y="${vy - hh / 2}" width="${w}" height="${hh}" rx="${hh / 2}" fill="url(#${id}g)" stroke="${metal}" stroke-width="3.5"/>`
    ex = w * 0.2
  } else if (t.visor === 'porthole') {
    vis = `<circle cx="60" cy="${vy}" r="17" fill="url(#${id}g)" stroke="${metal}" stroke-width="4.5"/>`
    ex = 6.5
  } else {
    vis = `<rect x="38" y="${vy - 14}" width="44" height="28" rx="7" fill="url(#${id}g)" stroke="${metal}" stroke-width="3.5"/>`
    ex = 9
  }
  out.push(vis)

  // eyes
  const eyeShapes = (fill: string): string => {
    if (dead) return ''
    if (sleepy) return `<path d="M${60 - ex - 4} ${eyeY + 1}h8M${60 + ex - 4} ${eyeY + 1}h8" stroke="${fill}" stroke-width="2.6" stroke-linecap="round"/>`
    switch (t.eyes) {
      case 'pills': return `<rect x="${60 - ex - 3}" y="${eyeY - 6.5}" width="6" height="11" rx="3" fill="${fill}"/><rect x="${60 + ex - 3}" y="${eyeY - 6.5}" width="6" height="11" rx="3" fill="${fill}"/>`
      case 'dots': return `<circle cx="${60 - ex}" cy="${eyeY}" r="3.8" fill="${fill}"/><circle cx="${60 + ex}" cy="${eyeY}" r="3.8" fill="${fill}"/>`
      case 'ring': return `<circle cx="60" cy="${eyeY}" r="8.5" fill="none" stroke="${fill}" stroke-width="2.4"/><circle cx="60" cy="${eyeY}" r="3.6" fill="${fill}"/>`
      case 'bar': return `<rect x="${60 - ex - 5}" y="${eyeY - 2.6}" width="${2 * ex + 10}" height="5.2" rx="2.6" fill="${fill}"/>`
      case 'slits': return `<path d="M${60 - ex - 5} ${eyeY - 2}l9 3M${60 + ex + 5} ${eyeY - 2}l-9 3" stroke="${fill}" stroke-width="3.2" stroke-linecap="round"/>`
    }
  }
  const smile = t.smile && !dead && !sleepy && !critical && t.visor !== 'porthole'
    ? `<path d="M55 ${eyeY + 6.5}q5 3.5 10 0" stroke="${glow}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` : ''
  if (!dead) {
    out.push(`<g filter="url(#${id}f)" opacity="${sleepy ? 0.45 : 0.95}">${eyeShapes(glow)}</g>`)
    out.push(`<g opacity="${sleepy ? 0.7 : 1}">${eyeShapes(shade(glow, 0.45))}</g>${smile}`)
  } else {
    // a dark visor with a crack
    out.push(`<path d="M${60 - ex} ${eyeY - 9}l5 6-4 4 6 7" stroke="#cfd5da" stroke-opacity=".65" stroke-width="1.2" fill="none" stroke-linejoin="round"/>`)
  }
  // visor glass highlight
  out.push(t.visor === 'porthole'
    ? `<path d="M50 ${vy - 6}a11 11 0 0 1 8-7" stroke="#fff" stroke-opacity=".45" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
    : `<path d="M${60 - ex - 9} ${vy - 6}h10" stroke="#fff" stroke-opacity=".38" stroke-width="2.4" stroke-linecap="round"/>`)

  // mood marks
  if (sleepy) out.push(`<text x="92" y="24" font-family="ui-monospace,monospace" font-size="13" font-weight="700" fill="#24211d">z</text><text x="101" y="14" font-family="ui-monospace,monospace" font-size="9" font-weight="700" fill="#24211d">z</text>`)
  if (critical) out.push(`<path d="M98 20l-5 9 6 2-5 10" stroke="#ff3b30" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${s}" height="${s}" role="img"><title>${esc(title)}</title>${out.join('')}</svg>`
}
