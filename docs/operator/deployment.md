# Mainnet installation

Sidekick requires Docker Compose 2.24.4 or newer, a deployed PoX-5 signer-manager, and the
[node and signer settings](node-signer-requirements.md). Use a release tag, not `main`.

## Configure

```sh
git clone --depth 1 --branch RELEASE_TAG https://github.com/stx-labs/signer-sidekick.git
cd signer-sidekick
cp .env.mainnet.example .env
chmod 600 .env
```

Set these values in `.env`:

| Variable | Value |
| --- | --- |
| `SIDEKICK_IMAGE_TAG` | Release version without the Git tag's `v` prefix |
| `STACKS_NODE_RPC_URL` | Node RPC URL reachable from the container |
| `SIDEKICK_MANAGER_PRINCIPAL` | Existing `SP_ADDRESS.contract-name` manager |
| `SIDEKICK_AUTH_TOKEN` | Random operator credential |
| `STACKS_API_KEY` | Hiro key from [platform.hiro.so](https://platform.hiro.so) |

A Hiro key avoids public rate limits during existing-pool backfill. Set
`STACKS_NODE_METRICS_URL` and `STACKS_SIGNER_MONITORING_URL` for full Signer Health diagnostics.
`HIRO_REFERENCE_API_KEY` is needed only when the comparison API uses a different credential. When
both API URLs have the same origin, Sidekick safely reuses `STACKS_API_KEY`.

The local node supplies current chain state. The indexed API supplies roster and history data; API
lag does not block node-backed status.

## Manager compatibility

`connection check` accepts a manager only when its network and exact PoX-5 signer-manager interface
match. A connected manager receives core monitoring: registration and grant state, signer-set
membership and weight, STX-only and Bitcoin-bond positions, PoX rewards, node and signer health,
raw activity, indexed history, and support export.

Manager-specific operations are evaluated separately:

| State | Meaning |
| --- | --- |
| **Available** | The deployed behavior matches a reviewed adapter for this operation. Runtime checks still apply when an action is prepared. |
| **Observe only** | The required interface exists, but this deployment does not match a reviewed adapter for the operation. |
| **Not provided** | The manager does not expose the functions Sidekick needs for the operation. |

Settings shows these states for registration, admin management, fee operations, and reward
distribution. A custom source therefore does not disable core monitoring or imply that every
operation is unavailable.

If an operation you need is **Observe only** or **Not provided**, open a
[manager compatibility issue](https://github.com/stx-labs/signer-sidekick/issues/new?title=Manager%20compatibility%3A%20).
Include the network, manager principal, operation, and a redacted support bundle when available; do
not include keys or credentials.

## Start

```sh
export COMPOSE_FILE=compose.yaml:compose.release.yaml
# On Linux with the node on the same host, append :compose.host-network.yaml

docker compose pull
docker compose run --rm --no-deps sidekick connection check
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/health/operational
```

`connection check` fails when RPC, network, manager identity, PoX-5 interface, or transaction
indexing is invalid. It confirms core monitoring compatibility; Settings reports manager-operation
compatibility after Sidekick starts.
`/health/ready` confirms Sidekick and its database can serve requests; `/health/operational` also
checks the current node, manager connection, manager preflight, and availability of health evidence.
Diagnostic warnings are reported in its body but do not fail the operational probe.
The dashboard's **Settings → Deployment check** tests the same requirements and optional telemetry.

## Network paths

| Direction | Port | Use |
| --- | ---: | --- |
| Sidekick → node | 20443 | RPC; required |
| Sidekick → node | 9153 | Prometheus; optional |
| Sidekick → signer | 30001 | Signer monitoring; optional |
| Node → Sidekick | 3700 | Event observer; recommended |
| Operator → Sidekick | 3998 | Dashboard and API |
| Sidekick → Stacks API | 443 | Roster and history |

Use loopback only when both processes share a network namespace. On split hosts, use private
addresses and restrict each listener to the listed source.

## Event observer

Generate the node configuration after `connection check` succeeds:

```sh
docker compose run --rm --no-deps sidekick observer config NODE_REACHABLE_SIDEKICK_HOST:3700
```

Merge the returned `observerToml` and `nodeToml` into the node configuration, then restart the node.
Port 3700 has no application authentication; expose it only to the node. Settings confirms the first
node-verified callback. Polling and API backfill continue if callbacks stop.

## Operator access

The default listener is `127.0.0.1:3998` with bearer-token login. For remote access, use an SSH
tunnel or an authenticating TLS proxy.

To trust a proxy-injected header, set `SIDEKICK_AUTH_TRUSTED_HEADER=X-Sidekick-Operator`. The proxy
must remove the client's copy before adding the token:

```caddyfile
reverse_proxy 127.0.0.1:3998 {
	header_up -X-Sidekick-Operator
	header_up X-Sidekick-Operator {$SIDEKICK_AUTH_TOKEN}
}
```

Set `SIDEKICK_AUTH_BASIC_USERNAME` to use the token as an HTTP Basic password. Keep mainnet in the
default `observe` engine mode.

## Gas wallet and reward runs

Sidekick can run the permissionless PoX-5 reward calls — calculate, collect, distribute, settle,
reclaim — from one operator-approved recipe at a time. Those calls need a key that pays network
fees, and Sidekick must never hold the signer or manager-admin key, so it generates a dedicated
**gas wallet**: a low-balance STX account that signs only the sealed recipe you approve. The
contract fixes every payout recipient and amount; the wallet's whole exposure is its balance. Keys
are never accepted through the environment, and Observe remains the default.

1. Set `SIDEKICK_ENGINE_MODE=operator-run` in `.env` and restart.
2. Open **Settings → Gas wallet → Create gas wallet**. The key is written once to
   `/data/gas-wallet.key` (owner-only), is never exposed through the UI or API, and Settings shows
   only the address.
3. Fund the address with STX from any wallet. For every transaction Sidekick asks the local node
   to estimate the exact payload and pays the estimate within the **fee band** in Settings →
   Reward runs (default 0.003–0.01 STX, the Leather wallet's standard contract-call band; the floor
   is also paid when the node has no estimate), so bot-driven estimate spikes are neither paid nor
   halted on. `SIDEKICK_ENGINE_MAXIMUM_FEE_USTX` (default 0.1 STX) is the deployment's hard
   per-transaction cap sealed into every run; a distribution of N payments takes about N + 1
   transactions, and Settings shows how many the balance covers at the cap.
4. **Enable**. Before every signature Sidekick re-checks that the address is not the signer, a
   manager admin, or a contract, and refuses otherwise.

Back up `gas-wallet.key` with the database (see Operations); losing it loses only the gas balance.
**Sweep remaining STX** returns the balance to an address you name. **Disable**, **Force Observe**
(Settings → Reward runs), or `SIDEKICK_ENGINE_MODE=observe` stop signing without
deleting the key.

See [Operations](operations.md) for upgrades, restore, diagnosis, and support collection.
