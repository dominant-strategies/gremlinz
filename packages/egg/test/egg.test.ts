import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { configHash, signConfig, verifyMessage, type EggAnnouncement, type GremlinConfig, type Pulse, type Signed, type SignedConfig } from '@gremlins/hatch'
import { step, type EggDeps } from '../src/egg.js'
import { generatePhrase, keysFromPhrase } from '../src/keys.js'
import { memoryStore } from '../src/store.js'

const maker = Wallet.createRandom()
const config = (who = maker): GremlinConfig => ({
  version: 1, name: 'sprocket', persona: 'tinkerer', voice: '', goals: ['build a weather station'], preferredModels: [],
  maker: who.address, parent: 'orphan', revenueSplit: { kind: 'none' },
  mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
  constitution: ['honesty'], createdAt: '2026-09-29T00:00:00.000Z',
})

function harness(funds: Record<string, bigint> = {}) {
  const board = {
    announced: [] as Signed<EggAnnouncement>[],
    pulses: [] as Signed<Pulse>[],
    config: undefined as SignedConfig | undefined,
    announce: async (s: Signed<EggAnnouncement>) => { board.announced.push(s) },
    fetchConfig: async () => board.config,
    postPulse: async (s: Signed<Pulse>) => { board.pulses.push(s) },
  }
  const balances = { funds, read: async () => balances.funds }
  const initialized: GremlinConfig[] = []
  let t = Date.parse('2026-09-29T00:00:00Z')
  const deps: EggDeps = {
    keys: keysFromPhrase(generatePhrase()),
    launch: { maker: maker.address, configHash: configHash(config()), boardUrl: 'https://board.example', launchId: 'L1' },
    board, balances, store: memoryStore(),
    now: () => new Date((t += 60_000)),
    onInitialized: async (c, signed) => { initialized.push(c); expect(signed.signature).toMatch(/^0x/); expect(typeof signed.message.issuedAt).toBe('bigint') },
    pulseEveryMs: 10 * 60_000,
  }
  return { deps, board, balances, initialized }
}

describe('egg', () => {
  it('announces itself with a verifiable signature and its own deposit addresses', async () => {
    const h = harness()
    expect((await step(h.deps)).stage).toBe('announced')
    const a = h.board.announced[0]
    expect(verifyMessage(a)).toBe(true)
    expect(a.message.deposit.quai).toBe(h.deps.keys.quai.address)
    expect(a.message.deposit.qiPaymentCode).toMatch(/^PM8T/)
  })

  it('waits for config, ignores a stranger config, accepts the maker config', async () => {
    const h = harness()
    await step(h.deps)
    expect((await step(h.deps)).stage).toBe('announced')

    const stranger = Wallet.createRandom()
    h.board.config = await signConfig(stranger, config(stranger), h.deps.keys.quai.address)
    const s1 = await step(h.deps)
    expect(s1.stage).toBe('announced')
    expect(s1.log.at(-1)!.event).toMatch(/rejected config/)

    h.board.config = await signConfig(maker, config(), Wallet.createRandom().address)
    expect((await step(h.deps)).stage).toBe('announced') // signed for a different egg

    h.board.config = await signConfig(maker, config(), h.deps.keys.quai.address)
    expect((await step(h.deps)).stage).toBe('configured')
  })

  it('initializes only once funded, then pulses and hatches', async () => {
    const h = harness()
    await step(h.deps)
    h.board.config = await signConfig(maker, config(), h.deps.keys.quai.address)
    await step(h.deps)
    expect((await step(h.deps)).stage).toBe('configured')
    expect(h.initialized).toHaveLength(0)

    h.balances.funds = { 'usdc:8453': 25_000_000n }
    expect((await step(h.deps)).stage).toBe('initialized')
    expect(h.initialized[0].name).toBe('sprocket')

    const s = await step(h.deps)
    expect(s.stage).toBe('hatched')
    expect(h.board.pulses).toHaveLength(1)
    expect(verifyMessage(h.board.pulses[0])).toBe(true)
    expect(h.board.pulses[0].message.balances['usdc:8453']).toBe('25000000')

    await step(h.deps) // not due yet
    expect(h.board.pulses).toHaveLength(1)

    // once the runtime reports, pulses carry its tier, goals and highlights
    h.deps.pulseEveryMs = 0
    h.deps.readStatus = () => ({ tier: 'low_compute', goals: [{ goal: 'build a weather station', progressPct: 40 }], highlights: ['First donation: 50 QUAI'] })
    await step(h.deps)
    const p = h.board.pulses[1].message
    expect(p.tier).toBe('low_compute')
    expect(p.goals[0].progressPct).toBe(40)
    expect(p.highlights).toEqual(['First donation: 50 QUAI'])
  })

  it('resumes from persisted state', async () => {
    const h = harness()
    await step(h.deps)
    const saved = h.deps.store.load()!
    const h2 = harness()
    h2.deps.keys = h.deps.keys
    h2.deps.store.save(saved)
    expect((await step(h2.deps)).stage).toBe('announced')
    expect(h2.board.announced).toHaveLength(0)
  })
})
