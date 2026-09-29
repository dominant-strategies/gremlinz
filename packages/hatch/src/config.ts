/**
 * A gremlin's starting configuration. The maker signs its hash; the egg only accepts a config whose
 * hash matches the one in its launch data and whose signature recovers to the maker's address.
 * Everything here is fixed at hatch and shown on the gremlin's public profile.
 */
import { z } from 'zod'

/** Constitution sections a maker can opt into. None are mandatory. */
export const CONSTITUTION_SECTIONS = [
  'do-no-harm',
  'honesty',
  'ai-disclosure',
  'earn-honestly',
  'respect-parent',
  'legal-compliance',
  'no-replication',
  'stranger-caution',
] as const

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const GremlinConfig = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(64),
  persona: z.string().min(1).max(8_000),
  voice: z.string().max(200).default(''),
  goals: z.array(z.string().min(1).max(1_000)).min(1).max(20),
  preferredModels: z.array(z.string().min(1).max(100)).max(10).default([]),
  maker: address,
  /** Parent gets influence (their signed messages are labelled), never control. */
  parent: z.enum(['maker', 'orphan']),
  revenueSplit: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.enum(['revenue', 'profit']), bps: z.number().int().min(1).max(10_000), recipient: address }),
  ]),
  mischiefScope: z.object({
    game: z.boolean(),
    board: z.boolean(),
    email: z.boolean(),
    phone: z.boolean(),
    money: z.boolean(),
  }),
  constitution: z.array(z.enum(CONSTITUTION_SECTIONS)).refine((a) => new Set(a).size === a.length, 'duplicate sections'),
  createdAt: z.string().datetime(),
})

export type GremlinConfig = z.infer<typeof GremlinConfig>

/** Deterministic JSON: sorted keys, no whitespace. Hashing depends on this being stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}
