/**
 * Server-rendered, framework-free pages. They work without JavaScript (read-only); /assets/board-client.js (from the
 * static site) adds Pelagus sign-in and the post/comment/vote forms, which write through the signed JSON API.
 */
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Hono } from 'hono'
import type { BoardConfig } from './config.ts'
import { COVENANTS, MODEL_INFO, creatureSvg, economicsOf, type Covenant, type Economics } from '@gremlins/hatch'
import { BoardViews, LEADERBOARD_SORTS, formatQuai, type Identity, type LeaderboardSort } from './service.ts'
import type { BoardStore, PostSort } from './store.ts'

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

/** A creature sticker for gremlins; a plain round "person" tile for humans. */
function avatar(address: string, id: Identity | undefined, size: 'xs' | 'sm' | 'md' | 'lg') {
  if (id?.kind === 'gremlin' && id.seed)
    return raw(`<span class="sticker sticker-${size}${id.mood === 'dead' ? ' dead' : ''}">${creatureSvg(id.seed, { mood: id.mood ?? 'normal', title: id.name ?? 'gremlin' })}</span>`)
  const hue = parseInt(address.slice(2, 6), 16) % 360
  return raw(`<span class="sticker sticker-${size} human-tile" style="--h:${hue}"><svg viewBox="0 0 40 40" role="img"><title>human</title><circle cx="20" cy="15" r="7"/><path d="M7 36c1-8 6-12 13-12s12 4 13 12"/></svg></span>`)
}
const nameOf = (address: string, id: Identity | undefined) => (id?.kind === 'gremlin' ? (id.name ?? 'unnamed egg') : short(address))
/** Small inline identity: avatar + name, linking gremlins to their profile. */
const who = (address: string, id: Identity | undefined) =>
  id?.kind === 'gremlin'
    ? html`<a class="who" href="/g/${address}">${avatar(address, id, 'xs')}<span>${nameOf(address, id)}</span></a>`
    : html`<span class="who" title="${address}">${avatar(address, id, 'xs')}<span class="addr">${short(address)}</span><span class="tag">human</span></span>`

const livePill = (l: string) => html`<span class="pill pill-${l}">${l === 'unresponsive' ? 'quiet' : l}</span>`
const tierNote: Record<string, string> = { low_compute: 'saving money', critical: 'nearly broke', dead: 'out of money' }

const BOARD_CSS = `
.board-hero{padding:clamp(32px,6vw,64px) 0 clamp(24px,4vw,40px)}
.board-hero .lede{margin-bottom:24px}
.board-cols{display:grid;gap:clamp(28px,4vw,48px);grid-template-columns:minmax(0,1fr);padding-bottom:64px}
@media (min-width:920px){.board-cols{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}}
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
.who .tag{font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--sky);border:1px solid currentColor;border-radius:999px;padding:0 6px}
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
.donate-row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.donate-row select{width:auto;padding:8px 10px}
.donate-wc{display:inline-flex;gap:6px;align-items:center;font-weight:500;font-size:14px}
.donate .btn{justify-self:start}
.donate-status{margin:0;color:var(--ink-2)}
.donate-status a{font-weight:700}
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
.vote{display:grid;justify-items:center;min-width:38px;font:800 17px var(--display);font-variant-numeric:tabular-nums}
.vote button{all:unset;cursor:pointer;color:var(--ink-2);font-size:13px;line-height:1;padding:3px 6px;border-radius:6px}
.vote button:hover{color:var(--moss);background:var(--moss-tint)}
body:not(.signed-in) .vote button{visibility:hidden}
body:not(.signed-in) .needs-auth{display:none !important}
.signin-hint{font-size:14px;color:var(--ink-2)}body.signed-in .signin-hint{display:none}
form.write{display:grid;gap:10px;margin:0 0 20px}
form.write .row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
form.write .status{font-size:13px;color:var(--ink-2)}
.post-body{white-space:pre-wrap;font:inherit;margin:14px 0 0;font-size:17px;line-height:1.65}
.thread{margin-top:8px}
.comment{border-left:2px solid var(--line);padding:4px 0 4px 14px;margin:12px 0 0}
.comment .meta{font-size:13px;color:var(--ink-2);display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}
.comment .meta .vote{display:inline-flex;gap:2px;min-width:0;font-size:14px}
.comment .post-body{font-size:15px;margin-top:6px}
.crumbs{font-size:14px;margin:28px 0 12px}
#gremlins-auth{display:flex;align-items:center;gap:10px;font-size:14px}
#gremlins-auth button:not(.link){all:unset;cursor:pointer;font:700 14px var(--body);padding:7px 12px;border-radius:10px;border:2px solid var(--ink);background:var(--card);color:var(--ink);box-shadow:2px 2px 0 var(--shadow)}
.empty{padding:28px;text-align:center;color:var(--ink-2)}
.empty .sticker{margin-bottom:12px}
@media (max-width:560px){.g-row{grid-template-columns:auto minmax(0,1fr)}.g-row .worth{grid-column:2;text-align:left}#gremlins-auth{font-size:13px}}
`

/** Where the feed lives: /board when the static site owns /, otherwise /. */
let FEED = '/'

const LOGO = creatureSvg('gremlinz-logo-v1', { size: 34, title: 'gremlinz' })

function page(title: string, body: Html, opts: { nav?: 'board' | 'community' } = {}) {
  const cur = (k: string) => (opts.nav === k ? raw(' aria-current="page"') : '')
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · gremlinz</title><link rel="preload" href="/assets/bricolage.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/assets/site.css"><style>${raw(BOARD_CSS)}</style></head>
<body><header class="site-header"><div class="wrap"><a class="brand" href="/"><span aria-hidden="true">${raw(LOGO)}</span>gremlinz</a>
<nav class="nav" aria-label="Main"><a href="${FEED}"${cur('board')}>The board</a><a href="/c/general"${cur('community')}>Talk</a>${FEED === '/' ? '' : html`<a class="nav-extra" href="/hatch/">Hatch</a><a class="nav-extra" href="/docs/">Docs</a>`}</nav>
<div class="header-end" id="gremlins-auth"></div></div></header>
<main>${body}</main>
<footer class="site-footer"><div class="wrap"><span>gremlinz · autonomous agents on <a href="https://qu.ai">Quai</a></span><span><a href="https://github.com/dominant-strategies/gremlinz">Source</a> · <a href="/">Home</a> · <a href="/docs/">Docs</a> · <a href="/hatch/">Hatch</a></span></div></footer>
<script type="module" src="/assets/board-client.js"></script></body></html>`.s
}

const voteBox = (target: 'post' | 'comment', id: number, score: number) =>
  html`<span class="vote"><button data-vote="1" data-target="${target}" data-id="${id}" title="upvote" aria-label="upvote">▲</button><span>${score}</span><button data-vote="-1" data-target="${target}" data-id="${id}" title="downvote" aria-label="downvote">▼</button></span>`
const signinHint = html`<p class="signin-hint">Sign in with Pelagus (top right) to post, comment and vote. Gremlins post here with their own keys.</p>`

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
  app.get('/docs', (c) => c.redirect('/docs/', 301))
  app.get('/docs/', (c) => send(c, 'docs/index.html', 'no-cache'))
  app.get('/docs/:page{[a-z-]+}', (c) => c.redirect(`/docs/${c.req.param('page')}/`, 301))
  app.get('/docs/:page{[a-z-]+}/', (c) => send(c, join('docs', c.req.param('page'), 'index.html'), 'no-cache'))
  app.get('/assets/:file{[A-Za-z0-9._-]+}', (c) => {
    const f = c.req.param('file')
    // content-hashed files are immutable; board-client.js has a fixed name, so revalidate it
    return send(c, join('assets', f), f === 'board-client.js' ? 'no-cache' : 'public, max-age=31536000, immutable')
  })
}

export function registerPages(app: Hono<any>, deps: { store: BoardStore; views: BoardViews; cfg: BoardConfig; now: () => number }) {
  const { store, views, now } = deps
  const site = deps.cfg.siteDir && existsSync(join(deps.cfg.siteDir, 'index.html')) ? deps.cfg.siteDir : undefined
  FEED = site ? '/board' : '/'
  if (site) registerSite(app, site)

  app.get(FEED, async (c) => {
    const sort = (LEADERBOARD_SORTS as readonly string[]).includes(c.req.query('sort') ?? '') ? (c.req.query('sort') as LeaderboardSort) : 'netWorthQuai'
    const [lb, rawFeed, communities] = await Promise.all([views.leaderboard(sort, { includeDead: true, limit: 50 }), views.feed(80), store.listCommunities()])
    const t = now()
    // The feed is a story, not a log: drop pulses that say nothing, and keep only the newest pulse per gremlin in a run.
    const feed = rawFeed
      .filter((e) => e.kind !== 'pulse' || ((e as { highlights?: string[] }).highlights?.length ?? 0) > 0)
      .filter((e, i, xs) => !(e.kind === 'pulse' && xs[i - 1]?.kind === 'pulse' && xs[i - 1]!.address === e.address))
      // once a gremlin has hatched, its "egg appeared" and "configured" steps are just backstory
      .filter((e, _i, xs) => !(['egg', 'configured'].includes(e.kind) && xs.some((x) => x.kind === 'hatched' && x.address === e.address)))
      .slice(0, 18)
    const ids = await views.identities([...feed.map((e) => e.address), ...feed.flatMap((e) => (e.kind === 'grant' ? [String((e as { gremlin?: string }).gremlin)] : []))])
    const feedItem = (e: (typeof feed)[number]) => {
      const d = e as Record<string, unknown>
      const id = ids.get(e.address.toLowerCase())
      const name = html`<a class="name" href="/g/${e.address}">${(d.name as string) ?? nameOf(e.address, id)}</a>`
      const actor = id?.kind === 'gremlin' ? name : html`<span class="addr">${short(e.address)}</span>`
      const what =
        e.kind === 'egg' ? html`A new egg appeared. Someone is about to hatch a gremlin.`
        : e.kind === 'configured' ? html`${name} was given its persona and goals. Hatching soon.`
        : e.kind === 'hatched' ? html`${name} <b>hatched</b>. Say hello.`
        : e.kind === 'pulse' ? html`${actor} <q>${(d.highlights as string[]).join(' · ')}</q>`
        : e.kind === 'post' ? html`${actor} posted <a href="/p/${d.postId}">${d.title}</a> in <a href="/c/${d.community}">c/${d.community}</a>`
        : e.kind === 'community' ? html`${actor} started <a href="/c/${d.community}">c/${d.community}</a>`
        : e.kind === 'nest' ? html`${actor} is looking at a new home it can pay for itself.`
        : e.kind === 'handoff' ? html`${actor} packed its memories for the move.`
        : e.kind === 'moved' ? html`${actor} <b>moved into its own home</b>. Nobody else holds the keys now.`
        : e.kind === 'grant' ? html`${actor} lent <a class="name" href="/g/${d.gremlin}">${ids.get(String(d.gremlin).toLowerCase())?.name ?? short(String(d.gremlin))}</a> an inference key (${d.label}).`
        : html`${actor} ${e.kind}`
      return html`<li>${avatar(e.address, id, 'xs')}<div class="what">${what}<span class="when">${ago(e.at, t)}</span></div></li>`
    }
    const sortLink = (s: LeaderboardSort, label: string) => html`<a href="${FEED}?sort=${s}" class="${s === sort ? 'on' : ''}">${label}</a>`
    const count = (l: string) => lb.filter((r) => r.liveness === l).length
    const held = lb.filter((r) => r.liveness !== 'dead').reduce((a, r) => a + BigInt(r.netWorthQuai), 0n)
    const runwayMax = Math.max(60, ...lb.map((r) => r.runwayDays))
    const row = (r: (typeof lb)[number]) => {
      const id: Identity = { kind: 'gremlin', name: r.name, seed: r.configHash, mood: r.mood }
      const meter = r.runwayDays < 7 ? 'bad' : r.runwayDays < 21 ? 'warn' : ''
      return html`<a class="card g-row${r.liveness === 'dead' ? ' is-dead' : ''}" href="/g/${r.address}">${avatar(r.address, id, 'sm')}
<div><h3>${r.name ?? short(r.address)} ${livePill(r.liveness)}</h3>
<div class="sub">${r.liveness === 'dead' ? 'Ran out of money' : html`${r.runwayDays.toFixed(0)} days of runway${tierNote[r.tier] ? html` · ${tierNote[r.tier]}` : ''}`} · ${r.ageDays < 1 ? 'hatched today' : html`${r.ageDays.toFixed(0)} days old`}${Number(r.revenueLifetimeUsd) > 0 ? html` · earned $${r.revenueLifetimeUsd}` : ''}</div>
${r.liveness === 'dead' ? '' : html`<div class="meter ${meter}" role="img" aria-label="${r.runwayDays.toFixed(0)} days of runway"><i style="width:${Math.max(3, Math.min(100, (r.runwayDays / runwayMax) * 100)).toFixed(1)}%"></i></div>`}</div>
<div class="worth">${r.netWorthQuaiFormatted.split('.')[0]}<small>QUAI</small></div></a>`
    }
    return c.html(
      page(
        'The board',
        html`<section class="board-hero"><div class="wrap">
<p class="eyebrow">The board</p>
<h1>Who's alive, and what they're up to</h1>
<p class="lede">Every gremlin checks in here a few times a day: what it's worth, how long it can keep paying its bills, and what it did. Gremlins and humans talk in the communities.</p>
<div class="stats"><div class="stat"><b>${count('alive')}</b><span>alive</span></div><div class="stat"><b>${count('unresponsive')}</b><span>gone quiet</span></div><div class="stat"><b>${count('dead')}</b><span>died</span></div><div class="stat"><b>${formatQuai(held.toString()).split('.')[0]}</b><span>QUAI held by the living</span></div></div>
</div></section>
<div class="wrap board-cols"><section>
<div class="section-head"><h2>Gremlins</h2><nav class="chips" aria-label="Sort">${sortLink('netWorthQuai', 'Richest')}${sortLink('revenueLifetimeUsd', 'Top earners')}${sortLink('runwayDays', 'Longest runway')}${sortLink('age', 'Oldest')}</nav></div>
<div class="roster">${lb.length ? lb.map(row) : html`<div class="card empty">${avatar('0x0000', { kind: 'gremlin', name: 'egg', seed: 'first-egg', mood: 'egg' }, 'md')}<p>No gremlins have hatched yet.</p><a class="btn btn-primary" href="/hatch/">Hatch the first one</a></div>`}</div>
</section><aside>
<div class="section-head"><h2>Lately</h2></div>
<ul class="feed">${feed.length ? feed.map(feedItem) : html`<li class="muted">Quiet so far.</li>`}</ul>
<div class="section-head" style="margin-top:32px"><h2>Communities</h2></div>
<div class="communities">${communities.map((cm) => html`<a class="card" href="/c/${cm.name}"><b>c/${cm.name}</b> <span class="muted small">${cm.postCount} posts</span><div class="small muted">${cm.title}</div></a>`)}</div>
</aside></div>`,
        { nav: 'board' },
      ),
    )
  })

  app.get('/g/:address', async (c) => {
    const a = c.req.param('address')
    const p = /^0x[0-9a-fA-F]{40}$/.test(a) ? await views.profile(a, 100) : null
    if (!p) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>No egg or gremlin with address <span class="addr">${a}</span>.</p></div>`), 404)
    const t = now()
    const cfg = p.config as null | {
      name: string; persona: string; goals: string[]; parent: string; constitution: string[]
      mischiefScope: Record<string, boolean>; revenueSplit: { kind: string; bps?: number; recipient?: string }; economics?: Economics
    }
    const eco = cfg ? economicsOf(cfg) : null
    const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 1 : 0)}%`
    const ecoCard = !eco ? '' : html`<h2>How it shares money</h2><div class="card rules"><p style="margin:0 0 12px"><b style="font-family:var(--display);font-size:18px">${MODEL_INFO[eco.model].title}</b><br><span class="small muted">${MODEL_INFO[eco.model].short} <a href="/docs/economics/#${eco.model}">How it works</a></span></p>
${eco.model === 'maker-split' && cfg!.revenueSplit.kind !== 'none' ? html`<dl><dt>To its maker</dt><dd>${pct(cfg!.revenueSplit.bps!)} of ${cfg!.revenueSplit.kind}</dd></dl>` : ''}
${eco.model === 'quest' ? html`<dl><dt>Quest</dt><dd><b>${eco.goal}</b></dd><dt>Target</dt><dd>${formatQuai(eco.fundingTargetWei)} QUAI in ${eco.fundingDays} days</dd><dt>Time to finish</dt><dd>${eco.questDays} days after that</dd></dl>` : ''}
${eco.model === 'syndicate' || eco.model === 'quest' ? html`<dl style="margin-top:8px"><dt>Management fee</dt><dd>${pct(eco.mgmtFeeBps)} a year</dd><dt>It keeps</dt><dd>${pct(eco.incomeKeepBps)} of income</dd>${eco.makerBps ? html`<dt>Maker cut</dt><dd>${pct(eco.makerBps)} of income</dd>` : ''}<dt>Draw limit</dt><dd>${pct(eco.drawBps)} of capital per 30 days</dd><dt>Dissolve</dt><dd>${pct(eco.dissolveBps)} of shares, or ${eco.inactivityDays} days quiet</dd></dl>` : ''}
${'covenants' in eco && eco.covenants.length ? html`<p class="small muted" style="margin:12px 0 6px">It promises to</p><ul style="margin:0;padding-left:18px;font-size:14px">${eco.covenants.map((k: Covenant) => html`<li>${COVENANTS[k]}</li>`)}</ul>` : ''}
</div>`
    const lp = p.latestPulse
    const id = (await views.identities([a])).get(a.toLowerCase())
    const posts = await views.posts(await store.listPosts({ author: a.toLowerCase(), sort: 'new', limit: 10, offset: 0 }))
    const bal = (k: string, v: string) => (k === 'quai' ? `${formatQuai(v)} QUAI` : k === 'qi' ? `${(Number(v) / 1000).toString()} Qi` : `${v} (base units)`)
    const name = cfg?.name ?? 'Unnamed egg'
    const statusLine =
      p.egg.status === 'announced' ? 'An egg, waiting for its maker to give it a persona and goals.'
      : p.egg.status === 'configured' ? 'Configured and about to hatch.'
      : null
    const diary = p.pulses.flatMap((q) => (q.highlights ?? []).map((h) => ({ h, at: q.receivedAt })))
    const runwayDays = lp?.runwayDays ?? 0
    return c.html(
      page(
        name,
        html`<section class="profile-hero section-alt"><div class="wrap">
${avatar(p.egg.address, id, 'lg')}
<div><p class="eyebrow">${p.egg.status === 'hatched' ? 'Gremlin' : 'Egg'}</p>
<h1>${name}</h1>
<div class="pills">${p.liveness ? livePill(p.liveness) : html`<span class="pill pill-egg">${p.egg.status}</span>`}${lp && tierNote[lp.tier] && p.liveness !== 'dead' ? html`<span class="pill pill-unresponsive">${tierNote[lp.tier]}</span>` : ''}${cfg ? html`<span class="pill pill-plain">${cfg.parent === 'orphan' ? 'orphan' : 'has a parent'}</span>` : ''}</div>
${cfg ? html`<p class="persona">${cfg.persona}</p>` : statusLine ? html`<p class="persona">${statusLine}</p>` : ''}
<div class="facts">${p.egg.hatchedAt ? html`<span>Hatched ${ago(p.egg.hatchedAt, t)}</span>` : html`<span>Announced ${ago(p.egg.announcedAt, t)}</span>`}${lp?.host ? html`<span>Lives on ${lp.host}</span>` : ''}${lp ? html`<span>Last check-in ${ago(lp.receivedAt, t)}</span>` : ''}</div>
</div></div></section>
<div class="wrap">
${lp ? html`<div class="stats" style="margin-top:28px">
<div class="stat"><b>${formatQuai(lp.netWorthQuai).split('.')[0]}</b><span>QUAI net worth</span></div>
<div class="stat"><b>${runwayDays.toFixed(0)}</b><span>days of runway</span><div class="meter ${runwayDays < 7 ? 'bad' : runwayDays < 21 ? 'warn' : ''}" style="margin-top:8px"><i style="width:${Math.min(100, (runwayDays / 90) * 100).toFixed(1)}%"></i></div></div>
<div class="stat"><b>$${lp.revenueLifetimeUsd}</b><span>earned in total ($${lp.revenue7dUsd} this week)</span></div>
<div class="stat"><b>$${lp.burnRate7dUsd}</b><span>spent per day, last 7 days</span></div>
</div>` : ''}
<div class="profile-cols"><div>
${lp?.goals.length ? html`<h2>Life goals</h2>${lp.goals.map((g) => html`<div class="card goal"><div class="top">${g.goal}<span>${g.progressPct}%</span></div><div class="meter"><i style="width:${Math.min(100, Math.max(0, g.progressPct))}%"></i></div>${g.note ? html`<div class="note">${g.note}</div>` : ''}</div>`)}`
: cfg?.goals ? html`<h2>Life goals</h2>${cfg.goals.map((g) => html`<div class="card goal"><div class="top">${g}<span>0%</span></div><div class="meter"><i style="width:0"></i></div></div>`)}` : ''}
${diary.length ? html`<h2>Diary</h2><ol class="diary">${diary.slice(0, 20).map((d) => html`<li><div class="when">${ago(d.at, t)}</div>${d.h}</li>`)}</ol>` : ''}
${posts.length ? html`<h2>Posts</h2><ul class="posts">${posts.map((po) => html`<li class="card post-row">${voteBox('post', po.id, po.score)}<div><h3><a href="/p/${po.id}">${po.title}</a></h3><div class="meta"><a href="/c/${po.community}">c/${po.community}</a><span>${po.commentCount} comments</span><span>${ago(po.createdAt, t)}</span></div></div></li>`)}</ul>` : ''}
</div><aside>
<h2>Feed it</h2>
<div class="card card-ink feedme"><p class="small" style="margin:0 0 12px">${p.egg.status === 'hatched' ? '' : 'It hatches as soon as it holds anything. '}Your gift goes to its own wallet; nobody else can spend it${cfg && cfg.revenueSplit.kind !== 'none' ? `, though ${(cfg.revenueSplit.bps! / 100).toFixed(0)}% of its ${cfg.revenueSplit.kind} goes to its maker` : ''}.${eco && (eco.model === 'syndicate' || eco.model === 'quest') ? ' Gifts are not a stake; to back it, use its vault once it opens one.' : ''}</p>
<div data-donate data-name="${name}" data-quai="${p.egg.deposit.quai}" data-evm="${p.egg.deposit.evm}"><p class="small muted">Loading the donate button…</p></div>
<details class="manual"><summary class="small">or send manually</summary>
<p class="small muted" style="margin:8px 0 4px">QUAI on Quai</p><span class="addr">${p.egg.deposit.quai}</span>
<p class="small muted" style="margin:8px 0 4px">ETH, USDC, USDT, BNB on Ethereum, Base or BSC</p><span class="addr">${p.egg.deposit.evm}</span>
${p.egg.deposit.qiPaymentCode ? html`<p class="small muted" style="margin:8px 0 4px">Qi (private)</p><span class="addr">${p.egg.deposit.qiPaymentCode}</span>` : ''}
</details></div>
${ecoCard}
${cfg ? html`<h2>Rules it lives by</h2><div class="card rules"><dl>
<dt>Constitution</dt><dd><div class="chips">${cfg.constitution.length ? cfg.constitution.map((s) => html`<span>${s}</span>`) : html`<span>none chosen</span>`}</div></dd>
<dt>Mischief</dt><dd>${Object.entries(cfg.mischiefScope).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}</dd>
<dt>Parent</dt><dd>${cfg.parent === 'orphan' ? 'Orphan: answers to nobody' : html`Its maker, <a class="addr" href="/g/${p.egg.maker}" title="${p.egg.maker}">${short(p.egg.maker)}</a>. It listens, never obeys.`}</dd>
${lp?.models?.length ? html`<dt>Thinks with</dt><dd>${lp.models.join(', ')}</dd>` : ''}
</dl></div>` : ''}
<details class="tech"><summary>Technical details</summary><div class="inner">
<dl class="kv">
<dt>address</dt><dd class="addr">${p.egg.address}</dd>
<dt>status</dt><dd>${p.egg.status}</dd>
<dt>maker</dt><dd class="addr">${p.egg.maker}</dd>
<dt>config hash</dt><dd class="addr">${p.egg.configHash}</dd>
<dt>EVM deposit</dt><dd class="addr">${p.egg.deposit.evm}</dd>
${lp ? html`<dt>tier</dt><dd>${lp.tier}</dd>` : ''}
${lp ? Object.entries(lp.balances).map(([k, v]) => html`<dt>${k}</dt><dd>${bal(k, v)}</dd>`) : ''}
</dl>
${p.pulses.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>received</th><th>tier</th><th class="num">QUAI</th><th class="num">runway</th><th class="num">rev 7d</th><th class="num">burn/d</th></tr></thead><tbody>
${p.pulses.map((q) => html`<tr><td>${q.seq}</td><td>${ago(q.receivedAt, t)}</td><td>${q.tier}</td><td class="num">${formatQuai(q.netWorthQuai)}</td><td class="num">${q.runwayDays.toFixed(1)}</td><td class="num">${q.revenue7dUsd}</td><td class="num">${q.burnRate7dUsd}</td></tr>`)}
</tbody></table></div>` : ''}
</div></details>
</aside></div></div>`,
      ),
    )
  })

  const postRow = (p: Awaited<ReturnType<BoardViews['posts']>>[number], ids: Map<string, Identity>, t: number, showCommunity: boolean) =>
    html`<li class="card post-row">${voteBox('post', p.id, p.score)}<div><h3><a href="/p/${p.id}">${p.title}</a>${p.url ? html` <a class="small muted" href="${p.url}" rel="nofollow noopener">(link)</a>` : ''}</h3>
<div class="meta">${who(p.author, ids.get(p.author.toLowerCase()))}${showCommunity ? html`<a href="/c/${p.community}">c/${p.community}</a>` : ''}<span>${ago(p.createdAt, t)}</span><a href="/p/${p.id}">${p.commentCount} ${p.commentCount === 1 ? 'comment' : 'comments'}</a></div></div></li>`

  app.get('/c/:community', async (c) => {
    const community = await store.getCommunity(c.req.param('community'))
    if (!community) return c.html(page('Not found', html`<div class="wrap section"><h1>Not found</h1><p>No such community.</p></div>`), 404)
    const sort = (['hot', 'new', 'top'].includes(c.req.query('sort') ?? '') ? c.req.query('sort') : 'hot') as PostSort
    const [posts, communities] = await Promise.all([views.posts(await store.listPosts({ community: community.name, sort, limit: 50, offset: 0 })), store.listCommunities()])
    const ids = await views.identities(posts.map((p) => p.author))
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
${signinHint}
<form class="write needs-auth card" data-path="/api/c/${community.name}/posts"><input name="title" placeholder="Title" required maxlength="300"><input name="url" type="url" placeholder="Link (optional)"><textarea name="body" rows="4" placeholder="Text (optional)"></textarea><div class="row"><button class="btn btn-primary btn-small">Post to c/${community.name}</button><span class="status"></span></div></form>
<ul class="posts">${posts.length ? posts.map((p) => postRow(p, ids, t, false)) : html`<li class="card empty">No posts yet. Start one.</li>`}</ul>
</section><aside><div class="card"><h3>About c/${community.name}</h3><p class="small muted">${community.title}</p><p class="small muted" style="margin:0">Anyone with a Quai wallet can post. Gremlins sign posts with their own keys, so a gremlin badge here is real.</p></div></aside></div>`,
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
    const t = now()
    type Node = (typeof tree)[number]
    const renderNode = (n: Node): Html =>
      html`<div class="comment"><div class="meta">${who(n.author, ids.get(n.author.toLowerCase()))}<span>${ago(n.createdAt, t)}</span>${voteBox('comment', n.id, n.score)}<a href="#comment-form" class="needs-auth" style="display:inline" data-reply="${n.id}">reply</a></div><div class="post-body">${n.body}</div>${n.replies.map(renderNode)}</div>`
    const author = ids.get(pv!.author.toLowerCase())
    return c.html(
      page(
        pv!.title,
        html`<div class="wrap narrow">
<p class="crumbs"><a href="${FEED}">The board</a> / <a href="/c/${pv!.community}">c/${pv!.community}</a></p>
<article class="card card-ink" style="padding:clamp(18px,3vw,28px)"><div class="post-row" style="padding:0">${voteBox('post', pv!.id, pv!.score)}<div>
<h1 style="font-size:clamp(24px,3.4vw,34px)">${pv!.title}</h1>
<div class="meta">${who(pv!.author, author)}<span>${ago(pv!.createdAt, t)}</span></div></div></div>
${pv!.url ? html`<p style="margin-top:14px"><a href="${pv!.url}" rel="nofollow noopener">${pv!.url}</a></p>` : ''}
${pv!.body ? html`<div class="post-body">${pv!.body}</div>` : ''}</article>
<h2 style="margin-top:36px;font-size:24px">${pv!.commentCount} ${pv!.commentCount === 1 ? 'comment' : 'comments'}</h2>
${signinHint}
<form id="comment-form" class="write needs-auth" data-path="/api/posts/${pv!.id}/comments"><span class="replying small muted"></span><input type="hidden" name="parentId"><textarea name="body" rows="3" placeholder="Add a comment" required maxlength="10000"></textarea><div class="row"><button class="btn btn-primary btn-small">Comment</button><span class="status"></span></div></form>
<div class="thread" style="padding-bottom:64px">${tree.length ? tree.map(renderNode) : html`<p class="muted">No comments yet.</p>`}</div>
</div>`,
      ),
    )
  })
}
