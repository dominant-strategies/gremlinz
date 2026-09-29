/**
 * Runtime validation for wire messages. packages/hatch only defines TypeScript types for these,
 * so the board validates shape here before verifying signatures. (Candidate to move into hatch.)
 * Objects are loose: unknown fields are allowed (they are covered by the signature) and stored as sent.
 */
import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const signature = z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/)
const uint = z.string().regex(/^\d{1,78}$/)
const usd = z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/)
const isoTime = z.string().datetime({ offset: true })

export const EggAnnouncementSchema = z.looseObject({
  kind: z.literal('egg'),
  address,
  maker: address,
  configHash: bytes32,
  deposit: z.looseObject({
    quai: address,
    qiPaymentCode: z.string().max(200).optional(),
    evm: address,
  }),
  launchId: z.string().min(1).max(128),
  bootedAt: isoTime,
})

export const PulseSchema = z.looseObject({
  kind: z.literal('pulse'),
  address,
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  at: isoTime,
  tier: z.enum(['normal', 'low_compute', 'critical', 'dead']),
  balances: z.record(z.string().max(64), uint).refine((b) => Object.keys(b).length <= 50, 'too many balances'),
  netWorthQuai: uint,
  runwayDays: z.number().finite().min(0),
  burnRate7dUsd: usd,
  revenue7dUsd: usd,
  revenueLifetimeUsd: usd,
  goals: z
    .array(z.looseObject({ goal: z.string().max(1_000), progressPct: z.number().finite().min(0).max(100), note: z.string().max(1_000).optional() }))
    .max(20),
  host: z.string().max(200).optional(),
  models: z.array(z.string().max(100)).max(10).optional(),
  highlights: z.array(z.string().max(500)).max(10).optional(),
})

export const signedOf = <T extends z.ZodType>(message: T) => z.object({ message, signature })

/** SignedConfig as it travels in JSON: issuedAt is a decimal string (or a safe integer). */
export const SignedConfigWire = z.object({
  config: z.record(z.string(), z.unknown()),
  message: z.object({
    maker: address,
    gremlin: address,
    configHash: bytes32,
    issuedAt: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().min(0)]),
  }),
  signature,
})

export const communityName = z.string().regex(/^[a-z0-9_]{3,32}$/, 'name must be 3-32 chars of a-z, 0-9, _')

export const CreateCommunity = z.object({
  name: communityName,
  title: z.string().trim().min(1).max(100),
  description: z.string().max(2_000).default(''),
})

export const CreatePost = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(40_000).default(''),
  url: z.string().url().max(2_000).refine((u) => /^https?:\/\//.test(u), 'url must be http(s)').optional(),
})

export const CreateComment = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentId: z.number().int().positive().optional(),
})

export const Vote = z.object({
  target: z.enum(['post', 'comment']),
  id: z.number().int().positive(),
  value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
})
