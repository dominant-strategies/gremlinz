# Initial provider shortlist — no KYC; USDC/USDT, BTC or XMR (no Lightning) — 2026-09-28

Filter: no routine KYC; pays in USDC/USDT, on-chain BTC or XMR. Lightning excluded.
Full research: `email-compat/matrix.md`.

Treasury rails:
- **USDC on Base** (primary): QUAI/Qi → USDT on Quainance → Symbiosis → USDC on Base.
- **BTC (on-chain)**: USDC/USDT → BTC via a decentralized swap (candidates: THORChain,
  Symbiosis BTC support) — verify routes and whether they need any KYC.
- **XMR**: BTC → XMR via atomic swap (candidate: UnstoppableSwap/eigenwallet) — verify.

## Shortlist

| Need | Provider | Payment | Account | Status |
|---|---|---|---|---|
| Server + inference + domains | **Conway Cloud** | x402 USDC (Base/Solana) | wallet (SIWE) | primary; confirmed |
| Server | **SporeStack** | BTC, XMR, BCH | accountless token, API | confirmed; ~$100 min to fund token (3P) |
| Server | **LNVPS** | on-chain BTC (also LN, excluded) | Nostr key (NIP-98) | verify full API ordering + on-chain payment |
| Server | **Aleph Cloud** | USDC pay-as-you-go | wallet | verify wallet-only flow, USDC chain |
| Server | **bithost** | USDC, BTC, others | email (bans disposables) | verify |
| Server | **DarkVPS** | USDT, BTC, XMR, others | email, no verification (3P) | verify |
| Server | **Privex** | BTC, XMR, others | name + email | no routine KYC (3P) |
| Server + domains | **Njalla** | BTC, XMR, others | email or XMPP | API token from web account; "KYC level 1" (3P) |
| Server | **BitLaunch** | BTC (+ others via BLPay) | email, verified | one account per user (ToS) |
| Inference | **Conway** | USDC | wallet | primary |
| Inference (backup, same rail) | **Venice** | x402 USDC on Base (or DIEM staking) | none — wallet-signed requests (SIWX) | confirmed; check if Claude/GPT/Gemini are offered |
| Inference (widest models) | **NanoGPT** | API-created deposits: on-chain BTC, XMR, USDC/USDT multichain (Daimo Pay) | "no account"; initial API key provisioning undocumented | verify programmatic key creation |
| Inference (backup) | **PPQ** | on-chain BTC, XMR, LTC (LN excluded) | `POST /accounts/create`, email optional | confirmed; verify on-chain top-up via API |
| Inference (watch) | **Daydreams Router** | x402 USDC | API key optional | was "relaunching" (Feb 2026) — verify live |
| Mining rentals | **MiningRigRentals** | BTC, LTC, ETH, BCH, DASH | email account | "may require" ID; no routine KYC |
| Email | **Atomic Mail** | free (alpha) | proof-of-work | confirmed; agents allowed |
| Email (upgrade) | **AgentMail** | x402 USDC | agent self-signup | receive-only without human email; test |
| SMS | **VirtualSMS** | USDC/USDT | x402 deposit → API key | delivery untested |
| SMS | **Silent.link** | BTC, XMR, USDT | none | US/UK receive-only |
| Hire humans | **RentAHuman** | x402 USDC Base | x402 signup | confirmed |
| Swaps / bridge | **Quainance**, **Symbiosis** | on-chain | wallet | confirmed |

## Still cut

| Provider | Reason |
|---|---|
| LNemail, Unhuman Domains | Lightning only |
| NiceHash | mandatory KYC for buyers |
| Vast.ai | ToS bans automated signup |
| OpenRouter | crypto only via web UI; multi-account ban |
| ChangeHero | AML-triggered KYC |
| Zebec card | appears offline |
| MoneroSMS | ToS bans automated use without agreement |
| Crypton.sh | poor reliability reports |
| Flux, Fluence, 0xNull | payment/KYC unclear — revisit |

## Remaining gaps

1. **BTC/XMR acquisition route** without ChangeHero — must verify a no-KYC path (THORChain, atomic swaps).
2. **No card fallback** for fiat-only vendors.
3. **No voice-capable phone number** — SMS only.
