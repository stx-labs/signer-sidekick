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

## License

Signer Sidekick is licensed under GPL-3.0-only. Vendored upstream files retain their own
copyright and provenance; see [contracts/PROVENANCE.md](contracts/PROVENANCE.md).
