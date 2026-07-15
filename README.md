# Signer Sidekick

Signer Sidekick is an open-source operations suite for Stacks PoX-5 signer and STX pool
operators. It is designed to attach to an existing compatible signer-manager deployment or
guide a fresh operator through setup, then monitor and automate the pool lifecycle without
holding the signer or manager-admin keys.

The repository now contains the activation/setup path, the read-only v1 control plane, and a
self-contained Epoch 4.0 lifecycle harness for the protocol foundation. Permissionless
transaction automation and production-profile approval are still gated, so it is not yet ready
for unattended mainnet operation.

## Start here

- [v1 product and architecture plan](docs/product/v1-plan.md)
- [questions for protocol, API, signer, design, and security reviewers](docs/reviews/team-questions.md)
- [initial independent plan review](docs/reviews/initial-spec-review.md)
- [round 2 review and product-owner disposition](docs/reviews/round2-disposition.md)
- [development setup](docs/operator/development.md)
- [scale and longitudinal data design](docs/architecture/scaling.md)
- [upstream source provenance](contracts/PROVENANCE.md)
- [SQLite persistence decision](docs/architecture/decisions/0005-sqlite-persistence.md)

## Current scaffold

- `apps/sidekick`: local API, reconciliation service, CLI, and static dashboard host
- `apps/dashboard`: React operator interface using the vendored Stacks design system
- `packages/protocol`: versioned PoX-5 and signer-manager profiles, types, and artifact generator
- `packages/core`: protocol-independent domain and reconciliation boundaries
- `contracts`: pinned upstream sources and reproducibly generated manager artifacts
- `test/integration/regtest`: self-contained Epoch 4.0 contract lifecycle plus optional live-node smoke test

## Development

Use Node.js 24.18.0 and pnpm 10.32.1.

```sh
pnpm install
pnpm protocol:verify
pnpm check
pnpm test
pnpm test:regtest
pnpm build
```

See [the development guide](docs/operator/development.md) for the upstream refresh and
regtest workflows. See [the container deployment guide](docs/operator/deployment.md) for the
loopback-only Compose profile, upgrade, online backup, and offline restore procedure.

### Activation CLI

Connected commands require `STACKS_NODE_RPC_URL`. Mainnet and testnet default to the matching
Hiro API; `STACKS_API_URL`, `STACKS_API_KEY`, and `STACKS_API_KEY_HEADER` can point Sidekick at
another hosted or self-managed API.

```sh
pnpm --filter @stx-labs/signer-sidekick build

pnpm --filter @stx-labs/signer-sidekick cli config validate
pnpm --filter @stx-labs/signer-sidekick cli doctor
pnpm --filter @stx-labs/signer-sidekick cli database backup backups/sidekick.sqlite
pnpm --filter @stx-labs/signer-sidekick cli preflight
pnpm --filter @stx-labs/signer-sidekick cli \
  init fresh <admin-principal> <contract-name> <output-directory> <auth-id>
pnpm --filter @stx-labs/signer-sidekick cli init attach <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli setup status <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli \
  pool enrollment-info <manager-principal> docs/examples/pool-enrollment-config.example.json
pnpm --filter @stx-labs/signer-sidekick cli pool sync-stakers <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli events sync <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli pool status <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli rewards status <manager-principal> [reward-cycle]
pnpm --filter @stx-labs/signer-sidekick cli \
  setup record <manager-principal> \
  docs/examples/pool-enrollment-config.example.json \
  docs/examples/operator-record-metadata.example.json
pnpm --filter @stx-labs/signer-sidekick cli \
  export support-bundle <manager-principal> \
  docs/examples/pool-enrollment-config.example.json \
  docs/examples/operator-record-metadata.example.json
```

### Local operator dashboard

Build the workspace, then run the loopback-only API and embedded dashboard with one manager and a high-entropy local credential:

```sh
pnpm build

SIDEKICK_NETWORK=mainnet \
STACKS_NODE_RPC_URL=http://127.0.0.1:20443 \
SIDEKICK_MANAGER_PRINCIPAL=SP1234OFFLINEADMIN.my-signer-manager \
SIDEKICK_AUTH_TOKEN='replace-with-at-least-24-random-characters' \
pnpm --filter @stx-labs/signer-sidekick start
```

Open `http://127.0.0.1:3998`, enter the configured credential, and run **Reconcile now**. The app stays loopback-bound by default. It exposes authenticated operator APIs, `/health/live`, `/health/ready`, and `/metrics`; it deliberately has no public pool route. The Public Pool Page screen generates a live or static artifact for the operator to host elsewhere.

The enrollment command writes a versioned public JSON document to standard output. Its fee is
explicitly operator-supplied, and its registration, grant, cycle, threshold, and signer-set fields
come from the connected node. It does not collect staker inputs or connect, sign, or broadcast for
a wallet.

The signer-staker sync uses the configured API only to discover the manager's paginated roster.
It verifies every STX entry against the connected node's PoX-5 `get-staker-info` result before
storing a position, then reads `get-signer-cycle-membership` for the exact amount and signer in
each active cycle. Page checkpoints are durable and scoped to the API provider, so an interrupted
scan resumes without prematurely removing unseen members. API-discovery and node-verification
provenance are stored separately.

Manager contract-log ingestion is independently resumable, enriches events with canonical block identity, decodes Clarity hex structurally, and overlaps completed scans so displaced events are marked non-canonical after a reorg. The reward and withdrawal screens derive claim, pending, settled, and reclaimed histories from that evidence.

Large operator collections are independently paginated. The dashboard status response carries
totals rather than the full roster/ledger, while explicit authenticated CSV and JSON downloads
remain available. Current projections are paired with append-only staker-position observations,
per-cycle pool snapshots, and a normalized manager-activity ledger so dozens of historical cycles
do not depend on a bounded in-memory event reduction. See the
[scale design](docs/architecture/scaling.md) for tested fixtures and concurrency bounds.

`SIDEKICK_FORECAST_HORIZON_CYCLES` controls how many cycles are reconciled and defaults to six.
The forecast keeps enumerated STX-only membership, contract pending STX, eligible STX reward
shares, and total delegated signer weight as separate values so bond weight or a roster mismatch
cannot be mistaken for STX pool principal.

The operator record metadata contains only public identifiers. Its strict schema rejects private
key fields and keeps the gas payer distinct from the manager admin. The support bundle is built
from an explicit diagnostic allowlist; it does not dump environment variables or signer-host
health and never includes the configured API key.

## License

Signer Sidekick is licensed under GPL-3.0-only. Vendored upstream files retain their own
copyright and provenance; see [contracts/PROVENANCE.md](contracts/PROVENANCE.md).
