# Email compatibility test

Goal: decide which email setup gremlins use by testing whether candidate
inboxes (a) can be created without a human, (b) are accepted by the services a
gremlin needs, and (c) deliver mail to human inboxes rather than spam.

## Candidate inboxes

| ID | Inbox | How it's created | Cost |
|----|-------|------------------|------|
| A1 | Atomic Mail `@atomicmail.ai` | scrypt proof-of-work, API (JMAP) | free (alpha) |
| A2 | Atomic Mail + gremlin-owned custom domain | as A1, plus domain DNS | domain cost |
| L1 | LNemail `@lnemail.net` | API call + Lightning invoice | 1000 sats/yr, ~100 sats/send |
| M1 | AgentMail `@agentmail.to` | API, x402 USDC (Base/Polygon/Solana) | $2/inbox |
| M2 | AgentMail + custom domain | as M1, plus domain DNS | $2 + domain |
| C0 | Control: a normal Gmail address | manual | free |

Custom domain for A2/M2: bought with crypto (Njalla or Unhuman Domains), with SPF, DKIM and DMARC configured.

## Phase 1 — passive checks (no accounts) — DONE 2026-09-28

Disposable-domain blocklists checked (disposable-email-domains, wesbos,
fakefilter, ivolo, mailchecker): **none of atomicmail.ai, lnemail.net,
agentmail.to are listed.**

DNS authentication:

| Domain | MX | SPF | DMARC | DKIM |
|--------|----|-----|-------|------|
| atomicmail.ai | mx1.atomicmail.ai (89.127.218.190) | `ip4:… ~all` | `p=reject` | selector not found by guessing |
| lnemail.net | mail.lnemail.net (62.76.229.11) | `mx -all` | `p=quarantine` | `mail._domainkey` present |
| agentmail.to | Amazon SES inbound | none at apex (likely SES MAIL FROM subdomain) | `p=reject` | not checked |

IP blacklists: both MX IPs are clean on SpamCop, Barracuda, SORBS and PSBL.
Spamhaus returned 127.255.255.254, which means it refused a query from a public
resolver, not that the IP is listed. Re-check via MXToolbox or our own resolver.

Caveat: a domain can be clean on public lists and still be blocked by a
service's private list, so Phase 3 is the real test.

## Phase 2 — signup requirements matrix (research, no accounts)

For each target service, record: whether it needs email at all, email
verification, CAPTCHA type, phone/SMS, KYC thresholds, disposable-domain
policy, ToS on automated accounts, API signup, payment methods.
Results → `matrix.md`.

## Phase 3 — live signup tests (needs approval + small funds)

For each (inbox × service that needs email):

1. Attempt signup with the inbox.
2. Record: accepted / rejected at form / rejected after verification /
   CAPTCHA required / phone required / KYC required / account later banned.
3. Confirm the verification email arrived (latency, spam folder or not).
4. Log to `results.csv`: `date,inbox_id,service,step,outcome,notes`.

Run the whole test from one clean IP (a gremlin-like VPS), not a residential IP,
because services score signup IPs too.

Services to test (Phase 2 done, see `matrix.md`; only those needing email):
bithost, BitLaunch, Privex, Njalla, DarkVPS, OpenRouter, MiningRigRentals.
Dropped: NiceHash (mandatory KYC), Vast.ai (ToS bans automated signup),
Zebec (appears offline). Many core services need no email at all.

Extra test: AgentMail agent self-signup. Is it receive-only without a human
email, and does paying via x402 lift that restriction?

## Phase 4 — deliverability

From each inbox, send one plain, personal-style message to seed accounts at
Gmail, Outlook and Yahoo (and one Proton), and record where it lands:
inbox, promotions or spam. Repeat after a week of low-volume use to see warm-up.

## Decision criteria

Pick the default inbox with the highest acceptance across required services
that can be created with no human. Prefer a setup that works without a custom
domain, but adopt custom domains if they materially improve acceptance or
deliverability.

## Needed from the team before Phase 3

- Approval to create real test accounts on the listed services.
- Small funds: ~5,000 sats Lightning (LNemail), ~$10 USDC on Base (AgentMail),
  ~$15 for a test domain.
- A test VPS to run signups from.
- Someone to handle CAPTCHAs during the test. Whether a CAPTCHA appears is
  itself a result.
