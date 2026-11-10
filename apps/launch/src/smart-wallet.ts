/**
 * Quai Smart Wallet: a Safe smart account on Quai mainnet (the one quainance.com uses), owned by any EVM wallet or an
 * email/X login. The wallet site does the signing in a popup; the account is the Safe's address, and the board checks
 * its signatures through the Safe (ERC-1271) over the same payload EOAs sign.
 *
 * Only the SDK's small connector entry is used (no Privy, no controller). Browsers allow the popup only straight from
 * a click, so `prepareSmartWallet()` must run before the click handler's first await.
 */
import { SmartAccountClient, createPopupTransport } from '@quai-smart-wallet/sdk/connector'

// wallet.qu.ai is the planned host but does not resolve yet; Quainance points at the Vercel deployment too.
const WALLET_URL = (import.meta.env.VITE_SMART_WALLET_URL as string | undefined) || 'https://quai-smart-wallet.vercel.app'
const QUAI_MAINNET = '9'

let client: SmartAccountClient | undefined
/** The Safe this page's client has a session for (a reloaded page has none until it connects again). */
let session: string | undefined

const smartClient = () => (client ??= new SmartAccountClient(createPopupTransport({ walletUrl: WALLET_URL })))

/** Opens (or focuses) the wallet window. Call synchronously from the user's click. */
export const prepareSmartWallet = () => smartClient().prepare()

/** Connects (asking the wallet if this site isn't approved yet) and returns the Safe's address. */
export async function connectSmartWallet(): Promise<string> {
  const c = smartClient()
  c.prepare()
  const { address, chainId } = await c.connect()
  if (chainId !== QUAI_MAINNET) throw new Error('Quai Smart Wallet answered for another network. Switch it to Quai mainnet and try again.')
  session = address
  return address
}

/** The Safe this page can sign for, connecting first after a reload. */
export const smartWalletAccount = async () => session ?? (await connectSmartWallet())

/** The Safe's signature (ERC-1271, checked on chain) over `message`, as personal_sign would sign it for an EOA. */
export async function smartWalletSign(account: string, message: string): Promise<string> {
  return (await smartClient().signMessage({ chainId: QUAI_MAINNET, account, message })).signature
}

/** Forgets the session and closes the wallet window (the wallet keeps this site's approval until revoked there). */
export function disconnectSmartWallet() {
  session = undefined
  client?.destroy()
  client = undefined
}
