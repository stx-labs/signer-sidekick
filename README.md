# Signer Sidekick

Signer Sidekick is an open-source operations suite for Stacks PoX-5 signer and STX pool
operators. It is designed to attach to an existing compatible signer-manager deployment or
guide a fresh operator through setup, then monitor and automate the pool lifecycle without
holding the signer or manager-admin keys.

This repository is in the protocol-foundation phase. It is not ready for mainnet operation.

## Start here

- [v1 product and architecture plan](docs/product/v1-plan.md)
- [questions for protocol, API, signer, design, and security reviewers](docs/reviews/team-questions.md)
- [initial independent plan review](docs/reviews/initial-spec-review.md)
- [round 2 review and product-owner disposition](docs/reviews/round2-disposition.md)
- [development setup](docs/operator/development.md)
- [upstream source provenance](contracts/PROVENANCE.md)

## Current scaffold

- `apps/sidekick`: local API, worker, scheduler, and CLI process
- `apps/dashboard`: React operator interface using the vendored Stacks design system
- `packages/protocol`: versioned PoX-5 and signer-manager profiles, types, and artifact generator
- `packages/core`: protocol-independent domain and reconciliation boundaries
- `contracts`: pinned upstream sources and reproducibly generated manager artifacts
- `test/integration/regtest`: externally provisioned Epoch 4.0 regtest/devnet smoke harness

## Development

Use Node.js 24.18.0 and pnpm 10.32.1.

```sh
pnpm install
pnpm protocol:verify
pnpm check
pnpm test
pnpm build
```

See [the development guide](docs/operator/development.md) for the upstream refresh and
regtest workflows.

### Activation CLI

Connected commands require `STACKS_NODE_RPC_URL`. Mainnet and testnet default to the matching
Hiro API; `STACKS_API_URL`, `STACKS_API_KEY`, and `STACKS_API_KEY_HEADER` can point Sidekick at
another hosted or self-managed API.

```sh
pnpm --filter @stx-labs/signer-sidekick build

pnpm --filter @stx-labs/signer-sidekick cli config validate
pnpm --filter @stx-labs/signer-sidekick cli preflight
pnpm --filter @stx-labs/signer-sidekick cli \
  init fresh <admin-principal> <contract-name> <output-directory> <auth-id>
pnpm --filter @stx-labs/signer-sidekick cli init attach <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli setup status <manager-principal>
pnpm --filter @stx-labs/signer-sidekick cli \
  pool enrollment-info <manager-principal> docs/examples/pool-enrollment-config.example.json
pnpm --filter @stx-labs/signer-sidekick cli \
  setup record <manager-principal> \
  docs/examples/pool-enrollment-config.example.json \
  docs/examples/operator-record-metadata.example.json
pnpm --filter @stx-labs/signer-sidekick cli \
  export support-bundle <manager-principal> \
  docs/examples/pool-enrollment-config.example.json \
  docs/examples/operator-record-metadata.example.json
```

The enrollment command writes a versioned public JSON document to standard output. Its fee is
explicitly operator-supplied, and its registration, grant, cycle, threshold, and signer-set fields
come from the connected node. It does not collect staker inputs or connect, sign, or broadcast for
a wallet.

The operator record metadata contains only public identifiers. Its strict schema rejects private
key fields and keeps the gas payer distinct from the manager admin. The support bundle is built
from an explicit diagnostic allowlist; it does not dump environment variables or signer-host
health and never includes the configured API key.

## License

Signer Sidekick is licensed under GPL-3.0-only. Vendored upstream files retain their own
copyright and provenance; see [contracts/PROVENANCE.md](contracts/PROVENANCE.md).
