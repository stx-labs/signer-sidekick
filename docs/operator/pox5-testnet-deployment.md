# PoX-5 Testnet validation

This runbook targets the dedicated PoX-5 Testnet profile. Ordinary Stacks testnet uses a different
chain ID and is not interchangeable.

Sidekick begins after the node, signer, and signer-manager are running. Complete first-time setup in
[Zero to Signing](https://stx.fan/zero_to/signing/) and use current upstream material for the
infrastructure:

- [Node guide](https://docs.stacks.co/operate/run-a-node)
- [Signer guide](https://docs.stacks.co/operate/run-a-signer)
- [Network and faucet information](https://docs.stacks.co/learn/network-fundamentals/mainnet-and-testnets)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)

## Prerequisites

- Synced PoX-5 Testnet node and running signer.
- Deployed signer-manager with a confirmed `register-self` call.
- Funded manager-admin address and an external wallet or approved signing tool.
- Node RPC reachable from the Sidekick container.

## Start Sidekick

Follow the main [install guide](deployment.md#install-a-release), starting from
`.env.pox5-testnet.example`:

```dotenv
SIDEKICK_NETWORK=pox5-testnet
STACKS_API_URL=https://api.testnet-pox5.hiro.so
STACKS_API_KEY_HEADER=x-api-key
SIDEKICK_FORECAST_HORIZON_CYCLES=6
STACKS_NODE_RPC_URL=http://REPLACE_WITH_NODE_RPC:20443
SIDEKICK_MANAGER_PRINCIPAL=ST_REPLACE_WITH_ADMIN.signer-manager
SIDEKICK_AUTH_TOKEN=REPLACE_ME
```

Leave `SIDEKICK_NETWORK_ID` unset; the built-in profile supplies `0x80000005`. Run the container
connectivity check, start Sidekick, and verify the configured manager:

```sh
docker compose run --rm --no-deps sidekick connection check
docker compose up -d
docker compose exec -T sidekick node /app/dist/main.js connection check
```

The result should show the baseline node/manager connection plus the separate node and signer
requirements assessment. Registration, grant, and operator readiness appear after Sidekick starts;
they are intentionally not connection gates. A missing or incompatible manager is repaired outside
Sidekick, then rechecked here.

### Leather custom network

For browser-wallet execution, add a Leather custom network with key `pox5-testnet` and Stacks API
URL `https://api.testnet-pox5.hiro.so`. The wallet must report the configured admin's `ST...`
address. Ordinary Stacks testnet is `0x80000000`; Sidekick accepts only the dedicated PoX-5 chain ID
`0x80000005` and independently verifies the broadcast transaction. Use manual handoff if the wallet
cannot represent that exact network.

## Exercise recurring operations

Open the dashboard and review Overview, Pool, Rewards, Activity, Signer Health, and Settings. Then
exercise only the operations relevant to the evaluator:

1. Reconcile the roster and manager events twice; the second run must be idempotent.
2. Prepare a fee/admin transaction, sign it externally, and verify its canonical poststate.
3. Generate and verify a new public signer grant, then prepare a `register-self` rotation with the
   manager-admin wallet.
4. Confirm STX-only positions and the STX side of any Bitcoin bond positions remain visible.
5. Download a support bundle and confirm it contains node, signer, manager, reconciliation, and
   operation evidence without private keys or credentials.

Allow an indexed API to catch up before treating a lagging roster or history view as a Sidekick
defect. Node-backed status should remain available while the API is behind.

Record the Sidekick commit, compatibility profile, node/signer releases, public grant JSON,
transaction IDs, and verification heights. Use the support bundle for escalation to Stacks Labs.
