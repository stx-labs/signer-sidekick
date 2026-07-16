# Container deployment

This is the mainnet-first guide for installing and operating the Sidekick software. It does not
install or configure a Stacks node or signer; use the current official Stacks guides for those
network components. The public testnet activation exercise is deliberately isolated in its own
[validation runbook](testnet-deployment.md).

Signer Sidekick ships as one non-root OCI container with the dashboard embedded in the local
operator API. The supplied Compose profile binds the application only to `127.0.0.1:3998`, drops
all Linux capabilities, uses a read-only root filesystem, and keeps SQLite in a named volume.

The read-only V1 container accepts its initial API key and bearer token through environment
variables. An API key replaced later through the authenticated Settings UI is stored in SQLite;
protect the named volume and backups as secret-bearing. Signer, manager-admin, and gas-payer keys
are never stored there.
Before any gas-payer automation is enabled, production key material must use the documented
read-only Docker-secret mount rather than environment injection.

The supplied Compose profile also mounts `./trusted-managers` at
`/etc/sidekick/trusted-managers` read-only. Sidekick loads profile JSON only at startup. Anyone who
can write the host directory controls trusted configuration, but a profile still cannot declare
automation eligibility: Sidekick must reproduce its reference render from the pinned source and a
matching built-in profile for the installed profile's own network that is already
production-approved.

The Compose profile separately mounts `./network-compatibility` read-only. Node build strings are
diagnostic and are not allowlisted. When a network activates PoX-5 or updates its reviewed contract
fingerprint, an operator can install a strict compatibility profile without releasing a new
Sidekick image. Put the plain profile JSON in that directory and restart Sidekick. Use
`sidekick doctor` and `sidekick preflight` to inspect the selected profile and any rejected files.

Sidekick ignores invalid, duplicate, ambiguous, oversized, or symlinked files. These profiles are
operator configuration, not an authorization mechanism: they may guide read-only inspection and
deterministic Fresh setup artifacts, but cannot enable transaction automation. Generated deployment
manifests expose every substituted principal and source hash, require external review, and are
signed and broadcast outside Sidekick. Protect the directory as configuration, and prefer profiles
derived from official release source and live node evidence.

Before transaction automation ships, Sidekick will add authenticated compatibility attestations.
The preferred trust root is an official network/core release key and manifest if upstream publishes
the required deployment facts; a separate Stacks Labs signing process is only the fallback.

## Start

Use a Stacks node RPC endpoint reachable from inside the container. On Docker Desktop and on the
supplied Linux Compose profile, `host.docker.internal` reaches a node running on the host.

```sh
cp .env.example .env
openssl rand -base64 32
# Edit .env with the node URL, manager principal, and generated credential.
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3998/health/ready
```

Open `http://127.0.0.1:3998` and enter the same `SIDEKICK_AUTH_TOKEN`. The token remains in the
browser tab's session storage. Do not publish port 3998 directly to the internet. If remote access
is needed, place an authenticated TLS proxy or private-network access layer in front of the
loopback service.

The container starts in Observe mode. It has no signer or manager-admin key and does not broadcast
transactions.

Run connected preflight before using any Fresh setup artifact:

```sh
docker compose exec -T sidekick node /app/dist/main.js preflight
```

On mainnet and public testnet, manager rendering refuses to proceed until the live network
fingerprint matches an installed compatibility profile. Do not bypass a failed or inconsistent
preflight by guessing release contracts or principals.

## Install a manager profile

An interface-compatible unknown manager already supports attach, display, reconciliation, and
monitoring. If it is a private/testnet render of the pinned reference manager, generate a profile
from the deployed source:

```sh
pnpm --filter @stx-labs/signer-sidekick build
pnpm --filter @stx-labs/signer-sidekick cli \
  manager trust "$SIDEKICK_MANAGER_PRINCIPAL" \
  --output trusted-managers/my-manager.json
docker compose restart sidekick
```

The command uses the configured node and network. It refuses to describe a semantically different
contract as a reference render. `--observe-only` may be used explicitly for a custom contract; that
profile improves identification but remains ineligible for reference-manager automation. The
dashboard and support bundle show the profile origin, proof result, load errors, and eligibility
reason. Back up profile JSON with deployment configuration, but review it before sharing because it
contains operationally identifying public principals.

## Upgrade

Create a backup first, then rebuild from the reviewed source revision:

```sh
mkdir -p backups
docker compose exec -T sidekick node /app/dist/main.js database backup /data/pre-upgrade.sqlite
docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
```

The backup command refuses to overwrite an existing file and runs `PRAGMA quick_check` on the
result. Copy durable backups out of the named volume:

```sh
docker compose cp sidekick:/data/pre-upgrade.sqlite backups/pre-upgrade.sqlite
```

## Restore

Restoration is deliberately an offline operation. Stop the service, preserve the failed database,
copy in a verified backup, and then start Sidekick so migrations can run normally:

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

Confirm the actual Compose project volume name with `docker volume ls` before restoring. Never
replace the SQLite file while Sidekick is running.

## Diagnostics

```sh
docker compose logs --tail=200 sidekick
docker compose exec -T sidekick node /app/dist/main.js doctor
curl --fail http://127.0.0.1:3998/health/live
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/metrics
```

The support bundle and browser status snapshot are allowlisted and redacted. Logs and support
artifacts must still be reviewed before sharing because manager and staker principals are public
but operationally identifying.
