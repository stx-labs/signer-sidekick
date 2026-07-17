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
cp .env.example .env
openssl rand -base64 32
```

Set the node URL, manager principal, and generated `SIDEKICK_AUTH_TOKEN` in `.env`. Mainnet uses the
Hiro API by default; set `STACKS_API_URL` and optional key fields for another provider. For Fresh
setup, configure the future manager principal.

```sh
docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
```

Open `http://127.0.0.1:3998` and enter the configured token. Do not publish port 3998 directly;
remote access requires an authenticated TLS proxy or private network.

The service starts in Observe mode and cannot broadcast.

## Verify the connection

```sh
docker compose exec -T sidekick node /app/dist/main.js preflight
```

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

For the current public-testnet exercise, use the separate
[testnet runbook](testnet-deployment.md).
