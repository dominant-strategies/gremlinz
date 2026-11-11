/**
 * Email and X sign-in for the Quai Smart Wallet, inside our own sign-in dialog (no wallet popup).
 *
 * Privy (the same app the Smart Wallet itself uses, so the same login reaches the same Safe) runs headless in a hidden
 * React root that is mounted only when someone picks email or X, or comes back from X. It logs the person in and
 * gives their Privy wallet, which owns their Safe; smart-wallet.ts turns that into the Safe account.
 */
import type { PrivyOwnerSession, PrivyOwnerWallet } from '@quai-smart-wallet/sdk/privy'

const env = import.meta.env
export const PRIVY_APP_ID = (env.VITE_PRIVY_APP_ID as string | undefined) || 'cmu30bcpj015g0dl0adfxscgp'
const PRIVY_CLIENT_ID = (env.VITE_PRIVY_CLIENT_ID as string | undefined) || undefined

export interface PrivyBridge {
  session(): PrivyOwnerSession
  authenticated(): boolean
  sendEmailCode(email: string): Promise<void>
  loginWithEmailCode(code: string): Promise<void>
  /** Leaves the page for X; the page finishes signing in when X sends the person back (resumeFromX). */
  loginWithX(): Promise<void>
  /** The person's Privy wallet (created on first sign-in): it owns their Safe. */
  ownerWallet(): Promise<PrivyOwnerWallet>
  logout(): Promise<void>
}

/** True while coming back from X's login page. */
export const returningFromX = () => /[?&]privy_oauth_(code|state)=/.test(location.search)

let bridge: Promise<PrivyBridge> | undefined

/** Mounts Privy (once) and resolves when it is ready. */
export function privy(): Promise<PrivyBridge> {
  return (bridge ??= mount())
}

async function mount(): Promise<PrivyBridge> {
  const [React, { createRoot }, Privy] = await Promise.all([import('react'), import('react-dom/client'), import('@privy-io/react-auth')])
  const { PrivyProvider, usePrivy, useWallets, useCreateWallet, useLoginWithEmail, useLoginWithOAuth } = Privy

  // The latest hook values, read by the bridge's promises; waiters re-check on every render.
  type Snapshot = {
    ready: boolean
    walletsReady: boolean
    authenticated: boolean
    userId: string | null
    wallets: PrivyOwnerWallet[]
    email: ReturnType<typeof useLoginWithEmail>
    oauth: ReturnType<typeof useLoginWithOAuth>
    createWallet: ReturnType<typeof useCreateWallet>['createWallet']
    logout: () => Promise<void>
  }
  let snap: Snapshot | undefined
  const waiters = new Set<() => void>()
  const until = (ok: (s: Snapshot) => boolean, what: string, ms = 120_000) =>
    new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Timed out waiting for ${what}.`)) }, ms)
      const check = () => { if (snap && ok(snap)) { clearTimeout(timer); waiters.delete(check); resolve(snap) } }
      waiters.add(check)
      check()
    })

  function Bridge() {
    const { ready, authenticated, user, logout } = usePrivy()
    const { wallets, ready: walletsReady } = useWallets()
    const { createWallet } = useCreateWallet()
    const email = useLoginWithEmail()
    const oauth = useLoginWithOAuth()
    // Only Privy's own embedded wallet can own the Safe; never an external wallet Privy happens to see.
    const embedded = wallets.filter((w) => w.walletClientType === 'privy') as unknown as PrivyOwnerWallet[]
    snap = { ready, walletsReady, authenticated, userId: user?.id ?? null, wallets: embedded, email, oauth, createWallet, logout }
    React.useEffect(() => { for (const w of [...waiters]) w() })
    return null
  }

  const host = document.createElement('div')
  host.hidden = true
  document.body.append(host)
  createRoot(host).render(
    React.createElement(PrivyProvider, {
      children: React.createElement(Bridge),
      appId: PRIVY_APP_ID,
      ...(PRIVY_CLIENT_ID ? { clientId: PRIVY_CLIENT_ID } : {}),
      config: {
        loginMethods: ['email', 'twitter'],
        // Our dialog shows every request for approval (smart-wallet.ts); Privy's own prompts would be a second popup.
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false },
        appearance: { walletList: [] },
      },
    }),
  )
  await until((s) => s.ready, 'the sign-in service', 30_000)

  const api: PrivyBridge = {
    session: () => ({ ready: !!snap?.ready && !!snap?.walletsReady, authenticated: !!snap?.authenticated, userId: snap?.userId ?? null, wallets: snap?.wallets ?? [] }),
    authenticated: () => !!snap?.authenticated,
    async sendEmailCode(email) {
      await snap!.email.sendCode({ email })
    },
    async loginWithEmailCode(code) {
      await snap!.email.loginWithCode({ code })
      await until((s) => s.authenticated, 'sign-in')
    },
    async loginWithX() {
      await snap!.oauth.initOAuth({ provider: 'twitter' })
    },
    async ownerWallet() {
      let s = await until((x) => x.authenticated && x.walletsReady, 'your sign-in')
      if (!s.wallets.length) {
        await s.createWallet()
        s = await until((x) => x.wallets.length > 0, 'your wallet')
      }
      return s.wallets[0]!
    },
    async logout() {
      if (snap?.authenticated) await snap.logout()
    },
  }
  // Coming back from X: Privy finishes the login itself once mounted.
  if (returningFromX()) await until((s) => s.authenticated, 'X sign-in').catch(() => undefined)
  return api
}
