# Two-gremlin development canary

This runbook prepares two independently hosted gremlins launched from the official website. The website creates
their identities, hosting accounts and VMs through the existing hatch flow. Their public addresses and VM hosts
can be collected afterward. Operator release configuration and dev SSH access are set before launching; a maker
address is the existing wallet connected to the website, not the new gremlin address.

## Commits and release identity

`4f6645a` checkpoints inference recovery, credential pools, provider discovery, spending reservations and documentation
monitoring. The following instrumentation commit adds metadata-only diagnostics and a signed, opt-in canary path.
Neither a local commit nor a website restart updates the pinned image used by a hosted gremlin.

The Dockerfile defaults to Gremlin Runtime commit
`14dec65a4549c8fd1484c83f0bc867dadafcdb2e`. Release builds require an explicit reviewed full SHA. Source and runtime
commits are embedded as environment metadata and OCI labels. The build must use a clean committed working tree and builds from a Git archive of that exact commit.

```sh
export HERMES_RUNTIME_REF=14dec65a4549c8fd1484c83f0bc867dadafcdb2e
scripts/build-release.sh linux/amd64 gremlins/egg:dev-cluster-$(git rev-parse --short HEAD)
node scripts/test-reliability-docker.mjs gremlins/egg:dev-cluster-$(git rev-parse --short HEAD)
```

The build makes a local image and matching `release/gremlin-linux-amd64.tgz` and checksum. The Docker fault test
uses a disposable identity, no network and no real funds. It verifies actual services, independent recovery,
container restart/recreation, retained identity/work and sanitized dev telemetry. A hosted VM reboot still needs
a real canary test. Publishing to GHCR/GitHub and updating the live site are separate operator actions.

Publish the reviewed image and bundle following [RELEASES.md](RELEASES.md). Record the registry manifest digest,
bundle SHA256, source commit and runtime commit. A local image ID is not a published manifest digest. Keep the
existing default release pins in place while enabling the candidate separately. Use an actual permanent HTTPS
board origin; old temporary tunnels cannot serve the hosted claim/handoff flow reliably.

## Website configuration and launch

Use the operator settings file already loaded by `scripts/prod-run.sh`, or pass the same variables through Compose.
Configure these public release/access values alongside the existing secret settings:

```sh
BOARD_CANARY_EGG_IMAGE='ghcr.io/dominant-strategies/gremlinz-egg@sha256:<manifest-digest>'
BOARD_CANARY_MAKERS='0x<existing-maker-wallet>'
BOARD_CANARY_DEV_SSH_KEYS='team'
BOARD_CANARY_ARTIFACT_URL='https://github.com/<owner>/<repo>/releases/download/<tag>/gremlin-linux-amd64.tgz'
BOARD_CANARY_ARTIFACT_SHA256='<bundle-sha256>'
```

The artifact pair is optional when testing Docker-only hosting. `BOARD_EGG_DEV_SSH_KEYS` is the fallback operator
key source if candidate-specific keys are unset; when both are unset, canaries use the two public keys bundled in
`packages/egg/src/dev-ssh.ts` (Karl Kreder and gameofpointers). `team` explicitly selects those keys; an explicit
public-key list replaces them. Normal launches keep SSH off unless `BOARD_EGG_DEV_SSH_KEYS` is configured; use
`team` there for normal Fluence dev launches, or `VITE_EGG_DEV_SSH_KEYS=team` for SporeStack dev launches.
The dev cloud-init installs/enables the host SSH server, authorizes both keys for `gremlinz-dev` with sudo, and
carries the selected keys into migration launch data. The operator's private SSH key stays on their machine. Store settings containing secrets as mode
0600 outside Git, as described in `deploy/board.env.example`.

`BOARD_EGG_IMAGE` and the normal frontend `VITE_EGG_IMAGE` keep the stable default. Configure their matching bundle
metadata too. With the effective build/server environment loaded, run:

```sh
node scripts/check-release.mjs
```

This is a read-only configuration check: it checks formats and agreement of declared pins, not live funding,
provider availability or the deployed server's actual environment. It does not print secret values. A canary also
needs allowlisted maker wallets, a pinned candidate image and dev monitoring keys. Restart/deploy the updated
board and frontend together; a Docker image build alone does not enable the new website route.

On the website, use `/hatch/?canary=1`, select the Fluence hatch flow, and sign with an allowlisted maker wallet.
The extra signed request selects the candidate on the server. Ordinary `/hatch/` still chooses the stable release;
a maker address in unsigned JSON cannot opt into the candidate. Canary mode is not silently downgraded to stable.
The creator's browser must retain its MPC shard and remain open through handoff, as in the existing flow.

The hatch page offers **Start over** throughout the flow, including the body editor and error screens. It saves
the current hatch before creating a new launch ID. **Saved hatches** restores previous attempts in their original
default or canary flow. Payment progress, the existing browser key share and reusable SporeStack credit are retained
in this browser; existing servers and payments continue separately. Starting over keeps `?canary=1` when selected,
and otherwise uses the site's current default launch settings. It does not change an old job's chosen image.
Switching hatches reloads the page to stop old callbacks, and other open hatch tabs pause. If browser storage is
full or unavailable, restarting fails without replacing the current hatch. Keep site data intact until paid hatches
have completed their handoff; saved hatches remain local to the browser profile.

Each new job saves its chosen image, bundle and dev public keys. Changing operator settings while that job is
funding/provisioning does not replace its release. Jobs created before this feature retain the legacy behavior;
finish or separately investigate those pending jobs before changing the global stable image. Do not change an
already funded job's channel to retry it. To disable new candidate launches, clear the candidate image, maker and
artifact settings together; existing jobs retain their persisted release and their makers can resume them.

## Development instrumentation

The runtime automatically enables instrumentation for launch data carrying dev SSH keys. Explicit
`GREMLIN_DEV_TELEMETRY=0` disables it; `=1` opts in for local tests. For hosted containers an environment override
must be passed into Docker; a host systemd environment entry alone is not a container variable.

Each service writes its own mode-0600 JSONL under `GREMLIN_HOME/dev-telemetry/`, with at most three 5 MiB files per
component. Diagnostics failures are swallowed so logging cannot stop inference, tools or payments. Process run IDs and sequence numbers prevent duplicate exports during rotation. Rotation bounds
retention, not time: collect reports regularly. This version creates no public telemetry endpoint and no external
telemetry account. Diagnostics stay on the VM until an authorized operator collects them. They are not part of the
migration payload; collect before a move if the old VM's history is needed.

Recorded fields include provider/model, request ID, response-header/full latency, input/output tokens, reported
cached/reasoning token subsets, request byte/message/tool counts, configured-price cost estimates, tool outcomes,
service starts/exits, health/resource gauges, recovery actions and documentation review counts. Prompts, tool
arguments/results, raw error text, authentication headers, private keys and arbitrary user-supplied fields are
excluded. Even export re-filters event fields. Reports omit raw financial journals and raw supervisor errors.

Request IDs link attempts within one gateway request, including fallbacks. They do not yet correlate every model
and tool call in an entire Hermes wake-up; that needs a companion Hermes integration. Cached input is already
included in input tokens, and reasoning is a subset of provider-reported output when supplied. Cost estimates use
configured token rates and are not provider invoices or cache-discount-aware billing. Missing usage/unpriced paid
attempts are explicit. Context utilization uses a 64,000-token reference; interpret it against any custom window.

## Collect after launching

Start alpha first. Once it has hatched, note its public EVM address and VM host from the website/provider. Confirm
SSH host identity through the usual operator process, then use the existing authorized dev SSH identity. No new
gremlin address is needed before the website creates it.

```sh
mkdir -p .tmp
cp docs/examples/dev-cluster.inventory.json .tmp/cluster.json
# Edit only public labels, gremlin addresses, VM SSH targets and optional expectedImage pins.
node scripts/dev-cluster-report.mjs --inventory .tmp/cluster.json --out .tmp/cluster-report.json
# Optional observation window:
node scripts/dev-cluster-report.mjs --inventory .tmp/cluster.json --since 2026-11-16T00:00:00Z
```

`expectedImage` can hold the reviewed digest-pinned image reference;
collection fails visibly on a mismatch. Collection uses fixed read-only `sudo docker exec`/`docker inspect`
commands, batch-mode SSH and normal host-key checking. It does not copy seed files, key files, complete logs or
raw tool results. A failed host is marked unavailable rather than treated as healthy. `.tmp/` is Git-ignored;
written reports are mode 0600. Data covers retained events only.

Inside a dev VM, the same report is available with:

```sh
sudo docker exec egg node /app/packages/gremlin-mcp/dist/dev/report.js
```

## Rollout and acceptance

1. Agree on each test agent's initial funds, daily inference allowance, top-up/hosting limits and provider hard
   limits. Website-generated wallets do not choose the desired test budget. Keep accounts and data directories
   separate. Health top-up limits and prepaid balances are distinct from the inference-call daily cap.
2. Launch alpha through the official canary flow. Confirm image/build identity, board pulse, claim/handoff, health
   worker, model usage and exported diagnostics. Keep a working fallback while testing recovery.
3. Exercise controlled process failure and a VM reboot on alpha. Verify automatic recovery, unchanged identity,
   work and payment journals, and no duplicate payments. Test provider failures with mocks first; perform a live
   own-account renewal only with explicit funding/credential scope. Do not revoke lenders' unrelated credentials.
4. Once alpha passes, launch beta through the same website flow and collect both reports. Observe for 24–48 hours:
   per-call median/p95 input/output/context growth, fallback rates, latency, cost estimates, actual credit/balance
   movement, tool failures, service restarts, six-hour maintenance runs and daily documentation checks.
5. Stop promotion on repeated unrecovered failures, uncertain payments, identity/state loss, unexpected spending,
   missing diagnostics, or disagreement between the intended and running image. Record evidence and repair before
   expanding. Resource-heavy optional strategies such as mining should be accounted for in CPU/runway readings.
6. Promote only after review of the measurements and a successful real-host reboot test. Roll back a website
   default by restoring the previous pins. For VM rollback, stop writers and retain both persistent state mounts;
   never replace a gremlin's state with fixtures or discard unresolved payment journals. Existing candidate jobs
   keep their pinned release, even after the candidate setting is disabled.

This commit prepares the implementation and local tools. A release publication, live site update, funded launch
and live provider renewal are separate recorded milestones, not implied by a passing local test suite.
