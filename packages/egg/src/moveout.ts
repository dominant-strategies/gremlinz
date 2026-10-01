/**
 * Move-out: a hatched gremlin moves itself to a server under its own control.
 *
 *   launching ─nest announced, proof ok─► (stop runtime, snapshot, seal, post) ─► handed-off ─nest pulses─► moved
 *                                                                                    └─ no pulse in time ─► reverted
 *
 * The nest secret never leaves this process except inside the nest's cloud-init, so neither the board nor anyone
 * reading it can pose as the nest. The old server stops pulsing once it hands off, so only one copy of the gremlin
 * ever acts; if the nest never shows up, it reverts and restarts the runtime.
 */
import { computeAddress, hexlify, randomBytes } from 'ethers'
import { detachCiphertext, nestProof, seal, signMessage, verifyMessage, type Handoff } from '@gremlins/hatch'
import type { NestBoardClient } from './board-client.js'
import type { EggKeys } from './keys.js'
import { encodePayload, type Payload } from './payload.js'

export type MoveOutStage = 'launching' | 'handed-off' | 'moved' | 'reverted'

export interface MoveOutState {
  stage: MoveOutStage
  launchId: string
  nestSecret: string
  startedAt: string
  nestAddress?: string
  serverRef?: string
  handedOffAt?: string
  seqAtHandoff?: number
  reason?: string
  /** Host request that started this move (kept so the move can resume after a restart). */
  request?: unknown
}

export interface NestLaunchRequest {
  mode: 'nest'
  forGremlin: string
  nestSecret: string
  boardUrl: string
  launchId: string
}

export interface MoveOutDeps {
  keys: EggKeys
  boardUrl: string
  board: Pick<NestBoardClient, 'findNest' | 'postHandoff' | 'latestPulseSeq'>
  now: () => Date
  /** Start the nest server (host adapter). Returns a provider reference for the record. */
  launchNest: (launch: NestLaunchRequest) => Promise<string>
  stopRuntime: () => Promise<void>
  startRuntime: () => void
  /** Snapshot seed + state, taken after the runtime has stopped. */
  collect: () => Payload
  /** Current pulse seq of this gremlin (from egg state). */
  pulseSeq: () => number
  /** Remove the seed and state from this server once the nest has taken over. */
  wipe: () => Promise<void>
  /** How long to wait for the nest before giving up. */
  timeoutMs?: number
}

export async function startMoveOut(deps: MoveOutDeps): Promise<MoveOutState> {
  const state: MoveOutState = {
    stage: 'launching',
    launchId: 'nest-' + hexlify(randomBytes(12)).slice(2),
    nestSecret: hexlify(randomBytes(32)),
    startedAt: deps.now().toISOString(),
  }
  state.serverRef = await deps.launchNest({ mode: 'nest', forGremlin: deps.keys.evm.address, nestSecret: state.nestSecret, boardUrl: deps.boardUrl, launchId: state.launchId })
  return state
}

export async function moveOutStep(deps: MoveOutDeps, state: MoveOutState): Promise<MoveOutState> {
  const now = deps.now()
  const timedOut = (since: string) => now.getTime() - Date.parse(since) > (deps.timeoutMs ?? 2 * 60 * 60_000)
  const me = deps.keys.evm.address

  if (state.stage === 'launching') {
    const nest = await deps.board.findNest(state.launchId)
    if (!nest) return timedOut(state.startedAt) ? { ...state, stage: 'reverted', reason: 'nest never announced' } : state
    const m = nest.message
    const genuine =
      verifyMessage(nest) &&
      m.address.toLowerCase() === computeAddress(m.transportKey).toLowerCase() &&
      m.forGremlin.toLowerCase() === me.toLowerCase() &&
      m.proof === nestProof(state.nestSecret, m.transportKey, me)
    if (!genuine) return { ...state, stage: 'reverted', reason: 'nest announcement failed verification (possible impersonation)' }

    await deps.stopRuntime()
    const seqAtHandoff = deps.pulseSeq()
    const { sealed, ct } = detachCiphertext(await seal(m.transportKey, encodePayload(deps.collect())))
    const handoff: Handoff = { kind: 'handoff', address: me, nest: m.address, sealed, createdAt: now.toISOString() }
    try {
      await deps.board.postHandoff(m.address, { ...(await signMessage(deps.keys.evm, handoff)), ct })
    } catch (e) {
      deps.startRuntime()
      return { ...state, stage: 'reverted', reason: `handoff failed: ${(e as Error).message}` }
    }
    return { ...state, stage: 'handed-off', nestAddress: m.address, handedOffAt: now.toISOString(), seqAtHandoff }
  }

  if (state.stage === 'handed-off') {
    const seq = await deps.board.latestPulseSeq(me)
    if (seq !== undefined && seq > (state.seqAtHandoff ?? 0)) {
      await deps.wipe()
      return { ...state, stage: 'moved' }
    }
    if (timedOut(state.handedOffAt!)) {
      deps.startRuntime()
      return { ...state, stage: 'reverted', reason: 'nest never pulsed after handoff' }
    }
  }
  return state
}

/** While a move is in flight the old server must not act as the gremlin. */
export const isQuiet = (s: MoveOutState | undefined) => s?.stage === 'handed-off' || s?.stage === 'moved'
