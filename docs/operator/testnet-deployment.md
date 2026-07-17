# Public PoX-5 testnet validation

This runbook is only for the public-testnet activation exercise. Normal deployment documentation
assumes mainnet.

Sidekick does not install the node or signer and never signs deployment or `register-self` calls.
Use current upstream material for those steps:

- [Node guide](https://docs.stacks.co/operate/run-a-node)
- [Signer guide](https://docs.stacks.co/operate/run-a-signer)
- [Network and faucet information](https://docs.stacks.co/learn/network-fundamentals/mainnet-and-testnets)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive)

## Prerequisites

- Synced public-testnet node and configured signer.
- Funded testnet admin address.
- External tool approved for signing and broadcasting contract transactions.
- Node RPC reachable from the Sidekick host/container.
- Reviewed checkout of this repository.

## Start Sidekick

Copy `.env.example` and set:

```dotenv
SIDEKICK_NETWORK=testnet
STACKS_NODE_RPC_URL=http://host.docker.internal:20443
STACKS_API_URL=https://api.testnet.hiro.so
SIDEKICK_MANAGER_PRINCIPAL=ST_REPLACE_WITH_ADMIN.signer-manager
SIDEKICK_AUTH_TOKEN=replace-with-a-random-32-byte-value
```

Leave `SIDEKICK_NETWORK_ID` unset for public testnet. For Fresh setup, the configured manager is the
future `<admin>.<contract-name>`; for Attach, it is already deployed.

```sh
docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
docker compose exec -T sidekick node /app/dist/main.js preflight
```

Do not continue with Fresh setup unless PoX-5 is active, compatibility is `matched`, and no check
fails. If the live network is unrecognized, review and install a profile under
`network-compatibility/`, restart, and repeat preflight. Do not infer contract principals or hashes.

## Attach an existing manager

Use **Attach existing** in the dashboard, or:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  init attach ST_REPLACE_WITH_ADMIN.signer-manager
docker compose exec -T sidekick node /app/dist/main.js \
  setup status ST_REPLACE_WITH_ADMIN.signer-manager
```

An interface-compatible custom manager may attach read-only. A reference render can be identified
with an installed manager profile; see [deployment](deployment.md#verify-the-connection).

## Create a manager

The dashboard provides the same flow. The CLI form is useful when recording exact outputs.

Choose one unsigned uint128 `AUTH_ID` and retain it throughout the ceremony:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  init fresh ST_REPLACE_WITH_ADMIN signer-manager /data/manager-deployment AUTH_ID
docker compose exec -T sidekick node /app/dist/main.js \
  manager render ST_REPLACE_WITH_ADMIN signer-manager /data/manager-deployment

mkdir -p manager-deployment
docker compose cp sidekick:/data/manager-deployment/. ./manager-deployment/
```

Review the source and manifest, then deploy with external admin tooling. After confirmation:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  signer-grant prepare ST_REPLACE_WITH_ADMIN.signer-manager AUTH_ID
```

Run the emitted `stacks-signer generate-staking-signature ... --json` command on the signer host.
Copy only its public JSON output back to Sidekick:

```sh
docker compose cp ./signer-grant.json sidekick:/data/signer-grant.json
docker compose exec -T sidekick node /app/dist/main.js \
  signer-grant verify ST_REPLACE_WITH_ADMIN.signer-manager AUTH_ID /data/signer-grant.json
```

Review the emitted `register-self` arguments and broadcast externally. After confirmation:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  setup status ST_REPLACE_WITH_ADMIN.signer-manager
```

The final result should show the expected manager registration, valid grant, and cycle eligibility.
Transaction submission alone is not success.

## Validate the dashboard

Open `http://127.0.0.1:3998`, reconcile, and review registration, pool, cycles, rewards, activity,
settings, and diagnostics. Allow the API indexer to catch up before treating a lagging indexed view
as a Sidekick defect.

Record the Sidekick commit, compatibility profile, node release, deployment artifacts, public grant
JSON, transaction IDs, and verification heights. Review diagnostics before sharing them.
