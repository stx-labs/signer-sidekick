# Development setup

## Requirements

- Node.js 24.18.0
- pnpm 10.32.1
- Git
- Docker for the future self-contained integration environment

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

## External regtest/devnet smoke harness

The initial harness connects to an already-running Epoch 4.0 regtest/devnet. It does not yet
provision Bitcoin Core, stacks-core, the Stacks API, sBTC contracts, or a signer.

```sh
RUN_REGTEST=1 \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
STACKS_API_URL=http://127.0.0.1:3999 \
pnpm test:regtest
```

The smoke test runs the production preflight clients and evaluator. It requires matching node/API
network identities, a ready Stacks API v9 or newer, and PoX-5 availability. API lag may produce a
warning up to the configured policy boundary; a failed preflight fails the test. Self-contained
lifecycle provisioning is the next harness increment in Milestone 1.

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
are emitted as decimal strings so downstream consumers do not lose integer precision.

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
