# Signup requirements matrix (research only; no accounts created) — 2026-09-28

Legend: C = confirmed from vendor source; ? = unknown; 3P = third-party directory (kycnot.me etc.).
CAPTCHA types were undocumented for nearly all services; assume unknown.

## Needs NO email (wallet/token/key/payment auth)
| Service | Auth | Payment | Notes |
|---|---|---|---|
| Conway Cloud | SIWE wallet; API key self-provisioned (C) | x402 USDC Base/Solana | "no login or KYC" (C) |
| SporeStack | accountless token (C) | XMR/BTC/BCH | ~$100 min to fund new token (3P) |
| LNVPS | Nostr NIP-98 / passkey (C) | Lightning, BTC, NWC | full API ordering unverified |
| PPQ (inference) | `POST api.ppq.ai/accounts/create` (C), email optional | Lightning, BTC, LTC, XMR, Stripe | no USDC |
| Unhuman Domains | payment = auth (L402) (C) | Lightning | email collected for ICANN |
| RentAHuman | `x402_signup`, $10 USDC Base, no human (C) | USDC Base / Stripe | |
| AgentMail | `POST /v0/agent/sign-up`, no auth (C) | x402 USDC Base/Polygon/Solana | **receive-only unless a human email verifies via OTP**; unclear if x402 lifts it |
| Atomic Mail | scrypt PoW (C); agents explicitly allowed | free alpha | human "Operator" legally responsible |
| LNemail | Lightning invoice → token (C) | Lightning | 1000 sats/yr |
| VirtualSMS (SMS) | x402 deposit → API key (C) | USDC Base, Solana, BNB | activation numbers from $0.05 |
| Aleph / Flux | wallet (Flux: C; Aleph: ?) | Aleph: ALEPH/USDC/card; Flux: FLUX/card/PayPal | end-to-end wallet-only flow unverified |

## Needs email
| Service | Verification | KYC | Disposable policy | Bot ToS | Payment |
|---|---|---|---|---|---|
| bithost | email+pwd (C) | none | **bans disposables w/o notice** (C) | ? | BTC+LN, LTC, ETH, USDC(?) |
| BitLaunch | verified (3P) | ? | ? | one account per user (C) | BTC+LN, others |
| Privex | name + valid email "not a bot" (C) | may request (3P) | ? | email = bot check | BTC, LTC, XMR, … |
| Njalla | email or XMPP (3P) | "level 1" (3P) | ? | ? | BTC, XMR, LTC, ZEC, ETH |
| DarkVPS | email, no verification (3P) | never (3P) | disposables OK (3P) | ? | BTC, XMR, ETH, USDT, LTC, TRX |
| OpenRouter | email "may be required" | none | ? | bans false identity / multi-account | card; USDC Base via web only (crypto API removed) |
| MiningRigRentals | account | may require (C) | ? | ? | BTC, LTC, ETH, BCH, DASH |

## Blocked / problematic
| Service | Problem | Source |
|---|---|---|
| NiceHash | **mandatory KYC for new hashpower buyers** | nicehash.com/blog/post/new-kyc-rules-for-hashpower-buyers |
| Vast.ai | **ToS bans automated account creation and scripts/browser automation; no mining on card credits** | vast.ai/terms |
| Zebec card | **card.zebec.io not resolving; reportedly offline until late 2026**; Silver tier asked name/phone/address | cryptocardhub.com/card/zebec-card |
| ChangeHero | no account, but **KYC triggered by AML flags**; API needs partner key | kycnot.me/service/changehero |
| MoneroSMS | ToS bans automated mass use without agreement | api.monerosms.com/tos |
| Crypton.sh | 70% 1-star ratings (stuck funds, dead numbers) | kycnot.me/service/crypton |

## Phone (crypto, no KYC, API) — candidates
VirtualSMS (x402, built for agents), VoipStore (x402, unverified), Silent.link (BTC/LN/XMR; US/UK SMS-receive only),
SMSPool (human signup first). None of these is confirmed to provide a persistent voice-capable number.

## Most in need of live testing
AgentMail send capability without human email; OpenRouter signup friction; 0xNull; Njalla/DarkVPS Lightning;
LNVPS end-to-end API ordering; Aleph/Flux wallet-only flow; bithost/BitLaunch/Privex domain rejection; VirtualSMS/VoipStore delivery; Zebec liveness.
