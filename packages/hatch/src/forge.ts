/**
 * Gremlin Forge: the design language Claude writes robot bodies in, the house-style checker that keeps every
 * generated body in the Atomic Appliances product line, and the fixed prompts the board sends to the model APIs.
 * Shared by the board (which calls the models) and the site (which renders the result in 3D).
 */

export const FORGE_STYLE = 'atomic-appliances-3d/3'

export const FORGE_MATERIALS = ['enamel', 'accent', 'chrome', 'brass', 'copper', 'glass', 'glow', 'rubber', 'steel', 'ivory'] as const
export type ForgeMaterial = (typeof FORGE_MATERIALS)[number]
const PRIMS = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule'] as const
const EYES = ['dot', 'pill', 'bar', 'slit', 'ring', 'smile'] as const
const KINDS = ['lathe', 'tube', 'extrude', 'visor', 'eye', ...PRIMS] as const
type Kind = (typeof KINDS)[number]

export type Vec3 = [number, number, number]

/** Weathering the renderer paints on in noise-shaped spots, streaks or patches. */
export const FORGE_WEAR = ['rust', 'grime', 'soot', 'scratches', 'patina', 'chipped', 'oil'] as const
export const FORGE_WEAR_PATTERNS = ['spots', 'streaks', 'patches', 'bottom', 'all'] as const
export const FORGE_DECAL_FINISHES = ['paint', 'ink', 'sticker', 'etched', 'glow'] as const
export interface ForgeWear {
  kind: (typeof FORGE_WEAR)[number]
  amount: number
  pattern: (typeof FORGE_WEAR_PATTERNS)[number]
  scale: number
  seed: number
  /** Top-level wear only: limit it to these materials. */
  on?: ForgeMaterial[]
}
/** Artwork projected onto the body: an SVG from `art`, or a picture the person uploaded (`upload:<id>`, kept in the browser). */
export interface ForgeDecal {
  art?: string
  image?: string
  at: Vec3
  dir: Vec3
  size: number
  rot: number
  finish: (typeof FORGE_DECAL_FINISHES)[number]
  mirror?: 'x'
}
export interface ForgeArray { type: 'radial' | 'linear'; count: number; step?: Vec3 }
export interface ForgePart {
  kind: Kind
  mat?: ForgeMaterial
  pos: Vec3
  rot: Vec3
  scale?: Vec3
  mirror?: 'x'
  array?: ForgeArray
  /** lathe */
  profile?: [number, number][]
  /** tube */
  points?: Vec3[]
  radius?: number | [number, number]
  rings?: number
  /** extrude */
  shape?: [number, number][]
  depth?: number
  bevel?: boolean
  /** visor */
  w?: number
  h?: number
  /** eye */
  eye?: (typeof EYES)[number]
  /** primitives (sphere [r], box [w,h,d], cylinder [rTop,rBottom,h], cone [r,h], torus [R,tube], capsule [r,len]) and eye size [s] */
  size?: number[]
  arc?: number
  wear?: ForgeWear[]
  /** Added by a house rule rather than by the model. */
  house?: true
}
export interface ForgeSpec {
  name: string
  tagline: string
  menace: number
  palette: { enamel: string; accent: string; glow: string }
  parts: ForgePart[]
  wear?: ForgeWear[]
  art?: Record<string, string>
  decals?: ForgeDecal[]
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------

export const FORGE_LANGUAGE = `DESIGN LANGUAGE (JSON). Coordinates: +y up, the floor is y=0, the robot faces +z (toward the viewer), +x is the viewer's right. Make it about 2.4 tall (it will be rescaled to fit the studio) and under 3 wide.

Every part has "kind", optional "pos":[x,y,z] (default origin), "rot":[xDeg,yDeg,zDeg] (applied X then Y then Z), "scale":[sx,sy,sz], and these modifiers:
- "mirror":"x" adds a copy reflected across x=0. Build the right side once and mirror it.
- "array":{"type":"radial","count":n} repeats the part n times around the vertical axis through x=0,z=0 (legs, tentacles, rivets).
- "array":{"type":"linear","count":n,"step":[dx,dy,dz]} repeats it in a row (teeth, vents, ribs).

Kinds:
- "lathe": a surface of revolution around the vertical axis, for bodies, heads, domes, bells, cans, funnels. "profile":[[radius,y],...] from bottom to top, smoothly interpolated; start and end at radius 0 to close it. "mat" required.
- "tube": a smooth tube through "points":[[x,y,z],...] in world coordinates (ignores pos/rot), for arms, legs, tentacles, hoses, pipes, antennae, cables. "radius": a number, or [startRadius,endRadius] to taper. "rings": n adds n segment collars (gives tentacles and flex-hoses their segmented look). "mat" required.
- "extrude": a flat outline "shape":[[x,y],...] extruded along z by "depth", with rounded edges, for fins, blades, wings, ears, crests, plates, claws, signs. "mat" required.
- "sphere" size [r]; "box" size [w,h,d] (edges auto-rounded); "cylinder" size [rTop,rBottom,height] (axis y); "cone" size [r,height] (axis y, tip at +y); "torus" size [ringRadius,tubeRadius] (ring in the x/y plane; rotate [90,0,0] to lie flat), optional "arc" degrees; "capsule" size [r,straightLength] (axis y). "mat" required.
- "visor": the house glass visor with chrome bezel, "w" and "h" (a rounded slot; make w=h for a round porthole). Faces +z.
- "eye": a glowing light, "shape": dot|pill|bar|slit|ring|smile, "size". Place eyes just in front of a visor (visor z + about 0.075), or anywhere a lamp or indicator should glow.

Materials ("mat"): enamel (main body colour), accent (second enamel colour, sparingly), chrome, brass, copper, glass, glow, rubber, steel (dark gunmetal), ivory (dial faces, handles).
Palette: "palette":{"enamel":"#hex","accent":"#hex","glow":"#hex"}. Enamels are 1950s appliance colours: creams, pastels, mustard, rosso red, gunmetal, matte black.

HOUSE STYLE (what makes every gremlin part of one product line):
- 1950s kitchen-appliance industrial design: big soft rounded enamel volumes, chrome trim bands at seams, chrome tubes and tapered chrome legs, dials, knobs and vents, and a glass visor with glowing eyes as the face.
- Chunky, readable silhouettes. Nothing thinner than 0.015. Rounded rather than faceted.
- Scary designs keep the same materials and go further: more limbs, extruded blades and claws, jaws of chrome cones, clustered or slit eyes, dark enamel, red glow, smokestacks and exposed brass.
- Friendly designs: pill eyes and a smile, pastel enamel, few limbs.
- Mostly symmetric (use mirror). Parts should touch or overlap so nothing floats.
- Be inventive with the overall form; the description should drive the body plan. Use 15 to 70 parts.

SURFACES (optional; use them when the description asks for age, damage, dirt, markings, logos, tattoos or pictures, or when they clearly suit the character):
- "wear":[{"kind":k,"amount":0-1,"pattern":p,"scale":0.3-4,"on":["enamel",...]}] at the top level weathers the whole robot, or only the materials listed in "on". A part can carry its own "wear" list (without "on") to weather just that part.
  Kinds: rust (flaky orange-brown oxide), grime (brown dirt), soot (black), scratches (bright scuffs through the finish), patina (green verdigris, best on brass and copper), chipped (paint flaked off, showing bare steel), oil (glossy black stains).
  Patterns: spots (scattered blotches), streaks (runs and drips), patches (large soft areas), bottom (builds up toward the feet), all (an even film). Amount 0.15 is a hint, 0.4 is clearly weathered, 0.8 is derelict. "scale" above 1 makes the marks smaller and busier. Up to 4 top-level layers and 3 per part.
- "art":{"id":"<svg viewBox=...>...</svg>"} is vector artwork you draw yourself: logos, emblems, insignia, tattoos, stencilled numbers, hazard stripes, pin-striping, flash-tattoo motifs. Give each a viewBox and a transparent background; use flat, bold shapes and a small palette; no scripts, event handlers, external links or embedded images. Under 4000 characters each, at most 6 pieces. Text only when asked for, in font-family="Futura, Helvetica, Arial, sans-serif" with font-weight="bold".
- "decals":[{"art":"id","at":[x,y,z],"dir":[x,y,z],"size":w,"rot":deg,"finish":f,"mirror":"x"}] applies artwork to the body. "at" is a point on the surface (or just outside it), "dir" points outward from the surface there ([0,0,1] on the front, [1,0,0] on the right flank), "size" is the width in model units, "rot" spins it in degrees, "mirror":"x" puts a copy on the other side.
  Finishes: paint (a glossy painted graphic), ink (a tattoo inked into the enamel under the clear coat), sticker (a printed label), etched (engraved into metal; use it on chrome, brass or steel), glow (a neon sign or backlit emblem). Up to 12 decals.
- Pictures the person uploaded appear as {"image":"upload:<id>"} in place of "art". Keep them unless asked to remove them; you may move, resize or re-finish them.

Reply with only JSON: {"name":"1-3 words","tagline":"wry, at most 12 words","menace":0-10,"palette":{...},"parts":[...],"wear":[...],"art":{...},"decals":[...]} (the last three only when used)`

/** Built-in designs, in the wire format the model writes. Used as starting points and as few-shot examples. */
export const FORGE_EXAMPLES: Record<'toaster' | 'octopod' | 'foreman', unknown> = {
  toaster: { name: 'Toaster', tagline: 'Pops up, says hi, asks for nothing.', menace: 0,
    palette: { enamel: '#efe3c8', accent: '#c9302c', glow: '#ffb347' },
    parts: [
      { kind: 'lathe', mat: 'enamel', profile: [[0, 0.62], [0.36, 0.63], [0.48, 0.7], [0.52, 0.85], [0.53, 1.1], [0.51, 1.35], [0.44, 1.48], [0.3, 1.53], [0, 1.54]] },
      { kind: 'torus', mat: 'chrome', size: [0.535, 0.028], pos: [0, 1.1, 0], rot: [90, 0, 0] },
      { kind: 'cylinder', mat: 'chrome', size: [0.3, 0.33, 0.06], pos: [0, 0.63, 0] },
      { kind: 'cylinder', mat: 'chrome', size: [0.1, 0.1, 0.18], pos: [0, 1.6, 0] },
      { kind: 'capsule', mat: 'enamel', size: [0.36, 0.46], pos: [0, 1.98, 0], rot: [0, 0, 90] },
      { kind: 'sphere', mat: 'chrome', size: [0.085], pos: [0.6, 1.98, 0], mirror: 'x' },
      { kind: 'visor', w: 0.8, h: 0.44, pos: [0, 2.0, 0.3] },
      { kind: 'eye', shape: 'pill', size: 0.055, pos: [0.12, 2.02, 0.375], mirror: 'x' },
      { kind: 'eye', shape: 'smile', size: 0.075, pos: [0, 1.96, 0.372] },
      { kind: 'tube', mat: 'chrome', points: [[0, 2.3, 0], [0, 2.64, 0]], radius: 0.016 },
      { kind: 'sphere', mat: 'accent', size: [0.06], pos: [0, 2.67, 0] },
      { kind: 'tube', mat: 'chrome', points: [[0.46, 1.27, 0], [0.74, 1.19, 0.06], [0.82, 0.88, 0.14]], radius: 0.045, rings: 16, mirror: 'x' },
      { kind: 'sphere', mat: 'enamel', size: [0.1], pos: [0.82, 0.84, 0.14], mirror: 'x' },
      { kind: 'tube', mat: 'chrome', points: [[0.2, 0.66, 0], [0.33, 0.04, 0.02]], radius: [0.05, 0.03], mirror: 'x' },
      { kind: 'cylinder', mat: 'rubber', size: [0.075, 0.085, 0.04], pos: [0.33, 0.02, 0.02], mirror: 'x' },
      { kind: 'box', mat: 'steel', size: [0.34, 0.018, 0.06], pos: [0, 1.24, 0.49], array: { type: 'linear', count: 3, step: [0, 0.06, 0] } },
      { kind: 'cylinder', mat: 'chrome', size: [0.085, 0.09, 0.07], pos: [0, 0.86, 0.49], rot: [90, 0, 0] },
      { kind: 'eye', shape: 'dot', size: 0.03, pos: [0.22, 0.86, 0.47] },
    ],
    art: { starburst: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><g fill="#c9302c"><polygon points="0,-48 6,-10 0,-6 -6,-10"/><polygon points="0,48 6,10 0,6 -6,10"/><polygon points="-48,0 -10,6 -6,0 -10,-6"/><polygon points="48,0 10,6 6,0 10,-6"/></g><g fill="#e0ad55"><polygon points="30,-30 8,-3 3,-8"/><polygon points="-30,30 -8,3 -3,8"/><polygon points="-30,-30 -3,-8 -8,-3"/><polygon points="30,30 3,8 8,3"/></g><circle r="7" fill="#c9302c"/></svg>' },
    decals: [{ art: 'starburst', at: [0.37, 1.0, 0.37], dir: [0.7, 0, 0.7], size: 0.26, finish: 'paint', mirror: 'x' }] },
  octopod: { name: 'Octopod', tagline: 'Eight arms, all of them busy.', menace: 10,
    palette: { enamel: '#2b2b2e', accent: '#c9302c', glow: '#ff3b30' },
    parts: [
      { kind: 'lathe', mat: 'enamel', profile: [[0, 0.55], [0.5, 0.57], [0.7, 0.7], [0.78, 0.95], [0.78, 1.2], [0.74, 1.5], [0.62, 1.82], [0.42, 2.05], [0, 2.16]] },
      { kind: 'torus', mat: 'chrome', size: [0.742, 0.03], pos: [0, 0.78, 0], rot: [90, 0, 0] },
      { kind: 'sphere', mat: 'brass', size: [0.02], pos: [0, 0.83, 0.75], array: { type: 'radial', count: 28 } },
      { kind: 'visor', w: 0.8, h: 0.44, pos: [0, 1.45, 0.72] },
      { kind: 'eye', shape: 'dot', size: 0.045, pos: [0.09, 1.45, 0.8], mirror: 'x' },
      { kind: 'eye', shape: 'dot', size: 0.025, pos: [0.18, 1.51, 0.79], mirror: 'x' },
      { kind: 'eye', shape: 'dot', size: 0.022, pos: [0.05, 1.545, 0.795], mirror: 'x' },
      { kind: 'eye', shape: 'dot', size: 0.02, pos: [0, 1.36, 0.79] },
      { kind: 'box', mat: 'chrome', size: [0.62, 0.07, 0.14], pos: [0, 1.11, 0.8] },
      { kind: 'cone', mat: 'chrome', size: [0.034, 0.11], pos: [-0.27, 1.03, 0.84], rot: [180, 0, 0], array: { type: 'linear', count: 7, step: [0.09, 0, 0] } },
      { kind: 'cylinder', mat: 'steel', size: [0.2, 0.2, 0.05], pos: [0, 0.96, 0.785], rot: [90, 0, 0] },
      { kind: 'torus', mat: 'chrome', size: [0.2, 0.02], pos: [0, 0.96, 0.81] },
      { kind: 'cylinder', mat: 'brass', size: [0.1, 0.1, 0.03], pos: [-0.06, 0.98, 0.815], rot: [90, 0, 0] },
      { kind: 'cylinder', mat: 'brass', size: [0.065, 0.065, 0.03], pos: [0.09, 0.92, 0.82], rot: [90, 0, 0] },
      { kind: 'tube', mat: 'chrome', points: [[0.28, 0.6, 0.1], [0.62, 0.3, 0.25], [0.98, 0.07, 0.38], [1.25, 0.1, 0.47], [1.34, 0.3, 0.5], [1.22, 0.42, 0.46], [1.12, 0.34, 0.42]], radius: [0.09, 0.014], rings: 11, array: { type: 'radial', count: 6 } },
      { kind: 'tube', mat: 'chrome', points: [[0.25, 0.95, -0.3], [0.6, 1.3, -0.6], [0.72, 1.9, -0.7], [0.6, 2.35, -0.55], [0.45, 2.3, -0.42], [0.44, 2.12, -0.4]], radius: [0.085, 0.014], rings: 10, mirror: 'x' },
      { kind: 'cylinder', mat: 'brass', size: [0.07, 0.07, 0.9], pos: [0.42, 2.05, -0.3] },
      { kind: 'cylinder', mat: 'brass', size: [0.11, 0.09, 0.08], pos: [0.42, 2.54, -0.3] },
    ],
    wear: [{ kind: 'chipped', amount: 0.25, pattern: 'spots', on: ['enamel'] }, { kind: 'oil', amount: 0.3, pattern: 'streaks' }],
    art: { kraken: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="none" stroke="#e9dcc0" stroke-width="5" stroke-linecap="round"><path d="M50 52 C30 60 20 80 8 78"/><path d="M50 52 C70 60 80 80 92 78"/><path d="M50 56 C40 74 36 90 24 94"/><path d="M50 56 C60 74 64 90 76 94"/></g><path d="M50 8 C72 8 80 26 74 44 C70 54 30 54 26 44 C20 26 28 8 50 8Z" fill="#e9dcc0"/><circle cx="40" cy="32" r="6" fill="#c9302c"/><circle cx="60" cy="32" r="6" fill="#c9302c"/></svg>' },
    decals: [{ art: 'kraken', at: [0.55, 1.25, 0.55], dir: [0.72, 0, 0.7], size: 0.34, rot: -8, finish: 'ink', mirror: 'x' }] },
  foreman: { name: 'Foreman', tagline: 'Runs the boiler room. Keeps the pressure up.', menace: 3,
    palette: { enamel: '#a9d8c4', accent: '#c9302c', glow: '#ffb347' },
    parts: [
      { kind: 'lathe', mat: 'enamel', profile: [[0, 0.58], [0.4, 0.58], [0.44, 0.64], [0.44, 1.64], [0.4, 1.7], [0, 1.7]] },
      { kind: 'torus', mat: 'brass', size: [0.445, 0.034], pos: [0, 0.74, 0], rot: [90, 0, 0], array: { type: 'linear', count: 2, step: [0, 0.8, 0] } },
      { kind: 'sphere', mat: 'brass', size: [0.02], pos: [0, 1.6, 0.45], array: { type: 'radial', count: 28 } },
      { kind: 'cylinder', mat: 'chrome', size: [0.1, 0.1, 0.16], pos: [0, 1.76, 0] },
      { kind: 'sphere', mat: 'enamel', size: [0.5], pos: [0, 2.3, 0] },
      { kind: 'torus', mat: 'brass', size: [0.3, 0.05], pos: [0, 1.85, 0], rot: [90, 0, 0] },
      { kind: 'visor', w: 0.54, h: 0.54, pos: [0, 2.32, 0.44] },
      { kind: 'torus', mat: 'brass', size: [0.29, 0.05], pos: [0, 2.32, 0.46] },
      { kind: 'eye', shape: 'ring', size: 0.13, pos: [0, 2.32, 0.52] },
      { kind: 'eye', shape: 'dot', size: 0.08, pos: [0, 2.32, 0.52] },
      { kind: 'torus', mat: 'brass', size: [0.085, 0.022], pos: [0.24, 1.32, 0.43] },
      { kind: 'cylinder', mat: 'ivory', size: [0.08, 0.08, 0.02], pos: [0.24, 1.32, 0.42], rot: [90, 0, 0] },
      { kind: 'tube', mat: 'chrome', points: [[0.38, 1.44, 0], [0.7, 1.3, 0.06], [0.8, 0.96, 0.14]], radius: 0.05, mirror: 'x' },
      { kind: 'torus', mat: 'chrome', size: [0.1, 0.024], arc: 170, pos: [0.8, 0.86, 0.14], rot: [0, 0, 90], mirror: 'x' },
      { kind: 'torus', mat: 'chrome', size: [0.1, 0.024], arc: 170, pos: [0.8, 0.86, 0.14], rot: [0, 0, -80], mirror: 'x' },
      { kind: 'tube', mat: 'chrome', points: [[0.18, 0.62, 0], [0.3, 0.04, 0.02]], radius: [0.05, 0.03], mirror: 'x' },
      { kind: 'cylinder', mat: 'rubber', size: [0.075, 0.085, 0.04], pos: [0.3, 0.02, 0.02], mirror: 'x' },
      { kind: 'cylinder', mat: 'copper', size: [0.07, 0.07, 1.0], pos: [0.36, 2.15, -0.3] },
      { kind: 'cylinder', mat: 'copper', size: [0.11, 0.09, 0.08], pos: [0.36, 2.69, -0.3] },
    ],
    wear: [{ kind: 'rust', amount: 0.22, pattern: 'spots', on: ['enamel'] }, { kind: 'soot', amount: 0.5, pattern: 'streaks', on: ['copper'] }, { kind: 'patina', amount: 0.3, pattern: 'patches', on: ['brass'] }],
    art: { number: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 70"><text x="60" y="58" text-anchor="middle" font-family="Futura, Helvetica, Arial, sans-serif" font-weight="bold" font-size="64" fill="#c9302c">07</text></svg>' },
    decals: [{ art: 'number', at: [-0.2, 1.05, 0.39], dir: [-0.45, 0, 0.89], size: 0.24, finish: 'paint' }] },
}

export const FORGE_TEXT_LIMIT = 1500

/** The full prompt for a new design or a change. Built server-side so the board's API key only ever designs gremlins. */
export function forgeDesignPrompt(mode: 'new' | 'refine', text: string, current?: ForgeSpec, uploads: ForgeUpload[] = []): string {
  const ask = text.slice(0, FORGE_TEXT_LIMIT)
  const ups = checkUploads(uploads)
  const pics = ups.length
    ? `\n\nThe person has uploaded these pictures, which you can place as decals with "image":"upload:<id>": ${ups.map((u) => `upload:${u.id} (${JSON.stringify(u.label)})`).join(', ')}.`
    : ''
  if (mode === 'refine' && current) {
    const spec = forgeSpecToWire(current)
    return `You design robot "gremlins" as 3D models for a character forge.\n\n${FORGE_LANGUAGE}\n\nCURRENT DESIGN:\n${JSON.stringify(spec)}${pics}\n\nApply this change and return the complete updated design. Keep everything the change doesn't touch.\n"""${ask}"""`
  }
  const examples = `EXAMPLE (a benign design):\n${JSON.stringify(FORGE_EXAMPLES.toaster)}\n\nEXAMPLE (a terrifying design):\n${JSON.stringify(FORGE_EXAMPLES.octopod)}`
  return `You design robot "gremlins" as 3D models for a character forge.\n\n${FORGE_LANGUAGE}\n\n${examples}\n\nDesign a new, original gremlin from this description. Don't copy the examples; invent a body plan that fits.${pics}\n"""${ask}"""`
}

/** Fixed instruction for turning the studio render into a photograph. No user text goes into it. */
export const FORGE_PHOTO_PROMPT = [
  'Turn this 3D render into a photorealistic studio product photograph of the same robot.',
  'Keep its exact silhouette, proportions, pose and camera angle, and every part in the same place: do not add, remove or redesign anything.',
  'Keep its colours. Materials: glossy clear-coated 1950s appliance enamel with a faint orange-peel texture, mirror-polished chrome reflecting a large softbox, warm polished brass and copper, black rubber, a dark glass visor with its eyes glowing from within and lighting the bezel.',
  'Shot on a medium-format camera with an 80mm lens: soft key light from the upper left, a gentle rim light from behind right, a seamless warm-grey paper backdrop, a soft contact shadow on the floor, shallow depth of field, crisp focus on the face.',
  'Keep every surface marking exactly where and how it appears: rust, grime, soot, scratches, chipped paint, oil stains, painted graphics, logos, numbers, tattoos and stickers, rendered as real physical finishes (flaky oxidised rust, inked tattoos under the clear coat, engraving in metal). Do not add any markings, text or logos that are not already on it.',
  'No people, no props.',
].join(' ')

// ---------------------------------------------------------------------------------------------------------------
// House-style checker (pure: runs on the board and in the browser)
// ---------------------------------------------------------------------------------------------------------------

const num = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const vec3 = (a: unknown, lo: number, hi: number, d: number): Vec3 => {
  const arr = Array.isArray(a) ? a : []
  return [num(arr[0], lo, hi, d), num(arr[1], lo, hi, d), num(arr[2], lo, hi, d)]
}
const pairs = (a: unknown, max: number, lo: number, hi: number, loY: number, hiY: number): [number, number][] =>
  (Array.isArray(a) ? a : []).slice(0, max).map((pt) => {
    const p = Array.isArray(pt) ? pt : []
    return [num(p[0], lo, hi, 0), num(p[1], loY, hiY, 0)] as [number, number]
  })

function hexToHsl(hex: unknown): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}
function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l)
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
function gamut(hex: unknown, sMin: number, sMax: number, lMin: number, lMax: number, fallback: string) {
  const hsl = hexToHsl(hex)
  if (!hsl) return { hex: fallback, changed: true }
  const [h, s, l] = hsl
  const s2 = Math.min(sMax, Math.max(sMin, s)), l2 = Math.min(lMax, Math.max(lMin, l))
  const changed = Math.abs(s2 - s) > 0.04 || Math.abs(l2 - l) > 0.04
  return { hex: changed ? hslToHex(h, s2, l2) : '#' + String(hex).replace('#', '').toLowerCase(), changed }
}

// ------------------------------------------------------------------------------------------------ surfaces

export interface ForgeUpload { id: string; label: string }
const UPLOAD_ID = /^[a-z0-9-]{1,24}$/
/** The person's uploaded pictures as the prompt may name them (the pictures themselves never leave the browser). */
export function checkUploads(raw: unknown): ForgeUpload[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 6).flatMap((u) => {
    const r = (u ?? {}) as Record<string, unknown>
    const id = String(r.id ?? '')
    if (!UPLOAD_ID.test(id)) return []
    return [{ id, label: String(r.label ?? 'picture').replace(/[\u0000-\u001f"`\\]/g, ' ').trim().slice(0, 60) || 'picture' }]
  })
}

export const FORGE_ART_MAX_CHARS = 4000
const ART_MAX_PIECES = 6
const ART_ID = /^[A-Za-z][\w-]{0,23}$/
const SVG_BANNED = /<\s*\/?\s*(script|foreignObject|iframe|image|img|object|embed|audio|video|animate\w*|set|a|style)\b|\bon[a-z]+\s*=|javascript:|@import|<!ENTITY|<!DOCTYPE/i
const SVG_EXTERNAL = /\b(?:xlink:)?(?:href|src)\s*=\s*(?!["']?#)|url\(\s*(?!["']?#)/i

/**
 * Accepts model-drawn SVG artwork only when it is self-contained: no scripts, handlers, embedded documents, external
 * references or stylesheets (the renderer draws it through an <img>, which also sandboxes it). Returns null to drop it.
 */
export function checkArtSvg(raw: unknown): string | null {
  let s = String(raw ?? '').trim().replace(/^<\?xml[^>]*\?>\s*/i, '')
  if (s.length > FORGE_ART_MAX_CHARS || !/^<svg[\s>]/i.test(s) || !/<\/svg>$/i.test(s)) return null
  if (SVG_BANNED.test(s) || SVG_EXTERNAL.test(s.replace(/xmlns(:\w+)?\s*=\s*["'][^"']*["']/g, ''))) return null
  if (!/^<svg[^>]*\sxmlns\s*=/i.test(s)) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return s
}

const WEAR_DEFAULT_PATTERN: Record<ForgeWear['kind'], ForgeWear['pattern']> = {
  rust: 'spots', grime: 'bottom', soot: 'streaks', scratches: 'patches', patina: 'patches', chipped: 'spots', oil: 'streaks',
}
function checkWear(raw: unknown, max: number, topLevel: boolean, salt: number): { wear: ForgeWear[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const wear: ForgeWear[] = []
  let dropped = 0
  for (const [i, item] of list.entries()) {
    const w = (item ?? {}) as Record<string, unknown>
    const kind = String(w.kind ?? '').toLowerCase() as ForgeWear['kind']
    if (!(FORGE_WEAR as readonly string[]).includes(kind) || wear.length >= max) { dropped++; continue }
    const pat = String(w.pattern ?? '').toLowerCase() as ForgeWear['pattern']
    const q: ForgeWear = {
      kind,
      amount: num(w.amount, 0, 1, 0.35),
      pattern: (FORGE_WEAR_PATTERNS as readonly string[]).includes(pat) ? pat : WEAR_DEFAULT_PATTERN[kind],
      scale: num(w.scale, 0.3, 4, 1),
      seed: Math.round(num(w.seed, 0, 999, (salt * 37 + i * 101) % 1000)),
    }
    if (topLevel && Array.isArray(w.on)) {
      const on = w.on.map((m) => String(m).toLowerCase()).filter((m): m is ForgeMaterial => (FORGE_MATERIALS as readonly string[]).includes(m) && m !== 'glow')
      if (on.length) q.on = [...new Set(on)]
    }
    if (q.amount > 0) wear.push(q)
  }
  return { wear, dropped }
}

function unit(a: unknown, d: Vec3): Vec3 {
  const v = vec3(a, -1, 1, 0), l = Math.hypot(v[0], v[1], v[2])
  const k = Math.abs(l - 1) < 1e-3 ? 1 : l
  const r = (x: number) => Math.round((x / k) * 1e4) / 1e4 // rounded so a second check gives the same numbers
  return l > 1e-3 ? [r(v[0]), r(v[1]), r(v[2])] : d
}

function checkSurfaces(r: Record<string, unknown>, notes: string[]): Pick<ForgeSpec, 'wear' | 'art' | 'decals'> {
  const out: Pick<ForgeSpec, 'wear' | 'art' | 'decals'> = {}
  const { wear, dropped: wd } = checkWear(r.wear, 4, true, 7)
  if (wear.length) out.wear = wear
  if (wd) notes.push(`${wd} weathering layer${wd > 1 ? 's' : ''} outside the design language removed.`)

  const art: Record<string, string> = {}
  let artDropped = 0
  if (r.art && typeof r.art === 'object' && !Array.isArray(r.art)) {
    for (const [id, svg] of Object.entries(r.art as Record<string, unknown>)) {
      const ok = ART_ID.test(id) && Object.keys(art).length < ART_MAX_PIECES ? checkArtSvg(svg) : null
      if (ok) art[id] = ok
      else artDropped++
    }
  }
  if (artDropped) notes.push(`${artDropped} piece${artDropped > 1 ? 's' : ''} of artwork removed: artwork must be a small, self-contained SVG.`)

  const decals: ForgeDecal[] = []
  let decalDropped = 0
  for (const item of (Array.isArray(r.decals) ? r.decals : []).slice(0, 24)) {
    const d = (item ?? {}) as Record<string, unknown>
    const artId = typeof d.art === 'string' && art[d.art] ? d.art : undefined
    const image = typeof d.image === 'string' && /^upload:[a-z0-9-]{1,24}$/.test(d.image) ? d.image : undefined
    if ((!artId && !image) || decals.length >= 12) { decalDropped++; continue }
    const at = vec3(d.at, -4, 6, 0)
    const flat = Math.hypot(at[0], at[2])
    const fin = String(d.finish ?? '').toLowerCase() as ForgeDecal['finish']
    const q: ForgeDecal = {
      at,
      dir: unit(d.dir ?? (flat > 0.05 ? [at[0], 0, at[2]] : undefined), [0, 0, 1]),
      size: num(d.size, 0.04, 1.6, 0.3),
      rot: num(d.rot, -360, 360, 0),
      finish: (FORGE_DECAL_FINISHES as readonly string[]).includes(fin) ? fin : 'paint',
    }
    if (artId) q.art = artId
    else q.image = image
    if (d.mirror === 'x') q.mirror = 'x'
    decals.push(q)
  }
  if (decalDropped) notes.push(`${decalDropped} decal${decalDropped > 1 ? 's' : ''} without usable artwork removed.`)
  if (decals.length) out.decals = decals
  // keep only artwork a decal uses
  const used = new Set(decals.flatMap((d) => (d.art ? [d.art] : [])))
  const kept = Object.fromEntries(Object.entries(art).filter(([id]) => used.has(id)))
  if (Object.keys(kept).length) out.art = kept
  return out
}

/** Most meshes a design may expand to (after mirror and array). */
export const FORGE_MAX_MESHES = 600

/**
 * Validates a design against the language, clamps every number, pulls colours into the house range and drops what it
 * can't use. Returns the cleaned spec plus a plain-English note per fix. Throws when nothing usable is left.
 * The geometric house rules (a face, chrome trim) need the built shape and run in the renderer.
 */
export function checkForgeSpec(raw: unknown): { spec: ForgeSpec; notes: string[] } {
  const notes: string[] = []
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.parts)) throw new Error('The design came back without any parts.')
  const pal = (r.palette ?? {}) as Record<string, unknown>
  const en = gamut(pal.enamel, 0, 0.62, 0.15, 0.88, '#efe3c8')
  const ac = gamut(pal.accent, 0, 0.75, 0.2, 0.8, '#c9302c')
  const gl = gamut(pal.glow, 0.7, 1, 0.5, 0.7, '#ffb347')
  if (en.changed) notes.push('Enamel colour toned into the house enamel range.')
  if (ac.changed) notes.push('Accent colour toned into the house range.')
  if (gl.changed) notes.push('Glow colour brightened to read as a light.')

  const parts: ForgePart[] = []
  let dropped = 0, remat = 0, meshes = 0
  for (const item of (r.parts as unknown[]).slice(0, 120)) {
    const p = item as Record<string, unknown> | null
    if (!p || !(KINDS as readonly string[]).includes(String(p.kind))) { dropped++; continue }
    const kind = p.kind as Kind
    const q: ForgePart = { kind, pos: vec3(p.pos, -4, 6, 0), rot: vec3(p.rot, -720, 720, 0) }
    if (kind !== 'visor' && kind !== 'eye') {
      const m = String(p.mat ?? '').toLowerCase()
      if ((FORGE_MATERIALS as readonly string[]).includes(m)) q.mat = m as ForgeMaterial
      else { q.mat = 'chrome'; remat++ }
    }
    if (p.scale) q.scale = vec3(p.scale, 0.05, 6, 1)
    if (kind === 'lathe') {
      const pts = pairs(p.profile, 40, 0, 2.5, -1, 5)
      if (pts.length < 2) { dropped++; continue }
      q.profile = pts
    } else if (kind === 'tube') {
      const pts = (Array.isArray(p.points) ? p.points : []).slice(0, 16).map((pt) => vec3(pt, -4, 6, 0))
      if (pts.length < 2) { dropped++; continue }
      q.points = pts
      q.radius = Array.isArray(p.radius)
        ? [num(p.radius[0], 0.015, 0.5, 0.05), num(p.radius[1], 0.008, 0.5, 0.03)]
        : num(p.radius, 0.015, 0.5, 0.04)
      if (p.rings) q.rings = Math.round(num(p.rings, 0, 40, 0))
    } else if (kind === 'extrude') {
      const pts = pairs(p.shape, 48, -3, 3, -3, 3)
      if (pts.length < 3) { dropped++; continue }
      q.shape = pts
      q.depth = num(p.depth, 0.01, 0.6, 0.05)
      q.bevel = p.bevel !== false
    } else if (kind === 'visor') {
      q.w = num(p.w, 0.2, 1.4, 0.8)
      q.h = num(p.h, 0.12, 0.8, 0.44)
    } else if (kind === 'eye') {
      // accepts the wire form ({shape, size}) and the checked form ({eye, size: [s]})
      const shape = String(p.shape ?? p.eye)
      q.eye = (EYES as readonly string[]).includes(shape) ? (shape as ForgePart['eye']) : 'dot'
      q.size = [num(Array.isArray(p.size) ? p.size[0] : p.size, 0.012, 0.3, 0.05)]
    } else {
      const need = { sphere: 1, box: 3, cylinder: 3, cone: 2, torus: 2, capsule: 2 }[kind]
      const s = Array.isArray(p.size) ? p.size : []
      q.size = Array.from({ length: need }, (_, i) => num(s[i], 0.008, 2.5, 0.05))
      if (kind === 'torus' && p.arc != null) q.arc = num(p.arc, 10, 360, 360)
    }
    if (p.wear && kind !== 'eye') {
      const { wear } = checkWear(p.wear, 3, false, parts.length + 1)
      if (wear.length) q.wear = wear
    }
    if (p.mirror === 'x') q.mirror = 'x'
    if (p.array && typeof p.array === 'object') {
      const a = p.array as Record<string, unknown>
      const type = a.type === 'linear' ? 'linear' : 'radial'
      q.array = { type, count: Math.round(num(a.count, 1, 32, 1)) }
      if (type === 'linear') q.array.step = vec3(a.step, -2, 2, 0)
    }
    const copies = (q.mirror ? 2 : 1) * (q.array ? q.array.count : 1)
    if (meshes + copies > FORGE_MAX_MESHES) { dropped++; continue }
    meshes += copies
    parts.push(q)
  }
  if (!parts.length) throw new Error('Nothing buildable was left after the style check.')
  if (dropped) notes.push(`${dropped} part${dropped > 1 ? 's' : ''} outside the design language removed.`)
  if (remat) notes.push(`${remat} unknown material${remat > 1 ? 's' : ''} switched to chrome.`)
  return {
    spec: {
      name: String(r.name ?? 'Unnamed gremlin').slice(0, 40),
      tagline: String(r.tagline ?? '').slice(0, 110),
      menace: Math.round(num(r.menace, 0, 10, 3)),
      palette: { enamel: en.hex, accent: ac.hex, glow: gl.hex },
      parts,
      ...checkSurfaces(r, notes),
    },
    notes,
  }
}

/** A checked spec back in the wire format the model writes (eyes use `shape` and a scalar `size`; house parts dropped). */
export function forgeSpecToWire(spec: ForgeSpec): unknown {
  return {
    ...spec,
    parts: spec.parts.filter((p) => !p.house).map(({ house: _h, eye, ...p }) =>
      p.kind === 'eye' ? { ...p, shape: eye, size: p.size?.[0] } : p),
  }
}

/**
 * Pulls one JSON value out of a model reply: the whole reply, else a fenced block, else the text from the first `{`
 * to the last `}`. Throws when none parses.
 */
export function parseModelJson(text: string): unknown {
  const tries = [text.trim()]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence?.[1]) tries.push(fence[1].trim())
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1))
  for (const t of tries) {
    try { return JSON.parse(t) } catch { /* next */ }
  }
  throw new Error('The design did not come back as JSON.')
}
