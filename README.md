# Signer Sidekick

Signer Sidekick is a self-hosted control plane for Stacks PoX-5 signer and STX pool operators. It
attaches to an existing signer-manager or guides a new deployment, then reconciles registration,
pool membership, rewards, and withdrawals from the operator's node and Stacks API.

The current build supports setup and read-only operations. It does **not** yet broadcast recurring
pool transactions and is not ready for unattended mainnet use. See
[issue #2](https://github.com/stx-labs/signer-sidekick/issues/2) for live delivery status.

## Documentation

Start with [the documentation index](docs/README.md).

- Operators: [container deployment](docs/operator/deployment.md)
- PoX-5 Testnet validation: [PoX-5 Testnet runbook](docs/operator/pox5-testnet-deployment.md)
- Contributors: [development guide](docs/operator/development.md)
- Product and safety contract: [V1 scope](docs/product/v1-plan.md)
- Open protocol questions: [review questions](docs/reviews/team-questions.md)

Node and signer installation are intentionally outside Sidekick. Operator guides link to the
current upstream Stacks documentation rather than copying release-sensitive instructions.

## Configure a deployment

Start from [`.env.mainnet.example`](.env.mainnet.example) or
[`.env.pox5-testnet.example`](.env.pox5-testnet.example).

| Setting | What to do |
| --- | --- |
| Network, Hiro API URL, API header, forecast horizon | Use the supplied value |
| `STACKS_NODE_RPC_URL` | Set an endpoint reachable from the Sidekick container |
| `SIDEKICK_MANAGER_PRINCIPAL` | Set the existing or future manager contract |
| `SIDEKICK_AUTH_TOKEN` | Generate a unique token |
| Node metrics, signer monitoring, Hiro reference URL | Optional; configure in Settings for Signer Health |
| API key/provider and publish address | Change only when needed |

The built-in compatibility profile supplies public network IDs and contract metadata. Do not set
`SIDEKICK_NETWORK_ID` for mainnet or PoX-5 Testnet.

Use a separate Compose project and volume for each network:

```sh
cp .env.mainnet.example .env.mainnet
chmod 600 .env.mainnet
docker compose --env-file .env.mainnet -p signer-sidekick-mainnet up -d --build
```

```sh
cp .env.pox5-testnet.example .env.pox5-testnet
chmod 600 .env.pox5-testnet
docker compose --env-file .env.pox5-testnet -p signer-sidekick-pox5-testnet up -d --build
```

Do not reuse a Sidekick database across networks. Both examples publish port `3998`, so stop one
before starting the other unless you supply a Compose port override. See
[container deployment](docs/operator/deployment.md) for credential generation and connectivity.

## Boundaries

- One network, signer-manager, and STX-only pool per deployment.
- Existing and fresh manager workflows.
- Hiro or self-hosted Stacks API endpoints.
- No manager-admin or signer key custody.
- No public staking or wallet UI.
- Direct node/signer health endpoints are supported; host resource and log monitoring remain out of
  scope.
- No sBTC bond pooling in V1.

Unknown but interface-compatible managers can be observed. Only reproduced reference-manager
source may become eligible for future automation; configuration files cannot grant that authority.

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
| `packages/core` | Protocol-independent domain boundaries |
| `contracts` | Pinned upstream sources and generated test artifacts |
| `test` | Contract, browser, container, and released-Devnet validation |
| `design` | Vendored tokens, components, examples, and local UI rules |

## License

GPL-3.0-only. Vendored sources retain their notices; see
[contract provenance](contracts/PROVENANCE.md) and [NOTICE.md](NOTICE.md).
