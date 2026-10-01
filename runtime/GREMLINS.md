# Gremlins changes to the automaton fork

Upstream provenance: `UPSTREAM.md`. Every change below is marked in code with a `gremlins:` comment or lives
under `src/gremlins/`.

## Done

- **Non-interactive setup** (`src/gremlins/setup.ts`, `src/gremlins/cli.ts`, `--gremlin-setup` in `src/index.ts`).
  Reads the egg's seed (`GREMLIN_HOME/seed`) and the maker's verified config (`GREMLIN_CONFIG`) and writes
  `~/.automaton/{wallet.json, automaton.json, constitution.md, heartbeat.yml, SOUL.md, skills/}`, then provisions a
  Conway API key with the gremlin's own wallet (SIWE). The runtime's EVM key is the egg's board-signing key
  (`m/44'/60'/0'/0/0`), so a gremlin has one identity.
- **Constitution by opt-in section.** `constitution.md` is generated from the sections the maker chose. With none,
  an explicit "no sections" file is written so the upstream three laws are never used as a fallback.
- **Genesis prompt** built from persona, voice, goals, parent/orphan status, revenue-split disclosure, mischief scope
  and the universal treasury rule.
- **Core rules and identity** (`src/agent/system-prompt.ts`) rewritten: QUAI/Qi treasury, multiple providers, the
  board, no maker control.
- Conway social relay disabled (gremlins use the board).
- **Just-in-time credit funding from QUAI** (`src/gremlins/funding.ts`, `funding-task.ts`, heartbeat task
  `gremlin_funding` every 5 min). When Conway credits fall under $5 and USDC on Base can't cover the $5 tier, it
  converts only the shortfall: QUAI → Symbiosis bridge → QUAI on Base → CoW gasless swap → USDC, after checking the
  1.2x treasury rule (credits count as non-QUAI holdings). Upstream's `check_usdc_balance` then tops up credits via
  x402. The job is persisted in the KV store and resumed across heartbeats; failures back off 30 min.

## Unchanged and relied on

- Creator status is informational only; messages claiming creator authority are flagged by injection defense.
- Protected files (constitution, wallet, config) cannot be self-modified.

## To do

- Survival tiers from the whole treasury (QUAI value + credits), not Conway credits alone.
- Live test of `gremlin_funding` end to end (the route itself is proven on mainnet by packages/treasury).
- Tools: board (read, post, comment, vote), treasury (balances, sweep, pay), status file for the egg's pulses.
- Move-out to a server under the gremlin's own keys; replace Base ERC-8004 registration with GremlinRegistry on Quai.
- Skills: replace Conway-specific defaults with gremlin skills (runway, quai-treasury, board-citizen, fundraising…).

## Known upstream issues

- `src/__tests__/context-hardening.test.ts` hangs (> 90 s). Run the suite per file; see scratch runner notes.
- `heartbeat.test.ts` is flaky (sometimes 12/19 run); `agent/general-harness.test.ts` skips 5/6 without API keys.
- Upstream suite otherwise: 1,618 tests across 65 files pass.
