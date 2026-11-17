import { describe, expect, it } from 'vitest'
import { currentStage, hatchbarHtml, stageStates } from '../src/hatchbar.js'

const config = {} as never
const none = () => false

describe('hatch step bar', () => {
  it('follows the hatch from sign-in to hatching', () => {
    expect(currentStage({})).toBe('connect')
    expect(currentStage({ maker: '0x1' })).toBe('name')
    expect(currentStage({ maker: '0x1', at: 'models' })).toBe('models')
    expect(currentStage({ maker: '0x1', config })).toBe('host')
    expect(currentStage({ maker: '0x1', config, host: 'fluence' })).toBe('fund')
    expect(currentStage({ maker: '0x1', config, host: 'fluence', machineId: 'fluence:1' })).toBe('hatch')
  })

  it('while building: earlier steps and steps finished before going back are clickable and editable; later ones are not', () => {
    const st = stageStates({ maker: '0x1', at: 'persona' }, (id) => id === 'models')
    const by = Object.fromEntries(st.map((x) => [x.stage, x]))
    expect(by.name).toMatchObject({ state: 'done', open: true, readOnly: false })
    expect(by.persona).toMatchObject({ state: 'now', viewing: true })
    expect(by.models).toMatchObject({ state: 'done', open: true })
    expect(by.rules).toMatchObject({ state: 'todo', open: false }) // persona isn't finished yet
    // went back to Name after reaching Personality: Body and Personality are still a click away, Models isn't
    const back = Object.fromEntries(stageStates({ maker: '0x1', at: 'name' }, (id) => ['name', 'look'].includes(id)).map((x) => [x.stage, x]))
    expect([back.look!.open, back.persona!.open, back.models!.open]).toEqual([true, true, false])
    expect(by.connect).toMatchObject({ open: true, readOnly: true }) // the maker can't change mid-hatch
  })

  it('once the egg is being rented, everything configured opens read-only', () => {
    const st = stageStates({ maker: '0x1', config, host: 'fluence', hatch: { jobId: 'j', hostingAddress: null, minUsd: 10 } }, none, 'name')
    expect(st.filter((x) => x.readOnly).map((x) => x.stage)).toEqual(['connect', 'name', 'look', 'persona', 'models', 'rules', 'host'])
    expect(st.find((x) => x.stage === 'fund')).toMatchObject({ state: 'now', viewing: false })
    expect(st.find((x) => x.stage === 'name')!.viewing).toBe(true)
    expect(st.find((x) => x.stage === 'hatch')!.open).toBe(false)
  })

  it('choosing a host is still undoable from the host step: the config can be edited until then', () => {
    const st = stageStates({ maker: '0x1', config }, none)
    expect(st.find((x) => x.stage === 'rules')).toMatchObject({ open: true, readOnly: false })
  })

  it('draws reachable stages as buttons and the rest as disabled labels, nine in the same order every time', () => {
    const h = hatchbarHtml(stageStates({ maker: '0x1', at: 'look' }, none))
    expect(h.match(/<li/g)).toHaveLength(9)
    expect(h.match(/<button/g)).toHaveLength(3) // sign in, name, body
    expect(h).toContain('aria-current="step"')
    expect(h).toContain('aria-disabled="true"')
  })
})
