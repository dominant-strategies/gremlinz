/**
 * Where the gremlin's files are and who it is. This server is the only process that reads the seed; Hermes and its
 * terminal never see it (the egg passes GREMLIN_HOME only to this server).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wallet as EvmWallet, type HDNodeWallet } from 'ethers'
import { Mnemonic, QuaiHDWallet, Zone } from 'quais'
import { quaiWallet } from '@gremlins/treasury'

export const home = () => process.env.GREMLIN_HOME ?? '/var/lib/gremlin'
export const homeFile = (name: string) => join(home(), name)

export function boardUrl(): string {
  if (process.env.GREMLIN_BOARD_URL) return process.env.GREMLIN_BOARD_URL
  const launch = JSON.parse(readFileSync(process.env.GREMLIN_LAUNCH ?? '/etc/gremlin/launch.json', 'utf8'))
  return launch.boardUrl
}

export interface Keys {
  quai: ReturnType<typeof quaiWallet>
  evm: HDNodeWallet
}

let cached: Keys | undefined
/** Quai (cyprus1, index 0) and EVM (m/44'/60'/0'/0/0) keys from the egg's seed: the same identity the egg uses. */
export function keys(): Keys {
  if (cached) return cached
  const phrase = readFileSync(homeFile('seed'), 'utf8').trim()
  const hd = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase))
  const { address } = hd.getNextAddressSync(0, Zone.Cyprus1)
  const k: Keys = { quai: quaiWallet(hd.getPrivateKey(address)), evm: EvmWallet.fromPhrase(phrase) }
  cached = k
  return k
}
