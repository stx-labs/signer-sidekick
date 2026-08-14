# Development

## Setup

Requires Node.js 24.18.0, pnpm 10.32.1, and Docker for container or Devnet tests.

```sh
pnpm install
pnpm check
pnpm test:coverage
pnpm test:regtest
pnpm build
```

Run `pnpm --filter @stx-labs/signer-sidekick cli help` after building for the current command
surface. Configuration is defined by the [mainnet](../../.env.mainnet.example) and
[PoX-5 Testnet](../../.env.pox5-testnet.example) examples. Devnet or regtest Assist requires
`SIDEKICK_NETWORK_ID`. Never place a signer or admin private key, mnemonic, or production credential
in the repository, fixtures, commands, screenshots, or support bundles.

## Additional validation

| Command | Purpose |
| --- | --- |
| `pnpm test:e2e:dashboard` | Responsive fixture-backed browser suite |
| `pnpm protocol:verify` | Vendored source and generated-artifact hashes |
| `pnpm devnet:verify:offline` | Released-Devnet lock without network access |
| `pnpm test:regtest:external` | Read-only smoke against a supplied PoX-5 network |
| `pnpm test:container:external` | Production-container smoke against supplied endpoints |

Install Chromium once before browser tests:

```sh
pnpm exec playwright install chromium
```

The deterministic contract harness is documented in
[`test/integration/regtest`](../../test/integration/regtest/README.md).

## Transaction engine development

The transaction engine starts in Observe when no engine variables are set. This exercises live
observation, durable blockers, API mapping, and the Operations UI without loading a signer or
reaching a broadcaster. Exact plans also require the public gas-payer identity and reviewed
attestation/trust files described in the deployment guide; the private gas key remains unnecessary
in Observe.

Implementation boundaries:

- fixed transaction vectors and compatibility-attestation schemas live in `packages/protocol`;
- durable jobs, admission, signing, submission, observation, and recovery live under
  `apps/sidekick/src/transaction-engine`;
- strict browser-facing schemas live in `packages/api-contracts`;
- approvals and emergency controls live in `apps/dashboard/src/features/operations`.

Run the full checks before changing an adapter or authority boundary. A focused backend pass is also
useful while iterating:

```sh
pnpm --filter @stx-labs/signer-sidekick test src/transaction-engine
pnpm --filter @stx-labs/signer-sidekick-api-contracts test
pnpm --filter @stx-labs/signer-sidekick-dashboard test
```

Assist is unreleased. Any isolated test-network work uses a disposable, dedicated, low-balance gas
payer and follows the [safety contract](../architecture/transaction-engine.md) and
[release gates](https://github.com/stx-labs/signer-sidekick/issues/6). Keep raw keys outside the
repository, fixtures, command line, environment, screenshots, and logs; pass only an absolute
read-only file path and matching public identity. Use reviewed attestation/trust files rather than
weakening verification for development.

Use a dedicated database for emergency-control tests because Force Observe and adapter disable are
one-way for that database. For restart or ambiguity tests, preserve the same database, WAL, mounted
secret, and precomputed txid across the simulated crash. Deleting state between nonce reservation
and reconciliation invalidates the recovery test.

## Released Devnet

The released-binary harness runs Bitcoin regtest, stacks-node, stacks-signer, Stacks API,
PostgreSQL, Sidekick, and browser scenarios. It is isolated from operator credentials.

```sh
pnpm e2e:devnet:doctor
pnpm e2e:devnet:up
pnpm e2e:devnet:scenario active-pool
pnpm e2e:devnet:status
pnpm e2e:devnet:down

# Disposable full acceptance run
pnpm e2e:devnet:test
```

`up` reports its bootstrap phase. It waits for the local chain to activate PoX-5 before it starts
Sidekick; use `status` to follow that phase rather than starting a second run. Only one harness can
use the fixed local ports at a time. Use `pnpm e2e:devnet:reset` after an interrupted run. The
`active-pool` scenario also routes a real stacks-node callback through Sidekick, requires its
canonical block anchor to become node-verified, and waits for the affected current-state and
manager-activity projections to reconcile. The harness enables Core's transaction index on the
released node before the scenario because local transaction inclusion is the independent witness
for indexed manager events. The version locks under `test/e2e/devnet` define the released artifacts.

## Local dashboard

Terminal 1:

```sh
SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
SIDEKICK_MANAGER_PRINCIPAL=SP_REPLACE.manager \
SIDEKICK_AUTH_TOKEN=replace-with-at-least-24-random-characters \
pnpm --filter @stx-labs/signer-sidekick dev
```

Terminal 2:

```sh
pnpm --filter @stx-labs/signer-sidekick-dashboard dev
```

Open `http://127.0.0.1:5173`. The Vite server proxies operator API requests to port 3998. UI work
must follow [the local design contract](../../design/README.md).

## Upstream contracts

Pinned sources and hashes are recorded in [contract provenance](../../contracts/PROVENANCE.md).

```sh
pnpm protocol:vendor
pnpm protocol:verify
```

Do not replace a pinned source in place. A source, tag, commit, principal, or expected-hash change
requires explicit provenance and profile review.
