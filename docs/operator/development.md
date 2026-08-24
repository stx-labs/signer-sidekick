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
[PoX-5 Testnet](../../.env.pox5-testnet.example) examples. Custom Devnet or regtest profiles require
`SIDEKICK_NETWORK_ID`. Never place a signer or admin key, mnemonic, or production credential in the
repository, fixtures, commands, screenshots, or support bundles.

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

The engine defaults to Observe. Operator-run uses a Sidekick-generated, disposable gas wallet and
one sealed recipe per run; it has no generic signing path. Use only isolated, low-balance test
accounts outside mainnet.

Implementation boundaries:

- reviewed adapters and exact transaction vectors live in
  `packages/protocol/src/reward-operation-plan.ts`;
- recipes, run state, signing, submission, observation, and recovery live under
  `apps/sidekick/src/transaction-engine`;
- strict browser-facing schemas live in `packages/api-contracts`;
- gas-wallet lifecycle lives in Settings; reward-run approval and recovery live in Rewards and
  Activity.

Run the full checks before changing an adapter or authority boundary. A focused backend pass is also
useful while iterating:

```sh
pnpm --filter @stx-labs/signer-sidekick test src/transaction-engine
pnpm --filter @stx-labs/signer-sidekick-api-contracts test
pnpm --filter @stx-labs/signer-sidekick-dashboard test
```

For restart or ambiguity tests, preserve the database, WAL, gas-wallet key, and transaction ID
across the simulated crash. Deleting state between nonce reservation and reconciliation invalidates
the test. The [engine contract](../architecture/transaction-engine.md) is normative.

Pull requests that touch the operator-run signing path are reviewed against
[`security/operator-run-mainnet-review.md`](../../security/operator-run-mainnet-review.md).

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
