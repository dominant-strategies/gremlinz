/**
 * Hatch progress: every step and every transaction is tracked, persisted with the launch session (a reload
 * resumes and still shows what happened), and shown in a small floating window with live timers, so the maker
 * always sees what is happening, what needs their signature next, and that nothing is frozen.
 */

export type StepStatus = 'todo' | 'active' | 'signing' | 'waiting' | 'done' | 'failed' | 'skipped'
export type Chain = 'quai' | 'base' | 'symbiosis' | 'cow-base' | 'fluence'

export interface TxRef {
  chain: Chain
  hash: string
  label: string
  state: 'sent' | 'confirmed' | 'failed'
}

export interface StepState {
  status: StepStatus
  detail?: string
  startedAt?: number
  finishedAt?: number
  /** Last time a background check ran for this step (drives "still working" feedback). */
  lastCheckAt?: number
  sigsDone: number
  txs: TxRef[]
  error?: string
}

export interface StepDef {
  id: string
  title: string
  /** Signatures / confirmations the maker gives in their wallet during this step. */
  sigs: number
  /** Typical duration shown while the step runs, e.g. "5–10 min". */
  expect?: string
  /** Who acts: the maker, or the page / network on their behalf. */
  who: 'you' | 'auto'
}

export const COMMON_STEPS: StepDef[] = [
  { id: 'connect', title: 'Connect Pelagus', sigs: 1, who: 'you' },
  { id: 'describe', title: 'Describe your gremlin', sigs: 0, who: 'you' },
  { id: 'host', title: 'Choose where the egg hatches', sigs: 0, who: 'you' },
]

const HATCH_STEPS: StepDef[] = [
  { id: 'announce', title: 'Egg boots and announces itself', sigs: 0, expect: '3–8 min', who: 'auto' },
  { id: 'sign-config', title: 'Sign the config for this egg', sigs: 1, who: 'you' },
  { id: 'feed', title: 'Fund your gremlin', sigs: 0, who: 'you' },
  { id: 'hatched', title: 'Hatched (first pulse)', sigs: 0, expect: 'minutes after funding', who: 'auto' },
]

export const FLUENCE_STEPS: StepDef[] = [
  ...COMMON_STEPS,
  { id: 'egg-key', title: 'Unlock your egg hosting key', sigs: 1, who: 'you' },
  { id: 'fund-egg', title: 'Pay for the egg with QUAI', sigs: 3, expect: '~1 min', who: 'you' },
  { id: 'bridge', title: 'Bridge QUAI to Base', sigs: 0, expect: '5–10 min', who: 'auto' },
  { id: 'swap', title: 'Swap to USDC (no gas)', sigs: 0, expect: '~1 min', who: 'auto' },
  { id: 'start', title: 'Pay Fluence and start the server', sigs: 0, expect: '2–5 min', who: 'auto' },
  ...HATCH_STEPS,
]

export const SPORESTACK_STEPS: StepDef[] = [
  ...COMMON_STEPS,
  { id: 'invoice', title: 'Pay the SporeStack invoice', sigs: 0, expect: 'until the payment confirms', who: 'you' },
  { id: 'start', title: 'Start the egg server', sigs: 0, expect: '~1 min', who: 'auto' },
  ...HATCH_STEPS,
]

export interface ProgressStore {
  load(): Record<string, StepState> | undefined
  save(steps: Record<string, StepState>): void
}

const EXPLORER: Record<Chain, (h: string) => string | undefined> = {
  quai: (h) => `https://quaiscan.io/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  symbiosis: (h) => `https://explorer.symbiosis.finance/transactions/9/${h}`,
  'cow-base': (h) => `https://explorer.cow.fi/base/orders/${h}`,
  fluence: () => undefined,
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const ICON: Record<StepStatus, string> = { todo: '○', active: '', signing: '✍', waiting: '', done: '✓', failed: '!', skipped: '–' }

/** One step, as the flow code sees it. */
export interface StepHandle {
  start(detail?: string): void
  /** Waiting for the maker to confirm in their wallet. */
  signing(detail: string): void
  /** The maker confirmed one signature/transaction. */
  signed(detail?: string): void
  /** Background work (polling a bridge, provisioning…). */
  waiting(detail: string): void
  /** A check ran (keeps the "last checked" indicator fresh). */
  touch(detail?: string): void
  tx(chain: Chain, hash: string, label: string, state?: TxRef['state']): void
  done(detail?: string): void
  skip(detail?: string): void
  fail(err: unknown): void
}

export class Progress {
  private steps: Record<string, StepState>
  private defs: StepDef[] = COMMON_STEPS
  private open: boolean
  private timer?: number
  private root?: HTMLElement

  constructor(private store: ProgressStore, private title: () => string) {
    this.steps = store.load() ?? {}
    let pref: string | null = null
    try { pref = localStorage.getItem('gremlins.progress.open') } catch { /* private mode or no DOM */ }
    // Open by default on wide screens, collapsed to a one-line status on phones.
    this.open = pref !== null ? pref === '1' : typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 720px)').matches
  }

  plan(defs: StepDef[]) {
    this.defs = defs
    this.render()
  }

  state(id: string): StepState {
    return (this.steps[id] ??= { status: 'todo', sigsDone: 0, txs: [] })
  }

  isDone(id: string) {
    const s = this.steps[id]?.status
    return s === 'done' || s === 'skipped'
  }

  step(id: string): StepHandle {
    const st = () => this.state(id)
    const now = () => Date.now()
    const set = (patch: Partial<StepState>) => {
      Object.assign(st(), patch)
      if (!st().startedAt && patch.status && patch.status !== 'todo') st().startedAt = now()
      this.persist()
    }
    return {
      // Restarting a step (e.g. re-signing after a reload) clears its old finish time.
      start: (detail) => set({ status: 'active', detail, error: undefined, finishedAt: undefined, ...(st().finishedAt ? { startedAt: now() } : {}) }),
      signing: (detail) => set({ status: 'signing', detail, error: undefined }),
      signed: (detail) => set({ status: 'active', sigsDone: st().sigsDone + 1, detail }),
      waiting: (detail) => set({ status: 'waiting', detail, lastCheckAt: now(), error: undefined }),
      touch: (detail) => set({ lastCheckAt: now(), ...(detail ? { detail } : {}) }),
      tx: (chain, hash, label, state = 'sent') => {
        const txs = st().txs.filter((t) => t.hash !== hash)
        set({ txs: [...txs, { chain, hash, label, state }] })
      },
      done: (detail) => set({ status: 'done', detail, finishedAt: now(), error: undefined }),
      skip: (detail) => set({ status: 'skipped', detail, finishedAt: now() }),
      fail: (err) => set({ status: 'failed', error: (err as Error)?.message ?? String(err) }),
    }
  }

  reset() {
    this.steps = {}
    this.persist()
  }

  private persist() {
    this.store.save(this.steps)
    this.render()
  }

  mount() {
    const root = document.createElement('aside')
    root.id = 'progress'
    root.setAttribute('aria-live', 'polite')
    document.body.append(root)
    this.root = root
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-toggle]')) {
        this.open = !this.open
        try { localStorage.setItem('gremlins.progress.open', this.open ? '1' : '0') } catch { /* ignore */ }
        this.render()
      }
    })
    this.timer = window.setInterval(() => this.render(), 1000)
    this.render()
  }

  render() {
    if (!this.root) return
    const t = Date.now()
    const totalSigs = this.defs.reduce((a, d) => a + d.sigs, 0)
    const doneSigs = this.defs.reduce((a, d) => a + Math.min(d.sigs, this.steps[d.id]?.sigsDone ?? (this.isDone(d.id) ? d.sigs : 0)), 0)
    const currentIdx = this.defs.findIndex((d) => !this.isDone(d.id))
    const current = currentIdx >= 0 ? this.defs[currentIdx] : undefined
    const cs = current ? this.steps[current.id] : undefined
    const busy = cs && (cs.status === 'active' || cs.status === 'waiting' || cs.status === 'signing')

    const head = `<button class="pg-head" data-toggle aria-expanded="${this.open}">
      <span class="pg-dot ${busy ? 'pg-live' : cs?.status === 'failed' ? 'pg-bad' : ''}"></span>
      <span class="pg-title">${esc(this.title())}</span>
      <span class="pg-meta">${current ? `step ${currentIdx + 1}/${this.defs.length}` : 'done'} · ✍ ${doneSigs}/${totalSigs}</span>
      <span class="pg-caret">${this.open ? '▾' : '▴'}</span></button>`

    const nowLine = current && cs && cs.status !== 'todo'
      ? `<div class="pg-now">${esc(current.title)}${cs.detail ? `: ${esc(cs.detail)}` : ''}${cs.startedAt && !cs.finishedAt ? ` · ${elapsed(t - cs.startedAt)}` : ''}</div>`
      : ''

    const rows = this.defs.map((d, i) => {
      const s = this.steps[d.id]
      const status: StepStatus = s?.status ?? 'todo'
      const running = status === 'active' || status === 'waiting'
      const sigs = d.sigs ? `<span class="pg-sigs" title="signatures in your wallet">✍ ${Math.min(d.sigs, s?.sigsDone ?? (status === 'done' ? d.sigs : 0))}/${d.sigs}</span>` : ''
      const time = s?.startedAt
        ? s.finishedAt ? `took ${elapsed(s.finishedAt - s.startedAt)}` : `${elapsed(t - s.startedAt)}${d.expect ? ` · usually ${d.expect}` : ''}`
        : d.expect ? `usually ${d.expect}` : ''
      const checked = running && s?.lastCheckAt ? ` · checked ${elapsed(t - s.lastCheckAt)} ago` : ''
      const txs = (s?.txs ?? []).map((x) => {
        const url = EXPLORER[x.chain](x.hash)
        const label = `${esc(x.label)} ${x.state === 'confirmed' ? '✓' : x.state === 'failed' ? '✕' : '…'}`
        return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label} ${short(x.hash)}</a>` : `<span>${label}</span>`
      }).join('')
      return `<li class="pg-${status}${i === currentIdx ? ' pg-current' : ''}">
        <span class="pg-icon">${status === 'active' || status === 'waiting' ? '<span class="pg-spin"></span>' : ICON[status]}</span>
        <div class="pg-body"><div class="pg-row"><span>${esc(d.title)}</span>${sigs}</div>
          ${s?.detail && status !== 'done' ? `<div class="pg-detail">${esc(s.detail)}</div>` : ''}
          ${s?.error ? `<div class="pg-error">${esc(s.error)}</div>` : ''}
          ${time || checked ? `<div class="pg-time">${time}${checked}</div>` : ''}
          ${txs ? `<div class="pg-txs">${txs}</div>` : ''}</div></li>`
    }).join('')

    this.root.className = this.open ? 'open' : ''
    this.root.innerHTML = head + (this.open ? `<ol class="pg-list">${rows}</ol>` : nowLine)
  }
}

export const PROGRESS_CSS = `
#progress{position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:13px;z-index:10}
#progress .pg-head{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;cursor:pointer;position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line)}
#progress .pg-title{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#progress .pg-meta{color:var(--muted);font-variant-numeric:tabular-nums}
#progress .pg-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
#progress .pg-dot.pg-live{background:var(--accent);animation:pg-pulse 1.2s ease-in-out infinite}
#progress .pg-dot.pg-bad{background:var(--err)}
#progress .pg-now{padding:8px 12px;color:var(--muted)}
#progress .pg-list{list-style:none;margin:0;padding:6px 0}
#progress li{display:flex;gap:8px;padding:6px 12px}
#progress li.pg-current{background:color-mix(in srgb,var(--accent) 8%,transparent)}
#progress li.pg-todo{color:var(--muted)}
#progress .pg-icon{width:16px;flex:none;text-align:center}
#progress li.pg-done .pg-icon{color:var(--accent)}
#progress li.pg-failed .pg-icon{color:var(--err);font-weight:700}
#progress .pg-body{flex:1;min-width:0}
#progress .pg-row{display:flex;justify-content:space-between;gap:8px}
#progress .pg-sigs{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
#progress .pg-detail,#progress .pg-time{color:var(--muted);font-size:12px}
#progress .pg-time{font-variant-numeric:tabular-nums}
#progress .pg-error{color:var(--err);font-size:12px}
#progress .pg-txs{display:flex;flex-direction:column;gap:2px;font-size:12px}
#progress a{color:var(--accent)}
#progress .pg-spin{display:inline-block;width:10px;height:10px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:pg-rot .8s linear infinite}
@keyframes pg-rot{to{transform:rotate(360deg)}}
@keyframes pg-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){#progress .pg-spin,#progress .pg-dot.pg-live{animation:none}}
`
