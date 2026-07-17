# Container deployment

This is the mainnet-first Sidekick guide. Install and operate the Stacks node and signer separately
using the current upstream documentation:

- [Run a Stacks node](https://docs.stacks.co/operate/run-a-node)
- [Run a signer](https://docs.stacks.co/operate/run-a-signer)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive)

Sidekick expects reachable node RPC and Stacks API endpoints. It does not need node/signer keys or
process access.

## Install

The supplied Compose service is non-root, read-only, and loopback-bound. SQLite uses a named
volume; profile directories are mounted read-only.

```sh
umask 077
cp .env.mainnet.example .env
chmod 600 .env
openssl rand -base64 32 | tr -d '\n' | pbcopy  # macOS
# Linux Wayland: replace pbcopy with wl-copy
```

Store the generated token in a password manager, then paste it into `.env`; avoid printing it in
terminal history or logs. Set the node URL and manager principal. Mainnet uses the Hiro API by
default; set `STACKS_API_URL` and optional key fields for another provider. For Fresh setup,
configure the future manager principal.

## Connect to the node

`host.docker.internal` works only when the node RPC listener and host networking permit Docker
bridge traffic. Choose the simplest endpoint that fits the deployment:

| Node location | `STACKS_NODE_RPC_URL` and networking |
| --- | --- |
| Same Docker network | Use `http://<node-service>:20443` and attach Sidekick with a Compose override. |
| Sidekick host | Use `http://host.docker.internal:20443` or a host address reachable from the container. |
| Remote host | Use its private RPC URL and restrict ingress to the Sidekick host. |
| Linux host networking | In an override, remove `ports`, set `network_mode: host`, `SIDEKICK_HTTP_HOST=127.0.0.1`, and use `http://127.0.0.1:20443`. |

Build, then verify the node from the same container network before starting Sidekick:

```sh
docker compose build --pull
docker compose run --rm --no-deps --entrypoint node sidekick -e \
  "fetch(new URL('/v2/info', process.env.STACKS_NODE_RPC_URL)).then(r => { if (!r.ok) throw new Error('Node RPC returned ' + r.status); console.log('Node RPC reachable') })"
docker compose up -d
curl --fail "http://$(docker compose port sidekick 3998)/health/live"
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
docker compose exec -T sidekick node /app/dist/main.js preflight
```

Docker `healthy` checks liveness only: it means the control plane is listening, not that the node,
API, or manager is ready. Do not begin onboarding until `/health/ready` succeeds and `preflight`
reports no failed checks.

Open `http://127.0.0.1:3998` and enter the configured token. The service starts in Observe mode and
cannot broadcast.

The Signer Health page works with node RPC alone. For peer and signer-operation signals, configure
the optional node Prometheus URL and signer monitoring base URL in Settings, then use each field's
connection test. These endpoints must be reachable from the Sidekick container; no private keys are
used. See the [Signer Health scope](../product/signer-health-v1-plan.md).

For remote private access, keep the default loopback bind and tunnel it:

```sh
ssh -N -L 3998:127.0.0.1:3998 operator@sidekick-host
```

Alternatively, set `SIDEKICK_PUBLISH_ADDRESS` in `.env` to the host's Tailscale IPv4 address and
keep port 3998 blocked on other interfaces. The `docker compose port` health commands above adapt
to either bind. Use an authenticated TLS proxy for any non-private exposure; never publish the
operator API directly to the internet.

Fresh artifacts on a public network require a matched compatibility profile. A failed or
inconsistent result is a stop condition.

Network profiles live in `network-compatibility/`; see its
[README](../../network-compatibility/README.md). Manager identification profiles live in
`trusted-managers/`; see its [README](../../trusted-managers/README.md). Both load at startup, so
restart after changes.

## Back up and upgrade

```sh
mkdir -p backups
docker compose exec -T sidekick \
  node /app/dist/main.js database backup /data/pre-upgrade.sqlite
docker compose cp sidekick:/data/pre-upgrade.sqlite backups/pre-upgrade.sqlite

docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
```

The backup command refuses to overwrite a file and checks the result. Protect the database and
backups: runtime API credentials may be stored in SQLite.

## Restore

Restore only while Sidekick is stopped. Confirm the Compose volume name before running this
example.

```sh
docker compose down
docker run --rm --user 0 --entrypoint sh \
  -v signer-sidekick_sidekick-data:/data \
  -v "$PWD/backups:/backups:ro" \
  signer-sidekick:local \
  -c 'mv /data/sidekick.sqlite /data/sidekick.sqlite.failed && cp /backups/pre-upgrade.sqlite /data/sidekick.sqlite && chown 10001:10001 /data/sidekick.sqlite'
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
```

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose logs --tail=200 sidekick
curl --fail http://127.0.0.1:3998/health/live
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/metrics
```

Use the dashboard support bundle for escalation. Review it and logs before sharing because public
principals are operationally identifying.

For the dedicated PoX-5 Testnet exercise, use the separate
[PoX-5 Testnet runbook](pox5-testnet-deployment.md).
