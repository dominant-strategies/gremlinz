/**
 * Launch data written by cloud-init. Only values chosen by whoever launched the server, before it existed.
 *
 * - egg:  a new gremlin. Public values only (maker, config hash), so the egg can recognise its maker's config.
 * - nest: a new home a hatched gremlin launched for itself. Carries `nestSecret`, known only to the gremlin and
 *         the host; the nest proves knowledge of it so nobody else (not even the board) can pose as the nest.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const common = {
  boardUrl: z.string().url(),
  launchId: z.string().min(1).max(128),
  /** The image this server runs, pinned by digest; reused when the gremlin launches its own nests. */
  image: z.string().optional(),
  /**
   * Dev gremlin: the team keeps SSH access to the server (these public keys, user gremlinz-dev with sudo) to monitor and
   * control it. Carried into every nest, so a dev gremlin stays dev wherever it moves. Absent: nobody can log in.
   */
  dev: z.object({ sshKeys: z.array(z.string().regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\n']*)?$/)).min(1).max(8) }).optional(),
  /** The same build as a release bundle for hosts without Docker, pinned by sha256. */
  artifact: z.object({ url: z.string().url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
}

export const EggLaunchData = z.object({
  mode: z.literal('egg').default('egg'),
  maker: address,
  configHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /**
   * Hatch custody (eggs the hatch backend launched): the secret proves to the backend that this server is the egg it
   * launched, so it seals the hosting account to this egg and nobody else (see hatch/hosting-handover.ts).
   */
  hatch: z.object({ secret: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).optional(),
  ...common,
})

export const NestLaunchData = z.object({
  mode: z.literal('nest'),
  /** EVM address of the gremlin moving in. */
  forGremlin: address,
  nestSecret: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  ...common,
})

export const LaunchData = EggLaunchData
export type LaunchData = z.infer<typeof EggLaunchData>
export type NestLaunchData = z.infer<typeof NestLaunchData>
export const AnyLaunchData = z.union([NestLaunchData, EggLaunchData])
export type AnyLaunchData = z.infer<typeof AnyLaunchData>

export function readLaunchData(path: string): AnyLaunchData {
  return AnyLaunchData.parse(JSON.parse(readFileSync(path, 'utf8')))
}
