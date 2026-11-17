/**
 * One-click donations: pick an amount in dollars (presets or your own), pick what to pay with, press Donate. The
 * button connects a wallet if needed and opens exactly one signing prompt. QUAI goes through Pelagus; ETH, BNB,
 * USDC and USDT on Ethereum, Base and BSC go through the signed-in EVM wallet, or the sign-in dialog's MetaMask, Phantom
 * and WalletConnect options (auth.ts); SOL, USDC and USDT on Solana go through Phantom (solana-wallet.ts). Bitcoin,
 * Litecoin and Qi are shown as an address and QR code to send from any wallet. Dollar amounts are converted at live
 * prices (DefiLlama). Nothing is converted at donation time.
 *
 * Where the money goes comes from the page (apps/board/src/donate.ts): the gremlin's signed donation card, or the
 * deposit addresses it announced. Solana, Bitcoin and Litecoin addresses are only on the card, and the board can't tie
 * them to the gremlin's keys, so they are labelled "as published by" it.
 */
import { Interface, formatUnits, parseUnits, toBeHex } from 'ethers'
import { evmWallet } from './auth.js'
import { pelagus as pelagusWallet } from './wallets.js'

export interface DonateTarget {
  name: string
  quai?: string
  evm?: string
  qi?: string
  solana?: string
  bitcoin?: string
  litecoin?: string
  note?: string
  suggestedUsd?: number[]
  /** 'card': the gremlin's signed donation card; 'announced': its announced deposit addresses. */
  source?: 'card' | 'announced'
}

type Family = 'quai' | 'evm' | 'solana' | 'copy'
type AddressKey = 'quai' | 'evm' | 'qi' | 'solana' | 'bitcoin' | 'litecoin'
export interface Coin {
  id: string
  label: string
  family: Family
  /** Which of the target's addresses it goes to. */
  to: AddressKey
  symbol: string
  decimals: number
  chainId?: number
  token?: string
  priceId?: string
  /** For copy-address coins: the payment URI scheme for the QR code. */
  scheme?: string
}

const COINS: Coin[] = [
  { id: 'quai', label: 'QUAI', family: 'quai', to: 'quai', chainId: 9, symbol: 'QUAI', decimals: 18, priceId: 'coingecko:quai-network' },
  { id: 'base-usdc', label: 'USDC on Base', family: 'evm', to: 'evm', chainId: 8453, symbol: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { id: 'base-eth', label: 'ETH on Base', family: 'evm', to: 'evm', chainId: 8453, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'eth-usdc', label: 'USDC on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'USDC', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { id: 'eth-usdt', label: 'USDT on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'USDT', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { id: 'eth-eth', label: 'ETH on Ethereum', family: 'evm', to: 'evm', chainId: 1, symbol: 'ETH', decimals: 18, priceId: 'coingecko:ethereum' },
  { id: 'bsc-usdt', label: 'USDT on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'USDT', token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { id: 'bsc-usdc', label: 'USDC on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'USDC', token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { id: 'bsc-bnb', label: 'BNB on BSC', family: 'evm', to: 'evm', chainId: 56, symbol: 'BNB', decimals: 18, priceId: 'coingecko:binancecoin' },
  { id: 'sol-usdc', label: 'USDC on Solana', family: 'solana', to: 'solana', symbol: 'USDC', token: 'usdc', decimals: 6 },
  { id: 'sol-sol', label: 'SOL', family: 'solana', to: 'solana', symbol: 'SOL', decimals: 9, priceId: 'coingecko:solana' },
  { id: 'sol-usdt', label: 'USDT on Solana', family: 'solana', to: 'solana', symbol: 'USDT', token: 'usdt', decimals: 6 },
  { id: 'btc', label: 'Bitcoin (copy address)', family: 'copy', to: 'bitcoin', symbol: 'BTC', decimals: 8, priceId: 'coingecko:bitcoin', scheme: 'bitcoin' },
  { id: 'ltc', label: 'Litecoin (copy address)', family: 'copy', to: 'litecoin', symbol: 'LTC', decimals: 8, priceId: 'coingecko:litecoin', scheme: 'litecoin' },
  { id: 'qi', label: 'Qi, private (copy payment code)', family: 'copy', to: 'qi', symbol: 'Qi', decimals: 3 },
]
const EXPLORER: Record<string, string> = { 9: 'https://quaiscan.io/tx/', 1: 'https://etherscan.io/tx/', 8453: 'https://basescan.org/tx/', 56: 'https://bscscan.com/tx/', solana: 'https://solscan.io/tx/' }
const PRESETS = [5, 10, 25, 50]
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
/** Addresses the board can't tie to the gremlin's keys: only its signature on the card vouches for them. */
const PUBLISHED_ONLY: AddressKey[] = ['solana', 'bitcoin', 'litecoin']
const CHAIN_NAME: Record<AddressKey, string> = { quai: 'Quai', evm: 'EVM', qi: 'Qi', solana: 'Solana', bitcoin: 'Bitcoin', litecoin: 'Litecoin' }

/** The coins a target can take: only those it has an address for. */
export const coinsFor = (t: DonateTarget) => COINS.filter((c) => !!t[c.to])

/** Token amount (base units) for a dollar amount; stablecoins are 1:1. */
export async function amountFor(coin: Pick<Coin, 'priceId' | 'decimals' | 'symbol'>, usd: number, fetchImpl: typeof fetch = fetch): Promise<bigint> {
  if (!coin.priceId) return parseUnits(usd.toFixed(Math.min(coin.decimals, 6)), coin.decimals)
  const r = await fetchImpl(`https://coins.llama.fi/prices/current/${coin.priceId}`)
  const price = (await r.json())?.coins?.[coin.priceId]?.price as number | undefined
  if (!price || !(price > 0)) throw new Error(`no live price for ${coin.symbol}; try a stablecoin`)
  return parseUnits((usd / price).toFixed(Math.min(coin.decimals, 12)), coin.decimals)
}

/** A readable amount: up to 6 significant decimals, no trailing zeros. */
export const showAmount = (amount: bigint, decimals: number) => {
  const [i, f = ''] = formatUnits(amount, decimals).split('.')
  const lead = f.match(/^0*/)![0].length
  const frac = f.slice(0, Math.max(4, lead + 4)).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i!
}
const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// ── wallets ──────────────────────────────────────────────────────────────────

async function sendEvm(coin: Coin, to: string, amount: bigint): Promise<string> {
  const { provider: w, address: from } = await evmWallet()
  const want = toBeHex(coin.chainId!)
  if ((await w.request({ method: 'eth_chainId' })) !== want) await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] })
  const tx = coin.token
    ? { from, to: coin.token, data: ERC20.encodeFunctionData('transfer', [to, amount]), value: '0x0' }
    : { from, to, value: toBeHex(amount) }
  return (await w.request({ method: 'eth_sendTransaction', params: [tx] })) as string
}

async function sendQuai(to: string, amount: bigint): Promise<string> {
  const pelagus = pelagusWallet()
  if (!pelagus) throw new Error('Install the Pelagus wallet (pelaguswallet.io) to donate QUAI, or pick another coin.')
  const { BrowserProvider } = await import('quais')
  const [from] = (await pelagus.request({ method: 'quai_requestAccounts' })) as string[]
  const signer = await new BrowserProvider(pelagus as never).getSigner(from)
  const tx = await signer.sendTransaction({ from, to, value: amount })
  return tx.hash
}

async function sendSolana(coin: Coin, to: string, amount: bigint): Promise<string> {
  const [{ connectPhantomSolana }, { SOLANA_TOKENS, buildSolanaDonation, solanaReader }] = await Promise.all([import('./solana-wallet.js'), import('./solana-pay.js')])
  const wallet = await connectPhantomSolana()
  const token = coin.token ? SOLANA_TOKENS[coin.token as keyof typeof SOLANA_TOKENS] : undefined
  const { bytes } = await buildSolanaDonation({ from: wallet.address, to, amount, token }, solanaReader())
  return wallet.signAndSend(bytes)
}

// ── UI ───────────────────────────────────────────────────────────────────────

const h = (tag: string, attrs: Record<string, string> = {}, text = '') => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (text) el.textContent = text
  return el
}

const WALLET_HINT: Record<Family, string> = { quai: 'with Pelagus', evm: 'MetaMask, Phantom, or any WalletConnect wallet', solana: 'with Phantom', copy: 'from any wallet' }

export function mountDonate(root: HTMLElement, target: DonateTarget) {
  const coins = coinsFor(target)
  const presets = target.suggestedUsd?.length ? target.suggestedUsd : PRESETS
  let usd = presets[Math.min(1, presets.length - 1)]!
  root.replaceChildren()
  root.classList.add('donate')
  if (!coins.length) {
    root.append(h('p', { class: 'small muted' }, `${target.name} has no donation address yet.`))
    return
  }

  if (target.note) root.append(h('p', { class: 'donate-note' }, `“${target.note}” (${target.name})`))

  const amounts = h('div', { class: 'donate-amounts', role: 'group', 'aria-label': 'Amount' })
  const custom = h('input', { type: 'number', min: '1', step: '1', inputmode: 'decimal', placeholder: 'Other', 'aria-label': 'Other amount in dollars' }) as HTMLInputElement
  const presetButtons = presets.map((v) => {
    const b = h('button', { type: 'button', class: 'chip' }, `$${v}`)
    b.onclick = () => { usd = v; custom.value = ''; sync() }
    return b
  })
  const dollar = h('label', { class: 'donate-custom' }, '$')
  dollar.append(custom)
  amounts.append(...presetButtons, dollar)
  custom.oninput = () => { const v = Number(custom.value); if (v > 0) { usd = v; sync() } }

  const coinSelect = h('select', { 'aria-label': 'Pay with' }) as HTMLSelectElement
  const sendable = coins.filter((c) => c.family !== 'copy')
  const copyable = coins.filter((c) => c.family === 'copy')
  const group = (label: string, list: Coin[]) => {
    if (!list.length) return
    const g = h('optgroup', { label })
    for (const c of list) g.append(h('option', { value: c.id }, c.label))
    coinSelect.append(g)
  }
  group('Send from a browser wallet', sendable)
  group('Send from any wallet', copyable)
  coinSelect.value = (pelagusWallet() && coins.find((c) => c.id === 'quai')) ? 'quai' : (coins.find((c) => c.id === 'base-usdc') ?? coins[0]!).id
  const hint = h('span', { class: 'donate-wc' })

  const go = h('button', { type: 'button', class: 'btn btn-primary' })
  const pick = h('div', { class: 'donate-pick' })
  const status = h('p', { class: 'donate-status small', role: 'status', 'aria-live': 'polite' })
  const coin = () => coins.find((c) => c.id === coinSelect.value)!
  const published = (c: Coin) => PUBLISHED_ONLY.includes(c.to) ? ` (as published by ${target.name})` : ''

  // Copy-address coins: the address, a copy button and a QR code with the amount filled in where the coin allows.
  let pickRun = 0
  const showPick = async () => {
    const c = coin()
    const run = ++pickRun
    const to = target[c.to]!
    pick.replaceChildren(h('p', { class: 'small', style: 'margin:0' }, 'Working out the amount…'))
    let amount: bigint | undefined
    try { if (c.priceId) amount = await amountFor(c, usd) } catch { /* no price: show the address alone */ }
    const uri = c.scheme ? `${c.scheme}:${to}${amount ? `?amount=${formatUnits(amount, c.decimals)}` : ''}` : to
    const QRCode = (await import('qrcode')).default
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 336, errorCorrectionLevel: 'M' }).catch(() => '')
    if (run !== pickRun) return
    const what = amount ? `Send about ${showAmount(amount, c.decimals)} ${c.symbol} ($${usd}) to` : `Send ${c.symbol} to`
    const lead = h('p', { class: 'small', style: 'margin:0' }, `${what} ${target.name}'s ${CHAIN_NAME[c.to]} ${c.to === 'qi' ? 'payment code' : 'address'}${published(c)}:`)
    const addr = h('span', { class: 'addr' }, to)
    const copy = h('button', { type: 'button', class: 'btn btn-small' }, 'Copy')
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(to); copy.textContent = 'Copied' } catch { copy.textContent = 'Select and copy it' }
      setTimeout(() => (copy.textContent = 'Copy'), 2000)
    }
    pick.replaceChildren(lead, addr, copy)
    if (qr) pick.append(h('img', { src: qr, alt: `QR code for ${target.name}'s ${CHAIN_NAME[c.to]} ${c.to === 'qi' ? 'payment code' : 'address'}` }))
    if (c.to === 'qi') pick.append(h('p', { class: 'small muted', style: 'margin:0' }, 'Qi payment codes work in Pelagus: send Qi to the code and only the gremlin can tell it was paid.'))
  }

  const sync = () => {
    presetButtons.forEach((b, i) => b.classList.toggle('on', !custom.value && presets[i] === usd))
    const c = coin()
    hint.textContent = WALLET_HINT[c.family]
    const copyMode = c.family === 'copy'
    // (style, not the hidden attribute: .btn sets its own display)
    go.style.display = copyMode ? 'none' : ''
    pick.style.display = copyMode ? '' : 'none'
    go.textContent = `Donate $${usd % 1 ? usd.toFixed(2) : usd}`
    status.textContent = copyMode ? '' : c.family === 'solana' ? `Goes to ${target.name}'s Solana address ${shortAddr(target.solana!)}${published(c)}.` : ''
    if (copyMode) void showPick()
  }
  coinSelect.onchange = sync

  go.onclick = async () => {
    const c = coin()
    const to = target[c.to]!
    go.setAttribute('disabled', '')
    status.textContent = 'Getting the price…'
    try {
      const amount = await amountFor(c, usd)
      const wallet = c.family === 'quai' ? 'Pelagus' : c.family === 'solana' ? 'Phantom' : 'your wallet'
      status.textContent = `Sending ${showAmount(amount, c.decimals)} ${c.symbol} (about $${usd}) to ${target.name} at ${shortAddr(to)}${published(c)}. Confirm in ${wallet}…`
      const hash = c.family === 'quai' ? await sendQuai(to, amount) : c.family === 'solana' ? await sendSolana(c, to, amount) : await sendEvm(c, to, amount)
      const explorer = EXPLORER[c.family === 'solana' ? 'solana' : String(c.chainId)]
      status.replaceChildren(
        document.createTextNode(`Thank you! You sent ${showAmount(amount, c.decimals)} ${c.symbol} to ${target.name}; it will see it shortly. `),
        h('a', { href: explorer + hash, target: '_blank', rel: 'noopener' }, 'View transaction'),
      )
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e)
      status.textContent = /reject|denied|cancel/i.test(msg) ? 'Cancelled.' : msg
    } finally {
      go.removeAttribute('disabled')
    }
  }

  const row = h('div', { class: 'donate-row' })
  row.append(coinSelect, hint)
  root.append(amounts, row, go, pick, status)
  sync()
}

// ── dialog (the compact and inline buttons) ─────────────────────────────────

let dialog: HTMLDialogElement | undefined
export function openDonateDialog(target: DonateTarget) {
  if (!dialog) {
    dialog = h('dialog', { class: 'donate-dialog', 'aria-labelledby': 'donate-dialog-title' }) as HTMLDialogElement
    // A click on the backdrop (outside the dialog's box) closes it.
    dialog.addEventListener('click', (e) => {
      const r = dialog!.getBoundingClientRect()
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog!.close()
    })
    document.body.append(dialog)
  }
  const close = h('button', { type: 'button', class: 'close', 'aria-label': 'Close' }, '×')
  close.onclick = () => dialog!.close()
  const title = h('h2', { id: 'donate-dialog-title' }, `Donate to ${target.name}`)
  const lede = h('p', { class: 'small muted', style: 'margin:0 0 12px' }, 'It goes straight to its own wallet; nobody else can spend it.')
  const box = h('div')
  dialog.replaceChildren(close, title, lede, box)
  mountDonate(box, target)
  dialog.showModal()
}

/** Reads a mount point's data attributes (apps/board/src/donate.ts writes them). */
export function targetOf(el: HTMLElement): DonateTarget {
  const d = el.dataset
  const suggested = (d.suggested ?? '').split(',').map(Number).filter((v) => v > 0)
  return {
    name: d.name || 'this gremlin', quai: d.quai, evm: d.evm, qi: d.qi, solana: d.solana, bitcoin: d.bitcoin, litecoin: d.litecoin,
    note: d.note, suggestedUsd: suggested.length ? suggested : undefined, source: d.source === 'card' ? 'card' : 'announced',
  }
}

export function mountAll() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-donate]')) {
    const target = targetOf(el)
    if (!coinsFor(target).length) continue
    const mode = el.dataset.donate
    if (mode === 'compact' || mode === 'inline') {
      const b = h('button', { type: 'button', class: 'donate-btn', title: `Donate to ${target.name}` }, mode === 'inline' ? `Donate to ${target.name}` : 'Donate')
      b.addEventListener('click', (e) => {
        // Board rows are links: the button opens the dialog instead of following them.
        e.preventDefault()
        e.stopPropagation()
        openDonateDialog(target)
      })
      el.replaceChildren(b)
    } else {
      mountDonate(el, target)
    }
  }
}
