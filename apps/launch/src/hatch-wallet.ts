/**
 * The maker's wallet in the hatch flow: whichever wallet they signed in with (auth.ts), not just Pelagus.
 *
 * - The config signature is EIP-712 typed data in the Gremlins domain (chain 9, Quai), verified by the egg, the board
 *   and GremlinRegistry by recovering the maker's key. Pelagus signs it natively; EVM wallets (MetaMask, Phantom,
 *   WalletConnect) sign it too once Quai's network is their active chain, since they refuse typed data for another.
 * - Quai Smart Wallet signs as a Safe (ERC-1271). The registry and eggs recover a key, so a Safe cannot be a maker yet.
 * - Paying for the egg: QUAI from Pelagus (bridged), or USDC on Base straight from an EVM wallet.
 */
import { HATCH_DOMAIN, HATCH_TYPES, configHash, type GremlinConfig, type SignedConfig } from '@gremlins/hatch'
import { Interface, toBeHex, verifyTypedData } from 'ethers'
import { account, isEvm, signIn, walletProvider, type Account, type WalletKind } from './auth.js'
import { signConfigWithPelagus } from './pelagus.js'

export const WALLET_NAMES: Record<WalletKind, string> = {
  smartwallet: 'Quai Smart Wallet', pelagus: 'Pelagus', metamask: 'MetaMask', phantom: 'Phantom', walletconnect: 'your WalletConnect wallet',
}

const QUAI_NETWORK = {
  chainId: '0x9',
  chainName: 'Quai',
  nativeCurrency: { name: 'Quai', symbol: 'QUAI', decimals: 18 },
  rpcUrls: ['https://rpc.quai.network/cyprus1'],
  blockExplorerUrls: ['https://quaiscan.io'],
}
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

/** The signed-in account to hatch with, asking to sign in if nobody is. A Smart Wallet cannot be a maker yet. */
export async function makerAccount(): Promise<Account> {
  const a = account() ?? (await signIn())
  if (a.kind === 'smartwallet')
    throw new Error('A Quai Smart Wallet signs as a contract, and eggs only accept a maker signature from a key for now. Sign out and sign in with Pelagus, MetaMask, Phantom or a WalletConnect wallet to hatch.')
  return a
}

/** The wallet must still be the gremlin's maker: a different account cannot sign its config. */
function sameMaker(maker: string): Account {
  const a = account()
  if (!a) throw new Error('Sign in again with the wallet you started with.')
  if (a.address.toLowerCase() !== maker.toLowerCase())
    throw new Error(`You are signed in as ${a.address.slice(0, 8)}…, but this gremlin's maker is ${maker.slice(0, 8)}…. Sign in with that wallet to continue.`)
  return a
}

async function switchChain(p: Awaited<ReturnType<typeof walletProvider>>, chain: { chainId: string } & Partial<typeof QUAI_NETWORK>) {
  if ((await p.request({ method: 'eth_chainId' })) === chain.chainId) return
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] })
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code
    if (code !== 4902 || !chain.chainName) throw e
    await p.request({ method: 'wallet_addEthereumChain', params: [chain] }) // unknown chain: add it (switches too)
  }
}

/** Sign the gremlin's config for one egg (its Quai address) with the maker's wallet. */
export async function signConfigWithWallet(maker: string, config: GremlinConfig, gremlin: string): Promise<SignedConfig> {
  const a = sameMaker(maker)
  if (a.kind === 'pelagus') return signConfigWithPelagus(maker, config, gremlin)
  const p = await walletProvider()
  try {
    await switchChain(p, QUAI_NETWORK)
  } catch {
    throw new Error(`${WALLET_NAMES[a.kind]} would not switch to the Quai network, which the config signature names. Approve adding Quai (chain 9) in the wallet, or hatch with Pelagus or MetaMask.`)
  }
  const message = { maker, gremlin, configHash: configHash(config), issuedAt: BigInt(Math.floor(Date.now() / 1000)) }
  const typedData = {
    domain: HATCH_DOMAIN,
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], ...HATCH_TYPES },
    primaryType: 'Hatch',
    message: { ...message, issuedAt: message.issuedAt.toString() },
  }
  const signature = (await p.request({ method: 'eth_signTypedData_v4', params: [maker, JSON.stringify(typedData)] })) as string
  // Check before handing it over: the egg would reject a signature from anyone else.
  if (verifyTypedData(HATCH_DOMAIN, HATCH_TYPES, message, signature).toLowerCase() !== maker.toLowerCase())
    throw new Error(`${WALLET_NAMES[a.kind]} signed with a different key than ${maker.slice(0, 8)}…. Try again, or hatch with Pelagus.`)
  return { config, message, signature }
}

export const canPayUsdc = (kind: WalletKind) => isEvm(kind)

/** Send USDC on Base from the maker's EVM wallet; returns the transaction hash. */
export async function payUsdcOnBase(maker: string, to: string, usdMicro: bigint): Promise<string> {
  const a = sameMaker(maker)
  if (!isEvm(a.kind)) throw new Error(`${WALLET_NAMES[a.kind]} cannot send USDC on Base. Send it from another wallet to the address shown.`)
  const p = await walletProvider()
  await switchChain(p, { chainId: toBeHex(8453) })
  const tx = { from: maker, to: BASE_USDC, data: ERC20.encodeFunctionData('transfer', [to, usdMicro]), value: '0x0' }
  return (await p.request({ method: 'eth_sendTransaction', params: [tx] })) as string
}
