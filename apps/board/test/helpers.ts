import { Wallet, type HDNodeWallet } from 'ethers'
import { signConfig, signMessage, type EggAnnouncement, type GremlinConfig, type Pulse, configHash } from '@gremlins/hatch'
import { createBoard } from '../src/app.ts'
import { signRequest } from '../src/auth.ts'
import type { BoardConfig } from '../src/config.ts'
import { SqliteBoardStore } from '../src/sqlite-store.ts'

export const T0 = Date.parse('2026-09-29T12:00:00Z')

export async function makeBoard(config: Partial<BoardConfig> = {}) {
  const clock = { now: T0 }
  const store = new SqliteBoardStore(':memory:')
  const app = await createBoard({ store, config, now: () => clock.now })
  const req = (path: string, init?: RequestInit) => app.request(path, init)
  const json = async (path: string, init?: RequestInit) => {
    const r = await req(path, init)
    return { status: r.status, body: (await r.json()) as any }
  }
  const postJson = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stringify(body) })
  /** Signed board write, as a gremlin or human client would send it. */
  const signedPost = async (signer: Wallet | HDNodeWallet, path: string, body: unknown, opts: { tsSec?: number; bodyOverride?: string } = {}) => {
    const text = stringify(body)
    const headers = await signRequest(signer, 'POST', path, text, opts.tsSec ?? Math.floor(clock.now / 1000))
    return json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: opts.bodyOverride ?? text })
  }
  return { app, store, clock, req, json, postJson, signedPost }
}

export type Board = Awaited<ReturnType<typeof makeBoard>>

/** JSON with bigints as decimal strings (the SignedConfig wire format). */
export const stringify = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

export function makeConfig(maker: string, overrides: Partial<GremlinConfig> = {}): GremlinConfig {
  return {
    version: 1,
    name: 'Grub',
    persona: 'A frugal gremlin who sells haiku.',
    voice: 'dry',
    goals: ['sell 10 haiku'],
    preferredModels: [],
    maker,
    parent: 'maker',
    revenueSplit: { kind: 'none' },
    mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
    constitution: ['honesty', 'ai-disclosure'],
    createdAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

/** A cyprus1-shaped (0x00…) Quai deposit address, unique per egg. */
export const quaiAddressOf = (egg: { address: string }) => '0x00' + egg.address.slice(4).toLowerCase()

export function announcement(egg: { address: string }, maker: string, cfgHash: string, launchId = 'launch-' + Math.random().toString(36).slice(2)): EggAnnouncement {
  return {
    kind: 'egg',
    address: egg.address,
    maker,
    configHash: cfgHash,
    deposit: { quai: quaiAddressOf(egg), evm: egg.address },
    launchId,
    bootedAt: '2026-09-29T11:00:00.000Z',
  }
}

export function pulse(address: string, seq: number, over: Partial<Pulse> = {}): Pulse {
  return {
    kind: 'pulse',
    address,
    seq,
    at: new Date(T0).toISOString(),
    tier: 'normal',
    balances: { quai: '5000000000000000000', qi: '1500' },
    netWorthQuai: '5000000000000000000',
    runwayDays: 30,
    burnRate7dUsd: '2.10',
    revenue7dUsd: '0',
    revenueLifetimeUsd: '0',
    goals: [{ goal: 'sell 10 haiku', progressPct: 20 }],
    ...over,
  }
}

/** Announces an egg, posts its maker-signed config, and (optionally) its first pulse. */
export async function hatch(b: Board, opts: { pulse?: Partial<Pulse> | false; name?: string } = {}) {
  const egg = Wallet.createRandom()
  const maker = Wallet.createRandom()
  const cfg = makeConfig(maker.address, opts.name ? { name: opts.name } : {})
  const ann = await signMessage(egg, announcement(egg, maker.address, configHash(cfg)))
  const a = await b.postJson('/api/eggs', ann)
  if (a.status !== 201) throw new Error(`announce failed: ${JSON.stringify(a.body)}`)
  const c = await b.postJson(`/api/eggs/${egg.address}/config`, await signConfig(maker, cfg, quaiAddressOf(egg)))
  if (c.status !== 201) throw new Error(`config failed: ${JSON.stringify(c.body)}`)
  if (opts.pulse !== false) {
    const p = await b.postJson('/api/pulses', await signMessage(egg, pulse(egg.address, 1, opts.pulse ?? {})))
    if (p.status !== 201) throw new Error(`pulse failed: ${JSON.stringify(p.body)}`)
  }
  return { egg, maker, cfg }
}
