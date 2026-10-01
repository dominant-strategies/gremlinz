/**
 * Nest mode: a fresh server a hatched gremlin launched for itself.
 *
 *   booted ─announce transport key + proof─► announced ─valid sealed handoff─► restored
 *
 * After `restored`, the server runs as the gremlin (normal egg mode) with the moved state.
 */
import { SigningKey, Wallet, computeAddress, hexlify, randomBytes } from 'ethers'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { HDNodeWallet } from 'ethers'
import { attachCiphertext, nestProof, open, signMessage, verifyMessage, type NestAnnouncement } from '@gremlins/hatch'
import type { NestBoardClient } from './board-client.js'
import type { NestLaunchData } from './launch.js'
import { decodePayload, type Payload } from './payload.js'
import { EVM_PATH } from './keys.js'

export type NestStage = 'booted' | 'announced' | 'restored'

export interface NestState {
  stage: NestStage
  bootedAt: string
  log: { at: string; event: string }[]
}

/** Must be shorter than the old server's give-up window (moveout.ts, 2 h) so both copies can never run. */
export const MAX_HANDOFF_AGE_MS = 90 * 60_000

export interface NestDeps {
  launch: NestLaunchData
  board: Pick<NestBoardClient, 'announceNest' | 'fetchHandoff'>
  transportKey: SigningKey
  now: () => Date
  /** Write the moved files into place (payload.restorePayload in production). */
  restore: (payload: Payload) => Promise<void>
}

/** The nest's transport key, generated once and kept root-only until the handoff completes. */
export function loadOrCreateTransportKey(path: string): SigningKey {
  if (existsSync(path)) return new SigningKey(readFileSync(path, 'utf8').trim())
  const key = new SigningKey(hexlify(randomBytes(32)))
  writeFileSync(path, key.privateKey + '\n', { mode: 0o600, flag: 'wx' })
  return key
}

export function nestAnnouncement(deps: Pick<NestDeps, 'launch' | 'transportKey'>, bootedAt: string): NestAnnouncement {
  const transportKey = deps.transportKey.publicKey
  return {
    kind: 'nest',
    address: computeAddress(transportKey),
    transportKey,
    forGremlin: deps.launch.forGremlin,
    launchId: deps.launch.launchId,
    proof: nestProof(deps.launch.nestSecret, transportKey, deps.launch.forGremlin),
    bootedAt,
  }
}

const rec = (s: NestState, now: Date, event: string): NestState => ({ ...s, log: [...s.log.slice(-49), { at: now.toISOString(), event }] })

export async function nestStep(deps: NestDeps, state: NestState): Promise<NestState> {
  const now = deps.now()
  if (state.stage === 'booted') {
    await deps.board.announceNest(await signMessage(new Wallet(deps.transportKey.privateKey), nestAnnouncement(deps, state.bootedAt)))
    return rec({ ...state, stage: 'announced' }, now, 'announced')
  }
  if (state.stage === 'announced') {
    const nestAddress = computeAddress(deps.transportKey.publicKey)
    const handoff = await deps.board.fetchHandoff(nestAddress)
    if (!handoff) return state
    const m = handoff.message
    if (!verifyMessage({ message: handoff.message, signature: handoff.signature }) || m.address.toLowerCase() !== deps.launch.forGremlin.toLowerCase() || m.nest.toLowerCase() !== nestAddress.toLowerCase()) {
      return rec(state, now, 'rejected handoff: not signed by the expected gremlin for this nest')
    }
    if (now.getTime() - Date.parse(m.createdAt) > MAX_HANDOFF_AGE_MS) {
      return rec(state, now, 'rejected handoff: too old (the old server may have resumed)')
    }
    let payload: Payload
    try {
      payload = decodePayload(await open(deps.transportKey, attachCiphertext(m.sealed, handoff.ct)))
    } catch (e) {
      return rec(state, now, `rejected handoff: ${(e as Error).message}`)
    }
    // The seed must actually be the gremlin's: its EVM key derives the announced address.
    if (HDNodeWallet.fromPhrase(payload.phrase, undefined, EVM_PATH).address.toLowerCase() !== deps.launch.forGremlin.toLowerCase()) {
      return rec(state, now, 'rejected handoff: seed does not belong to the expected gremlin')
    }
    await deps.restore(payload)
    return rec({ ...state, stage: 'restored' }, now, 'restored')
  }
  return state
}
