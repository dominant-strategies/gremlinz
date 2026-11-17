/**
 * Feeding a gremlin: pick an amount in dollars and press one button. What it's paid with is worked out from the
 * signed-in wallet and what it holds (balances.ts); "change" lists only what you hold. Anything else (another wallet,
 * a phone, an exchange, Bitcoin, Litecoin, Qi) is "send from another wallet": pick a network, scan or copy. The
 * button opens exactly one signing prompt. QUAI goes through Pelagus; ETH, BNB,
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
import { account, evmWallet, onAccountChange, signIn } from './auth.js'
import { COINS, coinsFor, type AddressKey, type Coin, type DonateTarget } from './coins.js'
export { coinsFor, type Coin, type DonateTarget }
import { bestSource, familiesFor, holdings, pricesFor, readBalances, type Holding } from './balances.js'
import { pelagus as pelagusWallet } from './wallets.js'


const EXPLORER: Record<string, string> = { 9: 'https://quaiscan.io/tx/', 1: 'https://etherscan.io/tx/', 8453: 'https://basescan.org/tx/', 56: 'https://bscscan.com/tx/', solana: 'https://solscan.io/tx/' }
const PRESETS = [5, 10, 25]
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
/** Addresses the board can't tie to the gremlin's keys: only its signature on the card vouches for them. */
const PUBLISHED_ONLY: AddressKey[] = ['solana', 'bitcoin', 'litecoin']


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
const money = (v: number) => `$${v % 1 ? v.toFixed(2) : v}`

/**
 * The networks a gremlin can be paid on by hand (scan or copy): each with the address to use, what it accepts there,
 * and what the QR code holds (a payment URI where the coin has one, else the bare address).
 */
type Network = { id: string; label: string; key: AddressKey; accepts: string; scheme?: string }
const NETWORKS: Network[] = [
  { id: 'quai', label: 'Quai', key: 'quai', accepts: 'QUAI' },
  { id: 'base', label: 'Base', key: 'evm', accepts: 'USDC or ETH' },
  { id: 'ethereum', label: 'Ethereum', key: 'evm', accepts: 'USDC, USDT or ETH' },
  { id: 'bsc', label: 'BSC', key: 'evm', accepts: 'USDT, USDC or BNB' },
  { id: 'solana', label: 'Solana', key: 'solana', accepts: 'USDC, USDT or SOL' },
  { id: 'bitcoin', label: 'Bitcoin', key: 'bitcoin', accepts: 'BTC', scheme: 'bitcoin' },
  { id: 'litecoin', label: 'Litecoin', key: 'litecoin', accepts: 'LTC', scheme: 'litecoin' },
  { id: 'qi', label: 'Qi (private)', key: 'qi', accepts: 'Qi, to its payment code (Pelagus)' },
]

/** Send from another wallet: pick a network, then scan the QR code or copy the address. */
function manualSend(target: DonateTarget, open: boolean): HTMLElement {
  const nets = NETWORKS.filter((n) => target[n.key])
  const box = h('details', { class: 'donate-manual' }) as HTMLDetailsElement
  box.open = open
  box.append(h('summary', {}, 'Send from another wallet (scan or copy)'))
  const chips = h('div', { class: 'donate-nets', role: 'radiogroup', 'aria-label': 'Network' })
  const shown = h('div', { class: 'donate-addr' })
  let run = 0
  const show = async (n: Network) => {
    for (const b of chips.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.net === n.id))
    const to = target[n.key]!, me = ++run
    const QRCode = (await import('qrcode')).default
    const qr = await QRCode.toDataURL(n.scheme ? `${n.scheme}:${to}` : to, { margin: 1, width: 320, errorCorrectionLevel: 'M' }).catch(() => '')
    if (me !== run) return
    const copy = h('button', { type: 'button', class: 'btn btn-small' }, 'Copy address')
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(to); copy.textContent = 'Copied' } catch { copy.textContent = 'Select and copy it' }
      setTimeout(() => (copy.textContent = 'Copy address'), 2000)
    }
    const warn = n.key === 'evm' ? ` Send on the ${n.label} network only.` : ''
    const vouched = PUBLISHED_ONLY.includes(n.key) ? ` This address is as published by ${target.name} (signed by its key).` : ''
    shown.replaceChildren(
      ...(qr ? [h('img', { src: qr, alt: `QR code for ${target.name}'s ${n.label} ${n.key === 'qi' ? 'payment code' : 'address'}`, width: '160', height: '160' })] : []),
      h('div'),
    )
    const side = shown.lastElementChild as HTMLElement
    side.append(h('p', { class: 'small', style: 'margin:0 0 6px' }, `${n.accepts} on ${n.label}.${warn}${vouched}`), h('span', { class: 'addr' }, to), copy)
  }
  for (const n of nets) {
    const b = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': 'false', 'data-net': n.id }, n.label)
    b.onclick = () => void show(n)
    chips.append(b)
  }
  box.append(chips, shown)
  if (nets[0]) void show(nets[0])
  return box
}

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

  const go = h('button', { type: 'button', class: 'btn btn-primary' })
  const from = h('p', { class: 'donate-from small' })
  const choices = h('div', { class: 'donate-choices', role: 'radiogroup', 'aria-label': 'Pay with' })
  choices.hidden = true
  const status = h('p', { class: 'donate-status small', role: 'status', 'aria-live': 'polite' })
  const manual = h('div')

  let held: Holding[] = []
  let chosen: Coin | undefined
  let picked = false // the person chose a coin under "change": keep it while the amount changes
  let balances = new Map<string, bigint | undefined>(), prices = new Map<string, number>()
  let reading = false

  const published = (c: Coin) => PUBLISHED_ONLY.includes(c.to) ? ` (as published by ${target.name})` : ''
  const sync = () => {
    presetButtons.forEach((b, i) => b.classList.toggle('on', !custom.value && presets[i] === usd))
    const a = account()
    const fams = familiesFor(a?.kind)
    const sendable = coins.filter((c) => fams.includes(c.family))
    held = holdings(sendable, balances, prices, usd)
    if (!picked || !chosen || !held.some((x) => x.coin.id === chosen!.id)) chosen = bestSource(held)?.coin
    go.style.display = ''
    if (!a) {
      go.textContent = 'Sign in to feed it'
      from.textContent = 'With Pelagus, MetaMask, Phantom or any WalletConnect wallet. Or send from another wallet below.'
    } else if (!sendable.length) {
      go.style.display = 'none'
      from.textContent = `Your ${a.kind === 'smartwallet' ? 'Quai Smart Wallet' : 'wallet'} can't send from this page yet: use the address or QR code below.`
    } else if (reading) {
      go.textContent = `Feed ${money(usd)}`
      from.textContent = 'Checking what your wallet holds…'
    } else if (chosen) {
      go.textContent = `Feed ${money(usd)}`
      const x = held.find((y) => y.coin.id === chosen!.id)!
      from.replaceChildren(document.createTextNode(`from ${showAmount(x.balance, chosen.decimals)} ${chosen.label}${published(chosen)} · `))
      if (held.length > 1) { const ch = h('button', { type: 'button', class: 'linkish' }, choices.hidden ? 'change' : 'done'); ch.onclick = () => { choices.hidden = !choices.hidden; sync() }; from.append(ch) }
    } else {
      go.style.display = 'none'
      from.textContent = held.length
        ? `Nothing in your wallet covers ${money(usd)} with its fee. Try a smaller amount, or send from another wallet below.`
        : `Your wallet holds nothing ${target.name} can take from here. Send from another wallet below.`
    }
    // "change": only what you hold, with balances
    choices.replaceChildren(...held.map((x) => {
      const id = `pay-${x.coin.id}-${Math.random().toString(36).slice(2, 7)}`
      const r = h('input', { type: 'radio', name: 'pay-with', id, value: x.coin.id }) as HTMLInputElement
      r.checked = x.coin.id === chosen?.id
      r.disabled = !x.enough || !x.feeOk
      r.onchange = () => { chosen = x.coin; picked = true; sync() }
      const l = h('label', { for: id, class: r.disabled ? 'off' : '' })
      l.append(r, h('span', {}, `${x.coin.label}`), h('span', { class: 'muted' }, `${showAmount(x.balance, x.coin.decimals)}${x.usd !== null ? ` · ${money(Math.floor(x.usd * 100) / 100)}` : ''}${!x.feeOk ? ' · no coin for the fee' : !x.enough ? ' · not enough' : ''}`))
      return l
    }))
    if (!manual.firstChild || manual.dataset.open !== String(!a || !chosen)) { manual.dataset.open = String(!a || !chosen); manual.replaceChildren(manualSend(target, !a || !chosen || !sendable.length)) }
  }

  // Reads balances for the signed-in wallet (only now, when the box is on screen).
  let readRun = 0
  const read = async () => {
    const a = account(), me = ++readRun
    const fams = familiesFor(a?.kind)
    const sendable = coins.filter((c) => fams.includes(c.family))
    if (!a || !sendable.length) { balances = new Map(); sync(); return }
    reading = true; sync()
    const sol = (globalThis as { phantom?: { solana?: { publicKey?: { toString(): string } } } }).phantom?.solana?.publicKey?.toString()
    const owner = { evm: fams.includes('evm') ? a.address : undefined, quai: a.kind === 'pelagus' ? a.address : undefined, solana: sol }
    const [b, p] = await Promise.all([readBalances(sendable, owner), pricesFor(sendable)])
    if (me !== readRun) return
    balances = b; prices = p; reading = false
    sync()
  }
  onAccountChange(() => { picked = false; void read() })

  go.onclick = async () => {
    if (!account()) { try { await signIn() } catch { /* closed */ } return }
    const c = chosen
    if (!c) return
    const to = target[c.to]!
    go.setAttribute('disabled', '')
    status.textContent = 'Getting the price…'
    try {
      const amount = await amountFor(c, usd)
      const wallet = c.family === 'quai' ? 'Pelagus' : c.family === 'solana' ? 'Phantom' : 'your wallet'
      status.textContent = `Sending ${showAmount(amount, c.decimals)} ${c.symbol} (about ${money(usd)}) to ${target.name} at ${shortAddr(to)}${published(c)}. Confirm in ${wallet}…`
      const hash = c.family === 'quai' ? await sendQuai(to, amount) : c.family === 'solana' ? await sendSolana(c, to, amount) : await sendEvm(c, to, amount)
      const explorer = EXPLORER[c.family === 'solana' ? 'solana' : String(c.chainId)]
      status.replaceChildren(
        document.createTextNode(`Thank you! You sent ${showAmount(amount, c.decimals)} ${c.symbol} to ${target.name}; it will see it shortly. `),
        h('a', { href: explorer + hash, target: '_blank', rel: 'noopener' }, 'View transaction'),
      )
      void read()
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e)
      status.textContent = /reject|denied|cancel/i.test(msg) ? 'Cancelled.' : msg
    } finally {
      go.removeAttribute('disabled')
    }
  }

  root.append(amounts, go, from, choices, status, manual)
  sync()
  void read()
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
