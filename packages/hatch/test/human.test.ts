import { describe, expect, it } from 'vitest'
import { HUMAN_TRAITS, HUMAN_TRAIT_NAMES, checkHumanSpec, humanSpecJson, humanSvg, humanTraits, type HumanTraits } from '../src/human.js'

/** Removes the per-call id prefix so two renders of the same face compare equal. */
const stable = (svg: string) => svg.replace(/hp[0-9a-z]+/g, 'ID')

describe('human portraits', () => {
  it('draws the same face from the same seed and overrides, and different faces from different seeds', () => {
    expect(humanTraits('alice')).toEqual(humanTraits('alice'))
    expect(stable(humanSvg(humanTraits('alice')))).toBe(stable(humanSvg(humanTraits('alice'))))
    const faces = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(humanTraits(`p${i}`))))
    expect(faces.size).toBeGreaterThan(35)
    // overrides win, the rest of the face stays put
    const base = humanTraits('bob')
    const t = humanTraits('bob', { hair: 'afro', glasses: 'round' })
    expect(t).toEqual({ ...base, hair: 'afro', glasses: 'round' })
    // values off the whitelist are ignored rather than drawn
    expect(humanTraits('bob', { hair: '<script>', skin: 42 as never, bogus: 'x' } as never)).toEqual(base)
  })

  it('every value of every trait renders a well-formed SVG', () => {
    for (const k of HUMAN_TRAIT_NAMES)
      for (const v of HUMAN_TRAITS[k]) {
        const svg = humanSvg(humanTraits(`${k}-${v}`, { [k]: v }))
        expect(svg.startsWith('<svg ')).toBe(true)
        expect(svg.endsWith('</svg>')).toBe(true)
        expect(svg).not.toMatch(/NaN|undefined|<script|on[a-z]+=|javascript:|href=/i)
        // balanced groups: the zoom group closes
        expect((svg.match(/<g[ >]/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length)
      }
  })

  it('checks specs strictly: all traits, only whitelisted values, nothing extra', () => {
    const traits = humanTraits('carol')
    const ok = checkHumanSpec({ v: 1, traits })
    expect(ok).toEqual({ v: 1, traits })
    expect(() => checkHumanSpec({ v: 2, traits })).toThrow(/v must be 1/)
    expect(() => checkHumanSpec({ v: 1, traits, svg: '<svg/>' })).toThrow(/unknown field/)
    expect(() => checkHumanSpec({ v: 1, traits: { ...traits, onload: 'x' } })).toThrow(/unknown trait/)
    expect(() => checkHumanSpec({ v: 1, traits: { ...traits, hair: 'short"/><script>alert(1)</script>' } })).toThrow(/trait hair/)
    expect(() => checkHumanSpec({ v: 1, traits: { ...traits, skin: '#ff0000' } })).toThrow(/trait skin/)
    const { glasses: _g, ...missing } = traits
    expect(() => checkHumanSpec({ v: 1, traits: missing })).toThrow(/trait glasses/)
    expect(() => checkHumanSpec({ v: 1, traits: { ...traits, freckles: true } })).toThrow(/trait freckles/)
    expect(() => checkHumanSpec(null)).toThrow()
    expect(() => checkHumanSpec([traits])).toThrow()
    // a prototype trick doesn't sneak a key past the whitelist
    expect(() => checkHumanSpec(JSON.parse(`{"v":1,"traits":${JSON.stringify({ ...traits })},"__proto__":{"x":1}}`))).toThrow(/unknown field/)
  })

  it('refuses to draw traits that are off the whitelist, and escapes the title', () => {
    const bad = { ...humanTraits('dave'), mouth: '"><script>' } as unknown as HumanTraits
    expect(() => humanSvg(bad)).toThrow(/trait mouth/)
    const svg = humanSvg(humanTraits('dave'), { title: '</title><script>x</script>' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&#60;/title&#62;')
  })

  it('serialises specs canonically (fixed key order), so equal faces hash equal', () => {
    const t = humanTraits('erin')
    const shuffled = Object.fromEntries(Object.entries(t).reverse())
    expect(humanSpecJson({ v: 1, traits: shuffled as HumanTraits })).toBe(humanSpecJson({ v: 1, traits: t }))
    expect(JSON.parse(humanSpecJson({ v: 1, traits: t }))).toEqual({ v: 1, traits: t })
  })
})
