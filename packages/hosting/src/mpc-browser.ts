/**
 * The maker's side of a 2-of-2 hatch key (mpc.ts): key generation when the job is created, then co-signing what the
 * board asks while the hatch page is open, each request checked against mpc-policy.ts first. The shard never leaves
 * the browser except sealed to the egg (the caller does that, @gremlins/hatch sealHostingShard).
 */
import { checkSignRequest, type PolicyContext, type Verdict } from './mpc-policy.js'
import { digestOf, encodeBatch, party2Keygen, party2Sign, type MpcAnswer, type MpcSignRequest } from './mpc.js'

/** The board's per-job MPC endpoints, authenticated with the job's browser secret. */
export interface MpcTransport {
  keygen(msg: string | null): Promise<{ msg: string; done: boolean; hostingAddress?: string }>
  confirmKeygen(hostingAddress: string): Promise<void>
  poll(): Promise<MpcSignRequest | null>
  answer(reqId: string, a: MpcAnswer): Promise<{ msg: string; done: boolean }>
}

export const HATCH_AUTH_HEADER = 'x-hatch-auth'

export function httpMpcTransport(boardUrl: string, jobId: string, secret: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): MpcTransport {
  const url = (p: string) => new URL(`/api/hatch/${encodeURIComponent(jobId)}/mpc${p}`, boardUrl).toString()
  const call = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(url(p), { method, headers: { [HATCH_AUTH_HEADER]: secret, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(`hatch service: ${j.error ?? res.status}`)
    return j
  }
  return {
    keygen: (msg) => call('POST', '/keygen', { msg }),
    confirmKeygen: async (hostingAddress) => void (await call('POST', '/keygen/confirm', { hostingAddress })),
    poll: async () => (await call<{ request: MpcSignRequest | null }>('GET', '/sign')).request,
    answer: (reqId, a) => call('POST', `/sign/${encodeURIComponent(reqId)}`, a),
  }
}

/**
 * Run key generation with the board. Returns our serialized shard and the shared address; the caller stores the shard
 * durably *before* `t.confirmKeygen(address)`, so the job is never funded against a shard we don't have.
 */
export async function browserKeygen(t: MpcTransport, jobId: string): Promise<{ share: string; address: string }> {
  const p2 = party2Keygen(jobId)
  try {
    let board = await t.keygen(null)
    for (let i = 0; i < 32; i++) {
      const mine = await p2.step(board.msg) // checks the board's proofs as they come
      board = board.done ? { ...board, msg: encodeBatch([]) } : await t.keygen(mine.msg)
      if (mine.done) {
        if (!board.done) board = await t.keygen(encodeBatch([])) // let the board finish
        if (!board.done || !board.hostingAddress || board.hostingAddress.toLowerCase() !== mine.address!.toLowerCase())
          throw new Error('the hatch service and this page disagree on the hosting address')
        return { share: mine.share!, address: mine.address! }
      }
    }
    throw new Error('key generation did not finish')
  } catch (e) {
    p2.cancel()
    throw e
  }
}

export type CosignEvent = { request: MpcSignRequest; verdict: Verdict } | { request: MpcSignRequest; signed: true } | { request: MpcSignRequest; error: string }

/**
 * Handle at most one signing request: check it, then co-sign it or refuse it. Returns false when there was nothing to
 * do. `onEvent` lets the page show what it is signing.
 */
export async function cosignOnce(t: MpcTransport, jobId: string, share: string, ctx: PolicyContext, onEvent?: (e: CosignEvent) => void): Promise<boolean> {
  const request = await t.poll()
  if (!request) return false
  const verdict = await checkSignRequest(request.payload, ctx)
  onEvent?.({ request, verdict })
  if (!verdict.ok) {
    await t.answer(request.id, { refuse: verdict.reason }).catch(() => {})
    return true
  }
  try {
    // Our own digest of the payload we checked: the board never tells us what the hash is.
    const p2 = party2Sign(jobId, request.id, share, digestOf(request.payload))
    let board = { msg: request.msg, done: false }
    let mine = { msg: encodeBatch([]), done: false }
    for (let i = 0; i < 32 && !(mine.done && board.done); i++) {
      if (!mine.done) mine = await p2.step(board.msg)
      else if (JSON.parse(mine.msg).length === 0) break // nothing left to send: the board can't finish
      // Each batch is delivered once; a finished board has nothing more to say.
      board = board.done ? { msg: encodeBatch([]), done: true } : await t.answer(request.id, { msg: mine.msg })
      if (mine.done) mine = { ...mine, msg: encodeBatch([]) }
    }
    if (!mine.done) throw new Error('signing did not finish')
    onEvent?.({ request, signed: true })
  } catch (e) {
    onEvent?.({ request, error: (e as Error).message })
  }
  return true
}
