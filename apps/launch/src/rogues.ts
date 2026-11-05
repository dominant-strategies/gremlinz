/**
 * The home page's rogues' gallery: three full-body gremlins with worse intentions than the portraits. Original designs
 * in the forge's studio style (chrome, enamel, glowing glass), nodding to film robots without copying any of them:
 * a liquid-chrome stalker whose arm is turning into a blade, a domed astromech with a saw it shouldn't have, and a
 * headless four-legged hunter with a sensor cluster for a face.
 */

let n = 0

/** Chrome, dark chrome, gunmetal and rosso enamel, dark glass and a glow blur, unique per SVG. */
function defs(id: string): string {
  return `<linearGradient id="${id}c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5e646b"/><stop offset=".18" stop-color="#f4f6f7"/><stop offset=".32" stop-color="#9aa1a8"/><stop offset=".52" stop-color="#fbfbfb"/><stop offset=".7" stop-color="#6c737a"/><stop offset=".86" stop-color="#d4d8dc"/><stop offset="1" stop-color="#4a4f55"/></linearGradient>
<linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfb"/><stop offset=".42" stop-color="#9aa1a8"/><stop offset=".5" stop-color="#f4f6f7"/><stop offset=".72" stop-color="#5e646b"/><stop offset="1" stop-color="#d4d8dc"/></linearGradient>
<linearGradient id="${id}d" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1b1d20"/><stop offset=".3" stop-color="#6a7078"/><stop offset=".45" stop-color="#2a2d31"/><stop offset=".8" stop-color="#4a4f56"/><stop offset="1" stop-color="#141618"/></linearGradient>
<radialGradient id="${id}m" cx=".35" cy=".25" r=".9"><stop offset="0" stop-color="#7b8189"/><stop offset=".45" stop-color="#3a3e44"/><stop offset="1" stop-color="#16181b"/></radialGradient>
<radialGradient id="${id}r" cx=".35" cy=".25" r=".9"><stop offset="0" stop-color="#e2574f"/><stop offset=".45" stop-color="#b8281f"/><stop offset="1" stop-color="#6e1410"/></radialGradient>
<radialGradient id="${id}g" cx=".4" cy=".3" r=".9"><stop offset="0" stop-color="#2a3644"/><stop offset=".6" stop-color="#0d131a"/><stop offset="1" stop-color="#05080b"/></radialGradient>
<radialGradient id="${id}e" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff1ec"/><stop offset=".3" stop-color="#ff5a4e"/><stop offset="1" stop-color="#ff3b30" stop-opacity="0"/></radialGradient>
<filter id="${id}f" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>`
}

const EDGE = 'rgba(20,18,16,.6)'
const svg = (id: string, vb: string, title: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img"><title>${title}</title><defs>${defs(id)}</defs>${body}</svg>`
/** A red eye: blurred halo, hot core, a pinpoint highlight. */
const eye = (id: string, x: number, y: number, r: number) =>
  `<circle class="rogue-glow" cx="${x}" cy="${y}" r="${r * 2.6}" fill="url(#${id}e)" opacity=".85"/><circle cx="${x}" cy="${y}" r="${r}" fill="#ff3b30"/><circle cx="${x}" cy="${y}" r="${r * 0.45}" fill="#fff1ec"/>`

/** Liquid-chrome stalker rising out of its own puddle, right arm half-turned into a blade. */
export function mercurySvg(title = 'a liquid-chrome gremlin'): string {
  const id = `rg${(n++).toString(36)}`
  const c = `url(#${id}c)`
  return svg(id, '0 0 160 240', title, `
<ellipse cx="80" cy="222" rx="58" ry="9" fill="rgba(36,33,29,.16)"/>
<path d="M30 218c4-7 18-9 30-9h40c14 0 28 2 32 9 2 5-10 8-26 8H56c-18 0-28-3-26-8z" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<path d="M44 216c6-2 12-2 16 0M100 214c8-1 16 0 20 3" stroke="#fff" stroke-opacity=".8" stroke-width="2" stroke-linecap="round" fill="none"/>
<path d="M64 124h32l4 30-2 44c0 6 3 10 8 13l-2 3H84l-1-58-3-14-3 14-1 58H64l-2-3c5-3 8-7 8-13l-2-44z" fill="${c}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M57 66c7-4 15-6 23-6s16 2 23 6l3 8c-1 18-4 34-10 50H64c-6-16-9-32-10-50z" fill="${c}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M57 70c-8 3-12 10-13 22l-3 34c-1 5 1 9 5 9s6-3 6-8l3-31c1-6 3-10 6-12z" fill="${c}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M103 70c8 3 12 10 13 22l1 12c-1 3-6 4-9 2l-3-12c-1-5-3-8-5-9z" fill="${c}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M107 100c4-2 9-2 11 1l3 10 22 76c1 4-1 6-4 4L111 118c-3-6-5-12-4-18z" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1.2" stroke-linejoin="round"/>
<path d="M115 116l25 70" stroke="#fff" stroke-opacity=".9" stroke-width="1.4" stroke-linecap="round"/>
<path d="M139 192c1 4 1 7-1 9-2-2-2-5 1-9z" fill="url(#${id}v)" stroke="${EDGE}" stroke-width=".8"/>
<path d="M135 205c.8 3 .6 5-.8 6.5-1.4-1.5-1.4-3.5.8-6.5z" fill="#c9ced3"/>
<path d="M110 104c3 4 6 6 10 6" stroke="${EDGE}" stroke-width="1" fill="none"/>
<rect x="73" y="52" width="14" height="12" fill="${c}" stroke="${EDGE}" stroke-width="1"/>
<path d="M80 14c11 0 18 9 18 21 0 13-7 22-18 22s-18-9-18-22c0-12 7-21 18-21z" fill="${c}" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M64 29l14 6M96 29l-14 6" stroke="#2a2d31" stroke-width="3" stroke-linecap="round"/>
<path d="M68 37.5l8 1.2M92 37.5l-8 1.2" class="rogue-glow" stroke="#7fe6ff" stroke-width="4.5" stroke-linecap="round" opacity=".55" filter="url(#${id}f)"/>
<path d="M68 37.5l8 1.2M92 37.5l-8 1.2" stroke="#e6fbff" stroke-width="1.8" stroke-linecap="round"/>
<path d="M73 49.5h14" stroke="#2a2d31" stroke-width="1.6" stroke-linecap="round"/>
<path d="M66 44c3 4 4 8 4 11M94 44c-3 4-4 8-4 11" stroke="#5e646b" stroke-width="1" stroke-linecap="round" fill="none"/>
<path d="M70 20c3-3 7-4 10-4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/>
<path d="M62 76c2 14 3 28 6 40M70 130l-2 56M90 130l2 56" stroke="#fff" stroke-opacity=".75" stroke-width="2" stroke-linecap="round" fill="none"/>
<path d="M46 98l-2 26" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/>
<path d="M60 202c-2 5-1 9 2 12M100 203c3 4 3 8 0 11" stroke="url(#${id}v)" stroke-width="4" stroke-linecap="round" fill="none"/>`)
}

/** Domed astromech gone wrong: gunmetal barrel, one red eye in the dome, a buzzsaw out of its chest panel. */
export function astroSvg(title = 'a domed gremlin with a saw'): string {
  const id = `rg${(n++).toString(36)}`
  const teeth = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2, b = a + 0.2
    const p = (r: number, t: number) => `${(30 + Math.cos(t) * r).toFixed(1)} ${(122 + Math.sin(t) * r).toFixed(1)}`
    return `L${p(19, a)}L${p(23, a + 0.1)}L${p(19, b)}`
  }).join('')
  return svg(id, '0 0 180 200', title, `
<ellipse cx="96" cy="186" rx="62" ry="8" fill="rgba(36,33,29,.18)"/>
<path d="M46 90h12l4 70-6 18H40l-4-10z" fill="url(#${id}d)" stroke="${EDGE}" stroke-width="1.2"/>
<path d="M134 90h12l10 78-4 10h-16l-6-18z" fill="url(#${id}d)" stroke="${EDGE}" stroke-width="1.2"/>
<rect x="36" y="172" width="26" height="10" rx="3" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<rect x="130" y="172" width="26" height="10" rx="3" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<path d="M88 160h16l4 14H84z" fill="url(#${id}d)" stroke="${EDGE}" stroke-width="1.2"/>
<rect x="82" y="172" width="28" height="9" rx="3" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<rect x="54" y="78" width="84" height="88" rx="10" fill="url(#${id}m)" stroke="${EDGE}" stroke-width="1.5"/>
<rect x="64" y="92" width="22" height="30" rx="3" fill="url(#${id}r)" stroke="${EDGE}" stroke-width="1"/>
<rect x="106" y="92" width="22" height="14" rx="3" fill="url(#${id}r)" stroke="${EDGE}" stroke-width="1"/>
<rect x="106" y="110" width="22" height="12" rx="3" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="2"/>
<path d="M109 116h6" stroke="#ff3b30" stroke-width="2" stroke-linecap="round"/>
<path d="M64 132h64M64 140h64M64 148h40" stroke="#14161a" stroke-width="2.4" stroke-linecap="round"/>
<path d="M58 84c2 30 2 56 0 78" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round" fill="none"/>
<rect x="52" y="76" width="88" height="7" rx="2" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<path d="M56 112H42l-6 6" stroke="url(#${id}v)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M${(30 + 19).toFixed(1)} 122${teeth}z" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>
<circle cx="30" cy="122" r="14" fill="url(#${id}c)" stroke="${EDGE}" stroke-width="1"/>
<circle cx="30" cy="122" r="4" fill="#2a2d31"/>
<path d="M18 112a16 16 0 0 1 10-5" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>
<path d="M10 104l-5-4M8 116l-6 0M12 96l-3-6" stroke="#ffb347" stroke-width="1.8" stroke-linecap="round"/>
<path d="M52 78c0-26 20-44 44-44s44 18 44 44z" fill="url(#${id}c)" stroke="${EDGE}" stroke-width="1.5"/>
<path d="M60 64h72" stroke="#3a3e44" stroke-width="1.2"/>
<path d="M66 50h22v14H66zM104 48h14v16h-14z" fill="#24272b" stroke="${EDGE}" stroke-width="1"/>
<circle cx="96" cy="52" r="10" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="3"/>
${eye(id, 96, 52, 3.6)}
<circle cx="124" cy="68" r="3.2" fill="#ff3b30" opacity=".9"/>
<rect x="128" y="40" width="6" height="12" rx="2" fill="url(#${id}d)" stroke="${EDGE}" stroke-width="1" transform="rotate(20 131 46)"/>
<path d="M66 44c6-6 14-9 22-10" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>`)
}

/** Headless four-legged hunter: low slung body, a sensor cluster for a face, legs that bend the wrong way. */
export function houndSvg(title = 'a four-legged hunting gremlin'): string {
  const id = `rg${(n++).toString(36)}`
  const d = `url(#${id}d)`
  const leg = (hip: [number, number], knee: [number, number], foot: [number, number]) =>
    `<path d="M${hip.join(' ')}L${knee.join(' ')}L${foot.join(' ')}" stroke="#1b1d20" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<path d="M${hip.join(' ')}L${knee.join(' ')}L${foot.join(' ')}" stroke="${d}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<circle cx="${knee[0]}" cy="${knee[1]}" r="5" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>` +
    `<path d="M${foot[0] - 7} ${foot[1] + 2}h14l-2-5h-10z" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>`
  return svg(id, '0 0 230 170', title, `
<ellipse cx="116" cy="158" rx="92" ry="8" fill="rgba(36,33,29,.18)"/>
${leg([78, 92], [58, 120], [70, 154])}
${leg([156, 92], [176, 118], [164, 154])}
<path d="M60 70c0-12 10-20 22-20h66c14 0 24 8 26 20l2 14c1 10-7 16-16 16H74c-9 0-15-6-14-15z" fill="url(#${id}m)" stroke="${EDGE}" stroke-width="1.5"/>
<path d="M70 58c20-4 54-5 80-1" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round" fill="none"/>
<path d="M84 64v28M100 62v30M116 62v30M132 63v29" stroke="#14161a" stroke-width="1.6" opacity=".7"/>
<rect x="88" y="72" width="34" height="10" rx="3" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="1.6"/>
<path d="M92 77h6" stroke="#ff3b30" stroke-width="2" stroke-linecap="round"/>
<path d="M74 54l-10-14M66 40l-4 2" stroke="url(#${id}v)" stroke-width="3" stroke-linecap="round"/>
${leg([90, 96], [72, 124], [92, 156])}
${leg([146, 96], [164, 124], [148, 156])}
<path d="M168 62l18-8c10-4 22 2 24 12l2 10c2 10-6 18-16 18h-22c-6 0-10-4-10-10z" fill="url(#${id}m)" stroke="${EDGE}" stroke-width="1.5"/>
<circle cx="196" cy="70" r="9" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="2.4"/>
${eye(id, 196, 70, 3.2)}
<circle cx="184" cy="82" r="4.2" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="1.6"/><circle cx="184" cy="82" r="1.6" fill="#ff3b30"/>
<circle cx="200" cy="86" r="3.6" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="1.4"/><circle cx="200" cy="86" r="1.3" fill="#ff3b30"/>
<circle cx="182" cy="66" r="2.8" fill="url(#${id}g)" stroke="url(#${id}v)" stroke-width="1.2"/>
<path d="M176 60c6-3 12-4 18-3" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round" fill="none"/>
<path d="M100 50l4-12h10l4 12" fill="url(#${id}d)" stroke="${EDGE}" stroke-width="1"/>
<rect x="102" y="32" width="14" height="7" rx="2" fill="url(#${id}v)" stroke="${EDGE}" stroke-width="1"/>`)
}
