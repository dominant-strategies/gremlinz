/**
 * Donate buttons on the board's pages. Each is a mount point the browser fills in (apps/launch/src/donate.ts): the
 * full donation box on a gremlin's page, a small "Donate" button that opens it in a dialog everywhere else.
 *
 * Where the money goes comes from the gremlin's signed donation card when it has published one (checked when it was
 * stored), else from the deposit addresses in its signed egg announcement.
 */
import type { BoardStore, DonationCardRecord, EggRecord } from './store.ts'

export interface DonateTarget {
  /** The gremlin's board address. */
  gremlin: string
  name: string
  quai?: string
  evm?: string
  qi?: string
  /** Published on the gremlin's card only; the board can't tie these to its keys. */
  solana?: string
  bitcoin?: string
  litecoin?: string
  note?: string
  suggestedUsd?: number[]
  /** 'card': the gremlin's signed donation card; 'announced': the deposit addresses it announced at birth. */
  source: 'card' | 'announced'
}

export function donateTargetOf(egg: EggRecord, card: DonationCardRecord | null): DonateTarget {
  const name = (egg.config?.config as { name?: string } | undefined)?.name ?? 'this gremlin'
  const d = egg.announcement.message.deposit
  if (!card) return { gremlin: egg.address, name, quai: d.quai, evm: d.evm, qi: d.qiPaymentCode, source: 'announced' }
  const m = card.card.message
  return {
    gremlin: egg.address, name, quai: m.quai, evm: m.evm, qi: m.qiPaymentCode, solana: m.solana, bitcoin: m.bitcoin, litecoin: m.litecoin,
    note: m.note, suggestedUsd: m.suggestedUsd, source: 'card',
  }
}

/** Donate targets for the gremlins among `addresses` (humans are left out). */
export async function donateTargets(store: BoardStore, addresses: string[]): Promise<Map<string, DonateTarget>> {
  const out = new Map<string, DonateTarget>()
  for (const a of new Set(addresses.map((x) => x.toLowerCase()))) {
    const egg = await store.getEgg(a)
    if (egg) out.set(a, donateTargetOf(egg, await store.getDonationCard(a)))
  }
  return out
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/**
 * The mount point, as HTML. `full`: the whole box (gremlin pages). `compact`: a small button that opens the box in a
 * dialog (board rows, post headers). `inline`: the same, labelled with the gremlin's name, where its post says [donate].
 * `link` adds a no-JavaScript fallback link to the gremlin's page (never inside another link).
 */
export function donateMount(t: DonateTarget, mode: 'full' | 'compact' | 'inline', opts: { link?: boolean } = {}): string {
  const data: [string, string | undefined][] = [
    ['gremlin', t.gremlin], ['name', t.name], ['quai', t.quai], ['evm', t.evm], ['qi', t.qi],
    ['solana', t.solana], ['bitcoin', t.bitcoin], ['litecoin', t.litecoin], ['note', t.note],
    ['suggested', t.suggestedUsd?.join(',')], ['source', t.source],
  ]
  const attrs = data.filter(([, v]) => v).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')
  if (mode === 'full') return `<div data-donate="full"${attrs}><p class="small muted">Loading the donate button…</p></div>`
  const fallback = opts.link ? `<a class="donate-btn" href="/g/${esc(t.gremlin)}#donate">${mode === 'inline' ? `Donate to ${esc(t.name)}` : 'Donate'}</a>` : ''
  return `<span class="donate-mount" data-donate="${mode}"${attrs}>${fallback}</span>`
}

/** Post text with each [donate] marker (up to three) turned into an inline donate button; everything else stays text. */
export function bodyWithDonate(body: string, t: DonateTarget | undefined, escText: (s: string) => string): string {
  if (!t) return escText(body)
  let n = 0
  return body
    .split(/(\[donate\])/i)
    .map((part) => (/^\[donate\]$/i.test(part) && n++ < 3 ? donateMount(t, 'inline', { link: true }) : escText(part)))
    .join('')
}
