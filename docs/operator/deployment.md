# Container deployment

This is the mainnet-first Sidekick guide. Install and operate the Stacks node and signer separately
using the current upstream documentation:

- [Run a Stacks node](https://docs.stacks.co/operate/run-a-node)
- [Run a signer](https://docs.stacks.co/operate/run-a-signer)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive)

Sidekick requires a reachable node RPC endpoint for its baseline connection. The indexed Stacks API
and signer-monitoring endpoints extend data coverage but do not determine whether Sidekick can
connect. Sidekick does not need node/signer private keys or process access.

Before deploying Sidekick, use [Zero to Signing](https://stx.fan/zero_to/signing/) to complete the
wallet-signed signer-manager flow and configure `SIDEKICK_MANAGER_PRINCIPAL` to that deployed
manager. Node and signer infrastructure belongs in upstream tooling or
[stacksup](https://github.com/stx-labs/stacksup).

## Install a release

The supplied Compose service is non-root, read-only, and loopback-bound by default. SQLite uses a
named volume; profile directories are mounted read-only.

Use the [latest release](https://github.com/stx-labs/signer-sidekick/releases/latest) for the
current version, or browse the persistent [container image package](https://github.com/orgs/stx-labs/packages/container/package/signer-sidekick).
Pin `SIDEKICK_IMAGE_TAG` to a specific release for production.

Docker Compose v2.24.4 or newer is required. Run `docker compose`, not the legacy
`docker-compose` v1 binary: it is unsupported and can fail recreating containers with current Docker.

```sh
git clone --depth 1 --branch v1.0.0 https://github.com/stx-labs/signer-sidekick.git
cd signer-sidekick
umask 077
cp .env.mainnet.example .env
chmod 600 .env
openssl rand -base64 32 | tr -d '\n' | pbcopy  # macOS
# Linux Wayland: replace pbcopy with wl-copy
./scripts/require-docker-compose-v2.sh
```

Store the generated token in a password manager, then paste it into `.env`; avoid printing it in
terminal history or logs. Set the node URL and manager principal. Mainnet uses the Hiro API by
default. Set `STACKS_API_KEY` for a Hiro plan or another keyed provider; public Hiro access can be
rate-limited. For a self-hosted API, set `STACKS_API_URL` instead. Configure the already-deployed
manager principal.

The configured Stacks node is authoritative for current operational state. The API supplies indexed
roster, event, and history capabilities. API lag or an API outage is shown as indexed-data
degradation and does not make the local operator dashboard unavailable; API-specific synchronization
and Assist proofs still wait or fail closed when their required indexed evidence is unavailable.

While the dashboard is visible, it requests a coalesced current operator snapshot every 15 seconds
so new Stacks blocks appear without manual refreshes. Sidekick also reconciles the authoritative
staking roster shortly after startup and every 30 minutes after the configured manager is
available, even when no browser is open. A failed automatic reconciliation retains the last
verified roster and retries
with bounded backoff; **Sync now** remains available for an immediate operator-triggered
reconciliation.

Use the published image rather than building locally:

```sh
docker compose -f compose.yaml -f compose.release.yaml pull
docker compose -f compose.yaml -f compose.release.yaml run --rm --no-deps sidekick connection check
docker compose -f compose.yaml -f compose.release.yaml up -d
curl --fail http://127.0.0.1:3998/health/live
curl --fail http://127.0.0.1:3998/health/ready
```

`SIDEKICK_IMAGE_TAG` is pinned in `.env`; change it only as part of a deliberate upgrade. To build
from source instead, use `docker compose build --pull` and omit `compose.release.yaml`.

## Connect to the node

`host.docker.internal` works only when the node RPC listener and host networking permit Docker
bridge traffic. Choose the simplest endpoint that fits the deployment:

| Node location | `STACKS_NODE_RPC_URL` and networking |
| --- | --- |
| Same Docker network | Use `http://<node-service>:20443` and attach Sidekick with a Compose override. |
| Sidekick host | Use `http://host.docker.internal:20443` or a host address reachable from the container. |
| Remote host | Use its private RPC URL and restrict ingress to the Sidekick host. |
| Linux host networking | Use `compose.host-network.yaml`, set `STACKS_NODE_RPC_URL=http://127.0.0.1:20443`, and keep the Sidekick listener on loopback. |

For Linux host networking, use the supplied Compose-v2 overlay for every command. It removes the
base port publishing and adapts the container health probe to the configured listener:

```sh
./scripts/require-docker-compose-v2.sh
docker compose -f compose.yaml -f compose.release.yaml -f compose.host-network.yaml config
docker compose -f compose.yaml -f compose.release.yaml -f compose.host-network.yaml pull
docker compose -f compose.yaml -f compose.release.yaml -f compose.host-network.yaml run --rm --no-deps sidekick connection check
docker compose -f compose.yaml -f compose.release.yaml -f compose.host-network.yaml up -d
curl --fail http://127.0.0.1:3998/health/live
```

For a source build, verify the node from the same container network before starting Sidekick:

```sh
docker compose build --pull
docker compose run --rm --no-deps sidekick connection check
docker compose up -d
curl --fail "http://$(docker compose port sidekick 3998)/health/live"
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
docker compose exec -T sidekick node /app/dist/main.js connection check
```

Docker `healthy` checks liveness only. `/health/ready` reports whether the configured local-node and
signer-manager connection is established, but does not trigger restarts. `connection check` uses
the same configured network, local node, manager, and database identity as `serve`, without waiting
for indexed data, registration, eligibility, or telemetry. `doctor connectivity` remains the deeper
node/API lag diagnostic. The authenticated Operations readiness panel
(`/api/v1/operations/readiness`) also reports manager and engine blockers. Resolve failed
connectivity checks before signing an operation.

### Connect the private event listener

Sidekick listens separately for Stacks Core event-dispatcher callbacks on port `3700`. The base
Compose file publishes that port on host loopback; the host-network overlay also binds it directly
to loopback. Do not route this listener through the operator reverse proxy or publish it to the
internet. The listener accepts only `/new_block`, `/new_burn_block`, and the node's implicit
`/attachments/new` callback, limits JSON bodies to 4 MiB by default, and commits each callback to
the SQLite inbox before returning HTTP 200.

After `connection check` succeeds, render subscriptions from the node-observed PoX-5 contract and
the configured manager instead of copying network-specific principals from documentation:

```sh
docker compose run --rm --no-deps sidekick observer config 127.0.0.1:3700
```

Use the endpoint that the Stacks node itself can reach: `127.0.0.1:3700` for a same-host node,
`sidekick:3700` when both services share a Docker network, or a firewalled private host address for
a remote node. The command returns an `observerToml` block with exact `burn_blocks`, PoX-5 print,
and attached-manager print subscriptions, plus `nodeToml` keys to merge into the node's existing
`[node]` table. Restart the node only through its normal infrastructure workflow, then verify
callback receipt in Sidekick's `/metrics` output or support snapshot.

Callbacks are prompts, not chain authority. New block and burn-block deliveries initially remain
`observer-claimed`; malformed, conflicting, or implausibly future claims are quarantined, and
implicit attachment callbacks are durably expired because Sidekick does not use them. A
restart-safe worker fences the node's info and tenure tips, then requires the block fetched by the
callback's index ID to be byte-identical to the canonical Nakamoto block at that height under the
stable tip. The callback block-hash field and embedded events remain untrusted and are never copied
directly into operator history or current projections. Terminal raw JSON has time, count, and byte
retention bounds while delivery evidence remains. Burn-block callbacks remain trigger-only and
expire after the node reaches their height because the local Stacks RPC cannot prove the claimed
burn hash. A PoX-5 print triggers a full roster scan only when its decoded routing hint names the
configured manager; network-wide activity for other managers is ignored. Manager activity is read
independently from the indexed API and becomes permanent only when the local transaction index
confirms the event's exact canonical height and index-block hash; five-minute manager-history and
30-minute full-roster backfills remain the recovery paths.

After deployment, measure the two-second p95 target over a bounded live window instead of relying
on a single callback or lifetime counters. The default check observes at least 100 `current` domain
reconciliations over ten minutes and exits nonzero when fewer than 95% finish within two seconds:

```sh
pnpm observer:latency:check --url http://127.0.0.1:3998/metrics
```

Use `--observe-seconds 0` only to inspect cumulative process-lifetime counters. A Sidekick restart
during a bounded measurement invalidates the counter deltas and requires rerunning the check.

Open `http://127.0.0.1:3998` and enter the configured token. The service starts in Observe mode and
cannot broadcast.

Signer Health uses node RPC by default. Configure and test optional Prometheus and signer-monitoring
endpoints in Settings; see [Signer Health](../product/signer-health.md).

For remote private access, keep the default loopback bind and tunnel it:

```sh
ssh -N -L 3998:127.0.0.1:3998 operator@sidekick-host
```

Alternatively, set `SIDEKICK_PUBLISH_ADDRESS` in `.env` to a trusted private-interface address and
restrict port 3998 with the host firewall and network ACLs. The `docker compose port` health
commands above adapt to either bind. Browser-wallet actions work over private HTTP, but HTTP exposes
the UI and auth token to that network. Use TLS for any untrusted or public network; never publish the
operator API directly to the internet.

### Reverse-proxy authentication

Bearer-token login remains the default. Sidekick can also recognize the existing
`SIDEKICK_AUTH_TOKEN` when a trusted reverse proxy injects it into a dedicated header, or when a
browser sends it as the password for HTTP Basic authentication. Both modes are disabled unless
configured.

For a proxy-injected header, choose a non-standard header name:

```dotenv
SIDEKICK_AUTH_TRUSTED_HEADER=X-Sidekick-Operator
```

The proxy must remove any client-supplied copy of that header and set its value to the raw
`SIDEKICK_AUTH_TOKEN` only after the proxy has authenticated and authorized the request. For
example, a Caddy service with the same token in its protected environment can use:

```caddyfile
reverse_proxy 127.0.0.1:3998 {
	header_up -X-Sidekick-Operator
	header_up X-Sidekick-Operator {$SIDEKICK_AUTH_TOKEN}
}
```

Do not inject this header for an unrestricted public route: every request that reaches that route
would receive operator access. Keep Sidekick bound to loopback or a private interface so clients
cannot bypass the authenticating proxy.

For HTTP Basic authentication, configure a username:

```dotenv
SIDEKICK_AUTH_BASIC_USERNAME=operator
```

The Basic password is the existing `SIDEKICK_AUTH_TOKEN`. Sidekick challenges unauthorized API
requests for both Bearer and Basic credentials, and the dashboard automatically detects an existing
trusted-header or browser Basic session. Use HTTPS: Basic credentials are encoded, not encrypted.
If a reverse proxy terminates Basic authentication itself, prefer having it inject the dedicated
header above after successful authentication.

Network compatibility profiles under
[`network-compatibility`](../../network-compatibility/README.md) and
[`trusted-managers`](../../trusted-managers/README.md) load at startup, so restart after changes.

Externally signed manager actions require the configured manager, the action's baseline interface,
and node network routing to agree. Manager source/profile trust is a warning for baseline actions,
not a blocker; reviewed adapters gate optional manager-specific behavior and Assist. Review every
wallet or manual signing request.

## Operation mode

Sidekick starts in Observe. It can prepare and verify external wallet requests but cannot sign or
broadcast. Keep mainnet deployments in this mode.

## Back up and upgrade

Never upgrade or restore while a submitted transaction is unresolved. Keep the release image tag
pinned until you are ready to upgrade it.

```sh
mkdir -p backups
docker compose -f compose.yaml -f compose.release.yaml exec -T sidekick \
  node /app/dist/main.js database backup /data/pre-upgrade.sqlite
docker compose -f compose.yaml -f compose.release.yaml cp sidekick:/data/pre-upgrade.sqlite backups/pre-upgrade.sqlite

./scripts/require-docker-compose-v2.sh
docker compose -f compose.yaml -f compose.release.yaml pull
docker compose -f compose.yaml -f compose.release.yaml up -d
curl --fail "http://$(docker compose -f compose.yaml -f compose.release.yaml port sidekick 3998)/health/ready"
```

The backup command refuses to overwrite a file and checks the result. Protect the database and
backups: runtime API credentials may be stored in SQLite.

## Restore

Restore only while Sidekick is stopped. Confirm the Compose volume name before running this example.

```sh
docker compose -f compose.yaml -f compose.release.yaml down
docker compose -f compose.yaml -f compose.release.yaml run --rm --no-deps --user 0 --entrypoint sh \
  -v "$PWD/backups:/backups:ro" sidekick \
  -c 'set -eu
quarantine=$(mktemp -d /data/restore-quarantine.XXXXXX)
for file in /data/sidekick.sqlite /data/sidekick.sqlite-wal /data/sidekick.sqlite-shm; do
  if [ -e "$file" ]; then mv "$file" "$quarantine/"; fi
done
cp /backups/pre-upgrade.sqlite /data/sidekick.sqlite
chown 10001:10001 /data/sidekick.sqlite
echo "Previous database files moved to $quarantine"'
docker compose -f compose.yaml -f compose.release.yaml run --rm --no-deps sidekick doctor
docker compose -f compose.yaml -f compose.release.yaml up -d
curl --fail "http://$(docker compose -f compose.yaml -f compose.release.yaml port sidekick 3998)/health/ready"
```

## Diagnose

```sh
docker compose -f compose.yaml -f compose.release.yaml exec -T sidekick node /app/dist/main.js doctor
docker compose -f compose.yaml -f compose.release.yaml exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose -f compose.yaml -f compose.release.yaml logs --tail=200 sidekick
curl --fail "http://$(docker compose -f compose.yaml -f compose.release.yaml port sidekick 3998)/health/live"
curl --fail "http://$(docker compose -f compose.yaml -f compose.release.yaml port sidekick 3998)/health/ready"
curl --fail "http://$(docker compose -f compose.yaml -f compose.release.yaml port sidekick 3998)/metrics"
```

Use **Download support bundle** on the dashboard Overview page for escalation to Stacks Labs. The
authenticated download performs a fresh, failure-tolerant collection and records each source as
`ok`, `failed`, or `unavailable`, so a broken node or signer does not prevent the artifact from
being created. It includes:

- Sidekick build/runtime information, database state, refresh/reconciliation state, and the current
  operator snapshot;
- connection outcome, durable deployment identity, and redacted runtime source configuration even
  when the operator snapshot is unavailable;
- local Stacks node, signer, Hiro reference, and configured monitoring health;
- manager registration, PoX-5 setup, pool roster/forecast/reward state, activity, alerts, and trust
  history; and
- transaction-engine status plus the 50 most recent operation summaries.

The bundle intentionally includes operationally identifying public principals, transaction IDs,
internal endpoint URLs, and filesystem paths. It excludes API-key values, operator credentials,
passwords, cookies, private keys, mnemonics, signer signatures, signed transactions, environment
dumps, and raw logs. The `safety` object records these boundaries in the artifact. Raw host, node,
and signer logs remain deployment-specific; attach relevant log excerpts separately when support
requests them.

For the dedicated PoX-5 Testnet exercise, use the separate
[PoX-5 Testnet runbook](pox5-testnet-deployment.md).
