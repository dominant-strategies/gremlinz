/**
 * Phantom on Solana, for donations. Phantom registers itself through the Wallet Standard, whose
 * `solana:signAndSendTransaction` takes the transaction's wire bytes (what solana-pay.ts builds); that is the path
 * used. Older Phantoms that only inject `window.phantom.solana` get the same bytes wrapped as a version-0 transaction.
 */
import { getBase58Decoder } from '@solana/kit'

interface StdAccount { address: string }
interface StdWallet {
  name: string
  features: Record<string, unknown>
}
type ConnectFeature = { connect(): Promise<{ accounts: readonly StdAccount[] }> }
type SignAndSendFeature = { signAndSendTransaction(...inputs: { account: StdAccount; chain: string; transaction: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]> }
interface InjectedSolana {
  isPhantom?: boolean
  connect(): Promise<{ publicKey: { toString(): string } }>
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>
}

const registered: StdWallet[] = []
let listening = false
/** Wallet Standard discovery: answer wallets that register now, and ask those already loaded to register. */
function discover() {
  if (listening) return
  listening = true
  const api = { register: (...ws: StdWallet[]) => { for (const w of ws) if (!registered.includes(w)) registered.push(w); return () => {} } }
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { (e as CustomEvent<(a: typeof api) => void>).detail(api) } catch { /* a broken wallet */ } })
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }))
}

const injected = () => (window as unknown as { phantom?: { solana?: InjectedSolana } }).phantom?.solana

const standardPhantom = () => {
  discover()
  return registered.find((w) => /phantom/i.test(w.name) && w.features['solana:signAndSendTransaction'] && w.features['standard:connect'])
}

/** Phantom (with Solana) is installed. */
export const hasPhantomSolana = () => !!standardPhantom() || !!injected()?.isPhantom

export interface SolanaSender {
  address: string
  /** Signs and broadcasts the transaction; returns its signature (base58), the id explorers use. */
  signAndSend(tx: Uint8Array): Promise<string>
}

export async function connectPhantomSolana(): Promise<SolanaSender> {
  const std = standardPhantom()
  if (std) {
    const { accounts } = await (std.features['standard:connect'] as ConnectFeature).connect()
    const account = accounts[0]
    if (!account) throw new Error('Phantom did not share a Solana account.')
    return {
      address: account.address,
      async signAndSend(transaction) {
        const [out] = await (std.features['solana:signAndSendTransaction'] as SignAndSendFeature).signAndSendTransaction({ account, chain: 'solana:mainnet', transaction })
        return getBase58Decoder().decode(out!.signature)
      },
    }
  }
  const p = injected()
  if (!p?.isPhantom) throw new Error('Install Phantom (phantom.com) to donate on Solana, or pick another coin.')
  const { publicKey } = await p.connect()
  return {
    address: publicKey.toString(),
    async signAndSend(bytes) {
      // The shape Phantom's injected provider serializes: a version-0 transaction whose serialize() gives the wire bytes.
      const { signature } = await p.signAndSendTransaction({ version: 0, serialize: () => bytes })
      return signature
    },
  }
}
