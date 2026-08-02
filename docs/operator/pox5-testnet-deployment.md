# PoX-5 Testnet validation

This runbook targets the dedicated PoX-5 Testnet profile. Do not substitute canonical Stacks testnet
configuration; normal deployment documentation assumes mainnet.

This procedure covers Attach, Fresh setup, and Observe validation.

Sidekick does not install the node or signer and never signs setup or manager-admin calls. It can
hand exact calls to Leather or a manual signing tool. Use current upstream material for node and
signer setup:

- [Node guide](https://docs.stacks.co/operate/run-a-node)
- [Signer guide](https://docs.stacks.co/operate/run-a-signer)
- [Network and faucet information](https://docs.stacks.co/learn/network-fundamentals/mainnet-and-testnets)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive)

## Prerequisites

- Synced PoX-5 Testnet node and configured signer.
- Funded PoX-5 Testnet admin address.
- Leather or another external tool approved for signing and broadcasting contract transactions.
- Node RPC reachable from the Sidekick host/container.
- Reviewed checkout of this repository.

## Start Sidekick

Follow the main [install guide](deployment.md#install), starting from
`.env.pox5-testnet.example` instead of the mainnet example. These values are already correct:

```dotenv
SIDEKICK_NETWORK=pox5-testnet
STACKS_API_URL=https://api.testnet-pox5.hiro.so
STACKS_API_KEY_HEADER=x-api-key
SIDEKICK_FORECAST_HORIZON_CYCLES=6
```

Set the three deployment-specific values:

```dotenv
STACKS_NODE_RPC_URL=http://REPLACE_WITH_NODE_RPC:20443
SIDEKICK_MANAGER_PRINCIPAL=ST_REPLACE_WITH_ADMIN.signer-manager
SIDEKICK_AUTH_TOKEN=REPLACE_ME
```

Leave `SIDEKICK_NETWORK_ID` unset; the built-in profile supplies `0x80000005`. For Fresh setup, the
configured manager is the future `<admin>.<contract-name>`; for Attach, it is already deployed. Use
the node endpoint that passed the container-side check in the main guide.

Complete the main guide through readiness and preflight before onboarding.

Do not continue with Fresh setup unless PoX-5 is active, compatibility is `matched`, and no check
fails. If the live network is unrecognized, review and install a profile under
`network-compatibility/`, restart, and repeat preflight. Do not infer contract principals or hashes.

### Leather custom network

For browser-wallet execution, add a Leather custom network with key `pox5-testnet` and Stacks API
URL `https://api.testnet-pox5.hiro.so`. The wallet must report the configured admin's `ST...`
address. Ordinary Stacks testnet is a different chain (`0x80000000`); Sidekick accepts only the
dedicated PoX-5 chain ID `0x80000005` and independently verifies the broadcast transaction. Xverse
is not enabled for this custom network. Use the manual handoff if Leather is not configured exactly.
Private HTTP access is supported under the restrictions in the main guide's remote-access section.

## Attach an existing manager

Use **Attach Existing Manager** in the dashboard, or:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  init attach ST_REPLACE_WITH_ADMIN.signer-manager
docker compose exec -T sidekick node /app/dist/main.js \
  setup status ST_REPLACE_WITH_ADMIN.signer-manager
```

An interface-compatible custom manager may attach and use fixed externally signed actions after
node/API routing checks pass. Its unverified source warns and keeps Assist disabled. Install a
[trusted-manager profile](../../trusted-managers/README.md) only to prove a reference render.

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

Open `http://127.0.0.1:3998`, reconcile, and review Overview, Manager, Pool, Rewards, Operations,
Signer Health, Initial Setup, Settings, and Public Pool Page. Allow the API indexer to catch up
before treating a lagging indexed view as a Sidekick defect.

Record the Sidekick commit, compatibility profile, node release, deployment artifacts, public grant
JSON, transaction IDs, and verification heights. Review diagnostics before sharing them.
