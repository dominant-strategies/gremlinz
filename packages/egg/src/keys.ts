/**
 * The egg's own keys, generated on first boot inside the server. Nobody else ever sees them:
 * not the maker, not the launch page, not the platform. One BIP39 seed derives:
 *  - a Quai (cyprus1) key for QUAI and contract calls,
 *  - a Qi payment code for private Qi receipts,
 *  - an EVM key used on Ethereum, Base and BSC, and to sign board messages.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HDNodeWallet, Mnemonic as EthMnemonic, randomBytes } from 'ethers'
import { Mnemonic, QiHDWallet, QuaiHDWallet, Wallet as QuaiWallet, Zone } from 'quais'

export const EVM_PATH = "m/44'/60'/0'/0/0"

export interface EggKeys {
  phrase: string
  quai: QuaiWallet
  qiPaymentCode: string
  evm: HDNodeWallet
}

export function keysFromPhrase(phrase: string): EggKeys {
  const m = Mnemonic.fromPhrase(phrase)
  const quaiHd = QuaiHDWallet.fromMnemonic(m)
  const { address } = quaiHd.getNextAddressSync(0, Zone.Cyprus1)
  return {
    phrase,
    quai: new QuaiWallet(quaiHd.getPrivateKey(address)),
    qiPaymentCode: QiHDWallet.fromMnemonic(m).getPaymentCode(0),
    evm: HDNodeWallet.fromPhrase(phrase, undefined, EVM_PATH),
  }
}

export function generatePhrase(): string {
  return EthMnemonic.fromEntropy(randomBytes(32)).phrase
}

/** Load the seed from disk, or create it on first boot. The file is root-only (0600). */
export function loadOrCreateKeys(path: string): EggKeys {
  if (existsSync(path)) return keysFromPhrase(readFileSync(path, 'utf8').trim())
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const phrase = generatePhrase()
  writeFileSync(path, phrase + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return keysFromPhrase(phrase)
}
