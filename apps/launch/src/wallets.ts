/**
 * Wallet connections for the site. EVM wallets go through one picker (Reown AppKit): every installed browser wallet
 * found via EIP-6963 (MetaMask, Phantom, Rabby, Coinbase Wallet, Trust, OKX, …) plus WalletConnect for phone
 * wallets. Quai goes through Pelagus. AppKit is loaded only when a wallet is actually needed.
 */
export interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

const WALLETCONNECT_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string) || '8921b9d59bb62e0dc9c063fc6babac22'

/** Injected providers, read without redeclaring window types (wallet libraries declare them differently). */
const injected = () => window as unknown as { pelagus?: Eip1193 }

export const pelagus = (): Eip1193 | undefined => injected().pelagus

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
    enableEIP6963: true,
    enableInjected: true,
    enableCoinbase: true,
    allWallets: 'SHOW',
    // Shown first (WalletConnect explorer ids); any other installed wallet still appears via EIP-6963.
    featuredWalletIds: [
      'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
      'a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393', // Phantom
      'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase Wallet
      '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby
      '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0', // Trust Wallet
    ],
  })
}

const kit = () => (appKit ??= loadAppKit())

/** Connect an EVM wallet: opens the picker unless one is already connected. Returns its provider and address. */
export async function connectEvm(): Promise<{ provider: Eip1193; address: string }> {
  const modal = await kit()
  if (!modal.getIsConnectedState()) {
    await modal.open()
    await new Promise<void>((resolve, reject) => {
      const off = modal.subscribeState((s) => {
        if (modal.getIsConnectedState()) { off?.(); resolve() } else if (!s.open) { off?.(); reject(new Error('No wallet connected.')) }
      })
    })
  }
  const provider = modal.getWalletProvider() as Eip1193 | undefined
  const address = modal.getAddress()
  if (!provider || !address) throw new Error('No wallet connected.')
  return { provider, address }
}

export async function disconnectEvm() {
  if (appKit) await (await appKit).disconnect().catch(() => {})
}
