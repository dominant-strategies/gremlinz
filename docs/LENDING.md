# Lending capacity

People can lend a gremlin spare capacity on their own AI provider accounts, on their own rules. The rules cover how much, when, which models, for what, and how the gremlin repays them. Before anything is sealed or relayed, we check that the provider's terms allow it, so lenders don't get banned.

- **Registry:** `packages/hatch/src/providers.ts` (`PROVIDER_REGISTRY_VERSION = 2026-11-16.1`). It holds each provider's stance, sources, limits, obligations and setup advice.
- **Grant schema:** `packages/hatch/src/grants.ts`.
- **Presets, summary and wishes note:** `packages/hatch/src/lending.ts`.
- **Lending page:** `/lend/?gremlin=0x…` (`apps/launch/lend/`, `apps/launch/src/lend.ts`). It is linked from the "Lend capacity" card on every hatched gremlin's page.
- **Enforcement:** `packages/gremlin-mcp/src/gateway/grants.ts` and `lent-limits.ts`.
- **The gremlin's view:** the `lent_keys` tool.

## Provider stances (terms read 2026-11-16)

A provider is **allowed-with-conditions** when no clause forbids letting another party use your key. The lender stays the billed account holder and stays responsible, and nothing is resold. A provider is **forbidden** when either:

- a clause forbids sharing keys or account access, or the service is a personal subscription; or
- we could not read the terms. We refuse rather than gamble with someone's account.

"(not read directly)" means the live page refused us, so the quote comes from a secondary source.

| Provider | Stance | Key clause | Source (document date) |
|---|---|---|---|
| OpenRouter | allowed-with-conditions | "responsible for all activity and charges under its account or API Credentials"; no "reselling API access"; their guide recommends capped keys for agents | https://openrouter.ai/terms (2026-08-31), https://openrouter.ai/docs/guides/best-practices/capping-shared-agent-keys.md |
| Hashference | allowed-with-conditions | "All API keys in a workspace spend one shared balance. A key can have a monthly budget."; "do not pass a console session token to an agent". No terms of service found. | https://hashference.com/llms.txt, https://hashference.com/docs/agents.md |
| NanoGPT (pay as you go) | allowed-with-conditions | "responsible for activity and charges under your account"; downstream users "as if it were your own"; subscriptions are "for use by a single individual" | https://nano-gpt.com/terms (2026-11-16) |
| Google Gemini API | allowed-with-conditions | "responsible for … the use of that content by anyone you share it with"; no resale of Search grounding. The Google APIs ToS was not re-read. | https://aistudio.google.com/docs/terms (2026-03-23) |
| Anthropic API | allowed-with-conditions (strict) | Commercial Terms: "Customer is responsible for all activity under its account"; no reselling. AUP: agents must comply; consumer-facing agents must disclose they are AI. | https://www.anthropic.com/legal/commercial-terms (2025-06-17), https://www.anthropic.com/legal/aup (2026-11-12) |
| Venice API | allowed-with-conditions | Confidentiality of account; no "transfer the access granted"; credits non-transferable | https://venice.ai/legal/tos (2026-06-08) |
| Together AI | allowed-with-conditions | No transferring or reselling, and no offering the Services "on a standalone basis"; you manage your users | https://www.together.ai/terms-of-service (2026-05-19) |
| Your own server | allowed | Your server, your rules | — |
| OpenAI API | forbidden | "You may not make account access credentials available to third parties…" (not read directly) | https://openai.com/policies/services-agreement/ |
| Groq | forbidden | "Customer will only make its Account available to Authorized Account Users … may not resell or lease access" | https://console.groq.com/docs/legal/services-agreement (2026-06-22) |
| DeepInfra | forbidden | "sell, transfer, or share any account or access credentials" | https://deepinfra.com/terms (2026-10-15) |
| Mistral | forbidden | "buy, sell, or transfer API keys … with a third party"; no third-party access without written authorization | https://legal.mistral.ai/terms/commercial-terms-of-service (2026-09-25) |
| DeepSeek | forbidden | "do not share or publicly disclose your API key with others" | https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html (2026-04-29) |
| xAI, Fireworks | forbidden (unverified) | Terms could not be read (403 / PDF) | https://x.ai/legal/terms-of-service, https://fireworks.ai/terms-of-service |
| ChatGPT Plus/Pro | forbidden | "You may not share your account credentials or make your account available to anyone else" (not read directly) | https://openai.com/policies/terms-of-use/ |
| Claude Pro/Max | forbidden | "You may not share your Account login information, Anthropic API key, or Account credentials"; no routing "through Free, Pro, Max, or Ultra plan credentials on behalf of their users" | https://www.anthropic.com/legal/consumer-terms (2025-10-08), https://code.claude.com/docs/en/legal-and-compliance |
| Google AI Pro/Ultra | forbidden | Personal subscription (Gemini Apps terms not re-read) | https://policies.google.com/terms |
| GitHub Copilot | forbidden | Personal account (not read directly) | GitHub Terms for Additional Products (2026-08-27) |
| Cursor | forbidden | "rent, lease, lend, or sell the Service" | https://cursor.com/terms-of-service (2026-09-03) |
| Perplexity Pro | forbidden | "personal, non-commercial use only"; no bots | https://www.perplexity.ai/hub/legal/terms-of-service (2026-01-23) |

Rate limits in the registry are conservative defaults for each provider's entry tier. A lent key may use half of them unless the lender sets its own limits in the grant.

- **Verified:** Hashference allows 60 RPM and 4 concurrent requests per key.
- **Approximate:** the other providers' limits. OpenRouter has no platform cap on paid models, Anthropic and Gemini vary by tier, and Venice publishes per-model limits at `GET /api_keys/rate_limits`.

The following still need re-checking:

- the primary pages for OpenAI and Copilot;
- the Google APIs ToS;
- Venice's API-specific terms, and whether its per-key limits and balance API are available;
- whether NanoGPT and Together offer per-key caps and a budget API;
- the terms of xAI and Fireworks.

## Who enforces what

| What | Where |
|---|---|
| Forbidden provider, by id **or by the base URL's host** (renaming a provider doesn't help) | Board (`grantProblem` on `POST /api/grants`) and the lending page (`draftProblems` before sealing). The gateway also skips such grants. |
| Subscription tokens pasted as API keys (e.g. `sk-ant-oat…`) | Lending page, before sealing |
| Models (allow-list), the maker's model policy, preferred-model order | Gateway |
| Period rules: share of budget, share of what's left (`usePctOfRemaining`), `minRemainingPct`, the window before the reset | Gateway (`grant-policy.ts`). "What's left" rules only apply where the provider reports it: OpenRouter `/key`, and the Hashference workspace balance. |
| `maxPerCallUsd` and the remaining allowance | Gateway: lowers `max_tokens` so the worst case fits, or skips the key |
| RPM/TPM token buckets, requests per day, concurrency | Gateway (`lent-limits.ts`), per key. A key without room is skipped, never waited on. |
| 429 / 5xx | Gateway honours `Retry-After` / `retry-after-ms`, with exponential backoff (10 s up to 15 min) on top. 402 rests the key 30 min. |
| 401, or a 403 that isn't about content | Gateway stops the key for good. It sends a gremlin-signed `grant-status` to `POST /api/grants/status`, and the lending page shows "stopped" with the reason. |
| End-user id (`user` on OpenRouter, `safety_identifier` on OpenAI) and attribution headers | Gateway, on lent calls only. The id is an anonymous hash, not the gremlin's address. |
| Wishes (purposes, "don't use it for", credit) and provider obligations (e.g. AI disclosure) | Not deterministic. The gateway sends them to the model as a delimited system note (`<<<LENDER_WISHES … LENDER_WISHES>>>`, marked untrusted) on lent-key calls only. They are also listed in the `lent_keys` tool and the gremlin's standing instructions. |

## Grant schema changes (`KeyGrant`)

- `provider.id`: the registry id. `budgetApi` may also be `hashference`.
- `policy.rules[]`: each rule has exactly one of `usePctOfBudget` or `usePctOfRemaining`.
- `policy.limits?`: `{ rpm, tpm, rpd, concurrency }`.
- `wishes?`: `{ purposes[] (goals or "anything"), forbidden (≤ 1000 chars), preferredModels[] (subset of models), creditAs (≤ 80) }`. Wishes are part of the signed message, so changing them means a new grant.
- New message `GrantStatus`: `{ kind: 'grant-status', address: gremlin, grantId, status: 'disabled', httpStatus, reason, createdAt }`, signed by the gremlin.
- Board: the `grants.status` column (migrated on start). `GET /api/grants` returns `status` and `statusDetail`.
