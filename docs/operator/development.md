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
pnpm test
pnpm build
```

## Upstream contract sources

The committed PoX-5 and signer-manager sources are pinned to stacks-core 4.0.0. To re-fetch
the files from their canonical URLs and verify their hashes:

```sh
pnpm protocol:vendor
pnpm protocol:verify
```

Changing a tag, commit, URL, expected hash, or contract principal requires a new protocol
profile and an architecture review. Do not update a pinned source in place.

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
pnpm --filter @stx-labs/signer-sidekick cli -- \
  manager render \
  SP1234OFFLINEADMIN \
  my-signer-manager \
  ./manager-deployment
```

The manifest contains the expected manager principal, source hashes, substituted PoX-5 and sBTC
principals, Clarity version, and external-signing instructions. It never asks for or stores an
admin key. The current mainnet profile is not production-approved, so the command writes a review
artifact, sets `deploymentAllowed` to `false`, emits a warning, and exits with status 3. That gate
must be changed only by reviewing and updating the pinned profile—not by a CLI override. Stacks
core's own PoX-5 test configuration declares both PoX-5 and the reference signer manager as
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
