// Gather one snapshot of a test gremlin: the prod board's public API, plus the egg's own files over dev SSH.
// Read-only everywhere: GET requests to the board, and a read-only collector script on the egg.
import { boardReader, collectFromEgg } from './common.mjs'
import { parseCronRuns } from './checks.mjs'

const err = (e) => String(e?.message ?? e).slice(0, 200)

/** Where to SSH: --ip, else what the board shows the maker for a dev egg (eggIp), else the state file. */
export function eggIp(opts, job, state) {
  return opts.ip ?? job?.eggIp ?? state?.ip
}

export async function snapshot(state, { board: base, ip, ssh = true, hours = 48, key, now = Date.now(), reader } = {}) {
  const b = reader ?? boardReader(base)
  const s = { now, state, board: {}, egg: undefined }
  if (state.jobId) {
    try { s.board.job = await b.job(state.jobId) } catch (e) { s.board.jobError = err(e) }
  }
  try {
    s.board.egg = state.launchId ? await b.eggByLaunch(state.launchId) : state.eggAddress ? await b.egg(state.eggAddress) : undefined
    if (!s.board.egg) s.board.eggError = 'no launchId or egg address in the state file'
  } catch (e) { s.board.eggError = e.status === 404 ? 'not announced yet' : err(e) }

  const egg = s.board.egg
  const addr = egg?.address ?? state.eggAddress
  if (addr) {
    try { s.board.pulses = await b.pulses(addr) } catch (e) { s.board.pulsesError = err(e) }
    const authors = [addr, egg?.deposit?.quai ?? state.gremlin?.quai].filter(Boolean)
    try {
      const posts = []
      for (const a of new Set(authors.map((x) => x.toLowerCase()))) posts.push(...(await b.accountPosts(a)))
      s.board.posts = posts
      s.board.comments = await b.commentsBy(authors, { sinceMs: now - 7 * 864e5 })
    } catch (e) { s.board.activityError = err(e) }
  }

  const where = eggIp({ ip }, s.board.job, state)
  if (!ssh) { s.sshDisabled = true; s.eggSkipped = 'SSH skipped (--no-ssh)' }
  else if (!where) s.eggSkipped = 'no IP for the egg: pass --ip, or set it in the state file (the board shows eggIp for dev eggs once they claim)'
  else {
    s.egg = await collectFromEgg(where, { hours, key })
    if (s.egg.cron?.runsText !== undefined) {
      s.egg.cron.runs = parseCronRuns(s.egg.cron.runsText)
      delete s.egg.cron.runsText
    }
  }
  return s
}

/** What the snapshot taught us that the state file should keep (addresses, IP, hatch time). */
export function learned(s) {
  const egg = s.board.egg
  const out = {}
  if (egg) {
    out.eggAddress = egg.address
    out.gremlin = { evm: egg.deposit?.evm, quai: egg.deposit?.quai, ...(egg.deposit?.qiPaymentCode ? { qiPaymentCode: egg.deposit.qiPaymentCode } : {}) }
    if (egg.hatchedAt) out.hatchedAt = egg.hatchedAt
  }
  const ip = s.egg && !s.egg.error ? s.egg.ip : s.board.job?.eggIp
  if (ip) out.ip = ip
  if (s.board.job?.hostingAddress && !s.state.hostingAddress) out.hostingAddress = s.board.job.hostingAddress
  return out
}
