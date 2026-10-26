/**
 * Every chain family's keys from the egg's one seed (BIP39), on the derivation paths other wallets use, so the
 * gremlin's addresses match what MetaMask, Phantom, Electrum or Pelagus would show for the same phrase.
 *
 *   EVM (Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Avalanche)  m/44'/60'/0'/0/0   secp256k1
 *   Quai (cyprus1)                                                     QuaiHDWallet, first cyprus1 address
 *   Qi (UTXO, private payments)                                        QiHDWallet payment code (BIP47-style)
 *   Solana                                                             m/44'/501'/0'/0'   ed25519 (SLIP-10)
 *   Bitcoin  (native SegWit, P2WPKH)                                   m/84'/0'/0'/0/0
 *   Litecoin (native SegWit, P2WPKH)                                   m/84'/2'/0'/0/0
 */
import { HDNodeWallet, Mnemonic as EthersMnemonic } from 'ethers'
import { Mnemonic, QiHDWallet, QuaiHDWallet, Zone } from 'quais'
import { HDKey } from '@scure/bip32'
import { p2wpkh, NETWORK } from '@scure/btc-signer'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'

export const LITECOIN = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 } as const

/** SLIP-10 ed25519 derivation (hardened only). */
export function slip10Ed25519(seed: Uint8Array, path: string): { key: Uint8Array; chainCode: Uint8Array } {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  let key = I.slice(0, 32)
  let chainCode = I.slice(32)
  for (const part of path.split('/').slice(1)) {
    if (!part.endsWith("'")) throw new Error('ed25519 supports hardened derivation only')
    const index = (Number(part.slice(0, -1)) | 0x80000000) >>> 0
    const data = new Uint8Array(37)
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, index, false)
    I = hmac(sha512, chainCode, data)
    key = I.slice(0, 32)
    chainCode = I.slice(32)
  }
  return { key, chainCode }
}

export interface ChainKeys {
  evm: { address: string; privateKey: string }
  quai: { address: string; privateKey: string }
  qi: { paymentCode: string }
  solana: { address: string; secretKey: Uint8Array }
  bitcoin: { address: string; privateKey: Uint8Array; publicKey: Uint8Array }
  litecoin: { address: string; privateKey: Uint8Array; publicKey: Uint8Array }
}

export function deriveKeys(phrase: string): ChainKeys {
  const seed = EthersMnemonic.fromPhrase(phrase).computeSeed()
  const seedBytes = Uint8Array.from(Buffer.from(seed.slice(2), 'hex'))

  const evm = HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0/0")
  const quaiMnemonic = Mnemonic.fromPhrase(phrase)
  const quaiHd = QuaiHDWallet.fromMnemonic(quaiMnemonic)
  const quaiAddr = quaiHd.getNextAddressSync(0, Zone.Cyprus1).address
  const qiPaymentCode = QiHDWallet.fromMnemonic(quaiMnemonic).getPaymentCode(0)

  const sol = slip10Ed25519(seedBytes, "m/44'/501'/0'/0'")
  const solPub = ed25519.getPublicKey(sol.key)

  const root = HDKey.fromMasterSeed(seedBytes)
  const btcNode = root.derive("m/84'/0'/0'/0/0")
  const ltcNode = root.derive("m/84'/2'/0'/0/0")

  return {
    evm: { address: evm.address, privateKey: evm.privateKey },
    quai: { address: quaiAddr, privateKey: quaiHd.getPrivateKey(quaiAddr) },
    qi: { paymentCode: qiPaymentCode },
    solana: { address: base58.encode(solPub), secretKey: new Uint8Array([...sol.key, ...solPub]) },
    bitcoin: { address: p2wpkh(btcNode.publicKey!, NETWORK).address!, privateKey: btcNode.privateKey!, publicKey: btcNode.publicKey! },
    litecoin: { address: p2wpkh(ltcNode.publicKey!, LITECOIN).address!, privateKey: ltcNode.privateKey!, publicKey: ltcNode.publicKey! },
  }
}

