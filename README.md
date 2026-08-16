# Signer Sidekick

Signer Sidekick monitors and operates one running Stacks PoX-5 signer and pool. It reconciles
registration, pool membership, rewards, manager actions, and signer health against the operator's
node and an indexed Stacks API.

![Signer Sidekick dashboard overview](docs/assets/dashboard-overview.jpg)

## Use

- [Install on mainnet](docs/operator/deployment.md)
- [Configure the node and signer](docs/operator/node-signer-requirements.md)
- [Operate and recover Sidekick](docs/operator/operations.md)
- [Evaluate on PoX-5 Testnet](docs/operator/pox5-testnet-deployment.md)

Sidekick starts after the node, signer, and signer-manager are running. Use
[Zero to Signing](https://stx.fan/zero_to/signing/) to deploy the manager and
[StacksUp](https://github.com/stx-labs/stacksup) to manage node and signer infrastructure.

Sidekick supports STX-only positions and the STX side of Bitcoin bonds. Manager and signer keys
remain in the operator's wallet and signer. Compatible custom managers receive baseline monitoring;
actions also require a reviewed execution profile.

## Development

Requires Node.js 24.18.0 and pnpm 10.32.1. See [Development](docs/operator/development.md).

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

GPL-3.0-only. See [NOTICE.md](NOTICE.md) and [contract provenance](contracts/PROVENANCE.md).
