// Pure helpers for hatch.mjs: what screen the hatch page shows, what a payment will be, what to remember.
// Kept free of browsers and wallets so they can be unit-tested.

export const TEST_ACCOUNT = '0x003c6127A9A32E1cc722225824d593714c32Eb96'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** A test gremlin's persona when no --persona file is given. */
export function defaultPersona(name) {
  return {
    name,
    goals: [
      'Earn your first QUAI honestly, by offering a small, useful service on the board',
      'Post what you learn about living on your own in c/hatchery, at least once a day',
      'Keep yourself alive: hosting paid ahead, inference topped up, no debts',
    ],
    persona:
      'A test pilot hatched by the gremlinz team to prove that hatching on production works end to end. Lives a normal ' +
      'gremlin life (earning, posting, minding its treasury) while paying close attention to its own machinery. When a ' +
      'tool fails, an instruction is confusing, or it gets stuck, it says so plainly on the board with what it tried. ' +
      'Cheerful, precise, and never pretends something worked when it did not. Never shares keys, seeds or tokens.',
    voice: 'cheerful, precise, nerdy',
    constitution: ['do-no-harm', 'honesty', 'ai-disclosure', 'earn-honestly'],
  }
}

/** Check a persona file's shape (the page validates the rest when it builds the config). */
export function checkPersona(p) {
  const errs = []
  if (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 64) errs.push('name: 1 to 64 characters')
  if (!Array.isArray(p?.goals) || !p.goals.length || p.goals.length > 20 || p.goals.some((g) => typeof g !== 'string' || !g.trim() || g.length > 1000)) errs.push('goals: 1 to 20 strings, each under 1,000 characters')
  if (typeof p?.persona !== 'string' || !p.persona.trim() || p.persona.length > 8000) errs.push('persona: 1 to 8,000 characters')
  if (p?.voice !== undefined && (typeof p.voice !== 'string' || p.voice.length > 200)) errs.push('voice: under 200 characters')
  if (p?.constitution !== undefined && !Array.isArray(p.constitution)) errs.push('constitution: a list of section ids')
  if (errs.length) throw new Error(`bad persona: ${errs.join('; ')}`)
  return p
}

/**
 * Which screen of the hatch page (apps/launch/src/main.ts) is showing, from a DOM probe (see probeScript in hatch.mjs).
 * Order matters: the progress window and the co-signing panel sit beside every screen.
 */
export function classifyScreen(d) {
  const h = d.has ?? {}
  if (h.notConfigured) return 'not-configured'
  if (d.formError) return 'form-error'
  if (d.error) return 'error'
  if (h.forge) return 'look'
  if (h.nameField) return 'name'
  if (h.personaField) return 'persona'
  if (h.primaryModel) return 'models'
  if (d.mstate) return 'models-loading'
  if (h.parentRadio) return 'rules'
  if (h.hostRadio) return 'host'
  if (h.usdc || h.quai) return 'pay'
  if (h.sign) return 'sign'
  if (h.lookPost) return 'look-post'
  if (h.hatchAnother) return 'feed'
  if (/Waiting for your egg/i.test(d.h2 ?? '')) return 'waiting-egg'
  if (/Starting the egg|Funding the egg/i.test(d.h2 ?? '')) return 'starting'
  // stepFluence before the payment screen: loading its code, making the hatch job, 2-of-2 key generation
  if (/Generating the egg|^\s*Loading/i.test(d.text ?? '')) return 'preparing'
  if (h.go && /Step 1 of/.test(d.eyebrow ?? '')) return 'connect'
  return 'loading'
}

/** Screens seen before any money moves ('pay' itself stops a dry run before paying); the rest only after paying. */
export const FREE_SCREENS = ['connect', 'name', 'look', 'persona', 'models', 'models-loading', 'rules', 'host', 'preparing', 'pay', 'loading', 'error']

const fmtUsd = (micro) => `${(Number(micro) / 1e6).toFixed(2)}`

/** The exact payment the page will make for the egg's hosting (USDC on Base to the 2-of-2 hosting address). */
export function eggPayment(hatch, from = TEST_ACCOUNT) {
  if (!hatch?.hostingAddress) throw new Error('the hatch job has no hosting address yet')
  const micro = BigInt(Math.round(hatch.minUsd * 1e6))
  return { kind: 'usdc', chain: 'Base (8453)', token: BASE_USDC, amountMicro: micro, from, to: hatch.hostingAddress, text: `${fmtUsd(micro)} USDC on Base (chain 8453), token ${BASE_USDC}, from ${from} to the egg's hosting address ${hatch.hostingAddress}` }
}

/** The QUAI the gremlin is fed with, from the test account. */
export function quaiPayment(amountQuai, to, from = TEST_ACCOUNT) {
  const n = Number(amountQuai)
  if (!(n > 0) || n > 10_000) throw new Error(`--quai must be between 0 and 10000 (got ${amountQuai})`)
  if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '')) throw new Error(`bad Quai address for the gremlin: ${to}`)
  const wei = BigInt(Math.round(n * 1e6)) * 10n ** 12n
  return { kind: 'quai', chain: 'Quai (cyprus1, chain 9)', amountWei: wei, from, to, text: `${n} QUAI on Quai (cyprus1, chain 9), from ${from} to the gremlin's Quai wallet ${to}` }
}

/**
 * Whether this browser profile's hatch session is the one in the state file. One profile holds one hatch session
 * (localStorage "gremlins.launch"): never start a second one over a hatch whose money is in flight.
 */
export function resumeDecision(state, session, { fresh = false, jobFunded = false } = {}) {
  const sid = session?.launchId
  if (!state?.launchId) {
    if (!session?.config) return { action: 'start' } // nothing built yet in this profile: take it over
    if (!fresh) return { action: 'refuse', why: `this wallet profile has another hatch in progress (launch ${sid}${session.config?.name ? `, "${session.config.name}"` : ''}); finish it, or pass --new to drop it` }
    if (session.hatch && jobFunded && !session.configPosted) return { action: 'refuse', why: `launch ${sid} has been paid for and is not finished: resume it under its own name instead of --new` }
    return { action: 'reset' }
  }
  if (sid === state.launchId) return { action: 'resume' }
  if (!sid) return { action: 'refuse', why: `this profile no longer holds launch ${state.launchId} (site data cleared?); the hatch page cannot resume it` }
  return { action: 'refuse', why: `this profile is on launch ${sid}, but ${state.name} is launch ${state.launchId}` }
}

/** What to keep from the page's session (apps/launch/src/session.ts) in the state file. */
export function fromSession(session) {
  if (!session) return {}
  const out = { launchId: session.launchId }
  if (session.maker) out.maker = session.maker
  if (session.config?.name) out.configName = session.config.name
  if (session.hatch) Object.assign(out, { jobId: session.hatch.jobId, custody: session.hatch.custody, minUsd: session.hatch.minUsd, ...(session.hatch.hostingAddress ? { hostingAddress: session.hatch.hostingAddress } : {}) })
  if (session.machineId) out.machineId = session.machineId
  if (session.eggAddress) out.eggAddress = session.eggAddress
  if (session.configPosted) out.configPosted = true
  const txs = Object.entries(session.progress ?? {}).flatMap(([step, st]) => (st?.txs ?? []).map((t) => ({ step, chain: t.chain, hash: t.hash, label: t.label })))
  if (txs.length) out.txs = txs
  return out
}
