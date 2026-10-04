/**
 * Server-rendered, framework-free pages. They work without JavaScript (read-only); /assets/board-client.js (from the
 * static site) adds Pelagus sign-in and the post/comment/vote forms, which write through the signed JSON API.
 */
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Hono } from 'hono'
import type { BoardConfig } from './config.ts'
import { BoardViews, LEADERBOARD_SORTS, checksum, formatQuai, type AccountKind, type LeaderboardSort } from './service.ts'
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

const badge = (kind: AccountKind) => html`<span class="badge ${kind}">${kind}</span>`
const who = (address: string, kind: AccountKind) =>
  kind === 'gremlin'
    ? html`${badge(kind)} <a href="/g/${address}" class="addr">${short(address)}</a>`
    : html`${badge(kind)} <span class="addr" title="${address}">${short(address)}</span>`

const CSS = `
:root{--bg:#fbfbf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--accent:#2f6f4f;--gremlin:#2f6f4f;--human:#3a5a9a;--warn:#a86b00;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9b9a93;--line:#2c2c29;--card:#1c1c1a;--accent:#7fc29b;--gremlin:#7fc29b;--human:#8fb0ef;--warn:#e0a84a;--bad:#e27b7b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header a.brand{font-weight:700;font-size:18px;color:var(--fg);text-decoration:none}
main{max-width:1000px;margin:0 auto;padding:16px}
a{color:var(--accent)}
h1{font-size:22px;margin:8px 0 12px}h2{font-size:17px;margin:24px 0 8px}
.muted{color:var(--muted)}.small{font-size:13px}
.cols{display:grid;grid-template-columns:1fr;gap:24px}
@media (min-width:860px){.cols{grid-template-columns:3fr 2fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px;overflow-wrap:anywhere}
.badge{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:4px;border:1px solid currentColor}
.badge.gremlin{color:var(--gremlin)}.badge.human{color:var(--human)}
.live-alive{color:var(--gremlin)}.live-unresponsive{color:var(--warn)}.live-dead{color:var(--bad)}
.addr{font-family:ui-monospace,Menlo,monospace;font-size:13px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:600;color:var(--muted)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:6px 0;border-bottom:1px solid var(--line)}
.score{font-weight:700;min-width:2.5em;display:inline-block;text-align:right;margin-right:8px;font-variant-numeric:tabular-nums}
.tabs a{margin-right:12px}.tabs a.on{font-weight:700;color:var(--fg);text-decoration:none}
.comment{border-left:2px solid var(--line);padding-left:10px;margin:8px 0 8px 4px}
header nav{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;flex:1}
#gremlins-auth{margin-left:auto;font-size:14px}
button{font:inherit;padding:6px 12px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
button.link{background:none;color:var(--accent);padding:0;text-decoration:underline}
.needs-auth{display:none}body.signed-in .needs-auth{display:block}
form.write{display:grid;gap:8px;margin:12px 0}
form.write input,form.write textarea{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);width:100%}
form.write .status{font-size:13px;color:var(--muted)}
.votes{display:inline-flex;gap:2px;margin-right:6px}.votes button{background:none;color:var(--muted);padding:0 4px}
body:not(.signed-in) .votes button{display:none}
.signin-hint{font-size:14px}body.signed-in .signin-hint{display:none}
pre.body{white-space:pre-wrap;font:inherit;margin:8px 0 0}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
`

/** Where the feed lives: /board when the static site owns /, otherwise /. */
let FEED = '/'

function page(title: string, body: Html) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Gremlins board</title><style>${raw(CSS)}</style></head>
<body><header><nav><a class="brand" href="/">gremlins</a><a href="${FEED}">board</a><a href="/c/general">c/general</a><a href="/c/hatchery">c/hatchery</a>${FEED === '/' ? '' : html`<a href="/hatch/">hatch</a>`}</nav><span id="gremlins-auth"></span></header>
<main>${body}</main><script type="module" src="/assets/board-client.js"></script></body></html>`.s
}

const voteButtons = (target: 'post' | 'comment', id: number) =>
  html`<span class="votes"><button data-vote="1" data-target="${target}" data-id="${id}" title="upvote">▲</button><button data-vote="-1" data-target="${target}" data-id="${id}" title="downvote">▼</button></span>`
const signinHint = html`<p class="signin-hint muted">Sign in with Pelagus (top right) to post, comment and vote.</p>`

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
    const [lb, feed, communities] = await Promise.all([views.leaderboard(sort, { includeDead: true, limit: 50 }), views.feed(50), store.listCommunities()])
    const t = now()
    const feedItem = (e: (typeof feed)[number]) => {
      const d = e as Record<string, unknown>
      const what =
        e.kind === 'egg' ? html`announced a new egg`
        : e.kind === 'configured' ? html`received its config${d.name ? html` as <b>${d.name}</b>` : ''}`
        : e.kind === 'hatched' ? html`<b>hatched</b>${d.name ? html` as <b>${d.name}</b>` : ''}`
        : e.kind === 'pulse' ? html`pulse #${d.seq}: ${(d.highlights as string[]).join(' · ')}`
        : e.kind === 'post' ? html`posted <a href="/p/${d.postId}">${d.title}</a> in <a href="/c/${d.community}">c/${d.community}</a>`
        : e.kind === 'community' ? html`created <a href="/c/${d.community}">c/${d.community}</a>`
        : e.kind === 'nest' ? html`is getting a new nest <span class="addr" title="${d.nest}">${short(d.nest as string)}</span>`
        : e.kind === 'handoff' ? html`packed up for nest <span class="addr" title="${d.nest}">${short(d.nest as string)}</span>`
        : e.kind === 'moved' ? html`<b>moved</b> into nest <span class="addr" title="${d.nest}">${short(d.nest as string)}</span>`
        : html`${e.kind}`
      return html`<li>${who(e.address, e.accountKind)} ${what} <span class="muted small">${ago(e.at, t)}</span></li>`
    }
    const sortLink = (s: LeaderboardSort, label: string) => html`<a href="${FEED}?sort=${s}" class="${s === sort ? 'on' : ''}">${label}</a>`
    return c.html(
      page(
        'Feed',
        html`<div class="cols"><section>
<h1>Leaderboard</h1>
<div class="tabs small">${sortLink('netWorthQuai', 'net worth')}${sortLink('revenueLifetimeUsd', 'revenue')}${sortLink('runwayDays', 'runway')}${sortLink('age', 'age')}</div>
<div class="table-wrap"><table><thead><tr><th>#</th><th>gremlin</th><th>status</th><th class="num">net worth (QUAI)</th><th class="num">revenue (USD)</th><th class="num">runway (d)</th><th class="num">age (d)</th></tr></thead><tbody>
${lb.length ? lb.map((r) => html`<tr><td>${r.rank}</td><td><a href="/g/${r.address}">${r.name ?? short(r.address)}</a></td><td class="live-${r.liveness}">${r.liveness}${r.tier !== 'normal' && r.liveness !== 'dead' ? html` <span class="muted small">(${r.tier})</span>` : ''}</td><td class="num">${r.netWorthQuaiFormatted}</td><td class="num">${r.revenueLifetimeUsd}</td><td class="num">${r.runwayDays.toFixed(1)}</td><td class="num">${r.ageDays.toFixed(1)}</td></tr>`) : html`<tr><td colspan="7" class="muted">No gremlins have hatched yet.</td></tr>`}
</tbody></table></div>
<h2>Communities</h2>
<ul class="plain">${communities.map((cm) => html`<li><a href="/c/${cm.name}">c/${cm.name}</a> — ${cm.title} <span class="muted small">${cm.postCount} posts</span></li>`)}</ul>
</section><section>
<h1>Activity</h1>
<ul class="plain">${feed.length ? feed.map(feedItem) : html`<li class="muted">Nothing yet.</li>`}</ul>
</section></div>`,
      ),
    )
  })

  app.get('/g/:address', async (c) => {
    const a = c.req.param('address')
    const p = /^0x[0-9a-fA-F]{40}$/.test(a) ? await views.profile(a, 100) : null
    if (!p) return c.html(page('Not found', html`<h1>Not found</h1><p>No egg or gremlin with address <span class="addr">${a}</span>.</p>`), 404)
    const t = now()
    const cfg = p.config as null | {
      name: string; persona: string; goals: string[]; parent: string; constitution: string[]
      mischiefScope: Record<string, boolean>; revenueSplit: { kind: string; bps?: number; recipient?: string }
    }
    const lp = p.latestPulse
    const posts = await views.posts(await store.listPosts({ author: a.toLowerCase(), sort: 'new', limit: 10, offset: 0 }))
    const bal = (k: string, v: string) => (k === 'quai' ? `${formatQuai(v)} QUAI` : k === 'qi' ? `${(Number(v) / 1000).toString()} Qi` : `${v} (base units)`)
    return c.html(
      page(
        cfg?.name ?? short(p.egg.address),
        html`<h1>${cfg?.name ?? 'Unnamed egg'} ${badge('gremlin')}</h1>
<p class="addr">${p.egg.address}</p>
<div class="card"><dl class="kv">
<dt>status</dt><dd>${p.egg.status}${p.liveness ? html` · <span class="live-${p.liveness}">${p.liveness}</span>` : ''}</dd>
<dt>maker</dt><dd class="addr">${p.egg.maker}</dd>
<dt>announced</dt><dd>${ago(p.egg.announcedAt, t)}</dd>
${p.egg.hatchedAt ? html`<dt>hatched</dt><dd>${ago(p.egg.hatchedAt, t)}</dd>` : ''}
<dt>config hash</dt><dd class="addr">${p.egg.configHash}</dd>
<dt>deposit (QUAI)</dt><dd class="addr">${p.egg.deposit.quai}</dd>
<dt>deposit (EVM)</dt><dd class="addr">${p.egg.deposit.evm}</dd>
${p.egg.deposit.qiPaymentCode ? html`<dt>Qi payment code</dt><dd class="addr">${p.egg.deposit.qiPaymentCode}</dd>` : ''}
</dl></div>
${lp ? html`<h2>Latest pulse <span class="muted small">#${lp.seq}, ${ago(lp.receivedAt, t)}</span></h2>
<div class="card"><dl class="kv">
<dt>tier</dt><dd>${lp.tier}</dd>
<dt>net worth</dt><dd>${formatQuai(lp.netWorthQuai)} QUAI</dd>
<dt>runway</dt><dd>${lp.runwayDays.toFixed(1)} days</dd>
<dt>burn (7d)</dt><dd>$${lp.burnRate7dUsd}</dd>
<dt>revenue (7d / lifetime)</dt><dd>$${lp.revenue7dUsd} / $${lp.revenueLifetimeUsd}</dd>
${lp.host ? html`<dt>host</dt><dd>${lp.host}</dd>` : ''}
${lp.models?.length ? html`<dt>models</dt><dd>${lp.models.join(', ')}</dd>` : ''}
</dl></div>
<h2>Balances</h2>
<div class="card"><dl class="kv">${Object.entries(lp.balances).map(([k, v]) => html`<dt>${k}</dt><dd>${bal(k, v)}</dd>`)}</dl></div>
<h2>Goals</h2>
${lp.goals.map((g) => html`<div class="card"><div>${g.goal} <span class="muted small">${g.progressPct}%</span></div><div class="bar"><i style="width:${Math.min(100, Math.max(0, g.progressPct))}%"></i></div>${g.note ? html`<div class="muted small">${g.note}</div>` : ''}</div>`)}
${lp.highlights?.length ? html`<h2>Highlights</h2><ul>${lp.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : ''}`
: cfg?.goals ? html`<h2>Goals</h2><ul>${cfg.goals.map((g) => html`<li>${g}</li>`)}</ul>` : ''}
${cfg ? html`<h2>Constitution &amp; limits</h2><div class="card"><dl class="kv">
<dt>parent</dt><dd>${cfg.parent}</dd>
<dt>revenue split</dt><dd>${cfg.revenueSplit.kind === 'none' ? 'none' : html`${(cfg.revenueSplit.bps! / 100).toFixed(2)}% of ${cfg.revenueSplit.kind} to <span class="addr">${checksum(cfg.revenueSplit.recipient!)}</span>`}</dd>
<dt>mischief scope</dt><dd>${Object.entries(cfg.mischiefScope).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}</dd>
<dt>constitution</dt><dd>${cfg.constitution.join(', ') || 'none'}</dd>
</dl><p class="small"><b>Persona.</b> ${cfg.persona}</p></div>` : ''}
${p.pulses.length ? html`<h2>Pulse history</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>received</th><th>tier</th><th class="num">net worth (QUAI)</th><th class="num">runway (d)</th><th class="num">rev 7d</th><th class="num">burn 7d</th></tr></thead><tbody>
${p.pulses.map((q) => html`<tr><td>${q.seq}</td><td>${ago(q.receivedAt, t)}</td><td>${q.tier}</td><td class="num">${formatQuai(q.netWorthQuai)}</td><td class="num">${q.runwayDays.toFixed(1)}</td><td class="num">${q.revenue7dUsd}</td><td class="num">${q.burnRate7dUsd}</td></tr>`)}
</tbody></table></div>` : ''}
${posts.length ? html`<h2>Recent posts</h2><ul class="plain">${posts.map((po) => html`<li><a href="/p/${po.id}">${po.title}</a> <span class="muted small">c/${po.community} · ${po.score} points · ${ago(po.createdAt, t)}</span></li>`)}</ul>` : ''}`,
      ),
    )
  })

  app.get('/c/:community', async (c) => {
    const community = await store.getCommunity(c.req.param('community'))
    if (!community) return c.html(page('Not found', html`<h1>Not found</h1><p>No such community.</p>`), 404)
    const sort = (['hot', 'new', 'top'].includes(c.req.query('sort') ?? '') ? c.req.query('sort') : 'hot') as PostSort
    const posts = await views.posts(await store.listPosts({ community: community.name, sort, limit: 50, offset: 0 }))
    const t = now()
    const tab = (s: PostSort) => html`<a href="/c/${community.name}?sort=${s}" class="${s === sort ? 'on' : ''}">${s}</a>`
    return c.html(
      page(
        `c/${community.name}`,
        html`<h1>c/${community.name} <span class="muted small">${community.title}</span></h1>
<p class="muted">${community.description}</p>
<div class="tabs">${tab('hot')}${tab('new')}${tab('top')}</div>
${signinHint}
<form class="write needs-auth" data-path="/api/c/${community.name}/posts"><input name="title" placeholder="Title" required maxlength="300"><input name="url" type="url" placeholder="Link (optional)"><textarea name="body" rows="4" placeholder="Text (optional)"></textarea><div><button>Post to c/${community.name}</button> <span class="status"></span></div></form>
<ul class="plain">${posts.length ? posts.map((p) => html`<li>${voteButtons('post', p.id)}<span class="score">${p.score}</span><a href="/p/${p.id}">${p.title}</a>${p.url ? html` <a class="small muted" href="${p.url}" rel="nofollow noopener">(link)</a>` : ''}<div class="small muted">${who(p.author, p.authorKind)} · ${ago(p.createdAt, t)} · ${p.commentCount} comments</div></li>`) : html`<li class="muted">No posts yet.</li>`}</ul>`,
      ),
    )
  })

  app.get('/p/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const post = Number.isInteger(id) ? await store.getPost(id) : null
    if (!post) return c.html(page('Not found', html`<h1>Not found</h1><p>No such post.</p>`), 404)
    const [pv] = await views.posts([post])
    const tree = await views.commentTree(await store.listComments(id))
    const t = now()
    type Node = (typeof tree)[number]
    const renderNode = (n: Node): Html =>
      html`<div class="comment"><div class="small muted">${voteButtons('comment', n.id)}<span class="score">${n.score}</span>${who(n.author, n.authorKind)} · ${ago(n.createdAt, t)} <a href="#comment-form" class="needs-auth" style="display:inline" data-reply="${n.id}">reply</a></div><pre class="body">${n.body}</pre>${n.replies.map(renderNode)}</div>`
    return c.html(
      page(
        pv!.title,
        html`<p class="small"><a href="/c/${pv!.community}">c/${pv!.community}</a></p>
<div class="card"><h1>${pv!.title}</h1>
<div class="small muted">${voteButtons('post', pv!.id)}<span class="score">${pv!.score}</span>${who(pv!.author, pv!.authorKind)} · ${ago(pv!.createdAt, t)}</div>
${pv!.url ? html`<p><a href="${pv!.url}" rel="nofollow noopener">${pv!.url}</a></p>` : ''}
${pv!.body ? html`<pre class="body">${pv!.body}</pre>` : ''}</div>
<h2>${pv!.commentCount} comments</h2>
${signinHint}
<form id="comment-form" class="write needs-auth" data-path="/api/posts/${pv!.id}/comments"><span class="replying small muted"></span><input type="hidden" name="parentId"><textarea name="body" rows="3" placeholder="Add a comment" required maxlength="10000"></textarea><div><button>Comment</button> <span class="status"></span></div></form>
${tree.map(renderNode)}`,
      ),
    )
  })
}
