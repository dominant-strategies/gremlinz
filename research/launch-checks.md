# Egg launch feasibility checks — 2026-09-28

## 1. Browser access (CORS preflight from a foreign origin)

| API | Browser-callable |
|---|---|
| SporeStack (incl. server launch) | yes (`*`) |
| Aleph (api2.aleph.im) | yes (reflects origin) |
| Symbiosis REST | yes (`*`) |
| LNVPS, PPQ, NanoGPT, Venice | yes |
| Conway | **no** — allowlists `app.conway.tech` only |
| AgentMail, RentAHuman | no |

## 2. SporeStack (egg option A — ready)

- `POST /token/{token}/servers` accepts **`user_data` (cloud-init)**, except on "slow" servers and SporeStack EU.
  OS images are stock (Debian etc.); the egg is started by cloud-init pulling our image by digest.
- Token funding: `POST /token/{token}/add` with `currency` ∈ {xmr, btc, bch, **usdt**}; **minimum $5** (not $100).
- Daily billing (price in cents/day), `autorenew`, `days` 1–90.
- Caveat: whoever knows the token can `vnc`, `rebuild`, `stop`, `delete`. Hence the move-out step.
- AUP: standard abuse list; enforced; follows DigitalOcean/Vultr AUPs.

## 3. Aleph (egg option B — partial)

- TypeScript SDK works in the browser; custom rootfs images supported (instance references a rootfs hash);
  confidential VMs (AMD SEV) with encrypted disk images.
- **Pay-as-you-go is deprecated** → credits. Credits bought with ALEPH, USDC or ETH **on Ethereum mainnet**
  (`aleph credit buy --token usdc`), not Base.
- Cloud-init/user-data for instances: not confirmed.

## 4. Quai ↔ other chains via Symbiosis

- Symbiosis **public REST API refuses every route touching Quai** (both directions) with "This swap is not available".
- The **JS SDK has full Quai config** (chain 9): WQUAI is a native-origin token; portal
  `0x003d9F9666853fD4A10351FF5364c602470A7cF6` locks WQUAI on Quai; synthetic **QUAI on Base**
  `0x5c97D726bf5130AE15408cE32bc764e458320D2f` and on Ethereum `0x70b7f7…cDA1`.
- **On-chain evidence the route works**: portal has 523 txs; in the last ~week, 32 WQUAI locks (bridge-out,
  50 → 132,800 WQUAI) and 18 releases (bridge-in).
- Quai docs: WQUAI Base↔Quai and Ethereum↔Quai both directions; USDT Ethereum→Quai only.
- Base leg (REST quotes, 2,000 QUAI ≈ $22):
  - QUAI(Base) → USDC(Base): ~22.36 USDC, 0.3% impact — **works**
  - QUAI(Base) → BTC: works
  - USDC(Base) → BTC: works (~11 min)
  - → XMR: **not available**
  - QUAI(Ethereum) → QUAI(Base): "price impact too high" (thin liquidity)

**Working outbound route:** QUAI → wrap WQUAI → Symbiosis SDK bridge → QUAI on Base → swap → USDC on Base (or BTC).
Not yet executed end to end; needs one small live transaction via the SDK (Node wasn't available locally).

## Open items

- XMR route: none via Symbiosis; needs a separate path (e.g. BTC→XMR atomic swap) or drop XMR for now.
- Aleph: confirm instance user-data support; USDC on Ethereum means an extra hop/gas.
- Conway: ask to allowlist our launch page origin.
- ~~Live test: a small WQUAI → Base bridge via the SDK.~~ Done, see section 5.

## 5. Live bridge test — 2026-09-29 (UTC)

Test wallet `0x003c6127A9A32E1cc722225824d593714c32Eb96` (key in `privkey.key`, git-ignored), ~1,993 QUAI.

SDK findings (symbiosis-js-sdk 3.11.60):
- The route only resolves if the Base token is built as synthetic: `new Token({..., chainFromId: ChainId.QUAI_MAINNET})`.
- WQUAI(Quai) → QUAI(Base): 50 → 49, 200 → 199 (1 QUAI fee); 1000 → 998 (2 QUAI fee). Approve/tx target = portal.
- WQUAI → USDC(Base) in one call: not offered. Swap on Base afterwards (needs Base ETH for gas).
- Native QUAI input not supported; wrap first (`WQUAI.deposit()`).

Transactions (all status ok):
- wrap 200 QUAI: `0x000d0077f5b2b3541ddc6f80de84fe54e3983aa4640d76dcad6fcd22e5d78363`
- approve portal: `0x00590043a9716a026f2183642a09c6f24d1dd75bfc10dd80a1d590142dd566bc`
- bridge (block 10345540): `0x003500711d685fb3db0c7b5d80d99d26dc15d0d397f1f3b446e76e23f2080332`
- Quai-side cost of the 3 txs: ~8.9 QUAI in gas (1992.94 → 1784.02 after the 200 moved).
- Symbiosis status right after: Pending. Result on Base: see below.
- **Result: Success.** 199 QUAI arrived on Base at 03:26:09 UTC (~6 min 17 s after the Quai tx).
  Base tx: `0x3815095d186f82d8548522cc314f6f8f7bb0bb02455d112b27ae4c7dfb063c7c`.
  Status via `GET https://api.symbiosis.finance/crosschain/v1/tx/9/{hash}` (Pending → Success).
- Funds now on Base at the same address; need a small amount of Base ETH for gas to swap to USDC or bridge back.

**Conclusion:** the Quai → Base leg works end to end through the JS SDK (browser-compatible). Total cost for
200 QUAI: 1 QUAI bridge fee + ~8.9 QUAI Quai gas across wrap/approve/bridge.

## 6. Alternative routes and the destination-gas problem — 2026-09-29

SDK quotes for 1,000 WQUAI from Quai:
| Route | Out | Fee |
|---|---|---|
| → QUAI on Base (bridge) | 998 | 2 QUAI (0.2%) |
| → QUAI on Ethereum (bridge) | 915 | 85 QUAI (8.5%) |
| → ETH/WETH/USDC on any chain, one step | not offered | — |
| WETH(Ethereum) → ETH(Base), 0.01 WETH | 0.00949 ETH | ~5% at this size |

The only exits from Quai are plain bridges to synthetic QUAI on Base or Ethereum. The Ethereum → WETH → Base path
costs ~8.5% + L1 gas and still needs ETH on Ethereum for the swap. **Base direct is strictly better.**
SDK-side DEX swaps need 0x/1inch API keys; the Symbiosis REST API (keys server-side) does quote Base swaps.

**Destination gas solved via gasless swap:** QUAI on Base (`0x5c97…2D2f`) supports EIP-2612 permit
(`DOMAIN_SEPARATOR`, `nonces` present). CoW Protocol on Base can run a signed order with a permit pre-hook, so no Base ETH is needed.
CoW quotes (API is browser-callable, CORS `*`):
- 199 QUAI → 2.244 USDC, fee 0.59 QUAI (~0.3%)
- 199 QUAI → 0.000843 ETH, fee 0.41 QUAI

**Full no-gas route:** QUAI → wrap → Symbiosis bridge → QUAI on Base → CoW gasless (permit) → USDC or ETH on Base.
Quai gas is the only gas paid by the user. Not yet executed on Base.

## 7. CoW gasless swap on Base — executed 2026-09-29

- Permit domain for QUAI on Base is **`{name: "Symbiosis", version: "1", chainId: 8453}`**, not the token's `name()`
  ("Quai Network"). Found by matching `DOMAIN_SEPARATOR`. Not a proxy.
- Flow: sign EIP-2612 permit (spender = CoW VaultRelayer `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`)
  → put `permit(...)` calldata in appData `metadata.hooks.pre` (gasLimit 100k) → quote with that appData
  → sign GPv2 order (feeAmount 0, sellAmount = quote sell + fee, buyAmount = quote × 0.99) → POST /orders.
- Result: **199 QUAI → 2.247641 USDC** (quote was 2.2445, min 2.2221), filled ~16 s after submission.
  Order uid `0x2dc7eaa4…6abb3c81`, settlement tx `0x67364745a6f50a004bb43dfb7885f3cae6384016ba675aa3661a72f94bd2d727`.
- **Zero ETH on Base was ever held or needed.**

### End-to-end route, proven

`QUAI (Quai) → wrap WQUAI → Symbiosis bridge (~6 min) → QUAI (Base) → CoW gasless swap (~16 s) → USDC (Base)`

Costs for this $2.2 test: 1 QUAI bridge fee + ~8.9 QUAI Quai gas (3 txs) + ~0.55 QUAI CoW fee.
That's ~10.5 of 208.9 QUAI spent, ≈5%, dominated by fixed Quai gas. At larger sizes it's ≈0.2% + 0.3% ≈ 0.5% plus fixed gas.
Everything used (quais, Symbiosis JS SDK, ethers, CoW API) runs in a browser.

## 8. Multi-asset funding checks — 2026-09-29

- Inbound QUAI(Base) → WQUAI(Quai) via SDK: 1000 → 990 (10 WQUAI fee, 1%). Needs a Base tx (gas).
- BTC → USDC/QUAI on Base via SDK: 4 candidate routes, all failed only because SDK-side aggregator keys (0x/1inch) are missing.
  Use the Symbiosis REST API or configure a 0x key.
- CoW API live on: Ethereum, Gnosis, Arbitrum, Base, Avalanche, Polygon, BNB, Linea, Plasma.
- Gasless CoW needs EIP-2612 permit tokens; others (e.g. USDT on Ethereum) need one approve tx (native gas).

## 9. Funding chains decided: Quai, Ethereum, Base, BSC — 2026-09-29

Inbound to WQUAI(Quai), 1000 QUAI in (SDK):
- Ethereum QUAI `0x70b7…cDA1` → 990 (1%); permit domain "Symbiosis" v1 ✓
- Base QUAI `0x5c97…2D2f` → 990 (1%); permit ✓
- BSC QUAI `0x9287…6651` → **no route**. Not a Symbiosis synthetic (not in the SDK token map); `owner()` =
  `0xc17d768Bf4FdC6f20a4A0d8Be8767840D106D077`, supply ~882,050. Permit (Symbiosis v1 domain) ✓.
  **Correction:** it *is* a Symbiosis synthetic. Owner = Symbiosis BSC `fabric` (`0xc17d…D077`); all mints come
  from the Symbiosis BSC `bridge` (`0xb8f2…81A8`). The npm SDK (3.11.60) token cache just lacks the entry.
  After adding `{chainId: 56, address: 0x9287…6651, chainFromId: 9, originalId: 108}` to the cache:
  BSC QUAI → WQUAI(Quai) quotes **990 per 1000 (1%)**, same as Ethereum/Base.
  In the product: supply the entry via config override (or upstream PR to symbiosis-js-sdk).

## 10. Sweeper round trip (code under test) — 2026-09-29

`scripts/sweep-live.mjs` using `packages/treasury` (planSweep + executeSweep), test wallet on Base:
- plan: buy-gas(0.10 USDC) → swap-to-quai(2.147641 USDC) → bridge-to-quai
- buy-gas: 0.10 USDC → 0.0000351 ETH (CoW gasless, tx `0xc0d1f865…9068`)
- swap: 2.147641 USDC → 188.071 QUAI on Base (CoW gasless, tx `0xd3193b12…0586`)
- bridge Base → Quai: tx `0xce762ecc…8629`, Symbiosis Success; **178.071 WQUAI** arrived on Quai
- Inbound bridge fee is a flat ~10 QUAI (170 → 160, 50 → 40), not a percentage — batch small deposits.
- Arrives as WQUAI: runtime should call `unwrapAll()`.

Full loop proven: QUAI → Base USDC → QUAI, with gas only ever bought from the wallet's own funds.
