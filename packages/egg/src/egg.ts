/**
 * The egg state machine. Each call to `step` advances at most one stage and persists state, so a reboot
 * resumes where it left off.
 *
 *   booted ─announce─► announced ─valid maker config─► configured ─funds seen─► initialized ─first pulse─► hatched
 *
 * Moving out to a server under the gremlin's own keys, and handing over to the agent runtime, happen after
 * `hatched` and live elsewhere.
 */
import { signMessage, verifySignedConfig, type EggAnnouncement, type GremlinConfig, type Pulse } from '@gremlins/hatch'
import { tokenKey, FUNDING_TOKENS, CHAIN } from '@gremlins/treasury'
import type { BoardClient } from './board-client.js'
import { hasFunds, type BalanceReader, type Balances } from '@gremlins/treasury'
import type { EggKeys } from './keys.js'
import type { LaunchData } from './launch.js'

export type Stage = 'booted' | 'announced' | 'configured' | 'initialized' | 'hatched'

export interface EggState {
  stage: Stage
  bootedAt: string
  config?: GremlinConfig
  pulseSeq: number
  lastPulseAt?: string
  log: { at: string; event: string }[]
}

export interface StateStore {
  load(): EggState | undefined
  save(state: EggState): void
}

export interface EggDeps {
  keys: EggKeys
  launch: LaunchData
  board: BoardClient
  balances: BalanceReader
  store: StateStore
  now: () => Date
  /** Called once when the egg initializes; starts the agent runtime with the verified config. */
  onInitialized: (config: GremlinConfig) => Promise<void>
  pulseEveryMs?: number
}

export function initialState(now: Date): EggState {
  return { stage: 'booted', bootedAt: now.toISOString(), pulseSeq: 0, log: [] }
}

function record(state: EggState, now: Date, event: string): EggState {
  return { ...state, log: [...state.log.slice(-99), { at: now.toISOString(), event }] }
}

export function announcement(deps: Pick<EggDeps, 'keys' | 'launch'>, bootedAt: string): EggAnnouncement {
  return {
    kind: 'egg',
    address: deps.keys.evm.address,
    maker: deps.launch.maker,
    configHash: deps.launch.configHash,
    deposit: { quai: deps.keys.quai.address, qiPaymentCode: deps.keys.qiPaymentCode, evm: deps.keys.evm.address },
    launchId: deps.launch.launchId,
    bootedAt,
  }
}

export function buildPulse(state: EggState, keys: EggKeys, balances: Balances, now: Date): Pulse {
  const quaiKey = tokenKey({ symbol: 'QUAI', chainId: CHAIN.quai })
  return {
    kind: 'pulse',
    address: keys.evm.address,
    seq: state.pulseSeq + 1,
    at: now.toISOString(),
    // Tiers and USD figures come from the runtime once it is running; the egg reports raw balances.
    tier: 'normal',
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, v.toString()])),
    netWorthQuai: (balances[quaiKey] ?? 0n).toString(),
    runwayDays: 0,
    burnRate7dUsd: '0',
    revenue7dUsd: '0',
    revenueLifetimeUsd: '0',
    goals: (state.config?.goals ?? []).map((goal) => ({ goal, progressPct: 0 })),
    highlights: state.stage === 'initialized' ? ['Hatched.'] : [],
  }
}

async function readAll(deps: EggDeps): Promise<Balances> {
  return deps.balances.read({ quai: deps.keys.quai.address, evm: deps.keys.evm.address })
}

/** Advance the egg by at most one stage. Returns the new state (also persisted). */
export async function step(deps: EggDeps): Promise<EggState> {
  const now = deps.now()
  let state = deps.store.load() ?? initialState(now)

  switch (state.stage) {
    case 'booted': {
      await deps.board.announce(await signMessage(deps.keys.evm, announcement(deps, state.bootedAt)))
      state = record({ ...state, stage: 'announced' }, now, 'announced')
      break
    }
    case 'announced': {
      const signed = await deps.board.fetchConfig(deps.keys.evm.address)
      if (!signed) break
      // Verify independently: the board is not trusted with the egg's identity.
      const v = verifySignedConfig(signed, { maker: deps.launch.maker, configHash: deps.launch.configHash, gremlin: deps.keys.quai.address })
      if (!v.ok) {
        state = record(state, now, `rejected config: ${v.reason}`)
        break
      }
      state = record({ ...state, stage: 'configured', config: v.config }, now, 'configured')
      break
    }
    case 'configured': {
      if (!hasFunds(await readAll(deps))) break
      await deps.onInitialized(state.config!)
      state = record({ ...state, stage: 'initialized' }, now, 'initialized')
      break
    }
    case 'initialized':
    case 'hatched': {
      const due = !state.lastPulseAt || now.getTime() - new Date(state.lastPulseAt).getTime() >= (deps.pulseEveryMs ?? 60 * 60_000)
      if (!due) break
      const pulse = buildPulse(state, deps.keys, await readAll(deps), now)
      await deps.board.postPulse(await signMessage(deps.keys.evm, pulse))
      state = { ...state, pulseSeq: pulse.seq, lastPulseAt: pulse.at }
      if (state.stage === 'initialized') state = record({ ...state, stage: 'hatched' }, now, 'hatched')
      break
    }
  }

  deps.store.save(state)
  return state
}

export const FUNDING_TOKEN_KEYS = FUNDING_TOKENS.map(tokenKey)
