# Signer Sidekick

Signer Sidekick is a self-hosted control plane for Stacks PoX-5 signer and STX pool operators. It
guides Fresh or Attach setup and reconciles registration, pool membership, rewards, and withdrawals
from the operator's node and Stacks API.

V1 provides monitoring, externally signed manager administration, and Observe reward claims.
Assist is a separate, controlled release track; it is not available for unattended mainnet use.

## Documentation

Start with [the documentation index](docs/README.md). Node and signer installation remain separate
upstream responsibilities.

## Scope

- One network and signer-manager per deployment. Pools may include PoX-5 bond participants;
  Sidekick observes bond membership and claims per-bond reward buckets, but never creates or
  changes a bond.
- Existing and fresh manager workflows.
- Browser-wallet or manual execution for setup, manager administration, and Observe reward claims.
- Hiro or self-hosted Stacks API endpoints.
- No custody of signer or manager-admin private keys.
- No end-user wallet connection or stake submission.
- Direct node/signer health endpoints are supported; host resource and log monitoring remain out of
  scope.
- No bond creation, Bitcoin L1 lock handling, SPV proofs, early exits, or rollovers.

Compatible managers can use supported external administration and registration actions. Observe
reward claims require a verified reference manager; Assist has additional release gates.

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
