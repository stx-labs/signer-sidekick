# Development setup

## Requirements

- Node.js 24.18.0
- pnpm 10.32.1
- Git
- Docker only when exercising the optional external node/API environment

The repository deliberately pins the current LTS runtime instead of using whichever Node.js
release happens to be installed globally.

## Install and validate

```sh
pnpm install
pnpm protocol:verify
pnpm check
pnpm test:coverage
pnpm test:e2e:dashboard
pnpm build
```

Install the Playwright Chromium runtime once before running the browser suite:

```sh
pnpm exec playwright install chromium
```

The coverage lane enforces the current backend/protocol floor and emits LCOV plus JSON summaries.
The browser lane uses generated large-pool fixtures at 1440px, 768px, and 390px; it does not need
Docker or a running Sidekick backend.

## Upstream contract sources

The committed PoX-5 sources retain both the stacks-core 4.0.0 protocol-test baseline and the 4.0.1
launch release. The unchanged reference-manager source remains pinned to 4.0.0. To re-fetch the
files from their canonical URLs and verify their hashes:

```sh
pnpm protocol:vendor
pnpm protocol:verify
```

Changing a tag, commit, URL, expected hash, or contract principal requires a new protocol
profile and an architecture review. Do not update a pinned source in place. A compatible,
operator-provided network profile can be installed independently of the Sidekick application release;
stacks-node version strings are recorded for evidence rather than hardcoded as an allowlist.

## Generate the mainnet manager artifact

```sh
pnpm protocol:generate:mainnet
```

The generator verifies the upstream source hash, replaces exactly the expected principal
occurrences, rejects any remaining upstream placeholders, and writes source/output hashes to
the adjacent metadata file. The generated artifact is not approved for production deployment
until the manager authors independently confirm all production principals.

## Self-contained Epoch 4.0 lifecycle harness

The default regtest suite runs in Clarinet's in-memory Epoch 4.0 environment. It loads the pinned
PoX-5 boot source, renders the manager and its sBTC principals from committed profiles, and deploys
the exact sBTC withdrawal dependency beside Clarinet's canonical testnet token and registry. It
does not require Docker, Bitcoin Core, a Stacks node, a signer process, an API, network access, or
private operator keys after dependencies are installed.

```sh
pnpm protocol:generate:regtest
pnpm protocol:verify
pnpm test:regtest
```

The suite proves rendered-principal alignment and executes every §15.2 contract path: grant and
registration, stake/update/unstake, signer-threshold crossings in both directions, both half-cycle
calculations, permissionless duplicate races, manager claims and insert-only fee snapshots, direct
sBTC and above/below-fee L1 payouts, accepted settlement, rejected reclaim, prepare-phase
rejections, and revoked-grant rejection. It also asserts representative print-event payloads
against the actual Clarity 6 PoX-5 and manager sources.
The deterministic development mnemonics under `test/integration/regtest/settings/` are public test
fixtures and must never be used on any live network.

## Released PoX-5 Devnet and interactive workbench

The opt-in Devnet harness is the integration ceiling above the in-memory lifecycle tests. It
starts digest-pinned Bitcoin regtest, Stacks 4.0.0 node and real signer, API v9, Postgres, and the
hardened production Sidekick image. It then deploys the exact generated manager artifact, consumes
the public JSON produced by the released signer command, registers the manager, creates and changes
STX-only positions, crosses a reward-cycle boundary, and proves reconciliation replay, clean attach,
restart recovery, pagination, browser navigation, API/node outages, rate limiting, and indexer lag.
It also deploys an independently rendered manager with alternate Devnet sBTC principals, proves it
starts as `Not recognized — read-only`, installs a generated profile, restarts an isolated
production container, and exercises the same provenance/automation gate as built-ins.

Recommended capacity is 4 CPU cores, 16 GB RAM, 25 GB free disk, and Docker with Compose support.
The fixture-backed browser and ordinary test lanes remain suitable for smaller machines. First run
time is dominated by downloading roughly 5–10 GB of pinned container layers and building Sidekick;
later runs reuse the Docker cache.

```sh
pnpm e2e:devnet:doctor
pnpm e2e:devnet:up
pnpm e2e:devnet:status
pnpm e2e:devnet:scenario active-pool
pnpm e2e:devnet:scenario trusted-manager-profile
pnpm e2e:devnet:scenario failure-injection
pnpm e2e:devnet:mine 1
pnpm e2e:devnet:down
```

`up` leaves a loopback dashboard at `http://127.0.0.1:3998` so an operator can click through the
same instance the scenarios use. Runtime credentials are stored mode `0600` under the ignored
`test/e2e/devnet/.runtime/` directory. Use `pnpm e2e:devnet:reset` for a clean workbench.
The automated scenarios wait for the normal burn cadence. Use `e2e:devnet:mine` only for
interactive exploration; rapidly mining through a prepare phase can outrun the signer and produce
an invalid PoX anchor that would not represent normal network operation.

The Devnet manager profile is intentionally marked `productionApproved` only for the isolated
Devnet network so this harness exercises Sidekick's real automation-compatibility gate. Mainnet and
regtest remain unapproved. The node/API failure proxies listen on all host interfaces because
Docker Desktop and Linux `host-gateway` containers cannot portably reach a host-loopback listener;
their control endpoint remains loopback-only. Run this public-fixture harness only on a trusted
developer machine or firewall ports `13999` and `21443` while it is active.

The one-command validation lane is disposable and writes a versioned `result.json`, scrubbed
per-component logs, sampled per-container CPU/memory/disk-I/O peaks, JUnit output, and Playwright
failure evidence under ignored `test/e2e/devnet/artifacts/` and report directories:

```sh
pnpm e2e:devnet:test
pnpm e2e:devnet:test -- --keep-on-failure
```

Every released-binary run starts from genesis. Clarinet 3.21.1's embedded snapshot was produced
with stacks-core 3.4 and cannot safely seed the pinned stacks-core 4.0 environment; using a clean
chain also prevents cached state from concealing protocol-deployment drift. The weekly scheduled
CI lane and manual workbench therefore exercise the same trustworthy startup path. The machine-readable
`test/e2e/devnet/versions.lock.json` pins Clarinet archives, source commits, manager hashes, and
container image digests. `pnpm devnet:verify` re-resolves remote digests; pull-request CI uses the
offline verifier to remain deterministic.

All accounts, mnemonics, and keys in this harness are public isolated-network fixtures. They never
enter the Sidekick environment, database, browser API, or retained evidence. Do not reuse them on
testnet, mainnet, or any network holding value.

## External regtest/devnet smoke harness

The optional smoke test still connects the production clients to an already-running Epoch 4.0
regtest/devnet with a fully indexed Stacks API:

```sh
RUN_REGTEST=1 \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
STACKS_API_URL=http://127.0.0.1:3999 \
pnpm test:regtest:external
```

The smoke test runs the production preflight clients and evaluator. It requires matching node/API
network identities, a ready Stacks API v9 or newer, and PoX-5 availability. API lag may produce a
warning up to the configured policy boundary; a failed preflight fails the test. A first run
against a released stacks-node/signer/API environment remains a Phase 1 exit gate, not a local
development prerequisite.

For a private network with a custom network ID and deployed manager, include both optional
identifiers. This adds read-only manager interface, registration, and signer-grant checks:

```sh
SIDEKICK_NETWORK=testnet \
SIDEKICK_NETWORK_ID=256 \
STACKS_NODE_RPC_URL=https://api.private.example \
STACKS_API_URL=https://api.private.example \
SIDEKICK_MANAGER_PRINCIPAL=ST123EXAMPLE.signer-manager \
pnpm test:regtest:external
```

## Production container smoke test

`test:container:external` builds the production image by default, creates a disposable database
volume, and exercises the packaged CLI twice against a live node/API. It validates preflight,
attach, setup, staker and event synchronization, forecast and reward reads, support-bundle
redaction, online backup, the embedded dashboard, bearer authentication, readiness, metrics, and
`POST /api/v1/sync`. The runner uses the same read-only filesystem, dropped capabilities, and
non-root user as the deployment image. It never requests a signer or manager-admin key and removes
its container and volume on completion.

```sh
SIDEKICK_NETWORK=testnet \
SIDEKICK_NETWORK_ID=256 \
STACKS_NODE_RPC_URL=https://api.private.example \
STACKS_API_URL=https://api.private.example \
SIDEKICK_MANAGER_PRINCIPAL=ST123EXAMPLE.signer-manager \
SIDEKICK_SMOKE_EXPECT_MIN_STAKERS=1 \
pnpm test:container:external
```

Set `SIDEKICK_SMOKE_BUILD=0` and `SIDEKICK_SMOKE_IMAGE=signer-sidekick:local` to reuse an existing
image. API credentials, when needed, are inherited from `STACKS_API_KEY` and
`STACKS_API_KEY_HEADER`; the smoke runner asserts that the API key does not appear in its support
bundle. To exercise an installed profile through the production container, set
`SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR` to the host directory containing its JSON; the runner
bind-mounts that directory read-only and uses the corresponding container path.

## Operator preflight

The preflight command is safe to run against an existing setup. It performs read-only requests to
the configured node and API, checks their network identity and indexed tips, and reports PoX-5
availability. It does not require a signer key or manager-admin key.

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick build

SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick preflight
```

Mainnet and testnet default to the corresponding Hiro API. Set `STACKS_API_URL` to use a
self-hosted API. If that API requires authentication, set `STACKS_API_KEY` and optionally
`STACKS_API_KEY_HEADER` (default: `x-api-key`). Secrets are sent only in the configured header and
are redacted from command output. `SIDEKICK_MAX_API_BURN_BLOCK_LAG` controls the warning threshold
and defaults to 12 blocks.

The JSON result includes current and next reward-cycle IDs, threshold and stacked amounts in
uSTX, and authoritative prepare/reward phase burn heights and countdowns from `/v2/pox`. Amounts
are accepted only while they remain within JavaScript's safe-integer boundary, then emitted as
decimal strings so downstream consumers do not lose integer precision. An out-of-range upstream
value fails closed instead of being rounded.

Reward status reads the manager's current `fees-bips` data variable and the underlying
`fee-bips-for-cycle` map directly from the configured node. This preserves the distinction between
an absent effective fee snapshot and an explicit zero-bips snapshot; no private key or proof is
required.

## Local dashboard development

The dashboard follows `design/HANDOFF.md` and the static references under `design/screens/`. Run the backend on port 3998 and Vite on port 5173; Vite proxies API, health, and metrics requests to the backend.

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
SIDEKICK_MANAGER_PRINCIPAL=SP1234OFFLINEADMIN.my-signer-manager \
SIDEKICK_AUTH_TOKEN='replace-with-at-least-24-random-characters' \
pnpm --filter @stx-labs/signer-sidekick dev

pnpm --filter @stx-labs/signer-sidekick-dashboard dev
```

The credential is held in browser `sessionStorage`, sent only as a bearer credential to the loopback API, and cleared when the API rejects it. Production builds embed `apps/dashboard/dist` in the Fastify process. Use the supplied light/dark theme control and verify critical screens at 1440px, 768px, and 375px.

The Phase 3 operator APIs are bearer-authenticated and intentionally have no public equivalents:

- `GET|PUT /api/v1/settings` reads or replaces validated runtime settings. Candidate node/API/key
  changes must pass connected preflight before the old revision is replaced. API-key values are
  write-only and responses expose only configured/source metadata.
- `/api/v1/onboarding/*` starts or resumes Attach Existing/Fresh Setup, verifies externally
  completed operations, and downloads generated manager artifacts.
- `POST /api/v1/pool-card/generate` returns static or live HTML plus versioned JSON for the operator
  to host elsewhere.

To test against a live node, set `SIDEKICK_MANAGER_PRINCIPAL` to the already deployed manager for
Attach Existing. For Fresh Setup, set it to the future `ADMIN.contract-name` before starting
Sidekick; the wizard requires the entered admin and contract name to match that identity. Use only
a public signer-grant JSON result from the released signer command. Never place signer or
manager-admin key material in the environment, UI, fixtures, or support bundle.

## Attach an existing manager

Build the backend, then supply the deployed manager contract principal:

```sh
pnpm --filter @stx-labs/signer-sidekick build

SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick attach -- \
  SP1234EXAMPLE.manager-contract
```

Attach is read-only. It runs the full operator preflight, fetches the deployed source and contract
interface from the configured node, and returns exact and canonical source hashes, profile
recognition, ABI compatibility, publish height, and the allowed operating mode. A recognized
manager is not automatically placed in automation mode. New attachments always begin in Observe
mode, and the current mainnet profile remains ineligible for automation until its review flag is
approved. Once PoX-5 is active, attach also verifies `get-signer-info` and
`verify-signer-key-grant` directly through the node and reports missing registration separately
from a registered manager whose grant has been revoked.

An unknown source may attach in Observe mode only when it is on the configured network and exposes
the complete manager interface. ABI similarity never enables automation. A wrong-network principal
or incomplete manager interface is rejected. Sidekick does not redeploy, replace, sign for, or call
the manager during attach.

## Render a fresh manager deployment

Rendering reads the pinned upstream source, applies the reviewed network substitutions, verifies
both exact and canonical hashes against the immutable registry, and writes a Clarity 6 source file
plus a deployment manifest. The output directory is explicit and existing files are never
overwritten.

```sh
pnpm --filter @stx-labs/signer-sidekick build

SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick cli -- \
  manager render \
  SP1234OFFLINEADMIN \
  my-signer-manager \
  ./manager-deployment
```

Manager rendering first runs connected preflight. Public mainnet or testnet rendering requires a
matched network-compatibility profile and refuses a failed or inconsistent network. The manifest
contains the expected manager principal, source hashes, substituted PoX-5 and sBTC principals,
Clarity version, and external-signing instructions. It never asks for or stores an admin key. Every
artifact is marked `operatorReviewRequired`; Sidekick neither approves nor submits the deployment.
Stacks core's own PoX-5 test configuration declares both PoX-5 and the reference signer manager as
[Clarity 6 contracts in Epoch 4.0](https://github.com/stacks-network/stacks-core/blob/4.0.0/contrib/core-contract-tests/Clarinet.toml#L63-L76).

## Signer grant ceremony

After the manager is deployed and PoX-5 is active, generate a unique uint128 `auth-id` and prepare
the signer-host command:

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick cli -- \
  signer-grant prepare \
  SP1234OFFLINEADMIN.my-signer-manager \
  1700000001 \
  /etc/stacks/signer.toml
```

Run only the returned `stacks-signer generate-staking-signature ... --json` command on the signer
host, save its stdout as JSON, and transfer that non-secret result back to the Sidekick machine.
The released Stacks 4.0.0 implementation emits exactly `signerKey`, `signerSignature`, `authId`,
and `signerManager`; see the pinned
[`handle_generate_staking_signature`](https://github.com/stacks-network/stacks-core/blob/4.0.0/stacks-signer/src/main.rs#L124-L162)
implementation.

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
pnpm --filter @stx-labs/signer-sidekick cli -- \
  signer-grant verify \
  SP1234OFFLINEADMIN.my-signer-manager \
  1700000001 \
  ./signer-grant.json
```

Verification is strict: manager and auth ID must match the ceremony; the JSON schema, compressed
33-byte key, 65-byte RSV signature, and recovery ID must be valid; the message hash is fetched
independently from PoX-5's `get-signer-grant-message-hash`; and the ECDSA signature and recovered
key must both match. Only then does Sidekick emit the four encoded `register-self` arguments. The
result remains an external-offline-admin instruction: Sidekick does not sign or broadcast it.
