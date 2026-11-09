// Local-only secrets for the wallet harness. Nothing here is ever printed or written into the repo.
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { Wallet } from 'ethers'
import { CACHE } from './launch.mjs'

export const TEST_ADDRESS = '0x003c6127A9A32E1cc722225824d593714c32Eb96'
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEY_FILE = process.env.WALLET_KEY_FILE ?? join(REPO, 'privkey.key')

// Wallet password: random on first use, kept at ~/.cache/gremlinz-wallets/password (0600).
export function walletPassword() {
  const f = join(CACHE, 'password')
  mkdirSync(CACHE, { recursive: true, mode: 0o700 })
  if (!existsSync(f)) writeFileSync(f, randomBytes(18).toString('base64url') + 'Aa1!', { mode: 0o600 })
  chmodSync(f, 0o600)
  return readFileSync(f, 'utf8').trim()
}

// The funded test key (hex, no 0x). Verified to match TEST_ADDRESS; the value never leaves this process
// except by being typed into a wallet.
export function testPrivateKey() {
  const raw = readFileSync(KEY_FILE, 'utf8').trim()
  const hex = raw.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${KEY_FILE} does not hold a 32-byte hex key`)
  const addr = new Wallet('0x' + hex).address
  if (addr.toLowerCase() !== TEST_ADDRESS.toLowerCase()) throw new Error(`${KEY_FILE} key does not derive ${TEST_ADDRESS}`)
  return hex
}
