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
| `SIDEKICK_IMAGE_TAG` | The same release tag |
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

`connection check` fails when RPC, network, manager identity, or transaction indexing is invalid.
`/health/ready` confirms Sidekick and its database can serve requests; `/health/operational` also
checks the current node, manager connection, and health evidence.
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

See [Operations](operations.md) for upgrades, restore, diagnosis, and support collection.
