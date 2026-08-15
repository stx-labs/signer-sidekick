# Node and signer requirements

Sidekick attaches to an already-running Stacks node and signer. It does not install, edit, or
restart either service. This guide records the configuration Sidekick needs, the additional signals
that make diagnosis useful, and what Sidekick can verify automatically.

Use the current upstream [node guide](https://docs.stacks.co/operate/run-a-node),
[signer guide](https://docs.stacks.co/operate/run-a-signer), and
[stacks-core release notes](https://github.com/stacks-network/stacks-core/releases) as the authority
for installing and operating those processes. The snippets here are the Sidekick-specific subset;
merge them into the existing TOML instead of replacing the complete configuration.

## What is required

| Capability | Importance | Why Sidekick needs it | Automatic proof |
| --- | --- | --- | --- |
| Private node RPC reachable from Sidekick | Required | Establishes network, PoX-5, manager, current chain, and action anchors | Connects to the configured RPC and verifies network/PoX-5/manager identity |
| Stacks Core transaction index | Required for complete manager/reward operation history | Independently verifies canonical manager events and reward calculations rather than trusting an indexed API alone | Probes `/v3/transaction/<unknown-txid>`; `404` proves the endpoint exists and `501` proves `txindex` is off |
| Node Prometheus endpoint | Recommended | Adds peer, tip, warning, error, and latency evidence for local-versus-network diagnosis | Parses the configured Prometheus endpoint and counts recognized node signals |
| Signer monitoring endpoint | Recommended | Identifies the running signer and adds heartbeat, proposal, response, latency, and agreement evidence | Requires valid `/info`, `/heartbeat`, and `/metrics` responses from the configured base URL |
| Sidekick event-observer subscription | Recommended | Drives prompt, event-based reconciliation instead of waiting for bounded polling | Requires a callback accepted by Sidekick and verified against the local node |

The baseline connection deliberately remains narrower than this table. Missing telemetry or event
delivery does not make a correctly attached manager “disconnected.” A required deployment check
blocks only features that need that prerequisite; a recommended failure reduces freshness or
diagnostic confidence.

Run all checks before first start and after node/signer configuration changes:

```sh
docker compose run --rm --no-deps sidekick connection check
```

The JSON contains separate `connection` and `requirements` objects. The command exits nonzero when
the baseline connection fails or a required deployment prerequisite is missing. After Sidekick is
running, open **Settings → Deployment check**. That page runs the same bounded, read-only checks
automatically and supplies exact remediation for every incomplete item. **Refresh checks** forces a
new observation. The result is also included in the support bundle.

## Stacks node

### RPC and transaction index

Merge these keys into the existing `[node]` table:

```toml
[node]
rpc_bind = "127.0.0.1:20443"
stacker = true
txindex = true
```

`rpc_bind` must be reachable from Sidekick. Loopback is correct for native same-host deployments or
Linux host networking. For separate containers or hosts, bind a private address and restrict the
port with the container network, host firewall, or private-network ACL. Never publish unauthenticated
node RPC to the internet.

Stacks Core disables `txindex` by default. Enabling it adds a local transaction-ID index and uses
additional chain-data storage. Keep the node working directory, including this index, on the same
durable fast volume as chainstate. Restart the node through the deployment's normal process and
allow indexing to catch up before expecting manager-event and reward-realization history to become
current.

Configure Sidekick with the matching base URL:

```dotenv
STACKS_NODE_RPC_URL=http://127.0.0.1:20443
```

### Node metrics

Enable a private Prometheus listener in the same `[node]` table:

```toml
[node]
prometheus_bind = "127.0.0.1:9153"
```

Then configure the URL visible from Sidekick:

```dotenv
STACKS_NODE_METRICS_URL=http://127.0.0.1:9153/metrics
```

The Settings check validates Prometheus syntax and recognized Stacks node signals; merely opening a
TCP connection does not pass.

### Node-to-signer events

A production signer also needs the node's normal signer observer. This is separate from the
Sidekick observer below and must remain present:

```toml
[[events_observer]]
endpoint = "127.0.0.1:30000"
events_keys = ["stackerdb", "block_proposal", "burn_blocks"]
```

The endpoint must match the signer's `endpoint`. The shared `[connection_options].auth_token` and
signer `auth_password` must also match, but neither value belongs in Sidekick and neither is shown
in a support bundle.

Sidekick cannot read the node's TOML, inspect that shared secret, or prove this exact stanza exists.
Signer Health instead evaluates the running signer's identity, heartbeat, node height, and signing
activity when monitoring is available. Use the upstream signer tooling or StacksUp for service-level
configuration validation.

## Signer

The complete signer configuration contains private key material and is outside Sidekick. The
following non-secret fields are the relevant topology:

```toml
node_host = "127.0.0.1:20443"
endpoint = "127.0.0.1:30000"
network = "mainnet"
db_path = "/durable/fast-storage/signer.sqlite"
metrics_endpoint = "127.0.0.1:30001"
```

- `node_host` must reach the same node that dispatches signer events.
- `endpoint` must match the node-to-signer observer above.
- `network` must match the node and Sidekick deployment.
- `db_path` should use durable storage. Sidekick never reads it.
- `metrics_endpoint` should remain private but must be reachable from Sidekick for full health
  diagnosis.

Configure the signer monitoring base URL; Sidekick appends `/info`, `/heartbeat`, and `/metrics`:

```dotenv
STACKS_SIGNER_MONITORING_URL=http://127.0.0.1:30001
```

Do not copy `stacks_private_key`, `auth_password`, seed phrases, or any other signer secret into the
Sidekick environment, dashboard, issue, or support artifact.

## Sidekick event observer

Sidekick's private callback listener defaults to loopback port `3700`. Generate the exact node
subscription only after the connection check has observed the network's PoX-5 contract and the
configured manager:

```sh
sidekick observer config <node-reachable-host:3700>
```

Use `127.0.0.1:3700` only when the node and Sidekick share a network namespace. Use the Sidekick
service name on a shared container network or a firewalled private address across hosts. Merge both
the returned `observerToml` stanza and returned `[node]` keys into the existing node configuration;
do not remove the separate signer observer.

Sidekick accepts callbacks as untrusted prompts, persists them before acknowledgement, and verifies
block claims against the local node. Until a verified callback arrives, the deployment check says
that the listener is ready but the node subscription is not yet proved. When callbacks fall behind,
the check reports attention while bounded polling continues.

## Detection limits and safe remediation

The assessment is intentionally evidence-based:

- it does not parse remote TOML, inspect process arguments, use SSH, or request privileged access;
- it never treats a configured URL as proof that its service is healthy;
- it never reports an observer subscription as working until a callback is node-verified;
- it cannot validate signer private keys or authentication secrets; and
- it never edits a file or restarts a process.

Instructions show the smallest relevant snippet and the services normally affected. Always merge
with the full existing configuration, use the deployment's normal backup/change process, and review
the relevant release notes before restarting a mainnet node or signer.
