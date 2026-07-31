# Container deployment

This is the mainnet-first Sidekick guide. Install and operate the Stacks node and signer separately
using the current upstream documentation:

- [Run a Stacks node](https://docs.stacks.co/operate/run-a-node)
- [Run a signer](https://docs.stacks.co/operate/run-a-signer)
- [stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive)

Sidekick expects reachable node RPC and Stacks API endpoints. It does not need node/signer private
keys or process access.

## Install

The supplied Compose service is non-root, read-only, and loopback-bound by default. SQLite uses a
named volume; profile directories are mounted read-only.

Docker Compose v2.24.4 or newer is required. Run `docker compose`, not the legacy
`docker-compose` v1 binary: it is unsupported and can fail recreating containers with current Docker.

```sh
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
rate-limited. For a self-hosted API, set `STACKS_API_URL` instead. For Fresh setup, configure the
future manager principal.

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
docker compose -f compose.yaml -f compose.host-network.yaml config
docker compose -f compose.yaml -f compose.host-network.yaml build --pull
docker compose -f compose.yaml -f compose.host-network.yaml run --rm --no-deps sidekick doctor connectivity
docker compose -f compose.yaml -f compose.host-network.yaml up -d
curl --fail http://127.0.0.1:3998/health/live
```

Build, then verify the node from the same container network before starting Sidekick:

```sh
docker compose build --pull
docker compose run --rm --no-deps sidekick doctor connectivity
docker compose up -d
curl --fail "http://$(docker compose port sidekick 3998)/health/live"
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
```

Docker `healthy` checks liveness only. `/health/ready` reports a current or last-good control-plane
observation, but does not change during ordinary engine observation or trigger restarts. Check that
its `freshness` is `current` before onboarding. `doctor connectivity` checks node, API, network,
lag, and PoX-5. The authenticated Operations readiness panel (`/api/v1/operations/readiness`) also
reports manager setup and engine blockers. Do not begin onboarding until connectivity reports no
failed checks.

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

Public-network Fresh setup requires a matched compatibility profile; failure or inconsistency is a
stop condition. Profiles under
[`network-compatibility`](../../network-compatibility/README.md) and
[`trusted-managers`](../../trusted-managers/README.md) load at startup, so restart after changes.

Fixed externally signed manager actions have a narrower gate: the configured manager, required
interface, and node/API network routing must agree. Manager source/profile trust is a warning, not a
blocker; review every wallet or manual signing request. Assist retains the stronger gates below.

## Transaction engine modes

The safety contract is [Transaction engine V1](../product/transaction-engine-v1.md).

### Observe

Observe starts without engine inputs and cannot reserve a nonce, sign, or broadcast. Keep production
and mainnet deployments in Observe until all
[rollout gates](../product/transaction-engine-v1.md#rollout-gates) are complete:

```dotenv
SIDEKICK_ENGINE_MODE=observe
```

Without engine inputs, Operations shows observations and blockers. Exact plans require the public
gas-payer principal/key and reviewed attestation/trust files from the Assist configuration below;
omit the gas secret and keep `SIDEKICK_ENGINE_MODE=observe` to preserve read-only authority.

### Assist configuration

Assist exists for controlled canary validation of the single code-backed
`reference-manager-claim-rewards` adapter. Do not enable it for a custom manager or unattended
mainnet operation.

Assist requires an exact reference manager/profile on every network. Production approval is
required only on mainnet; non-mainnet still requires the signed attestation, exact approval, and all
runtime admission checks.

Assist fails startup unless all of these values are present and mutually consistent:

```dotenv
SIDEKICK_ENGINE_MODE=assist
SIDEKICK_GAS_PAYER_PRINCIPAL=ST_REPLACE_WITH_DEDICATED_GAS_PAYER
SIDEKICK_GAS_PAYER_PUBLIC_KEY=02_REPLACE_WITH_COMPRESSED_PUBLIC_KEY
SIDEKICK_GAS_PAYER_SECRET_FILE=/run/sidekick-engine/gas-payer.key
SIDEKICK_COMPATIBILITY_ATTESTATION_FILE=/run/sidekick-engine/compatibility-attestation.json
SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE=/run/sidekick-engine/trust-keys.json
```

Devnet and regtest Assist also require `SIDEKICK_NETWORK_ID`; it must match both the node and signed
attestation.

The principal must be a standard principal for the configured network and must derive from the
compressed public key. The three file settings are absolute paths **inside the container**. Put only
paths and public identity in the environment; never put a private key, mnemonic, signed transaction,
or attestation issuer secret in an environment value.

The gas key must be dedicated to one running Sidekick instance, low balance, and funded only for
bounded transaction fees. It is not a signer, manager-admin, or operator-wallet private key. The file
contains exactly one raw Stacks private key, is a regular non-symlink file, is owned by container UID
`10001`, and permits owner read with optional owner write but no group, world, or execute access.
Keep it outside the repository and container image. Compatibility attestation and trust-key JSON
must come from the approved release process; do not author permissive local replacements.

On a Linux host, prepare a root-controlled directory and install reviewed source files without
printing them:

```sh
sudo install -d -m 0700 -o root -g root /var/lib/signer-sidekick/engine
sudo install -m 0400 -o 10001 -g 10001 /secure/source/gas-payer.key \
  /var/lib/signer-sidekick/engine/gas-payer.key
sudo install -m 0444 -o 10001 -g 10001 /secure/source/compatibility-attestation.json \
  /var/lib/signer-sidekick/engine/compatibility-attestation.json
sudo install -m 0444 -o 10001 -g 10001 /secure/source/trust-keys.json \
  /var/lib/signer-sidekick/engine/trust-keys.json
```

Pass the public settings and bind-mount each file read-only with a Compose override. The base Compose
file needs no engine mounts for Observe.

```yaml
# compose.assist.yaml
services:
  sidekick:
    environment:
      SIDEKICK_ENGINE_MODE: assist
      SIDEKICK_GAS_PAYER_PRINCIPAL: ${SIDEKICK_GAS_PAYER_PRINCIPAL:?Set the public principal}
      SIDEKICK_GAS_PAYER_PUBLIC_KEY: ${SIDEKICK_GAS_PAYER_PUBLIC_KEY:?Set the compressed public key}
      SIDEKICK_GAS_PAYER_SECRET_FILE: /run/sidekick-engine/gas-payer.key
      SIDEKICK_COMPATIBILITY_ATTESTATION_FILE: /run/sidekick-engine/compatibility-attestation.json
      SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE: /run/sidekick-engine/trust-keys.json
      SIDEKICK_ENGINE_FINALITY_DEPTH: ${SIDEKICK_ENGINE_FINALITY_DEPTH:-6}
      SIDEKICK_ENGINE_MAXIMUM_FEE_USTX: ${SIDEKICK_ENGINE_MAXIMUM_FEE_USTX:-100000}
      SIDEKICK_ENGINE_MAX_APPROVAL_MINUTES: ${SIDEKICK_ENGINE_MAX_APPROVAL_MINUTES:-30}
    volumes:
      - /var/lib/signer-sidekick/engine/gas-payer.key:/run/sidekick-engine/gas-payer.key:ro
      - /var/lib/signer-sidekick/engine/compatibility-attestation.json:/run/sidekick-engine/compatibility-attestation.json:ro
      - /var/lib/signer-sidekick/engine/trust-keys.json:/run/sidekick-engine/trust-keys.json:ro
```

Start the override only after reviewing the effective configuration and candidate image:

```sh
docker compose -f compose.yaml -f compose.assist.yaml config
docker compose -f compose.yaml -f compose.assist.yaml up -d
docker compose -f compose.yaml -f compose.assist.yaml exec -T sidekick \
  node /app/dist/main.js preflight
```

Use both Compose files for every later `up`, `run`, or replacement-container command in that Assist
canary. Omitting the override safely returns the replacement container to Observe without the engine
files.

Policy values are bounded at startup:

| Setting | Default | Accepted range |
| --- | ---: | ---: |
| `SIDEKICK_ENGINE_FINALITY_DEPTH` | 6 | 1–144 blocks |
| `SIDEKICK_ENGINE_MAXIMUM_FEE_USTX` | 100,000 | 1–10,000,000 µSTX per transaction |
| `SIDEKICK_ENGINE_MAX_APPROVAL_MINUTES` | 30 | 1–1,440 minutes |

### Approval and emergency controls

In Assist, open **Operations**, select a job in `awaiting_approval`, and review every displayed call,
checkpoint, anchor, recipient, outflow, fee, attestation, and expected post-state field. Approve only
when the exact intent and policy hashes match the current bounded approval window. Approval is the
authorization to run the final admission gate and broadcast; there is no later generic signing
prompt. Changed facts or expiry invalidate the action.

The same page provides three persistent controls:

- **Invalidate approval** withdraws only the selected exact approval.
- **Force Observe** permanently forces that database into Observe, invalidates active approvals,
  and blocks Sidekick from initiating new external-wallet claims.
- **Disable adapter** permanently disables new work and broadcasts for that adapter and invalidates
  its active approvals.

Force Observe and adapter disable are one-way circuit breakers in the current database. They stop
new authority but deliberately keep existing attempts visible and recoverable.

Wallet-intent expiry and Force Observe stop new Sidekick signing requests. They cannot revoke a
request already disclosed to an external signer or cancel a wallet broadcast, so Sidekick still
records matching txids and reconciles their effects.

### Assist recovery

If submission is ambiguous, a txid does not appear, the node/API becomes unavailable, account nonce
activity is unexpected, or a reorg occurs:

1. Use **Force Observe** or **Disable adapter** immediately.
2. Do not send the call manually, allocate another nonce, restart with another database, or remove
   the gas secret.
3. Preserve the SQLite database and WAL files, logs, txids, attestation files, and exact candidate
   image.
4. Restore node/API access. Sidekick probes the precomputed txid, unconfirmed/indexed transaction
   state, account nonce, canonical anchor, and expected contract effect without rebroadcasting the
   original attempt.
5. Keep the instance online until the job is confirmed/reconciled. A pending or ambiguous attempt
   that cannot be reconciled is reported as manual intervention required; V1 does not construct,
   sign, or broadcast replacement transactions. Escalate with the complete support evidence before
   taking any other signing action.

Restarting the same instance with the same database is supported. Replacing the database or key is
not a recovery procedure while any nonce remains unresolved.

## Back up and upgrade

These examples use the base Observe deployment. During an Assist canary, replace every
`docker compose` with `docker compose -f compose.yaml -f compose.assist.yaml`; omitting the override
intentionally restarts in Observe. Never upgrade or restore while a nonce is unresolved.

```sh
mkdir -p backups
docker compose exec -T sidekick \
  node /app/dist/main.js database backup /data/pre-upgrade.sqlite
docker compose cp sidekick:/data/pre-upgrade.sqlite backups/pre-upgrade.sqlite

./scripts/require-docker-compose-v2.sh
docker compose build --pull
docker compose up -d
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
```

The backup command refuses to overwrite a file and checks the result. Protect the database and
backups: runtime API credentials may be stored in SQLite.

## Restore

Restore only while Sidekick is stopped. Confirm the Compose volume name before running this
example. After any Assist submission, do not restore a backup taken before that submission: it may
erase the nonce, txid, and attempt evidence required to avoid a duplicate or conflicting
transaction.

```sh
docker compose down
docker run --rm --user 0 --entrypoint sh \
  -v signer-sidekick_sidekick-data:/data \
  -v "$PWD/backups:/backups:ro" \
  signer-sidekick:local \
  -c 'set -eu
quarantine=$(mktemp -d /data/restore-quarantine.XXXXXX)
for file in /data/sidekick.sqlite /data/sidekick.sqlite-wal /data/sidekick.sqlite-shm; do
  if [ -e "$file" ]; then mv "$file" "$quarantine/"; fi
done
cp /backups/pre-upgrade.sqlite /data/sidekick.sqlite
chown 10001:10001 /data/sidekick.sqlite
echo "Previous database files moved to $quarantine"'
docker compose run --rm --no-deps sidekick doctor
docker compose up -d
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
```

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose logs --tail=200 sidekick
curl --fail "http://$(docker compose port sidekick 3998)/health/live"
curl --fail "http://$(docker compose port sidekick 3998)/health/ready"
curl --fail "http://$(docker compose port sidekick 3998)/metrics"
```

Use the dashboard support bundle for escalation. Review it and logs before sharing because public
principals are operationally identifying.

For the dedicated PoX-5 Testnet exercise, use the separate
[PoX-5 Testnet runbook](pox5-testnet-deployment.md).
