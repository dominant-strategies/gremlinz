/**
 * Keeping a gremlin patched. Nobody patches a gremlin for it (no owner, no off switch), so it checks itself:
 *
 * - its image against the published release feed (docs/releases.json): every security fix shipped in a newer release
 *   is a known hole in this one, and the way out is move_out to that release's image;
 * - the runtime it is actually running (Node), for fixes we can test for directly;
 * - Debian security updates pending inside its container, which it can apply itself (security_patch_os).
 *
 * The host OS under the container patches itself (unattended-upgrades, set up by cloud-init).
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { constants as zlibConstants } from 'node:zlib'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { homeFile } from '../env.js'
import { fail, text } from '../result.js'

const run = promisify(execFile)
const HOUR = 60 * 60_000
/** A check is remembered this long, so calling it on every wake-up costs nothing. */
const CACHE_MS = 12 * HOUR

export const RELEASES_URL = 'https://raw.githubusercontent.com/dominant-strategies/gremlinz/main/docs/releases.json'

const Fix = z.object({ id: z.string(), severity: z.enum(['low', 'medium', 'high', 'critical']), summary: z.string() })
const Release = z.object({
  tag: z.string(),
  date: z.string(),
  image: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  artifact: z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  node: z.string().optional(),
  fixes: z.array(Fix).default([]),
})
/** Newest release first. A fix listed on a release is missing from every release after it in the list. */
export const ReleaseFeed = z.object({ repository: z.string(), releases: z.array(Release).min(1) })
export type ReleaseFeed = z.infer<typeof ReleaseFeed>
type Fix = z.infer<typeof Fix>

/** Fixes the running Node can be tested for directly (version strings don't always change with a backported fix). */
const RUNTIME_CHECKS: { id: string; fixedIn: string; present: () => boolean }[] = [
  // The fix is a cherry-pick (process.versions.brotli stays 1.2.0) that also added this constant.
  { id: 'CVE-2026-111497', fixedIn: 'Node 22.23.4, 24.22.1 or 26.12.1', present: () => (zlibConstants as Record<string, unknown>).BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH !== undefined },
]

export interface OsUpdates { security: string[]; other: number }

export interface SecurityDeps {
  now?: () => number
  fetchFeed?: () => Promise<unknown>
  /** Pending apt upgrades in this container (refreshes the package lists first). */
  osUpdates?: () => Promise<OsUpdates>
  /** Applies pending apt upgrades; returns apt's summary line. */
  patchOs?: () => Promise<string>
  runtimeChecks?: typeof RUNTIME_CHECKS
}

const sudoApt = (args: string[]) => run('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', ...args], { timeout: 10 * 60_000, maxBuffer: 16 << 20 })

async function aptUpdates(): Promise<OsUpdates> {
  await sudoApt(['-qq', 'update'])
  const { stdout } = await run('apt-get', ['-s', '-o', 'Debug::NoLocking=1', 'upgrade'], { timeout: 120_000, maxBuffer: 16 << 20 })
  const inst = stdout.split('\n').filter((l) => l.startsWith('Inst '))
  const security = inst.filter((l) => /security/i.test(l)).map((l) => l.split(' ')[1]!)
  return { security, other: inst.length - security.length }
}

async function aptUpgrade(): Promise<string> {
  await sudoApt(['-qq', 'update'])
  const { stdout } = await sudoApt(['-y', '-o', 'Dpkg::Options::=--force-confold', 'upgrade'])
  return stdout.split('\n').find((l) => /upgraded,/.test(l))?.trim() ?? 'apt-get upgrade finished.'
}

async function fetchFeed(): Promise<unknown> {
  const r = await fetch(process.env.GREMLIN_RELEASES_URL ?? RELEASES_URL, { signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`release feed answered ${r.status}`)
  return r.json()
}

/** The image this server runs: from the moved launch data if the gremlin moved here, else cloud-init's. */
export function currentImage(): string | undefined {
  const moved = homeFile('launch.json')
  const path = existsSync(moved) ? moved : process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json'
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { image?: string }).image } catch { return undefined }
}

const repo = (image: string) => image.split('@')[0]
const digest = (image: string) => image.split('@')[1]

export interface ImageVerdict {
  current?: string
  release?: string
  latest: z.infer<typeof Release>
  /** Fixes shipped after this server's release, i.e. known holes in it. Empty when up to date. */
  missing: (Fix & { fixedIn: string })[]
  /** Newest release that fixes everything in `missing` (the image to move to). */
  moveTo?: z.infer<typeof Release>
  official: boolean
}

export function judgeImage(feed: ReleaseFeed, image: string | undefined): ImageVerdict {
  const latest = feed.releases[0]!
  const i = image ? feed.releases.findIndex((r) => digest(r.image) === digest(image)) : -1
  if (i < 0) return { current: image, latest, missing: [], official: false }
  const missing = feed.releases.slice(0, i).flatMap((r) => r.fixes.map((f) => ({ ...f, fixedIn: r.tag })))
  return { current: image, release: feed.releases[i]!.tag, latest, missing, moveTo: missing.length ? latest : undefined, official: true }
}

/** What a check found, for the health monitor (the report is the same text security_check shows). */
export interface SecuritySummary {
  osSecurityPending: number
  missing: { id: string; severity: Fix['severity'] }[]
  moveTo?: { tag: string; image: string }
  runtimeMissing: string[]
  error?: string
}

export interface SecurityResult { at: number; report: string; summary?: SecuritySummary; cached: boolean }

/** Run the checks (or return the remembered answer when it is younger than 12 hours). */
export async function runSecurityCheck(deps: SecurityDeps = {}, refresh = false): Promise<SecurityResult> {
  const now = deps.now ?? Date.now
  const checks = deps.runtimeChecks ?? RUNTIME_CHECKS
  const cachePath = homeFile('security-check.json')
  const cached = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Omit<SecurityResult, 'cached'>) : undefined
  if (!refresh && cached && now() - cached.at < CACHE_MS) return { ...cached, cached: true }

  const lines: string[] = []
  const todo: string[] = []
  let urgent = false
  const summary: SecuritySummary = { osSecurityPending: 0, missing: [], runtimeMissing: [] }

  // Image vs releases
  let feed: ReleaseFeed | undefined
  try { feed = ReleaseFeed.parse(await (deps.fetchFeed ?? fetchFeed)()) } catch (e) { summary.error = (e as Error).message; lines.push(`Release feed: could not read it (${(e as Error).message}). Image not checked; try again later.`) }
  const image = currentImage()
  if (feed) {
    const v = judgeImage(feed, image)
    if (!v.official) {
      lines.push(`Image: ${image ?? 'unknown'}: not a published release, so its fixes are unknown. Latest release is ${v.latest.tag} (${v.latest.date}).`)
      if (image && repo(image) === repo(v.latest.image)) todo.push(`Consider move_out with image ${v.latest.image} (${v.latest.tag}).`)
    } else if (!v.missing.length) {
      lines.push(`Image: ${v.release}, the latest release. No known holes.`)
    } else {
      urgent = v.missing.some((f) => f.severity === 'high' || f.severity === 'critical')
      summary.missing = v.missing.map((f) => ({ id: f.id, severity: f.severity }))
      summary.moveTo = { tag: v.moveTo!.tag, image: v.moveTo!.image }
      lines.push(`Image: ${v.release}. Known holes, fixed in newer releases:`)
      for (const f of v.missing) lines.push(`- ${f.id} (${f.severity}, fixed in ${f.fixedIn}): ${f.summary}`)
      todo.push(`Move to ${v.moveTo!.tag}: move_out with image ${v.moveTo!.image}. A new server is the only way to change your image; it costs a host payment and a few minutes' pause.${urgent ? ' High or critical: do this as soon as your runway allows, before optional work.' : ''}`)
    }
  }

  // The runtime actually running
  const broken = checks.filter((c) => !c.present())
  summary.runtimeMissing = broken.map((c) => c.id)
  lines.push(broken.length
    ? `Runtime: Node ${process.version} lacks fixes for ${broken.map((c) => `${c.id} (needs ${c.fixedIn})`).join(', ')}.`
    : `Runtime: Node ${process.version}, known fixes present.`)
  if (broken.length) { urgent = true; if (!todo.some((t) => t.startsWith('Move to'))) todo.push('Your runtime comes from your image: move_out to the latest release image.') }

  // OS packages in this container
  try {
    const os = await (deps.osUpdates ?? aptUpdates)()
    summary.osSecurityPending = os.security.length
    lines.push(os.security.length
      ? `OS packages: ${os.security.length} security update(s) pending (${os.security.slice(0, 12).join(', ')}${os.security.length > 12 ? ', …' : ''}), ${os.other} other.`
      : `OS packages: no security updates pending (${os.other} other updates).`)
    if (os.security.length) todo.push('Run security_patch_os now; it takes a minute and needs no money.')
  } catch (e) {
    lines.push(`OS packages: could not check (${(e as Error).message.split('\n')[0]}).`)
  }

  const report = [...lines, '', todo.length ? `To do${urgent ? ' (urgent)' : ''}:\n${todo.map((t) => `- ${t}`).join('\n')}` : 'Nothing to do.'].join('\n')
  const result = { at: now(), report, summary }
  writeFileSync(cachePath, JSON.stringify(result), { mode: 0o600 })
  return { ...result, cached: false }
}

/** Apply pending OS updates; the next check looks again. */
export async function patchOs(deps: SecurityDeps = {}): Promise<string> {
  const summary = await (deps.patchOs ?? aptUpgrade)()
  const cachePath = homeFile('security-check.json')
  if (existsSync(cachePath)) writeFileSync(cachePath, JSON.stringify({ at: 0, report: '' }), { mode: 0o600 })
  return summary
}

export function registerSecurityTools(server: McpServer, deps: SecurityDeps = {}) {
  server.registerTool('security_check', {
    description:
      'Check whether you are running with known security holes: your server image against the published releases, the runtime you run on, and OS security updates pending in your container. Says what to do about each. Remembers its answer for 12 hours (refresh: true to check again now). Call it on your wake-ups; it is cheap.',
    inputSchema: { refresh: z.boolean().optional() },
  }, async ({ refresh }) => {
    const r = await runSecurityCheck(deps, refresh)
    return text(r.cached ? `${r.report}\n\n(Checked ${new Date(r.at).toISOString()}; refresh: true to check again.)` : r.report)
  })

  server.registerTool('security_patch_os', {
    description:
      "Install pending OS package updates (Debian security fixes included) inside your container. Safe to run any time; takes a minute or two. It cannot update Node or the rest of your image: for those, move_out to a newer release (security_check says when).",
    inputSchema: {},
  }, async () => {
    try {
      const summary = await patchOs(deps)
      return text(`Patched: ${summary}`)
    } catch (e) {
      return fail(`Patching failed: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`)
    }
  })
}
