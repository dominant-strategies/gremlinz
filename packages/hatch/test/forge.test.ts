import { describe, expect, it } from 'vitest'
import { FORGE_EXAMPLES, checkForgeSpec, curlPoints, forgePose, forgeSpecToWire, forgeTour, forgeTourAt, type Vec3 } from '../src/forge.js'

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('forge spec v4: assemblies and modes', () => {
  it('puts a v3 design into one body assembly with an idle mode', () => {
    const { spec, notes } = checkForgeSpec(FORGE_EXAMPLES.toaster)
    expect(spec.assemblies?.map((a) => a.id)).toEqual(['body'])
    expect(spec.modes?.map((m) => m.id)).toEqual(['idle'])
    expect(spec.parts.every((p) => p.asm === 'body')).toBe(true)
    expect(notes.join(' ')).not.toMatch(/assembl/)
  })

  it('keeps the octopod example whole: five assemblies, two modes, chains and rivets', () => {
    const { spec, notes } = checkForgeSpec(FORGE_EXAMPLES.octopod)
    expect(notes).toEqual([])
    expect(spec.assemblies?.map((a) => a.id)).toEqual(['mantle', 'optics', 'jaw', 'arms', 'stacks'])
    expect(spec.modes?.map((m) => m.id)).toEqual(['idle', 'strike', 'vent'])
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

  it('plays hero, each mode, then the exploded view, back to back', () => {
    expect(beats[0]).toMatchObject({ at: 0, mode: 'idle', label: 'Hero' })
    expect(beats.map((b) => b.label)).toContain('Strike')
    expect(beats.at(-1)!.label).toBe('Exploded')
    for (let i = 1; i < beats.length; i++) expect(beats[i]!.at).toBeCloseTo(beats[i - 1]!.at + beats[i - 1]!.dur)
  })

  it('seeks to any time and loops', () => {
    const total = beats.at(-1)!.at + beats.at(-1)!.dur
    const mid = beats[2]! // Strike, holding at full
    expect(forgeTourAt(beats, mid.at + 0.5)).toMatchObject({ mode: 'strike', input: 1, explode: 0, beat: 2 })
    expect(forgeTourAt(beats, mid.at + 0.5 + total)).toMatchObject({ mode: 'strike', input: 1, beat: 2 })
    expect(forgeTourAt([], 5)).toMatchObject({ mode: 'idle', input: 0 })
  })
})
