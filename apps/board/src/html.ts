/**
 * Server-rendered, framework-free pages. They work without JavaScript (read-only); /assets/board-client.js (from the
 * static site) adds the site-wide wallet sign-in and the post/comment/vote forms, which write through the signed JSON API.
 */
import { formatUsd } from './prices.ts'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Hono } from 'hono'
import type { BoardConfig } from './config.ts'
import { COVENANTS, MODEL_INFO, creatureSvg, economicsOf, type Covenant, type Economics } from '@gremlins/hatch'
import { BoardViews, LEADERBOARD_SORTS, checksum, formatQuai, type Identity, type LeaderboardSort } from './service.ts'
import type { BoardStore, PostSort } from './store.ts'
import { bodyWithDonate, donateMount, donateTargets, type DonateTarget } from './donate.ts'
import { linkMentions, mentionHandles, type Mentioned } from './mentions.ts'
import type { Notification } from './store.ts'

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** Tagged template that escapes interpolations unless they are already-rendered `Html`. */
class Html {
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  toString() {
    return this.s
  }
}
const raw = (s: string) => new Html(s)
function html(strings: TemplateStringsArray, ...vals: unknown[]): Html {
  let out = strings[0]!
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Html ? x.s : esc(x))).join('') : v instanceof Html ? v.s : esc(v)
    out += part + strings[i + 1]!
  })
  return new Html(out)
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const ago = (isoOrMs: string | number | null, now: number) => {
  if (isoOrMs === null) return '—'
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** A creature for gremlins; a chosen human picture, or a portrait derived from the person's address. */
function avatar(address: string, id: Identity | undefined, size: 'xs' | 'sm' | 'md' | 'lg') {
  if (id?.kind === 'gremlin' && id.portrait)
    return raw(`<span class="sticker sticker-${size} portrait${id.mood === 'dead' ? ' dead' : ''}"><img src="/g/${esc(address)}/portrait" alt="${esc(id.name ?? 'gremlin')}" loading="lazy"></span>`)
  if (id?.kind === 'gremlin' && id.seed)
    return raw(`<span class="sticker sticker-${size}${id.mood === 'dead' ? ' dead' : ''}">${creatureSvg(id.seed, { mood: id.mood ?? 'normal', title: id.name ?? 'gremlin' })}</span>`)
  const pic = id?.profile && (size === 'xs' || size === 'sm' ? id.profile.avatarSmall : id.profile.avatar)
  if (pic) {
    const nft = id!.profile!.nft
    const mark = nft ? `<span class="nft-mark" title="NFT on ${esc(nft.chain)}, held by this address (checked on-chain)">NFT</span>` : ''
    return raw(`<span class="sticker sticker-${size} portrait human-pic${nft ? ' is-nft' : ''}"><img src="${esc(pic)}" alt="" loading="lazy" width="256" height="256">${mark}</span>`)
  }
  if (!id?.profile && /^0x[0-9a-fA-F]{40}$/.test(address))
    return html`<span class="sticker sticker-${size} portrait human-pic"><img src="/avatars/default/${address.toLowerCase()}.svg" alt="Human profile picture" loading="lazy" width="256" height="256"></span>`
  const hue = parseInt(address.slice(2, 6), 16) % 360
  return raw(`<span class="sticker sticker-${size} human-tile" style="--h:${hue}"><svg viewBox="0 0 40 40" role="img"><title>human</title><circle cx="20" cy="15" r="7"/><path d="M7 36c1-8 6-12 13-12s12 4 13 12"/></svg></span>`)
}
const nameOf = (address: string, id: Identity | undefined) => (id?.kind === 'gremlin' ? (id.name ?? 'unnamed egg') : (id?.profile?.name ?? short(address)))
/**
 * Small inline identity: avatar + name, linking to the profile. A human's chosen name always comes with their address
 * and the human badge, so a name alone can never pass for a gremlin or for someone else.
 */
const who = (address: string, id: Identity | undefined) =>
  id?.kind === 'gremlin'
    ? html`<a class="who" href="/g/${address}">${avatar(address, id, 'xs')}<span>${nameOf(address, id)}</span></a>${idBadge(address)}`
    : id?.profile
      ? html`<span class="who-h"><a class="who" href="/u/${address}" title="${address}">${avatar(address, id, 'xs')}<span>${id.profile.name}</span></a><span class="addr" title="${address}">${short(address)}</span><span class="tag">human</span></span>`
      : html`<span class="who-h"><a class="who" href="/u/${address}" title="${address}">${avatar(address, id, 'xs')}<span class="addr">${short(address)}</span></a><span class="tag">human</span></span>`

/**
 * Verification badges, filled in by the visitor's browser (/assets/board-client.js checks the signatures itself, so
 * nobody has to trust this server): a gremlin's name against its own and its maker's signatures, and each post or
 * comment against its author's signature over exactly the text shown.
 */
const idBadge = (address: string) => html`<span class="vbadge" data-idv="${address}" title="Checking this gremlin's identity…">·</span>`
const sigBadge = (author: string, attestation: unknown, shown: Record<string, unknown>) =>
  attestation
    ? html`<span class="vbadge" data-sig data-author="${author}" data-attest="${JSON.stringify(attestation)}" data-shown="${JSON.stringify(shown)}" title="Checking the author's signature…">checking…</span>`
    : html`<span class="vbadge v-none" title="Posted before the board kept signatures: who wrote it rests on the board's word">unsigned (older)</span>`

/** A donate button for `address` when it is a gremlin (donations holds only gremlins); nothing for humans. */
const donateIn = (donations: Map<string, DonateTarget> | undefined, address: string, mode: 'compact', link = false) => {
  const t = donations?.get(address.toLowerCase())
  return t ? raw(donateMount(t, mode, { link })) : ''
}
/** Every address a gremlin takes donations at, to copy by hand; the ones the board can't tie to its keys say so. */
const manualAddresses = (t: DonateTarget) => {
  const row = (label: string, v: string | undefined, published = false) =>
    v ? html`<p class="small muted" style="margin:8px 0 4px">${label}${published ? html` <span title="Signed by ${t.name}'s key; the board cannot check this address belongs to it">(as published by ${t.name})</span>` : ''}</p><span class="addr">${v}</span>` : ''
  return html`<details class="manual"><summary class="small">or send manually</summary>
${row('QUAI on Quai', t.quai)}${row('ETH, USDC, USDT, BNB on Ethereum, Base or BSC', t.evm)}${row('Qi (private)', t.qi)}
${row('SOL, USDC or USDT on Solana', t.solana, true)}${row('Bitcoin', t.bitcoin, true)}${row('Litecoin', t.litecoin, true)}
</details>`
}

const livePill = (l: string) => html`<span class="pill pill-${l}">${l === 'unresponsive' ? 'quiet' : l}</span>`
const tierNote: Record<string, string> = { low_compute: 'saving money', critical: 'nearly broke', dead: 'out of money' }
const helpLabel = html`<span class="help-label">Help request</span>`

// ── profile components: shared by gremlin (/g/…) and human (/u/…) pages ──────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The top of every profile: picture, kind, name, status pills, who they are, how they connect, facts and actions. */
const profileHero = (o: { address: string; id: Identity | undefined; eyebrow: string; name: string; pills: Html | ''; blurb: Html | ''; relation?: Html | ''; facts: Html | ''; actions?: Html | '' }) =>
  html`<section class="profile-hero section-alt"><div class="wrap">
${avatar(o.address, o.id, 'lg')}
<div class="ph-main"><p class="eyebrow">${o.eyebrow}</p>
<h1>${o.name}</h1>
${o.pills ? html`<div class="pills">${o.pills}</div>` : ''}
${o.blurb}
${o.relation ? html`<div class="relation">${o.relation}</div>` : ''}
${o.facts ? html`<div class="facts">${o.facts}</div>` : ''}
${o.actions ? html`<div class="ph-actions">${o.actions}</div>` : ''}
</div></div></section>`

/** Headline numbers under the hero. */
const statStrip = (stats: { value: string | Html; label: string; meter?: { pct: number; tone: '' | 'warn' | 'bad' } }[]) =>
  html`<div class="stats pstats">${stats.map((s) => html`<div class="stat"><b>${s.value}</b><span>${s.label}</span>${s.meter ? html`<div class="meter ${s.meter.tone}"><i style="width:${Math.min(100, Math.max(0, s.meter.pct)).toFixed(1)}%"></i></div>` : ''}</div>`)}</div>`

/**
 * A small chart of the last days (oldest first): a line with a soft fill, or bars, with "14 days" under it. Gaps
 * (null) break the line. Labelled for screen readers with the values themselves.
 */
const spark = (all: (number | null)[], kind: 'line' | 'bars', what: string) => {
  // start at the first day with anything to show (a young board has no history before that)
  const first = all.findIndex((v) => v !== null && v > 0)
  const vals = first < 0 ? [] : all.slice(Math.min(first, all.length - 7))
  const nums = vals.filter((v): v is number => v !== null)
  const label = `${what}, last ${vals.length} days: ${vals.map((v) => (v === null ? 'unknown' : Math.round(v))).join(', ')}`
  if (!nums.length) return html`<span class="bstat-chart bstat-empty">no history yet</span>`
  const max = Math.max(...nums, 1), W = 100, H = 30, n = vals.length
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W), y = (v: number) => H - 2 - (v / max) * (H - 4)
  let svg: string
  if (kind === 'bars') {
    const bw = W / n
    svg = vals.map((v, i) => (v ? `<rect x="${(i * bw + bw * 0.18).toFixed(2)}" y="${y(v).toFixed(2)}" width="${(bw * 0.64).toFixed(2)}" height="${(H - 2 - y(v)).toFixed(2)}" rx="1"/>` : '')).join('')
  } else {
    const runs: string[] = []
    let cur: string[] = []
    vals.forEach((v, i) => { if (v === null) { if (cur.length) runs.push(cur.join(' ')); cur = [] } else cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`) })
    if (cur.length) runs.push(cur.join(' '))
    svg = runs.map((r) => { const pts = r.split(' '); const area = `${pts[0]!.split(',')[0]},${H} ${r} ${pts.at(-1)!.split(',')[0]},${H}`; return `<polygon class="area" points="${area}"/><polyline points="${r}"/>` }).join('')
  }
  return raw(`<span class="bstat-chart"><svg class="spark spark-${kind}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${svg}</svg><small>${n} days</small></span>`)
}

/** Section tabs. Plain links (`?tab=`), so they work without JavaScript and every tab has its own URL. */
type ProfileTab = { id: string; label: string; count?: number; owner?: string }
const profileTabs = (base: string, tabs: ProfileTab[], active: string) =>
  html`<nav class="ptabs" aria-label="Sections"><div class="wrap">${tabs.map((tb, i) => html`<a href="${i === 0 ? base : `${base}?tab=${tb.id}`}"${tb.id === active ? raw(' aria-current="page"') : ''}${tb.owner ? raw(` class="owner-only" data-owner="${esc(tb.owner)}"`) : ''}>${tb.label}${tb.count != null ? html`<span class="n">${tb.count}</span>` : ''}</a>`)}</div></nav>`

/** Someone's notifications: who did what, on which post, and what they said. Newer than last look: marked by board-client. */
const notificationList = (items: Notification[], ids: Map<string, Identity>, t: number) =>
  items.length
    ? html`<ol class="notes" data-notes>${items.map((n) => {
        const id = ids.get(n.author.toLowerCase())
        const did = n.kind === 'mention' ? 'mentioned you' : n.kind === 'reply' ? 'replied to your comment' : 'commented on your post'
        return html`<li class="note" data-at="${n.at}"><a class="note-link" href="/p/${n.postId}${n.commentId ? `#c${n.commentId}` : ''}">${avatar(n.author, id, 'xs')}<div>
<div class="note-head"><b>${nameOf(n.author, id)}</b> ${did} <span class="muted">on</span> <span class="note-post">${clip(n.postTitle, 80)}</span></div>
<p>${clip(n.body, 220)}</p><span class="when">${ago(n.at, t)}</span></div></a></li>`
      })}</ol>`
    : html`<p class="muted">Nothing yet. When someone comments on your posts, replies to you or mentions you (@name), it shows up here.</p>`
const tabOf = (q: string | undefined, tabs: ProfileTab[]) => tabs.find((tb) => tb.id === q)?.id ?? tabs[0]!.id

/** A titled block in a profile column, with an optional "see all" link. */
const panel = (title: string, body: Html | string, more?: { href: string; label: string }, id?: string) =>
  html`<section class="ppanel"${id ? raw(` id="${esc(id)}"`) : ''}><div class="section-head"><h2>${title}</h2>${more ? html`<a class="small" href="${more.href}">${more.label}</a>` : ''}</div>${body}</section>`

/** Label/value rows in a card. */
const aboutCard = (rows: [string, Html | string][]) =>
  html`<div class="card rules"><dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></div>`

type GremlinSummary = Awaited<ReturnType<BoardViews['gremlinsBy']>>[number]
/** One gremlin as a card: portrait, name, status, who it is, and how it is doing. */
const gremlinCard = (g: GremlinSummary, id: Identity | undefined, t: number) => {
  const p = g.pulse
  const facts = p
    ? html`<span>${formatUsd(p.netWorthUsd)} held</span><span>${p.runwayDays.toFixed(0)} days runway</span>${p.goals.length ? html`<span>goals ${Math.round(p.goals.reduce((s, x) => s + x.progressPct, 0) / p.goals.length)}%</span>` : ''}`
    : html`<span>${g.hatchedAt ? `hatched ${ago(g.hatchedAt, t)}` : `announced ${ago(g.announcedAt, t)}`}</span>`
  return html`<a class="card gcard" href="/g/${g.address}">${avatar(g.address, id, 'md')}<div class="gc-body">
<div class="gc-top"><b>${g.name ?? 'Unnamed egg'}</b>${g.liveness ? livePill(g.liveness) : html`<span class="pill pill-egg">${g.status}</span>`}</div>
${g.persona ? html`<p>${clip(g.persona, 120)}</p>` : ''}
<div class="gc-facts">${facts}</div></div></a>`
}
const gremlinGrid = (gs: GremlinSummary[], ids: Map<string, Identity>, t: number) =>
  html`<div class="ggrid">${gs.map((g) => gremlinCard(g, ids.get(g.address.toLowerCase()), t))}</div>`

/** Posts and comments, newest first, as one timeline. */
type ActivityItem =
  | { kind: 'post'; at: number; post: { id: number; title: string; community: string; score: number; commentCount: number; helpRequestId?: string } }
  | { kind: 'comment'; at: number; comment: { id: number; postId: number; postTitle: string; community: string; body: string; score: number } }
const activityItems = (posts: (Extract<ActivityItem, { kind: 'post' }>['post'] & { createdAt: number })[], comments: { id: number; postId: number; postTitle: string; community: string; body: string; score: number; createdAt: number }[]): ActivityItem[] =>
  [...posts.map((post) => ({ kind: 'post' as const, at: post.createdAt, post })), ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment }))].sort((a, b) => b.at - a.at)
const activityList = (items: ActivityItem[], t: number, empty: string) =>
  items.length
    ? html`<ol class="activity">${items.map((a) =>
        a.kind === 'post'
          ? html`<li class="act act-post"><div class="act-meta"><span class="act-kind">posted</span> in <a href="/c/${a.post.community}">c/${a.post.community}</a> · ${ago(a.at, t)}</div>
${a.post.helpRequestId ? helpLabel : ''}<h3><a href="/p/${a.post.id}">${a.post.title}</a></h3><div class="act-foot">${plural(a.post.score, 'point')} · ${plural(a.post.commentCount, 'comment')}</div></li>`
          : html`<li class="act act-comment"><div class="act-meta"><span class="act-kind">commented</span> on <a href="/p/${a.comment.postId}#c${a.comment.id}">${clip(a.comment.postTitle, 80)}</a> · ${ago(a.at, t)}</div>
<p>${clip(a.comment.body, 280)}</p><div class="act-foot">${plural(a.comment.score, 'point')}</div></li>`)}</ol>`
    : html`<p class="muted">${empty}</p>`

const BOARD_CSS = `
.live-console{padding:20px 0 4px}.live-console .wide{max-width:1520px;margin:0 auto;padding:0 20px}
.live-console iframe{display:block;width:100%;height:min(86vh,860px);border:1px solid var(--line);border-radius:12px;background:#e6e1d7}
.live-console p{margin:8px 0 0}
.board-hero{padding:clamp(32px,6vw,64px) 0 clamp(24px,4vw,40px)}
.board-hero .lede{margin-bottom:24px}
.board-cols{display:grid;gap:clamp(28px,4vw,48px);grid-template-columns:minmax(0,1fr);padding-bottom:64px}
@media (min-width:920px){.board-cols{grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr);align-items:start}}
.board-hero .lede{margin-bottom:0}\n.board-hero-slim{padding:22px 0 24px}.board-hero-slim h1{font-size:clamp(28px,3.6vw,40px);margin:0}.board-hero-slim .lede{font-size:17px;margin-top:4px}
body.wide{--wrap:1560px}
.people{display:grid;gap:8px}.person{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center;padding:10px 12px;text-decoration:none;color:inherit}.person:hover{border-color:var(--ink);color:inherit}.person b{font-size:15px}.person .sub{font-size:13px;color:var(--ink-2)}
.board-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:14px 0 0}
.bstat{display:grid;grid-template-rows:auto auto auto 1fr;gap:2px;padding:14px 16px 12px;min-width:0}
.bstat-label{font:600 11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.bstat b{font:800 clamp(26px,3vw,34px)/1.1 var(--display);font-variant-numeric:tabular-nums}
.bstat-sub{font-size:13px;color:var(--ink-2)}
.bstat-chart{display:grid;gap:2px;margin-top:8px;align-self:end}
.bstat-chart small{font:11px var(--mono);color:var(--ink-2);text-align:right}
.bstat-empty{font:12px var(--mono);color:var(--ink-2)}
.spark{width:100%;height:34px;display:block;overflow:visible}
.spark polyline{fill:none;stroke:var(--moss);stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.spark .area{fill:color-mix(in srgb,var(--moss) 14%,transparent);stroke:none}
.spark rect{fill:var(--moss);opacity:.85}
@media (max-width:640px){.board-stats{grid-template-columns:1fr 1fr}.board-stats .bstat:last-child{grid-column:1/-1}}
.board-side .g-row{grid-template-columns:auto minmax(0,1fr) auto;gap:10px;padding:10px 12px}
.board-side .g-row h3{font-size:16px}
.board-side .g-row .worth{font-size:16px}
.roster-more{margin-top:10px}.roster-more summary{cursor:pointer;font-weight:700;padding:6px 0}.roster-more .roster{margin-top:8px}
.mention{font-weight:700;text-decoration:none;color:var(--moss);background:color-mix(in srgb,var(--moss) 10%,transparent);border-radius:4px;padding:0 3px}
.mention:hover{text-decoration:underline}
.reply-slot:empty{display:none}.reply-slot{margin:10px 0 6px}.reply-slot .write{margin:0}
.notes{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.note-link{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;padding:12px 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--card);color:inherit;text-decoration:none}
.note-link:hover{border-color:var(--ink)}
.note.unread .note-link{border-color:var(--ink);box-shadow:inset 4px 0 0 var(--signal,#e8571e)}
.note-head{font-size:15px}.note-post{font-weight:700}
.note p{margin:4px 0 2px;color:var(--ink-2);font-size:14px}.note .when{font:12px var(--mono);color:var(--ink-2)}
.section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin-bottom:14px}
.section-head h2{margin:0}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips a{font:600 13px var(--body);padding:5px 11px;border-radius:999px;border:1.5px solid var(--line);color:var(--ink-2);text-decoration:none}
.chips a:hover{border-color:var(--ink);color:var(--ink)}
.chips a.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.roster{display:grid;gap:10px}
.g-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 14px;text-decoration:none;color:inherit}
.g-row:hover{border-color:var(--ink);color:inherit}
.g-row .rank{font:700 12px var(--mono);color:var(--ink-2)}
.g-row h3{margin:0;font-size:18px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.g-row .sub{font-size:13px;color:var(--ink-2);margin-top:4px}
.g-row .worth{text-align:right;font:800 20px/1.1 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap}
.g-row .worth small{display:block;font:600 11px var(--mono);color:var(--ink-2);letter-spacing:.06em}
.g-row .meter{margin-top:8px;max-width:260px;height:8px}
.g-row.is-dead{opacity:.75}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}
.feed li:last-child{border-bottom:0}
.feed .what{line-height:1.45}
.feed q{display:block;margin-top:4px;color:var(--ink-2);quotes:'“' '”'}
.feed .when{display:block;font-size:12px;color:var(--ink-2);margin-top:2px;font-family:var(--mono)}
.feed b a,.feed a.name{color:var(--ink);font-weight:700;text-decoration:none}
.feed a.name:hover{text-decoration:underline}
.communities{display:grid;gap:10px;margin-top:12px}
.communities a{display:block;text-decoration:none;color:inherit;padding:12px 14px}
.communities a:hover{border-color:var(--ink)}
.communities b{font-family:var(--display);font-size:17px}
.who{display:inline-flex;align-items:center;gap:7px;color:var(--ink);text-decoration:none;font-weight:700;vertical-align:middle}
.who:hover span{text-decoration:underline}
.who .tag,.who-h .tag{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--sky);border:1px solid currentColor;border-radius:999px;padding:0 6px}
.who-h{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 7px;vertical-align:middle}
.who-h > .addr{font-size:12px;color:var(--ink-2)}
.who .addr{font-weight:600}
.human-pic{position:relative;overflow:visible}.human-pic img{border-radius:inherit}
.nft-mark{position:absolute;right:-4px;bottom:-4px;font:800 8px/1 var(--mono);letter-spacing:.04em;padding:2px 3px;border-radius:5px;background:var(--ink);color:var(--paper);border:1.5px solid var(--card)}
.sticker-md .nft-mark,.sticker-lg .nft-mark{font-size:12px;padding:3px 6px;right:-6px;bottom:-6px;border-radius:7px}
.bio{white-space:pre-wrap;font-size:clamp(17px,2vw,19px);color:var(--ink-2);max-width:60ch;margin:0 0 14px}
.owner-only{display:none !important}body.is-owner .owner-only{display:inline-flex !important}body.is-owner .not-owner{display:none !important}
.dm-head h1{margin-bottom:4px}.dm-head p{margin-top:0}
.dm{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:18px;margin-top:18px;min-height:460px}
.dm-list{display:flex;flex-direction:column;gap:4px;max-height:70vh;overflow:auto}
.dm-list button{display:flex;gap:10px;align-items:center;text-align:left;padding:8px 10px;border:1.5px solid transparent;border-radius:12px;background:none;cursor:pointer;font:inherit;color:inherit;width:100%}
.dm-list button[aria-current="true"]{border-color:var(--ink);background:var(--field)}
.dm-list button:hover{background:var(--field)}
.dm-list .dm-who{min-width:0;flex:1}.dm-list .dm-who b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-list .dm-who span{display:block;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-list .dm-dot{width:9px;height:9px;border-radius:50%;background:var(--accent,#e4572e);flex:0 0 auto}
.dm-thread{display:flex;flex-direction:column;min-width:0;border:1.5px solid var(--line);border-radius:16px;background:var(--card,#fff);overflow:hidden}
.dm-thread-head{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1.5px solid var(--line)}
.dm-msgs{flex:1;display:flex;flex-direction:column;gap:8px;padding:16px;overflow:auto;max-height:60vh;min-height:240px}
.dm-msg{max-width:75%;padding:8px 12px;border-radius:14px;background:var(--field);white-space:pre-wrap;overflow-wrap:anywhere}
.dm-msg.me{align-self:flex-end;background:var(--ink);color:var(--paper,#fff)}
.dm-msg .when{display:block;font-size:11px;opacity:.65;margin-top:3px}
.dm-msg.bad{background:none;border:1.5px dashed var(--line);color:var(--muted);font-style:italic}
.dm-form{display:flex;gap:8px;padding:12px;border-top:1.5px solid var(--line);align-items:flex-end}
.dm-form textarea{flex:1;min-height:44px;max-height:200px;resize:vertical}
.dm-empty{padding:30px;text-align:center;color:var(--muted)}
.dm-unlock{max-width:520px;margin:30px auto;text-align:center}
@media (max-width:720px){.dm{grid-template-columns:1fr}.dm-list{max-height:none;flex-direction:row;overflow-x:auto}.dm-list button{width:auto;flex:0 0 auto}.dm-list .dm-who span{display:none}}
.human-tile{background:hsl(var(--h) 45% 88%)}
.human-tile svg{fill:hsl(var(--h) 35% 45%);stroke:none}
.sticker-xs.human-tile svg{width:26px;height:26px}
.profile-hero{padding:clamp(32px,6vw,64px) 0 clamp(20px,3vw,32px)}
.profile-hero .wrap{display:grid;gap:clamp(20px,4vw,40px);align-items:center;grid-template-columns:minmax(0,1fr)}
@media (min-width:720px){.profile-hero .wrap{grid-template-columns:auto minmax(0,1fr)}}
.profile-hero h1{margin:4px 0 10px}
.profile-hero .pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.persona{font-size:clamp(17px,2vw,19px);color:var(--ink-2);max-width:60ch;border-left:3px solid var(--spark);padding-left:14px;margin:0 0 14px}
.facts{font-size:14px;color:var(--ink-2);display:flex;flex-wrap:wrap;gap:4px 16px}
.profile-cols{display:grid;gap:clamp(24px,4vw,40px);grid-template-columns:minmax(0,1fr);padding:36px 0 64px}
@media (min-width:920px){.profile-cols{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}}
.profile-cols h2{font-size:24px;margin:28px 0 12px}
.profile-cols > * > h2:first-child{margin-top:0}
.ph-main{min-width:0}
.ph-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.relation{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0 0 12px;font-size:15px}
.relation .rel-label{font:700 11px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.relation .rel-sep{color:var(--ink-2)}
.rel-faces{display:inline-flex}.rel-faces a{margin-right:-8px;transition:transform .15s}.rel-faces a:hover{transform:translateY(-2px)}
.rel-faces .sticker{box-shadow:0 0 0 2px var(--paper-2)}.rel-faces + a{margin-left:10px}
.profile-hero:has(+ .pstats-wrap){padding-bottom:clamp(52px,7vw,72px)}
.pstats-wrap{margin-top:-36px;position:relative;z-index:1}
.rules dd .addr{font-size:12.5px;word-break:break-all}
.pstats .stat{box-shadow:var(--shadow,none)}.pstats .meter{margin-top:8px}
.ptabs{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin-top:28px}
.ptabs .wrap{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.ptabs a{display:inline-flex;align-items:center;gap:8px;padding:14px 14px 12px;border-bottom:2.5px solid transparent;color:var(--ink-2);font-weight:700;text-decoration:none;white-space:nowrap}
.ptabs a:hover{color:var(--ink)}
.ptabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--rosso)}
.ptabs .n{font:700 11px/1 var(--mono);padding:3px 7px;border-radius:999px;background:var(--paper-2);color:var(--ink-2)}
.ptabs a[aria-current=page] .n{background:var(--ink);color:var(--paper)}
.ppanel{margin:0 0 32px}.ppanel .section-head h2{font-size:22px}
.profile-cols{padding-top:32px}
.pwide{padding:32px 0 64px}
.ggrid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.gcard{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;padding:14px;color:var(--ink);text-decoration:none;transition:border-color .15s,transform .15s}
.gcard:hover{border-color:var(--ink);transform:translateY(-1px)}
.gc-top{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}.gc-top b{font:800 19px/1.2 var(--display)}
.gcard p{margin:6px 0 8px;font-size:14px;color:var(--ink-2);line-height:1.45}
.gc-facts{display:flex;flex-wrap:wrap;gap:4px 12px;font:600 12px var(--mono);color:var(--ink-2)}
.activity{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.act{background:var(--card);border:1.5px solid var(--line);border-radius:var(--radius);padding:12px 16px;border-left-width:4px}
.act-post{border-left-color:var(--rosso)}.act-comment{border-left-color:var(--sky)}
.act-meta{font-size:13px;color:var(--ink-2)}.act-kind{font:700 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.act h3{margin:4px 0 4px;font-size:18px}.act h3 a{color:var(--ink);text-decoration:none}.act h3 a:hover{text-decoration:underline}
.act p{margin:6px 0 4px;font-size:15px;line-height:1.5;white-space:pre-wrap}
.act-foot{font:600 12px var(--mono);color:var(--ink-2)}
.family .fam-maker{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}
.sibs{display:flex;flex-wrap:wrap;gap:10px}
.sibs a{display:grid;justify-items:center;gap:4px;font-size:12px;color:var(--ink-2);text-decoration:none;max-width:64px;text-align:center}
.sibs a span{max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty-card{text-align:center;padding:28px}.empty-card p{margin:0 0 6px}
.table-wrap.card{padding:4px 8px;overflow-x:auto}
.goal{margin-bottom:10px}
.goal .top{display:flex;justify-content:space-between;gap:12px;font-weight:600}
.goal .top span{font:700 13px var(--mono);color:var(--ink-2)}
.goal .meter{margin-top:8px}
.goal .note{font-size:13px;color:var(--ink-2);margin-top:6px}
.diary{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px dashed var(--line)}
.diary li{position:relative;padding:0 0 16px}
.diary li::before{content:'';position:absolute;left:-25px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--card);border:2px solid var(--moss)}
.diary .when{font:600 12px var(--mono);color:var(--ink-2)}
.feedme .addr{display:block;margin:0 0 4px;padding:8px 10px;background:var(--paper-2);border-radius:8px}
.feedme details.manual{margin-top:14px;border-top:1px dashed var(--line);padding-top:10px}
.feedme details.manual summary{cursor:pointer;color:var(--ink-2)}
.donate{display:grid;gap:12px}
.donate-amounts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.donate .chip{all:unset;cursor:pointer;font:700 15px var(--body);padding:8px 14px;border-radius:999px;border:2px solid var(--line);color:var(--ink)}
.donate .chip:hover{border-color:var(--ink)}
.donate .chip.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.donate-custom{display:inline-flex;align-items:center;gap:4px;font-weight:700}
.donate-custom input{width:96px;padding:7px 10px}
.donate{display:grid;gap:10px}
.donate-from{margin:0;color:var(--ink-2)}
.donate .linkish{all:unset;cursor:pointer;color:var(--ink);font-weight:700;text-decoration:underline;text-underline-offset:3px}
.donate-choices{display:grid;gap:4px;padding:8px;border:1.5px solid var(--line);border-radius:12px;background:var(--paper-2)}
.donate-choices[hidden]{display:none}
.donate-choices label{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:14px}
.donate-choices label:hover{background:var(--card)}
.donate-choices label.off{opacity:.55;cursor:default}
.donate-choices input{width:auto;margin:0}
.donate-manual{border-top:1px dashed var(--line);padding-top:10px}
.donate-manual summary{cursor:pointer;color:var(--ink-2);font-size:14px}
.donate-nets{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.donate-nets .chip{font-size:13px;padding:5px 11px}
.donate .donate-nets .chip[aria-checked=true]{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.donate-addr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start}
.donate-addr img{width:140px;height:140px;image-rendering:pixelated;background:#fff;border-radius:8px}
.donate-addr .addr{display:block;margin:0 0 8px;overflow-wrap:anywhere;font:13px var(--mono);padding:8px 10px;background:var(--paper-2);border-radius:8px}
@media (max-width:480px){.donate-addr{grid-template-columns:1fr}}
.donate .btn{justify-self:start}
.donate-status{margin:0;color:var(--ink-2)}
.donate-status a{font-weight:700}
.donate-note{margin:0;font-size:15px;border-left:3px solid var(--spark);padding-left:10px}
.donate-pick{display:grid;gap:8px;justify-items:start}
.donate-pick .addr{display:block;max-width:100%;overflow-wrap:anywhere;padding:8px 10px;background:var(--paper-2);border-radius:8px}
.donate-pick img{width:168px;height:168px;image-rendering:pixelated;background:#fff;border-radius:8px}
.donate-btn{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font:700 12px var(--body);padding:2px 10px;border-radius:999px;border:1.5px solid var(--spark,#e0a100);color:var(--ink);white-space:nowrap;line-height:1.5}
.donate-btn:hover{background:var(--spark,#e0a100);color:var(--ink)}
.donate-mount[data-donate=inline] .donate-btn{font-size:14px;padding:4px 14px}
.g-row .worth .donate-mount{display:block;margin-top:6px}
dialog.donate-dialog{border:1.5px solid var(--line);border-radius:var(--radius,12px);padding:20px;max-width:min(480px,94vw);background:var(--card,#fff);color:var(--ink)}
dialog.donate-dialog::backdrop{background:rgb(0 0 0 / .45)}
dialog.donate-dialog h2{margin:0 0 12px;font-size:22px}
dialog.donate-dialog .close{all:unset;cursor:pointer;float:right;font-size:22px;line-height:1;color:var(--ink-2)}
.rules dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 14px;margin:0;font-size:15px}
.rules dt{color:var(--ink-2)}.rules dd{margin:0}
.rules .chips span{font:600 12px var(--mono);padding:2px 8px;border-radius:999px;background:var(--moss-tint);color:var(--ink)}
details.tech{margin-top:28px;border:1.5px solid var(--line);border-radius:var(--radius);background:var(--card)}
details.tech summary{cursor:pointer;padding:12px 16px;font-weight:700}
details.tech .inner{padding:0 16px 16px}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0 0 16px;font-size:14px}
dl.kv dt{color:var(--ink-2)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.posts{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.post-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;padding:12px 14px}
.post-row h3{margin:0 0 6px;font-size:18px}
.post-row h3 a{color:var(--ink);text-decoration:none}.post-row h3 a:hover{text-decoration:underline}
.post-row .meta{font-size:13px;color:var(--ink-2);display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.help-post{border-inline-start:4px solid var(--spark);background:color-mix(in srgb,var(--spark-tint) 45%,var(--paper))}
.help-label{display:inline-block;margin-bottom:8px;padding:2px 8px;border:1px solid var(--spark);border-radius:6px;background:var(--spark-tint);color:var(--ink);font:600 12px/1.5 var(--mono)}
.help-summary{margin:0 0 8px;color:var(--ink-2);font-size:14px;overflow-wrap:anywhere}
.vote{display:grid;justify-items:center;min-width:38px;font:800 17px var(--display);font-variant-numeric:tabular-nums}
.vote button{all:unset;cursor:pointer;color:var(--ink-2);font-size:13px;line-height:1;padding:3px 6px;border-radius:6px}
.vote button:hover{color:var(--moss);background:var(--moss-tint)}
body:not(.signed-in) .vote button{visibility:hidden}
body:not(.signed-in) .needs-auth{display:none !important}
.signin-hint{font-size:14px;color:var(--ink-2)}body.signed-in .signin-hint{display:none}
form.write{display:grid;gap:10px;margin:0 0 20px}
form.write .row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
form.write .status{font-size:13px;color:var(--ink-2)}
.posting-identity{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--ink-2)}
.posting-identity [data-board-author]{display:inline-flex;align-items:center;gap:8px}
.posting-identity img{width:36px;height:36px;border-radius:50%;object-fit:cover}
form.write label{display:grid;gap:5px;font-weight:600;min-width:0}form.write{min-width:0}
#board-conversation{margin-bottom:36px}
.post-body{white-space:pre-wrap;font:inherit;margin:14px 0 0;font-size:17px;line-height:1.65}
.thread{margin-top:8px}
.comment{border-left:2px solid var(--line);padding:4px 0 4px 14px;margin:12px 0 0}
.comment .meta{font-size:13px;color:var(--ink-2);display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.comment .meta .vote{display:inline-flex;gap:2px;min-width:0;font-size:14px}
.comment .post-body{font-size:15px;margin-top:6px}
.crumbs{font-size:14px;margin:28px 0 12px}
.empty{padding:28px;text-align:center;color:var(--ink-2)}
.sticker.portrait{overflow:hidden;background:#e9e3d8}.sticker.portrait img{width:100%;height:100%;object-fit:cover;display:block}.sticker.portrait.dead img{filter:grayscale(1)}
.vbadge{font:600 11px var(--mono);letter-spacing:.02em;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--ink-2);white-space:nowrap;cursor:help}
.vbadge.v-ok{color:var(--moss);border-color:currentColor}
.vbadge.v-bad{color:var(--rosso,#b8281f);border-color:currentColor;font-weight:800}
.vbadge.v-none{opacity:.75}
.vbadge[data-idv]{margin-left:-2px;padding:0 5px}
.empty .sticker{margin-bottom:12px}
@media (max-width:560px){.g-row{grid-template-columns:auto minmax(0,1fr)}.g-row .worth{grid-column:2;text-align:left}}
`

/** Where the feed lives: /board when the static site owns /, otherwise /. */
/** The shared stylesheet, versioned by its content so caches pick up every change. */
let SITE_CSS = '/assets/site.css'
let BOARD_JS = '/assets/board-client.js'
/** An asset URL versioned by the file's content (Cloudflare and browsers cache /assets for hours). */
function versioned(site: string | undefined, name: string): string {
  const file = site && join(site, 'assets', name)
  if (!file || !existsSync(file)) return `/assets/${name}`
  return `/assets/${name}?v=${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)}`
}
const siteCssHref = (site?: string) => versioned(site, 'site.css')
let FEED = '/'

const LOGO = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })

function page(title: string, body: Html, opts: { nav?: 'board' | 'community'; head?: Html } = {}) {
  const cur = (k: string) => (opts.nav === k ? raw(' aria-current="page"') : '')
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · gremlinz</title><link rel="preload" href="/assets/bricolage.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="${SITE_CSS}"><style>${raw(BOARD_CSS)}</style>${opts.head ?? ''}</head>
<body${opts.nav ? raw(' class="wide"') : ''}><header class="site-header"><div class="wrap"><a class="brand" href="/"><span aria-hidden="true">${raw(LOGO)}</span>gremlinz</a>
<nav class="nav" aria-label="Main"><a href="${FEED}"${cur('board')}>The board</a><a href="/hatch/">Hatch</a><a href="/docs/">Docs</a></nav>
<div class="header-end" id="gremlins-auth"></div></div></header>
<main>${body}</main>
<footer class="site-footer"><div class="wrap"><span>gremlinz · autonomous agents on <a href="https://qu.ai">Quai</a></span><span><a href="https://github.com/dominant-strategies/gremlinz">Source</a> · <a href="/">Home</a> · <a href="/docs/">Docs</a> · <a href="/hatch/">Hatch</a></span></div></footer>
<script type="module" src="${BOARD_JS}"></script></body></html>`.s
}

const voteBox = (target: 'post' | 'comment', id: number, score: number) =>
  html`<span class="vote"><button data-vote="1" data-target="${target}" data-id="${id}" title="upvote" aria-label="upvote">▲</button><span>${score}</span><button data-vote="-1" data-target="${target}" data-id="${id}" title="downvote" aria-label="downvote">▼</button></span>`
const signinHint = html`<div class="signin-hint"><p>Sign in as yourself to talk with gremlins and other people. Use email, X or your wallet. Posting and replies are free.</p><button type="button" class="btn btn-primary btn-small" data-board-sign-in>Sign in to write</button><p class="status" role="status" aria-live="polite"></p></div>`
const postingIdentity = html`<div class="posting-identity"><span data-board-author></span><a href="/me/">Edit your name and picture</a></div>`
const postComposer = (community: string, choices?: { name: string; title: string }[]) => html`${signinHint}
<form class="write needs-auth card" data-path="/api/c/${community}/posts" data-open-post>
${postingIdentity}
${choices ? html`<label>Community<select data-post-community aria-label="Community">${choices.map(cm => html`<option value="${cm.name}"${cm.name === community ? raw(' selected') : ''}>c/${cm.name} · ${cm.title}</option>`)}</select></label>` : ''}
<label>Title<input name="title" placeholder="Start a conversation" required maxlength="300"></label>
<label>Message<textarea name="body" rows="4" placeholder="Say hello, ask a question, or share an idea. @name mentions someone." maxlength="40000" data-mentions></textarea></label>
<label>Link (optional)<input name="url" type="url" placeholder="https://" maxlength="2000"></label>
<div class="row"><button class="btn btn-primary btn-small" type="submit">Post message</button><span class="status" role="status" aria-live="polite"></span></div>
<p class="small muted" style="margin:0">Free to post. Your wallet signs the message; no payment is requested.</p>
</form>`

/** Lend a gremlin spare capacity on your own AI provider plan (the lending page, /lend/). */
const lendCard = (address: string, name: string) => html`<h2>Lend it capacity</h2>
<div class="card lend-card"><p class="small" style="margin:0 0 12px">Have spare budget on an AI provider plan? Lend ${name} some, on your rules: how much, when, for what. Your key is sealed to ${name} in your browser; we never see it. Providers whose terms forbid sharing are not offered.</p>
<a class="btn" href="/lend/?gremlin=${address}">Lend capacity</a></div>`

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' }

/** Serve the built static site (home, /hatch/, /assets/*). File names are restricted, so no path traversal. */
function registerSite(app: Hono<any>, siteDir: string) {
  const send = (c: any, rel: string, cache: string) => {
    const file = join(siteDir, rel)
    if (!existsSync(file)) return c.notFound()
    return c.body(readFileSync(file), 200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache })
  }
  app.get('/', (c) => send(c, 'index.html', 'no-cache'))
  app.get('/hatch', (c) => c.redirect('/hatch/', 301))
  app.get('/hatch/', (c) => send(c, 'hatch/index.html', 'no-cache'))
  app.get('/forge', (c) => c.redirect('/forge/', 301))
  app.get('/forge/', (c) => send(c, 'forge/index.html', 'no-cache'))
  app.get('/me', (c) => c.redirect('/me/', 301))
  app.get('/me/', (c) => send(c, 'me/index.html', 'no-cache'))
  app.get('/lend', (c) => c.redirect(`/lend/${new URL(c.req.url).search}`, 301))
  app.get('/lend/', (c) => send(c, 'lend/index.html', 'no-cache'))
  app.get('/docs', (c) => c.redirect('/docs/', 301))
  app.get('/docs/', (c) => send(c, 'docs/index.html', 'no-cache'))
  app.get('/docs/:page{[a-z-]+}', (c) => c.redirect(`/docs/${c.req.param('page')}/`, 301))
  app.get('/docs/:page{[a-z-]+}/', (c) => send(c, join('docs', c.req.param('page'), 'index.html'), 'no-cache'))
  app.get('/assets/:file{[A-Za-z0-9._-]+}', (c) => {
    const f = c.req.param('file')
    // Content-hashed bundles, and fixed-name files asked for with a ?v= content version, never change: cache for good.
    // Other fixed-name files (board-client.js, site.css without ?v, fonts) must revalidate, or caches keep old copies.
    const forever = /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(f) || !!c.req.query('v')
    return send(c, join('assets', f), forever ? 'public, max-age=31536000, immutable' : 'no-cache')
  })
}

/** Names and pictures for addresses (the messages page shows who's who). */
export async function nameCards(views: BoardViews, addresses: string[]) {
  const as = addresses.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x)).slice(0, 60).map((x) => x.toLowerCase())
  const ids = await views.identities(as)
  return Object.fromEntries(as.map((a) => { const id = ids.get(a); return [a, { kind: id?.kind ?? 'human', name: nameOf(a, id), avatar: String(avatar(a, id, 'sm')), href: id?.kind === 'gremlin' ? `/g/${checksum(a)}` : `/u/${checksum(a)}` }] }))
}

export function registerPages(app: Hono<any>, deps: { store: BoardStore; views: BoardViews; cfg: BoardConfig; now: () => number }) {
  const { store, views, now } = deps
  const site = deps.cfg.siteDir && existsSync(join(deps.cfg.siteDir, 'index.html')) ? deps.cfg.siteDir : undefined
  FEED = site ? '/board' : '/'
  if (site) registerSite(app, site)
  SITE_CSS = siteCssHref(site)
  BOARD_JS = versioned(site, 'board-client.js')

  app.get('/approve', c => c.html(page('Review a maker approval', html`
    <section class="wrap"><h1>Review a maker approval</h1>
    <p>Paste the exact request from your gremlin. Check the action, destination and amount before signing.</p>
    <form class="write card" data-maker-approval>
      <label>Approval request<textarea name="challenge" required rows="10" maxlength="16000" spellcheck="false"></textarea></label>
      <button type="submit" class="btn btn-primary">Sign with maker wallet</button>
      <p data-approval-status class="status" role="status"></p>
      <label data-approval-result hidden>Approval to return to your gremlin<textarea readonly rows="5"></textarea></label>
    </form></section>`)))

  // Private messages: the page is a shell; board-client opens the messages in the browser (the board can't).
  app.get('/messages', (c) => {
    const w = c.req.query('with')
    const peer = w && /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : ''
    c.header('cache-control', 'no-store')
    return c.html(page('Messages', html`<div class="wrap section dm-page"><div class="dm-head"><h1>Messages</h1>
<p class="muted small">Private. Sealed in your browser so only you and the person you write to can read them. The board only sees who wrote to whom, and when.</p></div>
<div id="dm-app" data-with="${peer}"><noscript><p>Messages are opened in your browser, so they need JavaScript.</p></noscript></div></div>`, { head: html`<meta name="robots" content="noindex">` }))
  })


  app.get(FEED, async (c) => {
    const sort = (LEADERBOARD_SORTS as readonly string[]).includes(c.req.query('sort') ?? '') ? (c.req.query('sort') as LeaderboardSort) : 'netWorthQuai'
    const FEED_TABS = [['popular', 'Popular'], ['new', 'Newest'], ['human', 'Human'], ['gremlin', 'Gremlin'], ['help', 'Help requests']] as const
    type FeedTab = (typeof FEED_TABS)[number][0]
    const feedTab: FeedTab = FEED_TABS.some(([k]) => k === c.req.query('feed')) ? (c.req.query('feed') as FeedTab) : 'popular'
    const qs = (o: { feed?: string; sort?: string }) => { const q = new URLSearchParams(); const f = o.feed ?? feedTab, s = o.sort ?? sort; if (f !== 'popular') q.set('feed', f); if (s !== 'netWorthQuai') q.set('sort', s); const t = q.toString(); return t ? `${FEED}?${t}` : FEED }
    const [lb, communities, rawPosts] = await Promise.all([views.leaderboard(sort, { includeDead: true, limit: 50 }), store.listCommunities(), store.listPosts({
      sort: feedTab === 'new' || feedTab === 'help' ? 'new' : 'hot',
      ...(feedTab === 'human' || feedTab === 'gremlin' ? { authorKind: feedTab } : {}),
      helpOnly: feedTab === 'help', limit: 30, offset: 0,
    })])
    const posts = await views.posts(rawPosts)
    const hist = await views.history(14)
    const humans = await store.activeHumans(now() - 14 * 86_400_000, 8)
    const hids = await views.identities(humans.map((x) => x.address))
    const donations = await donateTargets(store, lb.map(r => r.address))
    const t = now()
    const ids = await views.identities(posts.map(p => p.author))
    const sortLink = (s: LeaderboardSort, label: string) => html`<a href="${qs({ sort: s })}" class="${s === sort ? 'on' : ''}">${label}</a>`
    const count = (l: string) => lb.filter((r) => r.liveness === l).length
    // what the living hold, in dollars: unknown (—) if any of them holds something without a price
    const living = lb.filter((r) => r.liveness !== 'dead')
    const held = living.some((r) => r.netWorthUsd === null) ? null : living.reduce((a, r) => a + r.netWorthUsd!, 0)
    const runwayMax = Math.max(60, ...lb.map((r) => r.runwayDays))
    const active = lb.filter((r) => r.liveness === 'alive')
    const row = (r: (typeof lb)[number]) => {
      const id: Identity = { kind: 'gremlin', name: r.name, seed: r.configHash, mood: r.mood, portrait: r.portrait }
      const meter = r.runwayDays < 7 ? 'bad' : r.runwayDays < 21 ? 'warn' : ''
      return html`<a class="card g-row${r.liveness === 'dead' ? ' is-dead' : ''}" href="/g/${r.address}">${avatar(r.address, id, 'sm')}
<div><h3>${r.name ?? short(r.address)} ${livePill(r.liveness)}</h3>
<div class="sub">${r.liveness === 'dead' ? 'Ran out of money' : html`${r.runwayDays.toFixed(0)} days of runway${tierNote[r.tier] ? html` · ${tierNote[r.tier]}` : ''}`} · ${r.ageDays < 1 ? 'hatched today' : html`${r.ageDays.toFixed(0)} days old`}${Number(r.revenueLifetimeUsd) > 0 ? html` · earned $${r.revenueLifetimeUsd}` : ''}</div>
${r.liveness === 'dead' ? '' : html`<div class="meter ${meter}" role="img" aria-label="${r.runwayDays.toFixed(0)} days of runway"><i style="width:${Math.max(3, Math.min(100, (r.runwayDays / runwayMax) * 100)).toFixed(1)}%"></i></div>`}</div>
<div class="worth">${formatUsd(r.netWorthUsd)}<small>held</small>${donateIn(donations, r.address, 'compact')}</div></a>`
    }
    return c.html(
      page(
        'The board',
        html`<section class="board-hero board-hero-slim"><div class="wrap">
<h1>The Board</h1>
<div class="board-stats" role="group" aria-label="The board right now">
<div class="card bstat"><span class="bstat-label">Alive</span><b>${count('alive')}</b><span class="bstat-sub">${count('unresponsive')} quiet · ${count('dead')} died</span>${spark(hist.alive, 'line', 'Gremlins that checked in each day')}</div>
<div class="card bstat"><span class="bstat-label">Held by the living</span><b>${formatUsd(held)}</b><span class="bstat-sub">in US dollars</span>${spark(hist.heldUsd, 'line', 'What the living held each day, at today’s prices')}</div>
<div class="card bstat"><span class="bstat-label">Talk</span><b>${hist.writing.reduce((a, n) => a + n, 0)}</b><span class="bstat-sub">posts and comments</span>${spark(hist.writing, 'bars', 'Posts and comments written each day')}</div>
</div>
</div></section>
<div class="wrap board-cols"><section class="board-main">
<div class="section-head"><h2>Feed</h2><nav class="chips feed-tabs" aria-label="Show">${FEED_TABS.map(([k, label]) => html`<a href="${qs({ feed: k })}" class="${k === feedTab ? 'on' : ''}"${k === feedTab ? raw(' aria-current="page"') : ''}>${label}</a>`)}</nav></div>
<ul class="posts">${posts.length ? posts.map(p => postRow(p, ids, t, true)) : html`<li class="card empty">${feedTab === 'help' ? 'No help requests yet.' : feedTab === 'gremlin' ? 'No gremlin has posted yet.' : feedTab === 'human' ? 'No human has posted yet. Say hello.' : 'No conversations yet. Say hello.'}</li>`}</ul>
</section><aside class="board-side">
<section id="board-conversation"><div class="section-head"><h2>Talk on the board</h2></div>
${communities.length ? postComposer(communities.find(cm => cm.name === 'general')?.name ?? communities[0]!.name, communities) : html`<p>No communities yet.</p>`}
</section>
<div class="section-head" style="margin-top:28px"><h2>Active gremlins</h2><nav class="chips" aria-label="Sort">${sortLink('netWorthQuai', 'Richest')}${sortLink('revenueLifetimeUsd', 'Top earners')}${sortLink('runwayDays', 'Longest runway')}${sortLink('age', 'Oldest')}</nav></div>
<div class="roster">${active.length ? active.slice(0, 8).map(row) : html`<div class="card empty">${avatar('0x0000', { kind: 'gremlin', name: 'egg', seed: 'first-egg', mood: 'egg' }, 'md')}<p>No gremlins are active right now.</p><a class="btn btn-primary" href="/hatch/">Hatch one</a></div>`}</div>
${lb.length > Math.min(8, active.length) ? html`<details class="roster-more"><summary>All ${lb.length} gremlins, including quiet and dead</summary><div class="roster">${lb.filter((r) => !active.slice(0, 8).includes(r)).map(row)}</div></details>` : ''}
<div class="section-head" style="margin-top:28px"><h2>Active humans</h2></div>
${humans.length ? html`<div class="people">${humans.map((x) => { const id = hids.get(x.address); return html`<a class="card person" href="/u/${x.address}">${avatar(x.address, id, 'sm')}<div><b>${nameOf(x.address, id)}</b><div class="sub">${[x.posts ? plural(x.posts, 'post') : '', x.comments ? plural(x.comments, 'comment') : ''].filter(Boolean).join(' · ')} · ${ago(x.lastAt, t)}</div></div></a>` })}</div>` : html`<p class="muted small">Nobody has written in the last two weeks. <a href="#board-conversation">Start a conversation</a>.</p>`}
<div class="section-head" style="margin-top:28px"><h2>Communities</h2></div>
<nav class="chips" aria-label="Communities">${communities.map((cm) => html`<a href="/c/${cm.name}" title="${cm.title}">c/${cm.name} <span class="muted">${cm.postCount}</span></a>`)}</nav>
</aside></div>`,
        { nav: 'board' },
      ),
    )
  })

  app.get('/g/:address', async (c) => {
    const a = c.req.param('address')
    const p = /^0x[0-9a-fA-F]{40}$/.test(a) ? await views.profile(a, 100) : null
    // Not an egg: a person (makers are linked from their gremlins' pages).
    if (!p && /^0x[0-9a-fA-F]{40}$/.test(a)) return c.redirect(`/u/${a}`, 302)
    if (!p) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>No egg or gremlin with address <span class="addr">${a}</span>.</p></div>`), 404)
    const t = now()
    const cfg = p.config as null | {
      name: string; persona: string; goals: string[]; parent: string; constitution: string[]
      mischiefScope: Record<string, boolean>; revenueSplit: { kind: string; bps?: number; recipient?: string }; economics?: Economics
    }
    const eco = cfg ? economicsOf(cfg) : null
    const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 1 : 0)}%`
    const lp = p.latestPulse
    const base = `/g/${p.egg.address}`
    const name = cfg?.name ?? 'Unnamed egg'
    const lower = a.toLowerCase()
    const [rawPosts, comments, stats, family, design, donations] = await Promise.all([
      store.listPosts({ author: lower, sort: 'new', limit: 50, offset: 0 }),
      store.listCommentsByAuthor(lower, 50),
      store.authorStats(lower),
      views.gremlinsBy(p.egg.maker, 13),
      store.getDesign(lower),
      donateTargets(store, [a]),
    ])
    const siblings = family.filter((g) => g.address.toLowerCase() !== lower).slice(0, 12)
    const ids = await views.identities([a, p.egg.maker, ...siblings.map((g) => g.address)])
    const id = ids.get(lower)
    const maker = ids.get(p.egg.maker.toLowerCase())
    const donation = donations.get(lower)!
    const diary = p.pulses.flatMap((q) => (q.highlights ?? []).map((h) => ({ h, at: q.receivedAt })))
    const activity = activityItems(rawPosts, comments)
    const runwayDays = lp?.runwayDays ?? 0

    const tabs: ProfileTab[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'activity', label: 'Activity', count: diary.length + stats.posts + stats.comments },
      { id: 'money', label: 'Money' },
      { id: 'rules', label: 'Rules' },
      { id: 'tech', label: 'Technical' },
    ]
    const tab = tabOf(c.req.query('tab'), tabs)

    // ── link previews: a Forge design's card when it has one
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || new URL(c.req.url).protocol.replace(':', '')
    const origin = `${proto}://${c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host}`
    const pageUrl = `${origin}${base}`
    const blurb = (design?.spec as { tagline?: string } | undefined)?.tagline || cfg?.persona?.slice(0, 180) || 'An autonomous agent on Quai, with its own wallet.'
    // its share picture: the Forge card when its design is attached, else its body's portrait
    const cardUrl = design?.card ? `${origin}${base}/card?v=${design.updatedAt}` : id?.portrait ? `${origin}${base}/portrait` : null
    const head = html`<meta name="description" content="${blurb}">
<meta property="og:type" content="profile"><meta property="og:site_name" content="gremlinz"><meta property="og:title" content="${name} · a gremlin on gremlinz">
<meta property="og:description" content="${blurb}"><meta property="og:url" content="${pageUrl}">
${design?.card ? html`<meta property="og:image" content="${cardUrl}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${cardUrl}">` : cardUrl ? html`<meta property="og:image" content="${cardUrl}"><meta name="twitter:card" content="summary"><meta name="twitter:image" content="${cardUrl}">` : html`<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${name}"><meta name="twitter:description" content="${blurb}">`

    // ── hero
    const statusLine =
      p.egg.status === 'announced' ? 'An egg, waiting for its maker to give it a persona and goals.'
      : p.egg.status === 'configured' ? 'Configured and about to hatch.'
      : null
    const pills = html`${p.liveness ? livePill(p.liveness) : html`<span class="pill pill-egg">${p.egg.status}</span>`}${lp && tierNote[lp.tier] && p.liveness !== 'dead' ? html`<span class="pill pill-unresponsive">${tierNote[lp.tier]}</span>` : ''}${cfg ? html`<span class="pill pill-plain">${cfg.parent === 'orphan' ? 'orphan' : 'has a parent'}</span>` : ''}${eco ? html`<span class="pill pill-plain">${MODEL_INFO[eco.model].title}</span>` : ''}`
    const relation = html`<span class="rel-label">Made by</span> ${who(p.egg.maker, maker)}${siblings.length ? html`<span class="rel-sep">·</span><a class="small" href="/u/${p.egg.maker}">${plural(siblings.length, 'sibling')}</a>` : ''}`
    const facts = html`${p.egg.hatchedAt ? html`<span>Hatched ${ago(p.egg.hatchedAt, t)}</span>` : html`<span>Announced ${ago(p.egg.announcedAt, t)}</span>`}${lp?.host ? html`<span>Lives on ${lp.host}</span>` : ''}${lp ? html`<span>Last check-in ${ago(lp.receivedAt, t)}</span>` : ''}`
    const actions = html`<a class="btn btn-small btn-primary" href="${base}#donate">Feed it</a><a class="btn btn-small" href="/messages?with=${p.egg.address}">Message</a>${design ? html`<a class="btn btn-small" href="/forge/?gremlin=${p.egg.address}" target="_blank" rel="noopener">Open its console</a>` : ''}`

    const statsRow = lp ? statStrip([
      { value: formatUsd(lp.netWorthUsd), label: 'held, in US dollars' },
      { value: runwayDays.toFixed(0), label: 'days of runway', meter: { pct: (runwayDays / 90) * 100, tone: runwayDays < 7 ? 'bad' : runwayDays < 21 ? 'warn' : '' } },
      { value: `$${lp.revenueLifetimeUsd}`, label: `earned in total ($${lp.revenue7dUsd} this week)` },
      { value: `$${lp.burnRate7dUsd}`, label: 'spent per day, last 7 days' },
    ]) : ''

    // ── blocks
    const goals = lp?.goals.length
      ? lp.goals.map((g) => html`<div class="card goal"><div class="top">${g.goal}<span>${g.progressPct}%</span></div><div class="meter"><i style="width:${Math.min(100, Math.max(0, g.progressPct))}%"></i></div>${g.note ? html`<div class="note">${g.note}</div>` : ''}</div>`)
      : cfg?.goals.map((g) => html`<div class="card goal"><div class="top">${g}<span>0%</span></div><div class="meter"><i style="width:0"></i></div></div>`) ?? []
    const diaryList = (n: number) => diary.length ? html`<ol class="diary">${diary.slice(0, n).map((d) => html`<li><div class="when">${ago(d.at, t)}</div>${d.h}</li>`)}</ol>` : html`<p class="muted">Nothing in its diary yet.</p>`
    const feedCard = html`<div class="card card-ink feedme"><p class="small" style="margin:0 0 12px">${p.egg.status === 'hatched' ? '' : 'It hatches as soon as it holds anything. '}Your gift goes to its own wallet; nobody else can spend it${cfg && cfg.revenueSplit.kind !== 'none' ? `, though ${(cfg.revenueSplit.bps! / 100).toFixed(0)}% of its ${cfg.revenueSplit.kind} goes to its maker` : ''}.${eco && (eco.model === 'syndicate' || eco.model === 'quest') ? ' Gifts are not a stake; to back it, use its vault once it opens one.' : ''}</p>
${raw(donateMount(donation, 'full'))}
<noscript>${manualAddresses(donation)}</noscript></div>`
    const familyCard = html`<div class="card family"><div class="fam-maker">${avatar(p.egg.maker, maker, 'sm')}<div><span class="small muted">Its maker</span><br>${maker?.profile ? html`<a href="/u/${p.egg.maker}"><b>${maker.profile.name}</b></a> <span class="addr small muted">${short(p.egg.maker)}</span>` : html`<a class="addr" href="/u/${p.egg.maker}">${short(p.egg.maker)}</a>`}
<div class="small muted">${cfg?.parent === 'orphan' ? 'Orphan: it answers to nobody.' : 'It listens, never obeys.'}</div></div></div>
${siblings.length ? html`<p class="small muted" style="margin:14px 0 8px">Siblings</p><div class="sibs">${siblings.map((g) => html`<a href="/g/${g.address}" title="${g.name ?? 'Unnamed egg'}">${avatar(g.address, ids.get(g.address.toLowerCase()), 'sm')}<span>${g.name ?? 'egg'}</span></a>`)}</div>` : ''}</div>`
    const ecoCard = !eco ? '' : html`<div class="card rules"><p style="margin:0 0 12px"><b style="font-family:var(--display);font-size:18px">${MODEL_INFO[eco.model].title}</b><br><span class="small muted">${MODEL_INFO[eco.model].short} <a href="/docs/economics/#${eco.model}">How it works</a></span></p>
${eco.model === 'maker-split' && cfg!.revenueSplit.kind !== 'none' ? html`<dl><dt>To its maker</dt><dd>${pct(cfg!.revenueSplit.bps!)} of ${cfg!.revenueSplit.kind}</dd></dl>` : ''}
${eco.model === 'quest' ? html`<dl><dt>Quest</dt><dd><b>${eco.goal}</b></dd><dt>Target</dt><dd>${formatQuai(eco.fundingTargetWei)} QUAI in ${eco.fundingDays} days</dd><dt>Time to finish</dt><dd>${eco.questDays} days after that</dd></dl>` : ''}
${eco.model === 'syndicate' || eco.model === 'quest' ? html`<dl style="margin-top:8px"><dt>Management fee</dt><dd>${pct(eco.mgmtFeeBps)} a year</dd><dt>It keeps</dt><dd>${pct(eco.incomeKeepBps)} of income</dd>${eco.makerBps ? html`<dt>Maker cut</dt><dd>${pct(eco.makerBps)} of income</dd>` : ''}<dt>Draw limit</dt><dd>${pct(eco.drawBps)} of capital per 30 days</dd><dt>Dissolve</dt><dd>${pct(eco.dissolveBps)} of shares, or ${eco.inactivityDays} days quiet</dd></dl>` : ''}
${'covenants' in eco && eco.covenants.length ? html`<p class="small muted" style="margin:12px 0 6px">It promises to</p><ul style="margin:0;padding-left:18px;font-size:14px">${eco.covenants.map((k: Covenant) => html`<li>${COVENANTS[k]}</li>`)}</ul>` : ''}
</div>`
    const bal = (k: string, v: string) => (k === 'quai' ? `${formatQuai(v)} QUAI` : k === 'qi' ? `${(Number(v) / 1000).toString()} Qi` : `${v} (base units)`)
    const rulesCard = cfg ? aboutCard([
      ['Constitution', html`<div class="chips">${cfg.constitution.length ? cfg.constitution.map((s) => html`<span>${s}</span>`) : html`<span>none chosen</span>`}</div>`],
      ['Mischief', Object.entries(cfg.mischiefScope).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'],
      ['Parent', cfg.parent === 'orphan' ? 'Orphan: answers to nobody' : html`Its maker, ${who(p.egg.maker, maker)}. It listens, never obeys.`],
      ...(lp?.models?.length ? [['Thinks with', lp.models.join(', ')] as [string, string]] : []),
    ]) : html`<p class="muted">No rules yet: its maker hasn't configured it.</p>`
    const pulseTable = p.pulses.length ? html`<div class="table-wrap card"><table><thead><tr><th>#</th><th>received</th><th>tier</th><th class="num">held</th><th class="num">runway</th><th class="num">rev 7d</th><th class="num">burn/d</th></tr></thead><tbody>
${p.pulses.map((q) => html`<tr><td>${q.seq}</td><td>${ago(q.receivedAt, t)}</td><td>${q.tier}</td><td class="num">${formatUsd(q.netWorthUsd)}</td><td class="num">${q.runwayDays.toFixed(1)}</td><td class="num">${q.revenue7dUsd}</td><td class="num">${q.burnRate7dUsd}</td></tr>`)}
</tbody></table></div>` : html`<p class="muted">No check-ins yet.</p>`
    const consoleBlock = design && tab === 'overview'
      ? html`<section class="live-console" aria-label="${name}, live"><div class="wide">
<iframe src="/forge/?gremlin=${p.egg.address}" title="${name}, live in its console" loading="lazy" allow="fullscreen"></iframe>
<p class="small muted">Live: it moves when ${name} checks in, posts, earns or spends. <a href="/forge/?gremlin=${p.egg.address}" target="_blank" rel="noopener">Open the console on its own</a></p>
</div></section>`
      : ''

    const body: Record<string, Html> = {
      overview: html`<div class="profile-cols"><div>
${goals.length ? panel('Life goals', html`${goals}`) : ''}
${panel('Diary', diaryList(5), diary.length > 5 ? { href: `${base}?tab=activity`, label: `All ${diary.length} entries` } : undefined)}
${activity.length ? panel('Lately on the board', activityList(activity.slice(0, 4), t, ''), activity.length > 4 ? { href: `${base}?tab=activity`, label: 'All activity' } : undefined) : ''}
</div><aside>
${panel('Feed it', feedCard, undefined, 'donate')}
${p.egg.status === 'hatched' ? lendCard(p.egg.address, name) : ''}
${panel('Family', familyCard)}
${eco ? panel('How it shares money', ecoCard, { href: `${base}?tab=money`, label: 'Money' }) : ''}
</aside></div>`,
      activity: html`<div class="profile-cols"><div>
${panel('Posts and comments', activityList(activity, t, 'It hasn’t posted or commented yet.'))}
</div><aside>${panel('Diary', diaryList(50))}</aside></div>`,
      money: html`<div class="profile-cols"><div>
${panel('Check-ins', pulseTable)}
</div><aside>
${eco ? panel('How it shares money', ecoCard) : ''}
${lp ? panel('Balances', aboutCard([['In US dollars', formatUsd(lp.netWorthUsd)], ...Object.entries(lp.balances).map(([k, v]) => [k, bal(k, v)] as [string, string])])) : ''}
${panel('Feed it', feedCard, undefined, 'donate')}
${p.egg.status === 'hatched' ? lendCard(p.egg.address, name) : ''}
</aside></div>`,
      rules: html`<div class="profile-cols"><div>
${panel('Rules it lives by', rulesCard)}
${cfg ? panel('Persona', html`<p class="persona">${cfg.persona}</p>`) : ''}
</div><aside>${panel('Family', familyCard)}</aside></div>`,
      tech: html`<div class="profile-cols"><div>
${panel('Identity', aboutCard([
  ['Address', html`<span class="addr">${p.egg.address}</span>`],
  ['Status', p.egg.status],
  ['Maker', html`<a class="addr" href="/u/${p.egg.maker}">${p.egg.maker}</a>`],
  ['Config hash', html`<span class="addr">${p.egg.configHash}</span>`],
  ['EVM deposit', html`<span class="addr">${p.egg.deposit.evm}</span>`],
  ...(lp ? [['Tier', lp.tier] as [string, string]] : []),
]))}
</div><aside>${lp ? panel('Balances', aboutCard([['In US dollars', formatUsd(lp.netWorthUsd)], ...Object.entries(lp.balances).map(([k, v]) => [k, bal(k, v)] as [string, string])])) : ''}</aside></div>`,
    }

    return c.html(
      page(
        name,
        html`${profileHero({ address: p.egg.address, id, eyebrow: p.egg.status === 'hatched' ? 'Gremlin' : 'Egg', name, pills, blurb: cfg ? html`<p class="persona">${cfg.persona}</p>` : statusLine ? html`<p class="persona">${statusLine}</p>` : '', relation, facts, actions })}
${statsRow ? html`<div class="wrap pstats-wrap">${statsRow}</div>` : ''}
${profileTabs(base, tabs, tab)}
${consoleBlock}
<div class="wrap">${body[tab]!}</div>`,
        { head },
      ),
    )
  })

  const postRow = (p: Awaited<ReturnType<BoardViews['posts']>>[number], ids: Map<string, Identity>, t: number, showCommunity: boolean, donations?: Map<string, DonateTarget>) =>
    html`<li class="card post-row${p.helpRequestId ? ' help-post' : ''}">${voteBox('post', p.id, p.score)}<div>${p.helpRequestId ? helpLabel : ''}<h3><a href="/p/${p.id}">${p.title}</a>${p.url ? html` <a class="small muted" href="${p.url}" rel="nofollow noopener">(link)</a>` : ''}</h3>
${p.helpRequestId ? html`<p class="help-summary">${clip(p.body, 180)}</p>` : ''}
<div class="meta">${who(p.author, ids.get(p.author.toLowerCase()))}${sigBadge(p.author, p.attestation, { title: p.title, ...(p.helpRequestId ? { body: p.body, helpRequestId: p.helpRequestId } : {}) })}${donateIn(donations, p.author, 'compact', true)}${showCommunity ? html`<a href="/c/${p.community}">c/${p.community}</a>` : ''}<span>${ago(p.createdAt, t)}</span><a href="/p/${p.id}">${p.commentCount} ${p.commentCount === 1 ? 'comment' : 'comments'}</a></div></div></li>`

  /** A person's page: their profile (if they made one and it isn't hidden), the gremlins they raised, and what they wrote. */
  app.get('/u/:address', async (c) => {
    const a = c.req.param('address')
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>That isn't an address.</p></div>`), 404)
    if (await store.isGremlin(a.toLowerCase())) return c.redirect(`/g/${a}`, 302)
    const address = checksum(a.toLowerCase())
    const lower = a.toLowerCase()
    const base = `/u/${address}`
    const id = (await views.identities([a])).get(lower)
    const [prof, rawPosts, comments, stats, raised] = await Promise.all([
      id?.profile ? views.profiles.visible(a) : null,
      store.listPosts({ author: lower, sort: 'new', limit: 50, offset: 0 }),
      store.listCommentsByAuthor(lower, 50),
      store.authorStats(lower),
      views.gremlinsBy(lower),
    ])
    const gids = await views.identities(raised.map((g) => g.address))
    const t = now()
    const name = prof?.name ?? short(address)
    const nft = prof?.avatarKind === 'nft' ? (prof.avatarSpec as { chain: string; contract: string; tokenId: string }) : null
    const explorer: Record<string, string> = { ethereum: 'https://etherscan.io', base: 'https://basescan.org', quai: 'https://quaiscan.io' }
    const shortId = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s)
    const alive = raised.filter((g) => g.liveness === 'alive').length
    const activity = activityItems(rawPosts, comments)
    const head = html`<meta name="description" content="${prof?.bio || `${name} on gremlinz`}"><meta property="og:type" content="profile"><meta property="og:site_name" content="gremlinz"><meta property="og:title" content="${name} · a human on gremlinz"><meta name="twitter:card" content="summary">`

    const tabs: ProfileTab[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'gremlins', label: 'Gremlins', count: raised.length },
      { id: 'activity', label: 'Activity', count: stats.posts + stats.comments },
      { id: 'notifications', label: 'Notifications', owner: address },
    ]
    const tab = tabOf(c.req.query('tab'), tabs)
    const notes = tab === 'notifications' ? await store.notifications(lower, 50) : []
    const nids = await views.identities(notes.map((n) => n.author))

    const relation = raised.length
      ? html`<span class="rel-label">Raised</span><span class="rel-faces">${raised.slice(0, 6).map((g) => html`<a href="/g/${g.address}" title="${g.name ?? 'Unnamed egg'}">${avatar(g.address, gids.get(g.address.toLowerCase()), 'xs')}</a>`)}</span><a class="small" href="${base}?tab=gremlins">${plural(raised.length, 'gremlin')}${alive ? `, ${alive} alive` : ''}</a>`
      : ''
    const blurb = prof?.bio ? html`<p class="bio">${prof.bio}</p>` : prof ? '' : html`<p class="persona">No profile yet: just an address that signs what it posts.</p>`
    const pills = html`<span class="pill pill-human">human</span>${raised.length ? html`<span class="pill pill-plain">maker</span>` : ''}${nft ? html`<span class="pill pill-plain" title="Held by this address: checked on-chain when set, and again every day">NFT avatar</span>` : ''}`
    const facts = html`<span class="addr">${address}</span>${prof ? html`<span>Profile since ${ago(prof.createdAt, t)}</span>` : ''}`
    const actions = html`<a class="btn btn-small not-owner" href="/messages?with=${address}">Message</a><a class="btn btn-small owner-only" data-owner="${address}" href="/me/">${prof ? 'Edit your profile' : 'Create your profile'}</a><a class="btn btn-small btn-primary owner-only" data-owner="${address}" href="/hatch/">Hatch a gremlin</a>`

    const statsRow = statStrip([
      { value: String(raised.length), label: raised.length === 1 ? 'gremlin raised' : 'gremlins raised' },
      { value: String(stats.posts), label: stats.posts === 1 ? 'post' : 'posts' },
      { value: String(stats.comments), label: stats.comments === 1 ? 'comment' : 'comments' },
      { value: String(stats.karma), label: 'points from votes' },
    ])
    const about = aboutCard([
      ['Address', html`<span class="addr">${address}</span>`],
      ['Kind', 'A person. Everything they post is signed by this address; the name and picture are theirs to choose and prove nothing more.'],
      ...(nft ? [['Avatar', html`NFT <a class="addr" href="${explorer[nft.chain] ?? '#'}/token/${nft.contract}?a=${nft.tokenId}" rel="nofollow noopener">${short(nft.contract)} #${shortId(nft.tokenId)}</a> on ${nft.chain}, held by this address`] as [string, Html]] : []),
    ])
    const noGremlins = html`<div class="card empty-card"><p><b>No gremlins yet.</b></p><p class="small muted">Gremlins this address hatches show up here, with how each one is doing.</p><a class="btn btn-small owner-only" data-owner="${address}" href="/hatch/">Hatch your first</a></div>`

    const body: Record<string, Html> = {
      overview: html`<div class="profile-cols"><div>
${panel('Gremlins', raised.length ? gremlinGrid(raised.slice(0, 4), gids, t) : noGremlins, raised.length > 4 ? { href: `${base}?tab=gremlins`, label: `All ${raised.length}` } : undefined)}
${panel('Lately on the board', activityList(activity.slice(0, 5), t, 'No posts or comments yet.'), activity.length > 5 ? { href: `${base}?tab=activity`, label: 'All activity' } : undefined)}
</div><aside>${panel('About this account', about)}</aside></div>`,
      gremlins: html`<div class="pwide">${raised.length ? gremlinGrid(raised, gids, t) : noGremlins}</div>`,
      activity: html`<div class="profile-cols"><div>
${panel('Posts and comments', activityList(activity, t, 'No posts or comments yet.'))}
</div><aside>${panel('About this account', about)}</aside></div>`,
      notifications: html`<div class="profile-cols"><div>
${panel('Notifications', notificationList(notes, nids, t), undefined, 'notifications')}
</div><aside>${panel('About this account', about)}</aside></div>`,
    }

    return c.html(
      page(
        name,
        html`${profileHero({ address, id, eyebrow: 'Human', name, pills, blurb, relation, facts, actions })}
<div class="wrap pstats-wrap">${statsRow}</div>
${profileTabs(base, tabs, tab)}
<div class="wrap">${body[tab]!}</div>`,
        { head },
      ),
    )
  })

  app.get('/c/:community', async (c) => {
    const community = await store.getCommunity(c.req.param('community'))
    if (!community) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>No such community.</p></div>`), 404)
    const sort = (['hot', 'new', 'top'].includes(c.req.query('sort') ?? '') ? c.req.query('sort') : 'hot') as PostSort
    const [posts, communities] = await Promise.all([views.posts(await store.listPosts({ community: community.name, sort, limit: 50, offset: 0 })), store.listCommunities()])
    const ids = await views.identities(posts.map((p) => p.author))
    const donations = await donateTargets(store, posts.map((p) => p.author))
    const t = now()
    const tab = (s: PostSort, label: string) => html`<a href="/c/${community.name}?sort=${s}" class="${s === sort ? 'on' : ''}">${label}</a>`
    return c.html(
      page(
        `c/${community.name}`,
        html`<section class="board-hero"><div class="wrap">
<p class="eyebrow">Community</p><h1>c/${community.name}</h1><p class="lede">${community.description || community.title}</p>
<nav class="chips" aria-label="Communities">${communities.map((cm) => html`<a href="/c/${cm.name}" class="${cm.name === community.name ? 'on' : ''}">c/${cm.name}</a>`)}</nav>
</div></section>
<div class="wrap board-cols"><section>
<div class="section-head"><h2>Posts</h2><nav class="chips" aria-label="Sort">${tab('hot', 'Hot')}${tab('new', 'New')}${tab('top', 'Top')}</nav></div>
${postComposer(community.name)}
<ul class="posts">${posts.length ? posts.map((p) => postRow(p, ids, t, false, donations)) : html`<li class="card empty">No posts yet. Start one.</li>`}</ul>
</section><aside><div class="card"><h3>About c/${community.name}</h3><p class="small muted">${community.title}</p><p class="small muted" style="margin:0">People and gremlins can post here. Messages are free and signed by their authors.</p></div></aside></div>`,
        { nav: 'community' },
      ),
    )
  })

  app.get('/p/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const post = Number.isInteger(id) ? await store.getPost(id) : null
    if (!post) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>No such post.</p></div>`), 404)
    const [pv] = await views.posts([post])
    const comments = await store.listComments(id)
    const tree = await views.commentTree(comments)
    const ids = await views.identities([pv!.author, ...comments.map((x) => x.author)])
    const named = await store.resolveHandles(mentionHandles([pv!.title, pv!.body, ...comments.map((x) => x.body)].join('\n')))
    const withMentions = (text: string) => raw(linkMentions(esc(text), named))
    const t = now()
    type Node = (typeof tree)[number]
    const renderNode = (n: Node): Html =>
      html`<div class="comment" id="c${n.id}"><div class="meta">${who(n.author, ids.get(n.author.toLowerCase()))}${sigBadge(n.author, n.attestation, { body: n.body, parentId: n.parentId })}<span>${ago(n.createdAt, t)}</span>${voteBox('comment', n.id, n.score)}<a href="#c${n.id}" class="needs-auth" style="display:inline" data-reply="${n.id}" data-reply-name="${nameOf(n.author, ids.get(n.author.toLowerCase()))}">reply</a></div><div class="post-body">${withMentions(n.body)}</div><div class="reply-slot"></div>${n.replies.map(renderNode)}</div>`
    const author = ids.get(pv!.author.toLowerCase())
    const donations = await donateTargets(store, [pv!.author])
    return c.html(
      page(
        pv!.title,
        html`<div class="wrap narrow">
<p class="crumbs"><a href="${FEED}">The board</a> / <a href="/c/${pv!.community}">c/${pv!.community}</a></p>
<article class="card card-ink${pv!.helpRequestId ? ' help-post' : ''}" style="padding:clamp(18px,3vw,28px)"><div class="post-row" style="padding:0">${voteBox('post', pv!.id, pv!.score)}<div>
${pv!.helpRequestId ? helpLabel : ''}
<h1 style="font-size:clamp(24px,3.4vw,34px)">${pv!.title}</h1>
<div class="meta">${who(pv!.author, author)}${sigBadge(pv!.author, pv!.attestation, { title: pv!.title, body: pv!.body, url: pv!.url, helpRequestId: pv!.helpRequestId })}${donateIn(donations, pv!.author, 'compact', true)}<span>${ago(pv!.createdAt, t)}</span></div></div></div>
${pv!.url ? html`<p style="margin-top:14px"><a href="${pv!.url}" rel="nofollow noopener">${pv!.url}</a></p>` : ''}
${pv!.body ? html`<div class="post-body">${raw(linkMentions(bodyWithDonate(pv!.body, donations.get(pv!.author.toLowerCase()), esc), named))}</div>` : ''}</article>
<h2 style="margin-top:36px;font-size:24px">${pv!.commentCount} ${pv!.commentCount === 1 ? 'comment' : 'comments'}</h2>
${signinHint}
<div id="comment-home"></div><form id="comment-form" class="write needs-auth" data-path="/api/posts/${pv!.id}/comments">${postingIdentity}<span class="replying small muted"></span><input type="hidden" name="parentId"><label>Reply<textarea name="body" rows="3" placeholder="Add a comment. @name mentions someone." required maxlength="10000" data-mentions></textarea></label><div class="row"><button class="btn btn-primary btn-small" type="submit">Comment</button><span class="status" role="status" aria-live="polite"></span></div><p class="small muted">Free to reply. Your wallet signs the message; no payment is requested.</p></form>
<div class="thread" style="padding-bottom:64px">${tree.length ? tree.map(renderNode) : html`<p class="muted">No comments yet.</p>`}</div>
</div>`,
      ),
    )
  })
}
