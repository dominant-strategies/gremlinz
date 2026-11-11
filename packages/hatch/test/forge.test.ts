import { describe, expect, it } from 'vitest'
import { FORGE_EXAMPLES, checkForgeSpec, checkStory, curlPoints, forgePose, forgeShotAt, forgeSpecToWire, forgeTour, forgeTourAt, type Vec3 } from '../src/forge.js'

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('forge spec v4: assemblies and modes', () => {
  it('puts a v3 design into one body assembly with an idle mode', () => {
    const { spec, notes } = checkForgeSpec(FORGE_EXAMPLES.foreman)
    expect(spec.assemblies?.map((a) => a.id)).toEqual(['body'])
    expect(spec.modes?.map((m) => m.id)).toEqual(['idle'])
    expect(spec.parts.every((p) => p.asm === 'body')).toBe(true)
    expect(notes.join(' ')).not.toMatch(/assembl/)
  })

  it('keeps the octopod example whole: five assemblies, three modes, chains and rivets', () => {
    const { spec, notes } = checkForgeSpec(FORGE_EXAMPLES.octopod)
    expect(notes).toEqual([])
    expect(spec.assemblies?.map((a) => a.id)).toEqual(['mantle', 'optics', 'jaw', 'arms', 'stacks'])
    expect(spec.modes?.map((m) => m.id)).toEqual(['idle', 'strike', 'vent', 'jet'])
    expect(spec.modes?.map((m) => m.when)).toEqual([undefined, 'posting', 'thinking', 'earning'])
    const arm = spec.parts.find((p) => p.kind === 'chain' && p.asm === 'arms')!
    expect(arm).toMatchObject({ link: 'drum', count: 22, radius: [0.09, 0.022] })
    expect(spec.parts[0]!.rivets).toEqual([{ y: 1.25, count: 36, mat: 'brass' }, { y: 1.85, count: 24, mat: 'steel' }])
    expect(spec.parts[0]!.seams).toEqual([1.2, 1.62])
  })

  it('moves parts naming an unknown assembly into the body and drops empty modes', () => {
    const raw = {
      palette: { enamel: '#efe3c8', accent: '#c9302c', glow: '#ffb347' },
      assemblies: [{ id: 'head', name: 'Head', joint: { move: 'swing', axis: [0, 3, 0], range: 999 } }, { id: 'head' }, { id: 'Bad Id' }],
      modes: [{ id: 'nod', drive: { head: 2 } }, { id: 'ghost', drive: { tail: 1 } }, { id: 'idle', drive: { head: 1 } }],
      parts: [
        { kind: 'sphere', mat: 'enamel', size: [0.5], pos: [0, 2, 0], asm: 'head' },
        { kind: 'box', mat: 'steel', size: [0.5, 0.5, 0.5], pos: [0, 1, 0], asm: 'torso' },
      ],
    }
    const { spec, notes } = checkForgeSpec(raw)
    expect(spec.assemblies?.map((a) => a.id)).toEqual(['body', 'head'])
    expect(spec.parts[1]!.asm).toBe('body')
    const head = spec.assemblies!.find((a) => a.id === 'head')!
    expect(head.joint).toEqual({ move: 'swing', pivot: [0, 0, 0], axis: [0, 1, 0], range: 180 })
    expect(head.explode[1]).toBeGreaterThan(0) // default explode points away from the body's centre
    expect(spec.modes).toEqual([{ id: 'idle', name: 'Idle', drive: {} }, { id: 'nod', name: 'nod', drive: { head: 1 } }])
    expect(notes.join(' ')).toMatch(/2 assemblies/)
    expect(notes.join(' ')).toMatch(/unknown assembly/)
    expect(notes.join(' ')).toMatch(/1 operating mode that/)
  })

  it('clamps chains', () => {
    const { spec } = checkForgeSpec({ parts: [{ kind: 'chain', mat: 'chrome', points: [[0, 0, 0], [1, 1, 1]], count: 500, link: 'spiky' }] })
    expect(spec.parts[0]).toMatchObject({ kind: 'chain', count: 48, link: 'drum', radius: 0.05 })
  })

  it('round-trips through the wire format unchanged', () => {
    for (const ex of Object.values(FORGE_EXAMPLES)) {
      const { spec } = checkForgeSpec(ex)
      expect(checkForgeSpec(forgeSpecToWire(spec)).spec).toEqual(spec)
    }
  })
})

describe('forgePose', () => {
  const { spec } = checkForgeSpec(FORGE_EXAMPLES.octopod)

  it('drives every assembly in a mode from one input', () => {
    const rest = forgePose(spec, { mode: 'strike', input: 0, idle: false })
    expect(rest.arms).toMatchObject({ value: 0, status: 'READY', active: false })
    const full = forgePose(spec, { mode: 'strike', input: 1, idle: false })
    expect(full.arms).toMatchObject({ value: 140, drive: 1, status: 'STRIKING', active: true })
    expect(full.jaw).toMatchObject({ value: 0.14, status: 'BITING' })
    expect(full.optics!.value).toBeCloseTo(12)
    expect(full.stacks).toMatchObject({ value: 0, active: false })
  })

  it('explodes each assembly along its own vector', () => {
    const p = forgePose(spec, { explode: 1, idle: false })
    expect(p.mantle!.offset).toEqual([0, 0.7, -0.2])
    expect(forgePose(spec, { explode: 0 }).mantle!.offset).toEqual([0, 0, 0])
  })

  it('is a pure function of its input, with idle motion from the clock', () => {
    const a = forgePose(spec, { mode: 'vent', input: 0.4, t: 3.2 })
    expect(forgePose(spec, { mode: 'vent', input: 0.4, t: 3.2 })).toEqual(a)
    expect(forgePose(spec, { t: 1 }).arms!.value).not.toEqual(forgePose(spec, { t: 2 }).arms!.value)
  })
})

describe('curlPoints', () => {
  const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]

  it('keeps every segment length and the root fixed', () => {
    const out = curlPoints(pts, [0, 0, 1], 180)
    expect(out[0]).toEqual([0, 0, 0])
    for (let i = 1; i < pts.length; i++) expect(dist(out[i]!, out[i - 1]!)).toBeCloseTo(1)
    expect(out[3]![1]).toBeGreaterThan(0.5) // curls up toward +y about +z
  })

  it('leaves the limb alone at zero', () => {
    expect(curlPoints(pts, [0, 0, 1], 0)).toEqual(pts)
  })
})

describe('forgeTour', () => {
  const { spec } = checkForgeSpec(FORGE_EXAMPLES.octopod)
  const beats = forgeTour(spec)
  const total = beats.at(-1)!.at + beats.at(-1)!.dur

  it('opens on the hero, gives each mode its own take, explodes, and ends on the hero', () => {
    expect(beats[0]).toMatchObject({ at: 0, mode: 'idle', label: 'Hero' })
    expect(beats.at(-1)!.label).toBe('Hero')
    expect(beats.map((b) => b.label)).toEqual(expect.arrayContaining(['Strike', 'Vent', 'Jet', 'Exploded']))
    for (let i = 1; i < beats.length; i++) expect(beats[i]!.at).toBeCloseTo(beats[i - 1]!.at + beats[i - 1]!.dur)
  })

  it('never shows the same thing twice: each mode from its own angle with its own treatment', () => {
    const modeTakes = ['strike', 'vent', 'jet'].map((id) => beats.find((b) => b.mode === id && b.input[1] === 1 && b.input[0] === 1)!)
    const angles = modeTakes.map((b) => `${b.shot.az},${b.shot.el}`)
    expect(new Set(angles).size).toBe(3)
    expect(modeTakes.map((b) => [b.look.isolate, b.look.xray, b.look.labels])).toEqual([[true, false, 'focus'], [false, true, 'none'], [false, false, 'all']])
  })

  it('moves the camera without jumps, across beats and round the loop', () => {
    const aim = (t: number) => { const s = forgeShotAt(beats, t); const k = s.k; return { az: s.from.az + (s.to.az - s.from.az) * k, el: s.from.el + (s.to.el - s.from.el) * k, dist: s.from.dist + (s.to.dist - s.from.dist) * k } }
    for (const b of [...beats.slice(1), { at: total }]) {
      const a = aim(b.at - 1e-4), c = aim(b.at + 1e-4)
      expect(Math.abs(a.az - c.az)).toBeLessThan(0.01)
      expect(Math.abs(a.el - c.el)).toBeLessThan(0.01)
      expect(Math.abs(a.dist - c.dist)).toBeLessThan(0.01)
    }
  })

  it('seeks to any time and loops, with the beat\'s look', () => {
    const hold = beats.find((b) => b.mode === 'strike' && b.input[0] === 1 && b.input[1] === 1)!
    expect(forgeTourAt(beats, hold.at + 0.5)).toMatchObject({ mode: 'strike', input: 1, explode: 0, isolate: 'jaw', labels: 'focus' })
    expect(forgeTourAt(beats, hold.at + 0.5 + total)).toMatchObject({ mode: 'strike', input: 1 })
    const xr = beats.find((b) => b.mode === 'vent' && b.input[0] === 1)!
    expect(forgeTourAt(beats, xr.at + 0.5)).toMatchObject({ xray: true, isolate: null })
    expect(forgeTourAt([], 5)).toMatchObject({ mode: 'idle', input: 0 })
  })
})

describe('forge prompts', () => {
  it('asks for the reviewer checklist in every design, and a reference note only with a picture', async () => {
    const { forgeDesignPrompt, forgeCritiquePrompt } = await import('../src/forge.js')
    const plain = forgeDesignPrompt('new', 'a toaster')
    expect(plain).toContain('BEFORE YOU ANSWER')
    expect(plain).not.toContain('REFERENCE PICTURE')
    const withRef = forgeDesignPrompt('new', 'a toaster', undefined, [], { reference: true })
    expect(withRef).toContain('REFERENCE PICTURE')
    expect(withRef).toContain('Never copy names, logos')
    const { spec } = checkForgeSpec(FORGE_EXAMPLES.octopod)
    const review = forgeCritiquePrompt(spec, ['At rest', 'Strike at full drive'])
    expect(review).toContain('1. At rest; 2. Strike at full drive')
    expect(review).toContain('"fixed"')
  })
})

describe('mode activities', () => {
  it('keeps one mode per live activity and drops unknown ones', () => {
    const raw = { assemblies: [{ id: 'head', joint: { move: 'swing', axis: [0, 1, 0], range: 30 } }], parts: [{ kind: 'sphere', mat: 'enamel', size: [0.5], asm: 'head' }],
      modes: [{ id: 'nod', drive: { head: 1 }, when: 'Thinking' }, { id: 'shake', drive: { head: -1 }, when: 'thinking' }, { id: 'wave', drive: { head: 0.5 }, when: 'dancing' }] }
    const { spec } = checkForgeSpec(raw)
    expect(spec.modes!.map((m) => [m.id, m.when])).toEqual([['idle', undefined], ['nod', 'thinking'], ['shake', undefined], ['wave', undefined]])
  })
})

describe('per-part unwear', () => {
  it('keeps known whole-robot wear kinds a part opts out of, and drops the rest', () => {
    const raw = { wear: [{ kind: 'rust', amount: 0.4 }], parts: [{ kind: 'sphere', mat: 'enamel', size: [0.5], unwear: ['rust', 'rust', 'glitter', 'OIL'] }, { kind: 'eye', shape: 'dot', size: 0.05, unwear: ['rust'] }] }
    const { spec } = checkForgeSpec(raw)
    expect(spec.parts[0]!.unwear).toEqual(['rust', 'oil'])
    expect(spec.parts[1]!.unwear).toBeUndefined()
    expect(checkForgeSpec(forgeSpecToWire(spec)).spec).toEqual(spec)
  })
})

describe('the film tells what it lives for', () => {
  const sp = () => checkForgeSpec(structuredClone(FORGE_EXAMPLES.octopod)).spec
  it('every example carries a story, and the default film has a goals card and a motive card', () => {
    for (const ex of Object.values(FORGE_EXAMPLES)) expect(checkForgeSpec(structuredClone(ex)).spec.story?.goals.length).toBeGreaterThan(0)
    const beats = forgeTour(sp())
    const cards = beats.filter((b) => b.card)
    expect(cards.map((b) => b.card)).toEqual(['goals', 'motive'])
    expect(beats[1]!.card).toBe('goals') // right after the opening shot
    expect(beats[beats.length - 2]!.card).toBe('motive') // right before the finale
    expect(cards[0]!.lines).toEqual(sp().story!.goals)
    expect(cards[0]!.shot.side).toBeGreaterThan(0)
    expect(cards[1]!.shot.side).toBeLessThan(0)
  })
  it('cards fade in and out, and give their words', () => {
    const beats = forgeTour(sp()), g = beats.find((b) => b.card === 'goals')!
    expect(forgeTourAt(beats, g.at + 0.05).cardIn).toBe(0)
    const mid = forgeTourAt(beats, g.at + g.dur / 2)
    expect(mid).toMatchObject({ card: 'goals', cardIn: 1, lines: sp().story!.goals })
    expect(forgeTourAt(beats, g.at + g.dur - 0.01).cardIn).toBeLessThan(0.1)
  })
  it('a story from outside (its signed config) wins, and a story-less design has no cards', () => {
    const beats = forgeTour(sp(), { goals: ['Map every wreck in the North Sea'], motive: 'The sea keeps secrets; it does not.' })
    expect(beats.find((b) => b.card === 'goals')!.lines).toEqual(['Map every wreck in the North Sea'])
    const { story: _s, ...bare } = sp()
    expect(forgeTour(bare as typeof bare).some((b) => b.card)).toBe(false)
  })
  it('checks stories: trims, drops markup, needs both unless told otherwise', () => {
    expect(checkStory({ goals: ['  a <b>goal</b>  '], motive: 'why' })).toEqual({ goals: ['a b goal /b'], motive: 'why' })
    expect(checkStory({ goals: ['x'] })).toBeNull()
    expect(checkStory({ goals: ['x'] }, true)).toEqual({ goals: ['x'], motive: '' })
    expect(checkStory({ goals: ['1', '2', '3', '4'], motive: 'm' })!.goals).toHaveLength(3)
  })
})

describe('cutting the film', () => {
  const sp = () => checkForgeSpec(structuredClone(FORGE_EXAMPLES.octopod)).spec
  it('plays only the chosen modes, goals and extras', () => {
    const s = sp(), [first] = s.modes!.filter((m) => m.id !== 'idle')
    const beats = forgeTour(s, s.story, { modes: [first!.id], goals: [s.story!.goals[1]!], motive: false, exploded: false })
    expect(new Set(beats.filter((b) => b.mode !== 'idle').map((b) => b.mode))).toEqual(new Set([first!.id]))
    expect(beats.find((b) => b.card === 'goals')!.lines).toEqual([s.story!.goals[1]])
    expect(beats.some((b) => b.card === 'motive' || b.label === 'Exploded')).toBe(false)
  })
  it('spotlights an assembly alone, at rest, with its label', () => {
    const s = sp(), a = s.assemblies!.find((x) => x.id !== 'body')!
    const beats = forgeTour(s, s.story, { spotlight: [a.id] })
    const b = beats.find((x) => x.label === `Spotlight: ${a.name}`)!
    expect(b).toMatchObject({ focus: a.id, spot: true, look: { isolate: true, labels: 'focus' } })
    expect(forgeTourAt(beats, b.at + 1).isolate).toBe(a.id)
  })
  it('no goals and no motive: no cards', () => {
    const s = sp()
    expect(forgeTour(s, s.story, { goals: [], motive: false }).some((b) => b.card)).toBe(false)
  })
})
