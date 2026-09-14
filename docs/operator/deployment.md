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
| `SIDEKICK_AUTH_TOKEN` | Unique random operator credential (at least 24 characters) |
| `STACKS_API_KEY` | Recommended Hiro key from [platform.hiro.so](https://platform.hiro.so) |

A Hiro key is recommended for existing-pool backfill; keyed requests can still be rate-limited. Set
`STACKS_NODE_METRICS_URL` and `STACKS_SIGNER_MONITORING_URL` for full Signer Health diagnostics.
`HIRO_REFERENCE_API_KEY` is needed only when the comparison API uses a different credential. When
both API URLs have the same origin, Sidekick safely reuses `STACKS_API_KEY`.

The local node supplies current chain state. The indexed API supplies roster and history data; API
lag does not block node-backed status.

API calls continue with the browser closed. Compatible background reads are shared; backfill and
submitted work add traffic. See [traffic measurement](operations.md#api-traffic), not timer-based
daily estimates.

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

The operational probe returns HTTP 503 with `operational-startup-pending` until operational
workers finish starting. This is expected briefly after `up -d`; retry the probe. Failed startup
is retried in the background, while `/health/live` and `/health/ready` remain available for diagnosis.

`connection check` fails when the required RPC, network, manager identity or PoX-5 trait checks
fail. Transaction indexing, telemetry and observer delivery are optional. It confirms core monitoring
compatibility; Settings reports manager-operation compatibility after Sidekick starts.
`/health/ready` confirms Sidekick and its database can serve requests; `/health/operational` also
checks completed worker startup, the current node, manager connection, manager preflight, and
availability of health evidence.
Diagnostic warnings are reported in its body but do not fail the operational probe.
The dashboard's **Settings → Deployment check** tests the same requirements and optional telemetry.

## Pre-release testing

For team testing, run **Actions → Test image → Run workflow** on `main` after that commit's CI
passes. The manual workflow publishes amd64 and arm64 images under a unique
`test-<commit>-<run>-<attempt>` tag; it does not change release versions, create a GitHub release,
or move `latest`. Its summary contains the exact `docker pull` command and `SIDEKICK_IMAGE_TAG`.

Use the [backup and upgrade procedure](operations.md#upgrade) before changing the image tag.
Test images can migrate the database; returning to an older image may require its matching database
backup. Keep the gas key and configuration with that backup, and do not run two instances against
the same database or gas wallet. Prefer Observe mode for initial checks.

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

### Changing ports

The host port and the container port are configured separately:

| Setting | Controls | Default |
| --- | --- | --- |
| `SIDEKICK_PUBLISH_ADDRESS` | Host address the dashboard is published on | `127.0.0.1` |
| `SIDEKICK_PUBLISH_PORT` | Host port | Same as `SIDEKICK_HTTP_PORT` |
| `SIDEKICK_HTTP_PORT` | Port Sidekick listens on inside the container | `3998` |

`SIDEKICK_EVENT_PUBLISH_ADDRESS`, `SIDEKICK_EVENT_PUBLISH_PORT` and `SIDEKICK_EVENT_HTTP_PORT` do
the same for the private event listener.

Leave `SIDEKICK_HTTP_HOST` unset. On the default bridge network the container must listen on
`0.0.0.0` for Docker to forward the published port; binding it to loopback leaves the published port
unreachable. `compose.host-network.yaml` binds `127.0.0.1` instead, because host networking
publishes no ports.

To run a second instance on the same host, give it its own Compose project and host ports:

```sh
COMPOSE_PROJECT_NAME=sidekick-b \
SIDEKICK_PUBLISH_PORT=4998 \
SIDEKICK_EVENT_PUBLISH_PORT=3701 \
docker compose up -d
```

The project name namespaces the data volume, so each instance keeps its own database and gas wallet
at the default `/data` location and the container ports need not change. Never point two instances
at one database or gas wallet.

## Event observer

Generate the node configuration after `connection check` succeeds:

```sh
docker compose run --rm --no-deps sidekick observer config NODE_REACHABLE_SIDEKICK_HOST:3700
```

Merge `observerToml` and `nodeToml` into the existing node configuration without replacing the
signer's observer. Keep `disable_retries = true` on Sidekick's observer only, including when
upgrading an existing deployment; Sidekick does not edit node TOML. The bounded nonblocking
dispatcher can still block when full, so disabling retries protects node progress if Sidekick is
offline. Apply the configuration and coordinated node restart through your infrastructure tooling.
Port 3700 has no application authentication; expose it only to the node. Settings confirms the first
node-verified callback. At inbox capacity, Sidekick returns 200 with `accepted: false` and discards
the notification. Polling and API backfill recover gaps once their sources are available.

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
   Reward runs (default 0.003–0.01 STX; the floor applies when no estimate is available).
   `SIDEKICK_ENGINE_MAXIMUM_FEE_USTX` (default 0.1 STX) is the hard per-transaction cap sealed
   into each run. Review the recipe's actual transaction count and gas budget; Bitcoin payouts
   can require later settlement/reclaim calls.
4. **Enable**. Before every signature Sidekick re-checks that the address is not the signer, a
   manager admin, or a contract, and refuses otherwise.

Back up `gas-wallet.key` with the database (see Operations); losing it loses only the gas balance.
**Sweep remaining STX** returns the balance to an address you name. **Disable**, **Force Observe**
(Settings → Reward runs), or `SIDEKICK_ENGINE_MODE=observe` stop signing without
deleting the key.

See [Operations](operations.md) for upgrades, restore, diagnosis, and support collection.
