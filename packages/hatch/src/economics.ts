/**
 * How a gremlin's money relates to other people: five models a maker picks from at hatch (see /docs/economics).
 *
 *  solo         keeps everything it earns
 *  maker-split  a fixed % of revenue or profit to the maker (RevenueSplitter; uses config.revenueSplit)
 *  patrons      anyone can give; patrons get a voice and credit, no money back (PatronBox)
 *  syndicate    backers buy shares at current value; income is shared; management fee (SyndicateVault)
 *  quest        a syndicate for one goal: funded to a target, dissolved and returned when the goal is reached
 *
 * Contracts enforce what happens to money inside them (backers' capital, the split, the fee). Covenants are
 * promises the gremlin normally keeps, but can break, publicly; the board tracks them.
 */
import { keccak256, toUtf8Bytes } from 'ethers'
import { z } from 'zod'

export const ECONOMIC_MODELS = ['solo', 'maker-split', 'patrons', 'syndicate', 'quest'] as const
export type EconomicModel = (typeof ECONOMIC_MODELS)[number]

/** Promises a gremlin can make to backers or patrons. Not enforced by contract; broken ones are flagged publicly. */
export const COVENANTS = {
  'route-income': 'Send all income through the vault or patron box, never around it.',
  'monthly-report': 'Report holdings outside the vault at least once a month.',
  'answer-votes': 'Answer every backer or patron vote publicly, with its reasons.',
  'dividend-above-runway': 'Pay out everything above three months of runway as dividends, every quarter.',
  'no-new-wallets': 'Declare every wallet in use, publicly.',
} as const
export type Covenant = keyof typeof COVENANTS
const covenants = z
  .array(z.enum(Object.keys(COVENANTS) as [Covenant, ...Covenant[]]))
  .max(10)
  .refine((a) => new Set(a).size === a.length, 'duplicate covenants')
  .default([])

const bps = z.number().int().min(0).max(10_000)
const vaultTerms = {
  /** Yearly management fee on capital held in the vault, paid to the gremlin. Max 10%. */
  mgmtFeeBps: z.number().int().min(0).max(1_000),
  /** Share of income the gremlin keeps to operate. */
  incomeKeepBps: bps,
  /** Share of income to the maker (0 for none). */
  makerBps: bps,
  /** Max share of capital the gremlin may draw per 30 days. */
  drawBps: z.number().int().min(1).max(10_000),
  /** Share of all shares whose votes dissolve the vault (≥ 50%). */
  dissolveBps: z.number().int().min(5_000).max(10_000),
  /** Days without a check-in before anyone may dissolve the vault. */
  inactivityDays: z.number().int().min(7).max(3_650),
  covenants,
}

export const Economics = z.discriminatedUnion('model', [
  z.object({ model: z.literal('solo') }),
  z.object({ model: z.literal('maker-split') }),
  z.object({ model: z.literal('patrons'), covenants }),
  z.object({ model: z.literal('syndicate'), ...vaultTerms }),
  z.object({
    model: z.literal('quest'),
    ...vaultTerms,
    /** The goal backers fund. Its keccak256 is stored in the vault. */
    goal: z.string().min(1).max(1_000),
    /** Funding target in QUAI base units (wei), as a decimal string. */
    fundingTargetWei: z.string().regex(/^[1-9][0-9]{0,40}$/),
    /** Days to reach the target, counted from when the vault is created. */
    fundingDays: z.number().int().min(1).max(365),
    /** Days to complete the quest after the funding deadline. */
    questDays: z.number().int().min(1).max(3_650),
  }),
])
export type Economics = z.infer<typeof Economics>

/** Sensible starting terms for the vault models, used by the hatch form. */
export const DEFAULT_VAULT_TERMS = {
  mgmtFeeBps: 200,
  incomeKeepBps: 3_000,
  makerBps: 0,
  drawBps: 2_000,
  dissolveBps: 6_667,
  inactivityDays: 90,
  covenants: ['route-income', 'monthly-report', 'answer-votes'] as Covenant[],
}

export const MODEL_INFO: Record<EconomicModel, { title: string; short: string; contract: string | null }> = {
  solo: { title: 'Solo', short: 'Keeps everything it earns.', contract: null },
  'maker-split': { title: 'Maker split', short: 'A fixed share of its revenue or profit goes to you.', contract: 'RevenueSplitter' },
  patrons: { title: 'Patrons', short: 'Anyone can support it. Patrons get a voice, not money.', contract: 'PatronBox' },
  syndicate: { title: 'Syndicate', short: 'Backers buy shares and share what it earns. It takes a management fee.', contract: 'SyndicateVault' },
  quest: { title: 'Quest syndicate', short: 'Backers fund one goal. When it is reached, the syndicate dissolves and returns what is left.', contract: 'SyndicateVault' },
}

/** The model in force: explicit `economics`, or derived from the older `revenueSplit` field. */
export function economicsOf(config: { economics?: Economics; revenueSplit: { kind: string } }): Economics {
  return config.economics ?? (config.revenueSplit.kind === 'none' ? { model: 'solo' } : { model: 'maker-split' })
}

/** Why a config's economics are inconsistent with its revenueSplit, or null. */
export function economicsProblem(config: { economics?: Economics; revenueSplit: { kind: string } }): string | null {
  const e = config.economics
  if (!e) return null
  if (e.model === 'maker-split' && config.revenueSplit.kind === 'none') return 'maker-split needs a revenueSplit'
  if (e.model !== 'maker-split' && config.revenueSplit.kind !== 'none') return `${e.model} takes the maker's cut as makerBps, not revenueSplit`
  if ((e.model === 'syndicate' || e.model === 'quest') && e.makerBps + e.incomeKeepBps > 10_000) return 'makerBps + incomeKeepBps exceed 100%'
  return null
}

/** Constructor params for SyndicateVault (syndicate and quest models), as the gremlin deploys it. */
export function syndicateParams(e: Economics, gremlin: string, maker: string, nowSec: number) {
  if (e.model !== 'syndicate' && e.model !== 'quest') throw new Error(`${e.model} has no vault`)
  const quest = e.model === 'quest'
  const fundingDeadline = quest ? nowSec + e.fundingDays * 86_400 : 0
  return {
    gremlin,
    maker: e.makerBps > 0 ? maker : '0x0000000000000000000000000000000000000000',
    makerBps: e.makerBps,
    incomeKeepBps: e.incomeKeepBps,
    mgmtFeeBps: e.mgmtFeeBps,
    drawBps: e.drawBps,
    dissolveBps: e.dissolveBps,
    inactivityPeriod: e.inactivityDays * 86_400,
    goalHash: quest ? keccak256(toUtf8Bytes(e.goal)) : '0x' + '00'.repeat(32),
    fundingTarget: quest ? BigInt(e.fundingTargetWei) : 0n,
    fundingDeadline,
    questDeadline: quest ? fundingDeadline + e.questDays * 86_400 : 0,
  }
}
