/**
 * One-click donations: pick an amount in dollars (presets or your own), pick what to pay with, press Donate. The
 * button connects a wallet if needed and opens exactly one signing prompt. QUAI goes through Pelagus; ETH, BNB,
 * USDC and USDT on Ethereum, Base and BSC go through any injected wallet or WalletConnect (Reown AppKit, loaded only
 * when chosen). Dollar amounts are converted at live prices (DefiLlama). Nothing is converted at donation time; the
 * gremlin's sweeper turns what it receives into QUAI later.
 */
import { Interface, parseUnits, toBeHex } from 'ethers'

interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
/** Injected wallets, read without redeclaring window types (other libraries declare them differently). */
const injected = () => window as unknown as { ethereum?: Eip1193; pelagus?: Eip1193 }

export interface DonateTarget { name: string; quai: string; evm: string }

interface Coin { id: string; label: string; chainId: number; symbol: string; token?: string; decimals: number; priceId?: string }

const COINS: Coin[] = [
  { id: 'quai', label: 'QUAI', chainId: 9, symbol: 'QUAI', decimals: 18, priceId: 'coingecko:quai-network' },
  { id: 'base-usdc', label: 'USDC on Base', chainId: 8453, symbol: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { id: 'base-eth', label: 'ETH on Base', chainId: 8453, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'eth-usdc', label: 'USDC on Ethereum', chainId: 1, symbol: 'USDC', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { id: 'eth-usdt', label: 'USDT on Ethereum', chainId: 1, symbol: 'USDT', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { id: 'eth-eth', label: 'ETH on Ethereum', chainId: 1, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'bsc-usdt', label: 'USDT on BSC', chainId: 56, symbol: 'USDT', token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { id: 'bsc-usdc', label: 'USDC on BSC', chainId: 56, symbol: 'USDC', token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { id: 'bsc-bnb', label: 'BNB on BSC', chainId: 56, symbol: 'BNB', decimals: 18, priceId: 'coingecko:binancecoin' },
]
const EXPLORER: Record<number, string> = { 9: 'https://quaiscan.io/tx/', 1: 'https://etherscan.io/tx/', 8453: 'https://basescan.org/tx/', 56: 'https://bscscan.com/tx/' }
const PRESETS = [5, 10, 25, 50]
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
const WALLETCONNECT_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string) || '8921b9d59bb62e0dc9c063fc6babac22'

/** Token amount (base units) for a dollar amount; stablecoins are 1:1. */
export async function amountFor(coin: Coin, usd: number, fetchImpl: typeof fetch = fetch): Promise<bigint> {
  if (!coin.priceId) return parseUnits(usd.toFixed(Math.min(coin.decimals, 6)), coin.decimals)
  const r = await fetchImpl(`https://coins.llama.fi/prices/current/${coin.priceId}`)
  const price = (await r.json())?.coins?.[coin.priceId]?.price as number | undefined
  if (!price || !(price > 0)) throw new Error(`no live price for ${coin.symbol}; try a stablecoin`)
  return parseUnits((usd / price).toFixed(Math.min(coin.decimals, 12)), coin.decimals)
}

// ── wallets ──────────────────────────────────────────────────────────────────

async function evmWallet(useWalletConnect: boolean): Promise<Eip1193> {
  const eth = injected().ethereum
  if (!useWalletConnect && eth) return eth
  const [{ createAppKit }, { EthersAdapter }, nets] = await Promise.all([
    import('@reown/appkit'), import('@reown/appkit-adapter-ethers'), import('@reown/appkit/networks'),
  ])
  const modal = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [nets.mainnet, nets.base, nets.bsc],
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: { name: 'gremlinz', description: 'Feed a gremlin', url: location.origin, icons: [`${location.origin}/favicon.ico`] },
    features: { analytics: false, email: false, socials: false },
  })
  if (!modal.getIsConnectedState()) {
    await modal.open()
    await new Promise<void>((resolve, reject) => {
      const off = modal.subscribeState((s) => {
        if (modal.getIsConnectedState()) { off?.(); resolve() } else if (!s.open) { off?.(); reject(new Error('wallet not connected')) }
      })
    })
  }
  const provider = modal.getWalletProvider() as Eip1193 | undefined
  if (!provider) throw new Error('wallet not connected')
  return provider
}

async function sendEvm(coin: Coin, to: string, amount: bigint, useWalletConnect: boolean): Promise<string> {
  const w = await evmWallet(useWalletConnect)
  const [from] = (await w.request({ method: 'eth_requestAccounts' })) as string[]
  const want = toBeHex(coin.chainId)
  if ((await w.request({ method: 'eth_chainId' })) !== want) await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] })
  const tx = coin.token
    ? { from, to: coin.token, data: ERC20.encodeFunctionData('transfer', [to, amount]), value: '0x0' }
    : { from, to, value: toBeHex(amount) }
  return (await w.request({ method: 'eth_sendTransaction', params: [tx] })) as string
}

async function sendQuai(to: string, amount: bigint): Promise<string> {
  const pelagus = injected().pelagus
  if (!pelagus) throw new Error('Install the Pelagus wallet (pelaguswallet.io) to donate QUAI, or pick another coin.')
  const { BrowserProvider } = await import('quais')
  const [from] = (await pelagus.request({ method: 'quai_requestAccounts' })) as string[]
  const signer = await new BrowserProvider(pelagus as never).getSigner(from)
  const tx = await signer.sendTransaction({ from, to, value: amount })
  return tx.hash
}

// ── UI ───────────────────────────────────────────────────────────────────────

const h = (tag: string, attrs: Record<string, string> = {}, text = '') => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (text) el.textContent = text
  return el
}

export function mountDonate(root: HTMLElement, target: DonateTarget) {
  let usd = 10
  root.replaceChildren()
  root.classList.add('donate')

  const amounts = h('div', { class: 'donate-amounts', role: 'group', 'aria-label': 'Amount' })
  const custom = h('input', { type: 'number', min: '1', step: '1', inputmode: 'decimal', placeholder: 'Other', 'aria-label': 'Other amount in dollars' }) as HTMLInputElement
  const presetButtons = PRESETS.map((v) => {
    const b = h('button', { type: 'button', class: 'chip' }, `$${v}`)
    b.onclick = () => { usd = v; custom.value = ''; sync() }
    return b
  })
  const dollar = h('label', { class: 'donate-custom' }, '$')
  dollar.append(custom)
  amounts.append(...presetButtons, dollar)
  custom.oninput = () => { const v = Number(custom.value); if (v > 0) { usd = v; sync() } }

  const coinSelect = h('select', { 'aria-label': 'Pay with' }) as HTMLSelectElement
  for (const c of COINS) coinSelect.append(h('option', { value: c.id }, c.label))
  if (!injected().pelagus) coinSelect.value = 'base-usdc'
  const wc = h('label', { class: 'donate-wc' })
  const wcBox = h('input', { type: 'checkbox' }) as HTMLInputElement
  wc.append(wcBox, document.createTextNode(' use WalletConnect'))

  const go = h('button', { type: 'button', class: 'btn btn-primary' })
  const status = h('p', { class: 'donate-status small', role: 'status', 'aria-live': 'polite' })
  const coin = () => COINS.find((c) => c.id === coinSelect.value)!
  const sync = () => {
    presetButtons.forEach((b, i) => b.classList.toggle('on', !custom.value && PRESETS[i] === usd))
    wc.hidden = coin().chainId === 9
    go.textContent = `Donate $${usd % 1 ? usd.toFixed(2) : usd}`
  }
  coinSelect.onchange = sync

  go.onclick = async () => {
    const c = coin()
    go.setAttribute('disabled', '')
    status.textContent = 'Getting the price…'
    try {
      const amount = await amountFor(c, usd)
      status.textContent = 'Confirm in your wallet…'
      const hash = c.chainId === 9 ? await sendQuai(target.quai, amount) : await sendEvm(c, target.evm, amount, wcBox.checked)
      status.replaceChildren(document.createTextNode(`Thank you! ${target.name} will see it shortly. `), Object.assign(h('a', { href: EXPLORER[c.chainId] + hash, target: '_blank', rel: 'noopener' }, 'View transaction')))
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e)
      status.textContent = /reject|denied|cancel/i.test(msg) ? 'Cancelled.' : msg
    } finally {
      go.removeAttribute('disabled')
    }
  }

  const row = h('div', { class: 'donate-row' })
  row.append(coinSelect, wc)
  root.append(amounts, row, go, status)
  sync()
}

export function mountAll() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-donate]')) {
    const { name = 'this gremlin', quai = '', evm = '' } = el.dataset
    if (quai && evm) mountDonate(el, { name, quai, evm })
  }
}
