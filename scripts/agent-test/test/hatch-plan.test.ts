import { describe, expect, it } from 'vitest'
import { FREE_SCREENS, TEST_ACCOUNT, checkPersona, classifyScreen, defaultPersona, eggPayment, fromSession, quaiPayment, resumeDecision } from '../hatch-plan.mjs'
import { mergeState, parseArgs, parseDuration } from '../common.mjs'

const screen = (has: Record<string, boolean>, extra: Record<string, unknown> = {}) => classifyScreen({ eyebrow: '', h2: '', text: '', error: '', formError: '', has, ...extra })

describe('reading the hatch page', () => {
  it('names every screen of the five-step builder and the egg steps', () => {
    expect(screen({ go: true }, { eyebrow: 'Step 1 of 7' })).toBe('connect')
    expect(screen({ nameField: true })).toBe('name')
    expect(screen({ forge: true, go: true })).toBe('look')
    expect(screen({ personaField: true })).toBe('persona')
    expect(screen({}, { mstate: true })).toBe('models-loading')
    expect(screen({ primaryModel: true })).toBe('models')
    expect(screen({ parentRadio: true })).toBe('rules')
    expect(screen({ hostRadio: true, go: true }, { eyebrow: 'Step 7 of 7' })).toBe('host')
    expect(screen({}, { text: 'Loading…' })).toBe('preparing')
    expect(screen({}, { text: "Generating the egg's hosting account with the hatch service…" })).toBe('preparing')
    expect(screen({ usdc: true })).toBe('pay')
    expect(screen({ quai: true })).toBe('pay')
    expect(screen({}, { h2: 'Starting the egg…' })).toBe('starting')
    expect(screen({}, { h2: 'Waiting for your egg to announce itself…' })).toBe('waiting-egg')
    expect(screen({ sign: true }, { h2: 'Your egg is alive' })).toBe('sign')
    expect(screen({ lookPost: true })).toBe('look-post')
    expect(screen({ hatchAnother: true })).toBe('feed')
    expect(screen({})).toBe('loading')
  })

  it('puts errors first: a failed step, a rejected form, an unconfigured site', () => {
    expect(screen({ usdc: true }, { error: 'the hatch service refused: 429' })).toBe('error')
    expect(screen({ parentRadio: true }, { formError: 'Name: Required' })).toBe('form-error')
    expect(screen({ go: true, notConfigured: true })).toBe('not-configured')
  })

  it('treats only the screens before the payment as free', () => {
    for (const s of ['starting', 'waiting-egg', 'sign', 'look-post', 'feed', 'form-error']) expect(FREE_SCREENS).not.toContain(s)
    expect(FREE_SCREENS).toContain('pay') // shown, but the dry run stops before clicking
  })
})

describe('payments', () => {
  it("describes the egg payment exactly: the job's minUsd in USDC on Base to the hosting address", () => {
    const p = eggPayment({ jobId: 'j', hostingAddress: '0x5C1d2E3f4A5b6C7d8E9f0A1b2C3d4E5f6A7b8C9d', minUsd: 10 })
    expect(p.amountMicro).toBe(10_000_000n)
    expect(p.text).toBe(`10.00 USDC on Base (chain 8453), token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, from ${TEST_ACCOUNT} to the egg's hosting address 0x5C1d2E3f4A5b6C7d8E9f0A1b2C3d4E5f6A7b8C9d`)
    expect(() => eggPayment({ jobId: 'j', hostingAddress: null, minUsd: 10 })).toThrow(/no hosting address/)
  })

  it('describes the QUAI feed and refuses silly amounts or addresses', () => {
    const p = quaiPayment('12.5', '0x0049aF1e3c2B7D8e9F0a1B2c3D4e5F6071829304')
    expect(p.amountWei).toBe(12_500_000_000_000_000_000n)
    expect(p.text).toMatch(/^12\.5 QUAI on Quai \(cyprus1, chain 9\), from 0x003c.* to the gremlin's Quai wallet 0x0049/)
    expect(() => quaiPayment(0, '0x0049aF1e3c2B7D8e9F0a1B2c3D4e5F6071829304')).toThrow()
    expect(() => quaiPayment(20_000, '0x0049aF1e3c2B7D8e9F0a1B2c3D4e5F6071829304')).toThrow()
    expect(() => quaiPayment(5, 'cyprus1')).toThrow(/bad Quai address/)
  })
})

describe('resuming', () => {
  const session = (o: Record<string, unknown> = {}) => ({ launchId: 'L1', config: { name: 'pip' }, ...o })

  it('starts on an empty profile, and resumes its own launch', () => {
    expect(resumeDecision({}, null)).toEqual({ action: 'start' })
    expect(resumeDecision({}, { launchId: 'fresh' })).toEqual({ action: 'start' })
    expect(resumeDecision({ launchId: 'L1' }, session())).toEqual({ action: 'resume' })
  })

  it("never takes over or drops another hatch whose money is in flight", () => {
    expect(resumeDecision({}, session())).toMatchObject({ action: 'refuse', why: expect.stringMatching(/another hatch in progress \(launch L1, "pip"\)/) })
    expect(resumeDecision({}, session(), { fresh: true })).toEqual({ action: 'reset' })
    expect(resumeDecision({}, session({ hatch: { jobId: 'j' } }), { fresh: true, jobFunded: true })).toMatchObject({ action: 'refuse', why: expect.stringMatching(/paid for/) })
    expect(resumeDecision({ name: 'pip', launchId: 'L0' }, session())).toMatchObject({ action: 'refuse', why: 'this profile is on launch L1, but pip is launch L0' })
    expect(resumeDecision({ launchId: 'L0' }, null)).toMatchObject({ action: 'refuse', why: expect.stringMatching(/no longer holds launch L0/) })
  })

  it('keeps what watch.mjs needs from the page session', () => {
    const s = {
      launchId: 'L1', maker: TEST_ACCOUNT, config: { name: 'pip' }, hatch: { jobId: 'job-1', custody: 'mpc', hostingAddress: '0xH', minUsd: 10 }, machineId: 'fluence:vm-1', eggAddress: '0xE', configPosted: true,
      progress: { 'fund-egg': { status: 'done', sigsDone: 1, txs: [{ chain: 'base', hash: '0xaa', label: '$10.00 USDC to the egg', state: 'sent' }] }, start: { status: 'done', sigsDone: 0, txs: [{ chain: 'fluence', hash: 'vm-1', label: 'Server', state: 'confirmed' }] } },
    }
    expect(fromSession(s)).toEqual({
      launchId: 'L1', maker: TEST_ACCOUNT, configName: 'pip', jobId: 'job-1', custody: 'mpc', minUsd: 10, hostingAddress: '0xH', machineId: 'fluence:vm-1', eggAddress: '0xE', configPosted: true,
      txs: [{ step: 'fund-egg', chain: 'base', hash: '0xaa', label: '$10.00 USDC to the egg' }, { step: 'start', chain: 'fluence', hash: 'vm-1', label: 'Server' }],
    })
    expect(fromSession(null)).toEqual({})
  })

  it('merges state without losing transactions or addresses', () => {
    const a = mergeState({ name: 'pip', txs: [{ hash: '0xaa' }], gremlin: { evm: '0xE' } }, { txs: [{ hash: '0xaa' }, { hash: '0xbb' }], gremlin: { quai: '0xQ' } })
    expect(a.txs).toEqual([{ hash: '0xaa' }, { hash: '0xbb' }])
    expect(a.gremlin).toEqual({ evm: '0xE', quai: '0xQ' })
  })
})

describe('persona and arguments', () => {
  it('has a valid default persona and checks persona files', () => {
    expect(checkPersona(defaultPersona('pip'))).toMatchObject({ name: 'pip' })
    expect(() => checkPersona({ name: 'x', goals: [], persona: 'p' })).toThrow(/goals/)
    expect(() => checkPersona({ name: '', goals: ['g'], persona: '' })).toThrow(/name.*persona/)
  })

  it('parses flags and durations', () => {
    expect(parseArgs(['pip', '--spend', '--quai', '25', '--base=http://localhost:8790', '--new'])).toEqual({ _: ['pip'], spend: true, quai: '25', base: 'http://localhost:8790', new: true })
    expect(parseDuration('15m')).toBe(900_000)
    expect(parseDuration('3h')).toBe(10_800_000)
    expect(() => parseDuration('soon')).toThrow()
  })
})
