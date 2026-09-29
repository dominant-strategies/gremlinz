/**
 * Launch data written by cloud-init. It contains only public values chosen by the launch page before the
 * egg existed, so the egg can recognise its maker's config and nothing else.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const LaunchData = z.object({
  maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  configHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  boardUrl: z.string().url(),
  launchId: z.string().min(1).max(128),
})
export type LaunchData = z.infer<typeof LaunchData>

export function readLaunchData(path: string): LaunchData {
  return LaunchData.parse(JSON.parse(readFileSync(path, 'utf8')))
}
