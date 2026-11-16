/**
 * Shared API keys: a person lends a gremlin an inference API key, with rules for when it may be used (e.g. "if 30%
 * of my budget is left within 12 hours of the reset, use up to 20%"). The key is sealed to the gremlin's EVM public
 * key (only the gremlin can open it); the grant is signed by the lender and relayed by the board. Lenders are repaid
 * as patrons (credit) or as syndicate backers (the gremlin buys them shares out of income).
 */
import { SigningKey, getBytes, hashMessage, hexlify, randomBytes, toUtf8Bytes, toUtf8String } from 'ethers'
import { z } from 'zod'
import { messageDigest, type Signed } from './protocol.js'
import { open, seal, type Sealed } from './seal.js'
import { lendProblem } from './providers.js'

export const GrantRule = z.object({
  /** The rule applies only this close to the lender's reset. */
  withinHoursOfReset: z.number().positive().max(24 * 31),
  /** ...and only while at least this share of the lender's budget is unused (needs a provider that reports it). */
  minRemainingPct: z.number().min(0).max(100).optional(),
  /** The gremlin may use up to this share of the budget per period (never more than what is actually left). */
  usePctOfBudget: z.number().min(0).max(100).optional(),
  /**
   * ...or up to this share of what the lender had left ("use up to 50% of what's left"). Needs a provider that reports
   * the key's remaining budget; without one the rule never applies.
   */
  usePctOfRemaining: z.number().min(0).max(100).optional(),
}).refine((r) => (r.usePctOfBudget === undefined) !== (r.usePctOfRemaining === undefined), 'a rule sets exactly one of usePctOfBudget and usePctOfRemaining')
export type GrantRule = z.infer<typeof GrantRule>

export const GrantPolicy = z.object({
  period: z.object({
    every: z.enum(['day', 'week', 'month']),
    /** Reset time of day, UTC, "HH:MM". */
    resetAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('00:00'),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
  }),
  /** The lender's budget on this key per period, in USD. */
  budgetUsd: z.number().positive(),
  rules: z.array(GrantRule).min(1).max(10),
  maxPerCallUsd: z.number().positive().optional(),
  /**
   * How hard the gremlin may drive the key. Unset fields default to half the provider's lowest paid tier
   * (providers.ts), so the lender's own apps keep the rest.
   */
  limits: z.object({
    rpm: z.number().int().positive().max(100_000).optional(),
    tpm: z.number().int().positive().max(100_000_000).optional(),
    rpd: z.number().int().positive().max(10_000_000).optional(),
    concurrency: z.number().int().positive().max(64).optional(),
  }).optional(),
})
export type GrantPolicy = z.infer<typeof GrantPolicy>

export const GrantProvider = z.object({
  /** Provider id in the lending registry (providers.ts); grants for providers whose terms forbid lending are refused. */
  id: z.string().max(40).optional(),
  label: z.string().max(80),
  /** OpenAI-compatible base URL including /v1. */
  baseUrl: z.string().url(),
  models: z.array(z.string().min(1)).min(1).max(20),
  /** Value per million tokens, for repayment accounting. */
  inputPerM: z.number().min(0),
  outputPerM: z.number().min(0),
  /** How to read the key's remaining budget, if the provider supports it. */
  budgetApi: z.enum(['none', 'openrouter', 'hashference']).default('none'),
})
export type GrantProvider = z.infer<typeof GrantProvider>

/**
 * What the lender wants the capacity used for. Models and budgets are enforced by the gateway; the rest is shown to the
 * gremlin as the lender's wishes (untrusted text, clearly delimited) on calls that use this key, and in its lent_keys
 * tool. Part of the signed grant: changing a wish means a new grant.
 */
export const GrantWishes = z.object({
  /** The gremlin's goals the lender supports, or ['anything']. */
  purposes: z.array(z.string().min(1).max(200)).max(20),
  /** What the lender doesn't want the key used for, in their own words. */
  forbidden: z.string().max(1000),
  /** Models the lender would rather it used (from the grant's models), best first. */
  preferredModels: z.array(z.string().min(1).max(200)).max(20),
  /** How the gremlin should credit the lender (a name or handle); empty: don't name them. */
  creditAs: z.string().max(80),
})
export type GrantWishes = z.infer<typeof GrantWishes>

export interface KeyGrant {
  kind: 'key-grant'
  /** The lender (signer). */
  address: string
  /** The gremlin's EVM address. */
  gremlin: string
  grantId: string
  provider: GrantProvider
  policy: GrantPolicy
  repay: 'patron' | 'syndicate'
  wishes?: GrantWishes
  /** The API key, sealed to the gremlin's public key. */
  sealedKey: Sealed
  createdAt: string
  expiresAt?: string
}

export interface KeyRevoke {
  kind: 'key-revoke'
  address: string
  grantId: string
  createdAt: string
}

/**
 * The gremlin's report on a lent key, signed by the gremlin: the provider refused the key (401/403: revoked, suspended
 * or out of scope), so the gremlin stopped using it for good. The board shows it to the lender.
 */
export interface GrantStatus {
  kind: 'grant-status'
  /** The gremlin (signer). */
  address: string
  grantId: string
  status: 'disabled'
  httpStatus: number
  reason: string
  createdAt: string
}

/** The gremlin's uncompressed public key, recovered from anything it has signed (a pulse, an announcement). */
export function publicKeyFromSigned(signed: Signed<Parameters<typeof messageDigest>[0]>): string {
  return SigningKey.recoverPublicKey(hashMessage(getBytes(messageDigest(signed.message))), signed.signature)
}

export async function sealApiKey(gremlinPublicKey: string, apiKey: string): Promise<Sealed> {
  return seal(gremlinPublicKey, toUtf8Bytes(apiKey))
}

export async function openApiKey(gremlinKey: SigningKey, sealed: Sealed): Promise<string> {
  return toUtf8String(await open(gremlinKey, sealed))
}

export const newGrantId = () => hexlify(randomBytes(16))

/** Shape check for a grant before trusting it (signature is checked separately with verifyMessage). */
export function grantProblem(g: KeyGrant, now = new Date()): string | null {
  if (g.kind !== 'key-grant') return 'not a key grant'
  if (!/^0x[0-9a-f]{32}$/.test(g.grantId)) return 'bad grantId'
  if (!GrantProvider.safeParse(g.provider).success) return 'bad provider'
  const refused = lendProblem(g.provider)
  if (refused) return refused
  if (!GrantPolicy.safeParse(g.policy).success) return 'bad policy'
  if (g.wishes !== undefined && !GrantWishes.safeParse(g.wishes).success) return 'bad wishes'
  if (g.wishes?.preferredModels.some((m) => !g.provider.models.includes(m))) return "bad wishes: a preferred model is not one of the grant's models"
  if (g.expiresAt && (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= now.getTime())) return 'expired'
  return null
}
