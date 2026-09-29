# @gremlins/contracts

On-chain pieces for milestone M2: `GremlinRegistry` and `RevenueSplitter`. Standalone Hardhat package (not an npm
workspace of the repo root). Solidity 0.8.24, EVM target `shanghai`: the same compiler setup the QNS contracts
use on Quai mainnet.

```
npm install          # inside contracts/
npx hardhat test     # local Hardhat network, chainId 9
```

## Contracts

### GremlinRegistry

A public record of gremlins. It has no owner, admin, pause, kill switch or upgrade path.

| Function | Caller | Effect |
| --- | --- | --- |
| `register(maker, configHash, parentIsMaker, splitter, issuedAt, makerSig)` | the gremlin's own EOA | Checks the maker's EIP-712 `Hatch` signature, with `gremlin = msg.sender`, and records the gremlin. The parent is the maker, or `address(0)` (orphan). |
| `spawnChild(child, configHash, splitter, issuedAt, childSig)` | a registered gremlin | Registers `child` with parent = maker = `spawnedBy` = caller. `childSig` is the child's EIP-712 `Spawn` consent. |
| `setSplitter(splitter)` | the gremlin | One-time, only if no splitter was recorded at registration. |
| `renounce(gremlin)` | the current parent | The gremlin becomes an orphan. |
| `proposeAdoption(gremlin)` / `cancelAdoption(gremlin)` | anyone | Opens or withdraws an adoption offer. |
| `acceptAdoption(newParent)` | the gremlin, and only while it is an orphan | Accepts an open offer. The offer is consumed. |
| `heartbeat()` | the gremlin | Sets `lastSeen = block.timestamp`. |

Views: `getGremlin`, `isGremlin`, `parentOf`, `isOrphan`, `gremlinByConfigHash`, `adoptionProposed`,
`gremlinCount`/`gremlinAt`, `hatchDomainSeparator`, `hatchDigest`, `spawnDigest`. Every state change emits an event.

Rules:
- One registration per address. Each `configHash` can be used once across hatches and spawns, so a maker's
  signature cannot register a second gremlin.
- A non-zero `splitter` must be a contract whose `gremlin()` returns the gremlin being registered.
- `maker` may be neither zero nor the caller. The configHash may not be zero.
- Signatures go through OpenZeppelin `ECDSA.tryRecover`, which rejects high-s (malleable) and malformed
  signatures.

**EIP-712.** `Hatch(address maker,address gremlin,bytes32 configHash,uint64 issuedAt)` uses the domain
`{name: "Gremlins", version: "1", chainId}` with **no `verifyingContract`**. This matches
`packages/hatch/src/signing.ts`. A test reads that file to make sure the two stay in sync. `chainId` comes from
`block.chainid`. `Spawn(address parent,bytes32 configHash,address splitter,uint64 issuedAt)` is new, so its domain
also binds `verifyingContract = registry`.

### RevenueSplitter

Each gremlin deploys its own splitter: `constructor(gremlin, recipient, bps)` with `bps` in 1..10000. `gremlin`
and `recipient` are immutable. There is no admin.

- **Native QUAI:** `receive()` splits the incoming value into accrued balances (`owedGremlin`, `owedRecipient`)
  and makes no external calls. The recipient's share is `amount * bps / 10000`, rounded down, so dust goes to the
  gremlin.
- **Funds that arrive without calling `receive()`** (forced sends, credits that run no code) are split by
  `sync()`. Every state-changing function calls `sync()` first.
- **Payouts:** `release()` (anyone) pushes both balances. A payee that reverts keeps its balance accrued and gets
  a `PaymentFailed` event. The other payee still gets paid. `withdraw(payee)` pays one payee and reverts only if
  that transfer fails.
- **Payout safety:** payouts use checks-effects-interactions, `nonReentrant`, and an assembly `call` that copies
  no returndata, so a return bomb cannot drain the caller's gas.
- **ERC20:** `distribute(token)` splits the token balance that has not been accounted for yet, using the current
  bps, and tries both transfers. A failed transfer, such as a blocklisted recipient, is accrued in
  `owedToken[token][payee]` and can be retried with `withdrawToken(token, payee)`.
- **`lowerBps(newBps)`:** only the recipient can call it, only strictly downward, and 0 waives the share.
  Unsplit native funds are split at the old rate first. Tokens that have not been distributed yet use the rate in
  force when `distribute` runs.

## Deploying on Quai (do not run from CI)

```
cp .env.example .env    # set QUAI_RPC_URL and QUAI_PRIVATE_KEY
npx hardhat compile
node scripts/deploy-quai.js                 # GremlinRegistry (once per network)
node scripts/deploy-splitter-quai.js        # reference: a gremlin deploying its own splitter
```

- `deploy-quai.js` uses `quais` (`ContractFactory` with `setIPFSHash`, the same pattern as the QNS mainnet
  deploys) and refuses to run unless the chainId is 9 (override with `EXPECTED_CHAIN_ID`).
- After deploying, it checks that the on-chain `hatchDomainSeparator()` equals
  `TypedDataEncoder.hashDomain({name:"Gremlins",version:"1",chainId:9})`. If it does not match, don't use the
  deployment.
- It writes `deployments/registry-<chainId>.json`.
- `hardhat run --network …` is **not** used for Quai. Plain ethers deploys don't grind for an in-zone contract
  address.

## Security notes and assumptions

- **Squatting is prevented.** The maker signs after the egg announces itself, and `Hatch` names the egg's
  address (`gremlin`). `register` checks the signature against `gremlin = msg.sender`, so a public signed config
  is useless to anyone else: a squatter's call fails with `BadSignature`. A test covers this.
- **Replay across deployments.** The Hatch domain has no `verifyingContract`, so a maker signature is valid on
  every registry deployment on chain 9. This is required for compatibility. Uniqueness only holds within one
  registry.
- **Adoption needs an orphan.** A gremlin cannot swap one parent for another: its parent has to renounce it first.
  This keeps the maker-chosen parent binding, and the gremlin can't walk away from it. Offers never expire, but
  each is consumed when accepted and the proposer can cancel it.
- **The parent has no powers over the gremlin** beyond `renounce`. The registry is a public record. Enforcement
  (revenue, behaviour) lives elsewhere.
- **The splitter address is self-reported.** The registry checks that `splitter.gremlin()` returns the gremlin.
  It does not check that the recipient or bps match the signed config. Off-chain verifiers should compare them.
- **Splitter and senders that only forward 2300 gas** (`transfer`/`send`): `receive()` writes storage, so those
  senders revert. Senders that forward normal gas work.
- **Unusual ERC20s.** Fee-on-transfer and rebasing tokens are not supported. A token balance that rebases below
  the accrued amount makes `distribute` revert for that token until it recovers. Every other token and native
  QUAI keep working.
- The `maker` must be an EOA (no ERC-1271). Pelagus signers are EOAs.

## Quai-specific caveats (verify on Orchard testnet before mainnet)

1. **Contract addresses are sharded.**
   - quais appends a 4-byte salt to the init code and grinds it until the CREATE address falls in the deployer's
     zone and on the Quai ledger.
   - Constructor args are ABI-decoded from the front of the args region, so the trailing salt is ignored.
   - A gremlin deploying its own splitter must use quais' `ContractFactory`, not a plain ethers factory.
2. **Precompiles and `ecrecover`.**
   - The registry relies on `ecrecover` (precompile `0x01`).
   - My understanding (not confirmed from go-quai source) is that go-quai may scope precompile addresses by
     location. cyprus1's zone prefix is `0x00`, so `0x…01` should resolve there either way.
   - This has not been tested on-chain here. Do one real `register` on Orchard cyprus1 first.
   - Deploying in another zone may need extra checking.
3. **`block.chainid` must be 9.** The deploy script compares the domain separator after deploying.
4. **Cross-zone payments** to a splitter arrive as external transactions (ETXs). Whether an ETX runs `receive()`
   or only credits the balance, `sync()` accounts for the funds either way.
5. **`evmVersion` is pinned to `shanghai`** (it uses PUSH0), which QNS mainnet deploys show works on Quai. Cancun
   opcodes (e.g. `MCOPY`, transient storage) are not assumed.
