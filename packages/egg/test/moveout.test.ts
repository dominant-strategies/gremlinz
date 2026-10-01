import { describe, expect, it } from 'vitest'
import { SigningKey, Wallet, hexlify, randomBytes } from 'ethers'
import { detachCiphertext, signMessage, type Handoff, type HandoffWire, type NestAnnouncement, type Signed } from '@gremlins/hatch'
import { generatePhrase, keysFromPhrase } from '../src/keys.js'
import { moveOutStep, startMoveOut, type MoveOutDeps, type NestLaunchRequest } from '../src/moveout.js'
import { nestStep, type NestDeps, type NestState } from '../src/nest.js'
import type { Payload } from '../src/payload.js'

/** In-memory stand-in for the board's nest endpoints. */
function fakeBoard() {
  const nests = new Map<string, Signed<NestAnnouncement>>()
  const handoffs = new Map<string, HandoffWire>()
  const seqs = new Map<string, number>()
  return {
    nests, handoffs, seqs,
    announceNest: async (s: Signed<NestAnnouncement>) => { nests.set(s.message.launchId, s) },
    findNest: async (launchId: string) => nests.get(launchId),
    postHandoff: async (nest: string, s: HandoffWire) => { handoffs.set(nest.toLowerCase(), s) },
    fetchHandoff: async (nest: string) => handoffs.get(nest.toLowerCase()),
    latestPulseSeq: async (a: string) => seqs.get(a.toLowerCase()),
  }
}

function scenario() {
  const board = fakeBoard()
  const keys = keysFromPhrase(generatePhrase())
  let t = Date.parse('2026-10-01T00:00:00Z')
  const now = () => new Date((t += 60_000))
  const events: string[] = []
  let launched: NestLaunchRequest | undefined
  const old: MoveOutDeps = {
    keys, boardUrl: 'https://board.example', board, now,
    launchNest: async (l) => { launched = l; return 'ss_m_1' },
    stopRuntime: async () => { events.push('stop') },
    startRuntime: () => { events.push('start') },
    collect: (): Payload => ({ v: 1, phrase: keys.phrase, files: { 'gremlin/state.json': Buffer.from('{"pulseSeq":5}').toString('base64') } }),
    pulseSeq: () => 5,
    wipe: async () => { events.push('wipe') },
  }
  const restored: Payload[] = []
  const nestDeps = (): NestDeps => ({
    launch: { mode: 'nest', ...launched!, image: undefined },
    board, transportKey: new SigningKey(hexlify(randomBytes(32))), now,
    restore: async (p) => { restored.push(p) },
  })
  return { board, keys, old, nestDeps, restored, events, advance: (ms: number) => { t += ms } }
}

describe('move-out handoff', () => {
  it('moves the seed to a genuine nest, then wipes the old server once the nest pulses', async () => {
    const s = scenario()
    let mo = await startMoveOut(s.old)
    const nd = s.nestDeps()
    let ns: NestState = { stage: 'booted', bootedAt: new Date().toISOString(), log: [] }

    expect((mo = await moveOutStep(s.old, mo)).stage).toBe('launching') // nest not up yet
    ns = await nestStep(nd, ns)
    expect(ns.stage).toBe('announced')

    mo = await moveOutStep(s.old, mo)
    expect(mo.stage).toBe('handed-off')
    expect(s.events).toEqual(['stop'])

    ns = await nestStep(nd, ns)
    expect(ns.stage).toBe('restored')
    expect(s.restored[0].phrase).toBe(s.keys.phrase)

    expect((mo = await moveOutStep(s.old, mo)).stage).toBe('handed-off') // nest hasn't pulsed yet
    s.board.seqs.set(s.keys.evm.address.toLowerCase(), 6)
    expect((mo = await moveOutStep(s.old, mo)).stage).toBe('moved')
    expect(s.events).toEqual(['stop', 'wipe'])
  })

  it('refuses a nest that cannot prove the secret (e.g. a malicious board)', async () => {
    const s = scenario()
    let mo = await startMoveOut(s.old)
    const impostor = new Wallet(hexlify(randomBytes(32)))
    const fake: NestAnnouncement = {
      kind: 'nest', address: impostor.address, transportKey: impostor.signingKey.publicKey, forGremlin: s.keys.evm.address,
      launchId: mo.launchId, proof: '0x' + 'ab'.repeat(32), bootedAt: new Date().toISOString(),
    }
    s.board.nests.set(mo.launchId, await signMessage(impostor, fake))
    mo = await moveOutStep(s.old, mo)
    expect(mo.stage).toBe('reverted')
    expect(mo.reason).toMatch(/impersonation/)
    expect(s.events).toEqual([]) // never stopped, never sealed anything
    expect(s.board.handoffs.size).toBe(0)
  })

  it('nest rejects a handoff signed by someone other than its gremlin', async () => {
    const s = scenario()
    await startMoveOut(s.old)
    const nd = s.nestDeps()
    let ns: NestState = await nestStep(nd, { stage: 'booted', bootedAt: new Date().toISOString(), log: [] })
    const stranger = keysFromPhrase(generatePhrase())
    const ann = [...s.board.nests.values()][0].message
    const { seal } = await import('@gremlins/hatch')
    const { sealed, ct } = detachCiphertext(await seal(ann.transportKey, new Uint8Array([1])))
    const h: Handoff = { kind: 'handoff', address: stranger.evm.address, nest: ann.address, sealed, createdAt: new Date().toISOString() }
    s.board.handoffs.set(ann.address.toLowerCase(), { ...(await signMessage(stranger.evm, h)), ct })
    ns = await nestStep(nd, ns)
    expect(ns.stage).toBe('announced')
    expect(ns.log.at(-1)!.event).toMatch(/not signed by the expected gremlin/)
  })

  it('nest rejects ciphertext swapped after signing', async () => {
    const s = scenario()
    let mo = await startMoveOut(s.old)
    const nd = s.nestDeps()
    let ns = await nestStep(nd, { stage: 'booted', bootedAt: new Date().toISOString(), log: [] })
    mo = await moveOutStep(s.old, mo)
    const key = [...s.board.handoffs.keys()][0]
    const h = s.board.handoffs.get(key)!
    s.board.handoffs.set(key, { ...h, ct: h.ct.slice(0, -2) + (h.ct.endsWith('00') ? '01' : '00') })
    ns = await nestStep(nd, ns)
    expect(ns.stage).toBe('announced')
    expect(ns.log.at(-1)!.event).toMatch(/does not match signed hash/)
  })

  it('reverts and restarts the runtime if the nest never pulses', async () => {
    const s = scenario()
    let mo = await startMoveOut(s.old)
    const nd = s.nestDeps()
    await nestStep(nd, { stage: 'booted', bootedAt: new Date().toISOString(), log: [] })
    mo = await moveOutStep(s.old, mo)
    expect(mo.stage).toBe('handed-off')
    s.advance(3 * 60 * 60_000)
    mo = await moveOutStep(s.old, mo)
    expect(mo.stage).toBe('reverted')
    expect(s.events).toEqual(['stop', 'start'])
  })

  it('a late nest refuses a stale handoff so two copies never run', async () => {
    const s = scenario()
    let mo = await startMoveOut(s.old)
    const nd = s.nestDeps()
    let ns = await nestStep(nd, { stage: 'booted', bootedAt: new Date().toISOString(), log: [] })
    mo = await moveOutStep(s.old, mo)
    s.advance(100 * 60_000) // nest only checks after 100 minutes
    ns = await nestStep(nd, ns)
    expect(ns.stage).toBe('announced')
    expect(ns.log.at(-1)!.event).toMatch(/too old/)
  })
})

describe('quiet during a move', () => {
  it('the old server stops acting as the gremlin from the moment it hands off', async () => {
    const { isQuiet } = await import('../src/moveout.js')
    const base = { launchId: 'x', nestSecret: '0x', startedAt: '' }
    expect(isQuiet(undefined)).toBe(false)
    expect(isQuiet({ ...base, stage: 'launching' })).toBe(false) // still the live copy until it seals
    expect(isQuiet({ ...base, stage: 'handed-off' })).toBe(true) // no pulses → the board can't mark the nest occupied early
    expect(isQuiet({ ...base, stage: 'moved' })).toBe(true)
    expect(isQuiet({ ...base, stage: 'reverted' })).toBe(false)
  })
})
