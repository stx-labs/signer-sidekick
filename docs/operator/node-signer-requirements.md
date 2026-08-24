# Node and signer requirements

These are the Sidekick-specific additions to an existing Stacks node and signer. See the upstream
[node](https://docs.stacks.co/operate/run-a-node) and
[signer](https://docs.stacks.co/operate/run-a-signer) guides for full configuration.

## What is required

| Capability | Requirement | Effect |
| --- | --- | --- |
| Node RPC | Required | Current chain, PoX-5, manager, and operation state |
| Node transaction index | Recommended | Faster canonical manager and reward transaction verification |
| Node Prometheus | Recommended | Node progress, peers, errors, and latency |
| Signer monitoring | Recommended | Signer identity, heartbeat, proposals, and validation |
| Sidekick event observer | Recommended | Event-driven refresh instead of polling alone |

Run `docker compose run --rm --no-deps sidekick connection check` before first start and after node
changes. The same checks are available under **Settings → Deployment check**.

## Stacks node

### RPC and transaction index

Merge into `[node]`:

```toml
[node]
rpc_bind = "127.0.0.1:20443"
stacker = true
txindex = true
prometheus_bind = "127.0.0.1:9153"
```

Use addresses reachable from the Sidekick container.

`txindex` is optional. Without it the node answers transaction lookups with HTTP 501, and Sidekick
verifies manager activity and reward realization by reading the canonical block at the transaction's
height and confirming the transaction is in it. That is equally authoritative — block bytes are
primary consensus data — but deserializes a block per check instead of doing a single-row lookup.

Enabling it trades storage for that speed. The index only covers blocks the node processes after you
turn it on; it does not backfill, so transactions confirmed earlier keep using block reads. Keep the
node working directory, including the index, on the chainstate volume.

```dotenv
STACKS_NODE_RPC_URL=http://127.0.0.1:20443
STACKS_NODE_METRICS_URL=http://127.0.0.1:9153/metrics
```

### Node metrics

`STACKS_NODE_METRICS_URL` is optional. Settings requires Prometheus output containing recognized
Stacks node metrics.

### Node-to-signer events

Keep the normal signer observer; it is separate from the Sidekick observer:

```toml
[[events_observer]]
endpoint = "127.0.0.1:30000"
events_keys = ["stackerdb", "block_proposal", "burn_blocks"]
```

The endpoint must match the signer's `endpoint`. The node connection auth token must match the
signer's `auth_password`.

## Signer

Relevant signer fields:

```toml
node_host = "127.0.0.1:20443"
endpoint = "127.0.0.1:30000"
network = "mainnet"
db_path = "/durable/fast-storage/signer.sqlite"
metrics_endpoint = "127.0.0.1:30001"
```

```dotenv
STACKS_SIGNER_MONITORING_URL=http://127.0.0.1:30001
```

Sidekick appends `/info`, `/heartbeat`, and `/metrics`. It never needs the signer private key or
node/signer authentication secret.

## Sidekick event observer

Generate the manager- and network-specific node stanza:

```sh
docker compose run --rm --no-deps sidekick observer config NODE_REACHABLE_SIDEKICK_HOST:3700
```

Use loopback only for a shared network namespace. Otherwise use a private container or host address
and allow port 3700 only from the node. Merge the returned stanza without removing the signer
observer.
