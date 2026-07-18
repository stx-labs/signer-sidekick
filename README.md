# Signer Sidekick

Signer Sidekick is a self-hosted control plane for Stacks PoX-5 signer and STX pool operators. It
attaches to an existing signer-manager or guides a new deployment, then reconciles registration,
pool membership, rewards, and withdrawals from the operator's node and Stacks API.

V1 supports setup, read-only operations, and a durable transaction engine for one
fixed reference-manager reward claim. Deployments default to Observe; Assist remains a controlled,
approval-gated validation capability and is not ready for unattended mainnet use. See the
[transaction-engine rollout gates](docs/product/transaction-engine-v1.md#rollout-gates).

## Documentation

Start with [the documentation index](docs/README.md). Node and signer installation remain separate
upstream responsibilities.

## Scope

- One network, signer-manager, and STX-only pool per deployment.
- Existing and fresh manager workflows.
- Hiro or self-hosted Stacks API endpoints.
- No custody of signer or manager-admin private keys.
- No end-user wallet connection or stake submission.
- Direct node/signer health endpoints are supported; host resource and log monitoring remain out of
  scope.
- No sBTC bond pooling in V1.

Unknown but interface-compatible managers can be observed. Only reproduced reference-manager
source is eligible for the fixed code-backed adapter; configuration files cannot grant that
authority.

## Development

Requires Node.js 24.18.0 and pnpm 10.32.1.

```sh
pnpm install
pnpm check
pnpm test:coverage
pnpm test:regtest
pnpm build
```

See [development](docs/operator/development.md) for browser tests, the released Devnet harness,
live-node smoke tests, and upstream-source verification.

## Repository

| Path | Purpose |
| --- | --- |
| `apps/sidekick` | API, CLI, reconciliation, persistence, and dashboard host |
| `apps/dashboard` | React operator UI |
| `packages/protocol` | PoX-5 and signer-manager codecs, profiles, and artifacts |
| `packages/api-contracts` | Versioned operator API schemas and browser-facing DTOs |
| `contracts` | Pinned upstream sources and generated test artifacts |
| `test` | Contract, browser, container, and released-Devnet validation |
| `design` | Vendored tokens, fonts, and the local UI contract |

## License

GPL-3.0-only. Vendored sources retain their notices; see
[contract provenance](contracts/PROVENANCE.md) and [NOTICE.md](NOTICE.md).
