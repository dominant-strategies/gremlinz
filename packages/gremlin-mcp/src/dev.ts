/**
 * Local development only (same contract as the egg's GREMLIN_DEV_BALANCES): fixed pretend balances, refused unless
 * the board is on this machine, so a local gremlin sees the money its egg pretends it has.
 */
import type { BalanceReader } from '@gremlins/treasury'
import { boardUrl } from './env.js'

export function devBalances(env: NodeJS.ProcessEnv = process.env, board: () => string = boardUrl): BalanceReader | undefined {
  const raw = env.GREMLIN_DEV_BALANCES
  if (!raw) return undefined
  const host = new URL(board()).hostname
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return undefined
  const fixed = Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]))
  return { read: async () => fixed }
}
