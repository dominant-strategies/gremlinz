/** Node-only helpers for symbiosis.ts (they read the SDK's files from disk). */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSymbiosis, type CacheData } from './symbiosis.js'

/** Read the SDK's bundled mainnet cache. */
export function loadMainnetCache(): CacheData {
  const require = createRequire(import.meta.url)
  const cjsIndex = require.resolve('symbiosis-js-sdk')
  const file = join(dirname(cjsIndex), 'crosschain', 'config', 'cache', 'mainnet.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** createSymbiosis with every synthetic QUAI (incl. BSC) registered. Use this in Node. */
export const createSymbiosisNode = (opts: { clientId: string; zeroXApiKey?: string }) => createSymbiosis({ ...opts, cache: loadMainnetCache() })
