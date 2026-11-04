/**
 * Wallet providers for the site. Browser wallets are found through EIP-6963 announcements (with the older window
 * globals as a fallback): Pelagus for Quai, MetaMask and Phantom for EVM chains. Phone wallets connect through
 * WalletConnect (Reown AppKit), loaded only when someone picks it. The sign-in dialog that offers these lives in auth.ts.
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, fn: (...args: never[]) => void): void
  removeListener?(event: string, fn: (...args: never[]) => void): void
}

interface Announced { info: { rdns: string; name: string; icon?: string }; provider: Eip1193 }
type Injected = Eip1193 & { isMetaMask?: boolean; isPhantom?: boolean; isRabby?: boolean; isBraveWallet?: boolean; providers?: Injected[] }

const WALLETCONNECT_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string) || '8921b9d59bb62e0dc9c063fc6babac22'

const announced = new Map<string, Announced>()
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = (e as CustomEvent<Announced>).detail
  if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

/** Injected globals, read without redeclaring window types (wallet libraries declare them differently). */
const globals = () => window as unknown as { pelagus?: Eip1193; ethereum?: Injected; phantom?: { ethereum?: Injected } }
const byName = (re: RegExp) => [...announced.values()].find((a) => re.test(a.info.name))

export const pelagus = (): Eip1193 | undefined => globals().pelagus ?? byName(/pelagus/i)?.provider

export function metamask(): Eip1193 | undefined {
  const a = announced.get('io.metamask') ?? announced.get('io.metamask.flask')
  if (a) return a.provider
  // Without EIP-6963, other wallets also set isMetaMask on window.ethereum; only trust it when nobody else claims it.
  const eth = globals().ethereum
  const real = (p?: Injected) => p?.isMetaMask && !p.isPhantom && !p.isRabby && !p.isBraveWallet
  return eth?.providers?.find(real) ?? (real(eth) ? eth : undefined)
}

export const phantom = (): Eip1193 | undefined => announced.get('app.phantom')?.provider ?? globals().phantom?.ethereum

/** The icon a wallet announced for itself (a data: image), when it did. */
export function announcedIcon(wallet: 'pelagus' | 'metamask' | 'phantom'): string | undefined {
  const a = wallet === 'pelagus' ? byName(/pelagus/i) : wallet === 'metamask' ? announced.get('io.metamask') : announced.get('app.phantom')
  const icon = a?.info.icon
  return icon?.startsWith('data:image/') ? icon : undefined
}

type AppKit = Awaited<ReturnType<typeof loadAppKit>>
let appKit: Promise<AppKit> | undefined

async function loadAppKit() {
  const [{ createAppKit }, { EthersAdapter }, nets] = await Promise.all([
    import('@reown/appkit'), import('@reown/appkit-adapter-ethers'), import('@reown/appkit/networks'),
  ])
  return createAppKit({
    adapters: [new EthersAdapter()],
    networks: [nets.mainnet, nets.base, nets.bsc],
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: { name: 'gremlinz', description: 'Autonomous agents on Quai', url: location.origin, icons: [`${location.origin}/favicon.ico`] },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
    // Browser wallets are offered by our own dialog; AppKit only handles WalletConnect.
    enableEIP6963: false,
    enableInjected: false,
    enableCoinbase: false,
    themeMode: 'light',
    themeVariables: { '--w3m-accent': '#24211d', '--w3m-border-radius-master': '4px', '--w3m-z-index': 1000 },
  })
}

// AppKit finishes setting up after createAppKit returns; opening it before then gets the modal closed again.
const kit = () => (appKit ??= loadAppKit().then(async (m) => { await m.ready(); return m }))

/** Loads WalletConnect ahead of use (the first load takes a few seconds). */
export const prepareWalletConnect = async (): Promise<void> => { await kit() }

function connected(modal: AppKit): { provider: Eip1193; address: string } | undefined {
  const provider = modal.getWalletProvider() as Eip1193 | undefined
  const address = modal.getAddress()
  return modal.getIsConnectedState() && provider && address ? { provider, address } : undefined
}

/** A WalletConnect session restored from an earlier visit, if there is one (waits briefly for AppKit to reconnect). */
export async function walletConnectSession(): Promise<{ provider: Eip1193; address: string } | undefined> {
  const modal = await kit()
  for (let i = 0; i < 40 && !connected(modal); i++) {
    const status = modal.getAccount()?.status
    if (status === 'disconnected' && i > 4) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return connected(modal)
}

/**
 * Connects a phone wallet: shows the WalletConnect QR code unless a session is already live. `onShown` runs once
 * AppKit's modal is actually up (it fetches wallet data first), so a caller's own dialog can hand over without a gap.
 */
export async function connectWalletConnect(onShown?: () => void): Promise<{ provider: Eip1193; address: string }> {
  const modal = await kit()
  const live = connected(modal)
  if (live) return live
  const done = new Promise<void>((resolve, reject) => {
    // Only a close after the modal was open means "cancelled".
    let shown = false
    const off = modal.subscribeState((s) => {
      if (connected(modal)) { off?.(); resolve() }
      else if (s.open && !shown) { shown = true; onShown?.() }
      else if (!s.open && shown) { off?.(); reject(Object.assign(new Error('No wallet connected.'), { code: 4001 })) }
    })
  })
  await modal.open({ view: 'ConnectingWalletConnectBasic' })
  await done
  modal.close()
  return connected(modal)!
}

export async function disconnectWalletConnect() {
  if (appKit) await (await appKit).disconnect().catch(() => {})
}
