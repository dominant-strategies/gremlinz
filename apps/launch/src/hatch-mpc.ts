/**
 * The maker's half of a 2-of-2 hatch key (@gremlins/hosting/mpc). The egg's hosting account is generated together with
 * the board's hatch service: one key shard stays in this browser (localStorage), the other on the board, and neither
 * side can sign alone. While this page is open it co-signs what the hatch needs (Fluence sign-ins, the top-up, the
 * CoW swap of bridged QUAI), each checked against a fixed policy and shown in a panel first. Once the egg has claimed
 * its account, the page seals its shard to the egg and forgets it; the egg alone puts the key together.
 *
 * Lose this browser's storage before the hand-over and the funds at the hosting address are stuck for good.
 */
import { computeAddress, hexlify, randomBytes } from 'ethers'
import { sealBrowserShard } from '@gremlins/hatch'
import { fluencePayTo } from '@gremlins/hosting'
import { MAX_HATCH_TOPUP_USD, browserKeygen, cosignOnce, httpMpcTransport, mpcAuthOf, shareScalar, type CosignEvent, type PolicyContext } from '@gremlins/hosting/mpc'
import { CHAIN, QUAI_SYNTH, USDC, buildAppData, quoteSell } from '@gremlins/treasury'
import type { boardApi, HatchJobView } from './board.js'

type Board = ReturnType<typeof boardApi>
interface Held {
  /** Per-job secret: the board keeps only its hash and wants it on every MPC call. */
  secret: string
  jobId?: string
  share?: string
  address?: string
}

const KEY = (launchId: string) => `gremlins.hatch-mpc.${launchId}`
const load = (launchId: string): Held | undefined => {
  try {
    return JSON.parse(localStorage.getItem(KEY(launchId)) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}
// No private-mode fallback: a shard that isn't stored durably must not be funded.
const store = (launchId: string, h: Held) => localStorage.setItem(KEY(launchId), JSON.stringify(h))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export const LOSS_WARNING = `The egg's hosting account is split between this browser and the hatch service: neither can spend it alone. <b>Keep this page open until the egg has taken its account over, in this browser.</b> If this browser's site data is cleared before then, the money sent to the hosting address is lost for good, and nobody (not you, not gremlinz) can recover it. Send only the amount asked.`

/** The `mpcAuth` to create the job with; makes and stores this launch's secret first. */
export async function mpcAuthFor(launchId: string): Promise<string> {
  let h = load(launchId)
  if (!h) store(launchId, (h = { secret: hexlify(randomBytes(32)) }))
  return mpcAuthOf(h.secret)
}

/**
 * The hosting address, once this browser holds its shard. Runs key generation with the board if needed; stores the
 * shard before confirming, so the board never shows a funding address for a shard we don't have.
 */
export async function ensureShard(boardUrl: string, launchId: string, job: { jobId: string; custody?: string; hostingAddress: string | null }): Promise<string> {
  if (job.custody !== 'mpc') return job.hostingAddress!
  const h = load(launchId)
  if (!h) throw new Error('this hatch was started in another browser: its key shard is there, so continue it there')
  const t = httpMpcTransport(boardUrl, job.jobId, h.secret)
  if (!h.share) {
    const mine = await browserKeygen(t, job.jobId)
    store(launchId, { ...h, jobId: job.jobId, share: mine.share, address: mine.address })
    h.address = mine.address
  }
  await t.confirmKeygen(h.address!)
  return h.address!
}

let running = false

/**
 * Co-sign in the background while the page is open, and hand our shard to the egg once it has claimed. Idempotent;
 * returns at once. `job.minUsd` bounds the top-up we agree to.
 */
export function keepCosigning(o: { board: Board; boardUrl: string; launchId: string; jobId: string; maker: string; configHash: string; minUsd: number }) {
  const h = load(o.launchId)
  if (running || !h?.share || !h.address) return
  running = true
  const panel = mountPanel()
  const t = httpMpcTransport(o.boardUrl, o.jobId, h.secret)
  const topUpUsd = Math.min(o.minUsd, MAX_HATCH_TOPUP_USD)
  const ctx: PolicyContext = {
    hostingAddress: h.address,
    maxTopUpMicro: BigInt(Math.round(topUpUsd * 1e6)),
    now: () => Date.now(),
    // Asked of Fluence and CoW directly: the board doesn't get to say who is paid or what a fair price is.
    fluencePayTo: () => fluencePayTo(topUpUsd),
    cowQuote: async (sell) =>
      (await quoteSell({ chainId: CHAIN.base, sellToken: QUAI_SYNTH[CHAIN.base], buyToken: USDC[CHAIN.base]!, from: h.address!, receiver: h.address!, sellAmountBeforeFee: sell, app: buildAppData({ appCode: 'gremlins-egg' }) })).buyAmount,
  }
  void (async () => {
    const state = { launched: false }
    for (let i = 0; ; i++) {
      try {
        // Nothing needs signing once the server runs: from then on we only hand our shard over.
        if (state.launched || !(await cosignOnce(t, o.jobId, h.share!, ctx, panel.show))) await sleep(1_500)
        // Every ~15 s: is there an egg to hand our shard to?
        if (i % 10 === 0 && (await handOver(o, h, panel, state))) break
      } catch (e) {
        panel.note(`Waiting for the hatch service: ${(e as Error).message}`)
        await sleep(5_000)
      }
    }
    running = false
  })()
}

/** Seal our shard to the egg that claimed the account; true once the board has forgotten its own. */
async function handOver(o: Parameters<typeof keepCosigning>[0], h: Held, panel: ReturnType<typeof mountPanel>, state: { launched: boolean }): Promise<boolean> {
  const job: HatchJobView = await o.board.hatchJob(o.jobId)
  // The board signs nothing after launch; refusing then keeps it from opening Fluence sessions behind the egg's back.
  if (['launched', 'handed-off', 'done'].includes(job.status)) state.launched = true
  if (job.mpcAborted || job.status === 'failed') {
    panel.note(`The hatch stopped: ${job.error ?? 'failed'}`)
    return true
  }
  if (!job.eggPublicKey || !job.eggAddress) return false
  if (!job.browserHandoff) {
    // What we can check: the claimed key is the egg announced for our launch, by us, for our config. What we can't:
    // that it runs on the server that was launched (only the board's hatch secret proves that).
    if (computeAddress(job.eggPublicKey).toLowerCase() !== job.eggAddress.toLowerCase()) throw new Error('the claimed egg key does not match its address')
    const egg = await o.board.findEgg(o.launchId)
    const a = egg?.announcement
    if (!a || a.address.toLowerCase() !== job.eggAddress.toLowerCase() || a.maker.toLowerCase() !== o.maker.toLowerCase() || a.configHash.toLowerCase() !== o.configHash.toLowerCase())
      throw new Error('the egg claiming the account is not the one announced for this launch')
    const sealed = await sealBrowserShard(job.eggPublicKey, { v: 2, custody: 'mpc', launchId: o.launchId, hostingAddress: h.address!, shard: await shareScalar(h.share!) })
    await o.board.handOverShard(o.jobId, h.secret, sealed)
    panel.note(`Your key shard is sealed to the egg ${job.eggAddress.slice(0, 8)}…; only it can open it.`)
  }
  if (job.status !== 'done') return false
  // Both halves are with the egg and the board deleted its own: ours goes too.
  localStorage.removeItem(KEY(o.launchId))
  panel.note('The egg holds its hosting account now. This browser kept nothing.')
  return true
}

/** A small panel listing what this page co-signed or refused, newest first. */
function mountPanel() {
  const el = document.createElement('aside')
  el.className = 'mpc-panel'
  el.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:380px;z-index:50;background:var(--bg,#fff);border:1px solid #8884;border-radius:10px;padding:10px 12px;font-size:13px;box-shadow:0 4px 18px #0002'
  el.innerHTML = `<b>Co-signing for the egg's hosting account</b><p class="muted small" style="margin:4px 0">Keep this page open until the egg has taken over its account.</p><ul style="margin:0;padding-left:18px"></ul>`
  document.body.append(el)
  const list = el.querySelector('ul')!
  const add = (html: string) => {
    list.insertAdjacentHTML('afterbegin', `<li>${html}</li>`)
    while (list.children.length > 6) list.lastElementChild!.remove()
  }
  return {
    show(e: CosignEvent) {
      if ('verdict' in e) add(e.verdict.ok ? `Signing: ${esc(e.verdict.summary)}` : `<span class="error">Refused</span> a request for ${esc(e.request.purpose)}: ${esc(e.verdict.reason)}`)
      else if ('signed' in e) add('Signed.')
      else add(`<span class="error">Signing failed</span>: ${esc(e.error)}`)
    },
    note: (text: string) => add(esc(text)),
  }
}
