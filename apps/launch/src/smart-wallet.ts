/**
 * Quai Smart Wallet: a Safe smart account on Quai mainnet (the one quainance.com uses), owned by the person's email or
 * X login. It runs in this page: Privy (privy-bridge.ts) logs them in and supplies their Privy wallet, which owns the
 * Safe; the SDK's in-page wallet (the same controller as the standalone wallet) talks to Quai's relay and asks this
 * page to show each request for approval. No popup. The board checks the Safe's signatures (ERC-1271) over the same
 * payload EOAs sign.
 *
 * The SDK's controller and React load only when the Smart Wallet is used.
 */
import type { SmartAccountClient } from '@quai-smart-wallet/sdk/connector'
import { privy } from './privy-bridge.js'

const RELAY_URL = (import.meta.env.VITE_SMART_WALLET_RELAY_URL as string | undefined) || 'https://gasrelay.qu.ai'
const QUAI_MAINNET = '9'
const SAFE_KEY = 'gremlins.smartwallet.safe'

let client: Promise<SmartAccountClient> | undefined
/** The Safe this page's client has connected (none after a reload until it connects again). */
let session: string | undefined

const storedSafe = () => { try { return localStorage.getItem(SAFE_KEY) ?? undefined } catch { return undefined } }
const storeSafe = (v?: string) => { try { v ? localStorage.setItem(SAFE_KEY, v) : localStorage.removeItem(SAFE_KEY) } catch { /* private mode */ } }

async function smartClient(): Promise<SmartAccountClient> {
  return (client ??= (async () => {
    const [{ SmartAccountClient }, { InPageWalletTransport }, { PrivyOwnerAdapter }] = await Promise.all([
      import('@quai-smart-wallet/sdk/connector'), import('@quai-smart-wallet/sdk/core'), import('@quai-smart-wallet/sdk/privy'),
    ])
    const owner = new PrivyOwnerAdapter()
    const transport = new InPageWalletTransport({
      relayUrl: RELAY_URL,
      origin: location.origin,
      async connectSigner() {
        const p = await privy()
        if (!p.authenticated()) throw new Error('Sign in with your email or X first.')
        const wallet = await p.ownerWallet()
        owner.updateSession(p.session())
        await owner.connect(wallet.address)
        return owner
      },
      review: (r, signal) => approve(r.title, r.description, signal),
      // A returning visitor's Safe: a different login must never silently stand in for it.
      expectedAccount: () => storedSafe(),
      async disconnectSigner() { owner.disconnect() },
    })
    return new SmartAccountClient(transport)
  })())
}

/** Kept for callers that prepared the old popup synchronously; nothing to prepare in the page. */
export const prepareSmartWallet = () => {}

/** Connects the signed-in email/X login's Safe and returns its address. */
export async function connectSmartWallet(): Promise<string> {
  const { address, chainId } = await (await smartClient()).connect()
  if (chainId !== QUAI_MAINNET) throw new Error('Quai Smart Wallet answered for another network.')
  session = address
  storeSafe(address)
  return address
}

/** The Safe this page can sign for, connecting first after a reload. */
export const smartWalletAccount = async () => session ?? (await connectSmartWallet())

/** The Safe's signature (ERC-1271, checked on chain) over `message`, as personal_sign would sign it for an EOA. */
export async function smartWalletSign(account: string, message: string): Promise<string> {
  return (await (await smartClient()).signMessage({ chainId: QUAI_MAINNET, account, message })).signature
}

/** Signs out of email/X and forgets the Safe session. */
export function disconnectSmartWallet() {
  session = undefined
  storeSafe(undefined)
  void client?.then((c) => c.destroy())
  client = undefined
  void privy().then((p) => p.logout()).catch(() => {})
}

/** The page's approval for one Smart Wallet request (what a wallet extension's prompt would show). */
function approve(title: string, description: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'wallet-dialog'
    dlg.innerHTML = `<div class="wallet-head"><h2></h2></div><p class="wallet-note"></p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
      <button type="button" class="btn btn-small secondary" data-no>Cancel</button><button type="button" class="btn btn-small btn-primary" data-yes>Approve</button></div>
      <p class="wallet-foot">Quai Smart Wallet · signed by your email or X login's key</p>`
    dlg.querySelector('h2')!.textContent = title
    dlg.querySelector('.wallet-note')!.textContent = description
    const done = (ok: boolean) => {
      dlg.close()
      dlg.remove()
      ok ? resolve() : reject(Object.assign(new Error('Cancelled.'), { code: 4001 }))
    }
    ;(dlg.querySelector('[data-yes]') as HTMLButtonElement).onclick = () => done(true)
    ;(dlg.querySelector('[data-no]') as HTMLButtonElement).onclick = () => done(false)
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false) })
    signal.addEventListener('abort', () => dlg.open && done(false), { once: true })
    document.body.append(dlg)
    dlg.showModal()
  })
}
