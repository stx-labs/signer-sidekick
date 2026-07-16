# Public PoX-5 testnet validation

This validation-specific runbook is intentionally separate from the mainnet-first
[container deployment guide](deployment.md). It is the operator checklist for deploying Sidekick
against the public Stacks testnet and manually exercising its V1 Fresh or Attach flow. V1 observes
and verifies network state, generates reviewable setup artifacts, and prepares external transaction
instructions. It does not install a node or signer, hold private keys, sign transactions, or
broadcast transactions.

## Responsibility boundary

| Outside Sidekick | Sidekick V1 |
| --- | --- |
| Select and install released `stacks-node` and `stacks-signer` software | Validate the configured node and API against live network state |
| Configure, sync, fund, secure, back up, and upgrade the node and signer | Render a deterministic manager artifact after compatibility matches |
| Review, sign, broadcast, and confirm manager deployment and `register-self` transactions | Prepare and verify the public signer-grant ceremony output |
| Operate signing and investigate signer-host health | Verify registration, grant, eligibility, pool state, and API/indexer freshness |

Use current upstream documentation for network operations. These links, not this repository, are
authoritative for release versions, system requirements, node/signer configuration, and testnet
funding:

- [Run a Stacks node with Docker](https://docs.stacks.co/operate/run-a-node/run-a-node-with-docker)
- [Run a signer](https://docs.stacks.co/operate/run-a-signer) and the
  [signer quickstart](https://docs.stacks.co/operate/run-a-signer/signer-quickstart)
- [Official stacks-core releases](https://github.com/stacks-network/stacks-core/releases)
- [Mainnet and testnets](https://docs.stacks.co/learn/network-fundamentals/mainnet-and-testnets)
- [Hiro chainstate archive](https://docs.hiro.so/en/resources/archive), if the official node guide
  recommends using it for the chosen release and network
- [Hiro API rate limits and API keys](https://docs.hiro.so/en/resources/guides/rate-limits)

Do not copy a version number or configuration example from Sidekick into a production node or
signer. Check the current release notes and official guides at deployment time.

## 1. Prepare the external network components

Before starting Sidekick, confirm outside this application that:

- the testnet node and signer are installed from a reviewed official release and are running;
- the node is synced closely enough to the public testnet tip for the trial;
- the signer is configured and registered with the node according to the official signer guide;
- the operator has a funded testnet admin address and an approved external tool for signing and
  broadcasting the manager deployment and contract call; and
- the node RPC is reachable from the machine that will run Sidekick.

Sidekick deliberately does not evaluate signer-process health in V1. It reports only node/API data
related to pool setup, registration, and operation.

## 2. Prepare Sidekick

Use a reviewed, signed commit of this repository. The current V1 deployment builds the local OCI
image from that checkout; it does not assume that a registry image has been published.

```sh
cp .env.example .env
openssl rand -base64 32
```

Edit `.env` and replace every placeholder. A public testnet deployment normally needs:

```dotenv
SIDEKICK_NETWORK=testnet
STACKS_NODE_RPC_URL=http://host.docker.internal:20443
STACKS_API_URL=https://api.testnet.hiro.so
STACKS_API_KEY=
STACKS_API_KEY_HEADER=x-api-key
SIDEKICK_MANAGER_PRINCIPAL=ST_REPLACE_WITH_ADMIN.signer-manager
SIDEKICK_AUTH_TOKEN=replace-with-the-generated-credential
SIDEKICK_FORECAST_HORIZON_CYCLES=6
```

The RPC URL must be reachable from inside the container; it may instead be a secured remote or
self-hosted endpoint. The API URL can be Hiro's public testnet API or a self-hosted Stacks API. Add
an API key when the provider requires one. Leave `SIDEKICK_NETWORK_ID` unset for the public Stacks
testnet; that override exists for private or custom networks only.

For Fresh setup, `SIDEKICK_MANAGER_PRINCIPAL` is the future
`<testnet-admin-principal>.<contract-name>` and must exactly match the values entered later. For
Attach Existing, it is the already deployed manager principal.

Build and start the loopback-only service:

```sh
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3998/health/ready
```

Open `http://127.0.0.1:3998` and enter `SIDEKICK_AUTH_TOKEN`. Do not expose port 3998 directly to
the internet. See [container deployment](deployment.md) for the security model, backups, restore,
upgrades, and remote-access boundary.

## 3. Require a live compatibility match

Run preflight after PoX-5 activates on the public testnet:

```sh
docker compose exec -T sidekick node /app/dist/main.js preflight
```

Proceed with Fresh setup only when:

- `result.pox.activationState` is `active`;
- `result.pox.pox5ContractId` names the live PoX-5 contract;
- `result.compatibility.status` is `matched`; and
- there are no failed checks.

The node version is diagnostic only. A compatible node or network upgrade should not require a
Sidekick release. If the live fingerprint is not built in, place a strictly reviewed plain JSON
profile in `network-compatibility/`, restart Sidekick, and repeat preflight. Derive the profile from
official release source and live node evidence; do not guess its hashes or principals. The profile
can guide setup but cannot approve automation, signing, or broadcasting.

An `unrecognized` public network means Sidekick lacks reviewed compatibility data. An
`inconsistent` result means live facts contradict an installed profile. Stop in both cases; inspect
`preflight`, `doctor`, the official release material, and rejected profile details before changing
anything.

## 4A. Attach an existing manager

Choose **Attach existing** in Initial Setup, or run:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  init attach ST_REPLACE_WITH_ADMIN.signer-manager
docker compose exec -T sidekick node /app/dist/main.js \
  setup status ST_REPLACE_WITH_ADMIN.signer-manager
```

An interface-compatible custom manager can attach in **Not recognized - read-only** mode. This
allows display and reconciliation; it does not imply that future transaction automation will work
with custom semantics. If the deployment is a parameter-only render of Sidekick's pinned reference
manager, follow [Install a manager profile](deployment.md#install-a-manager-profile) after attach.

## 4B. Create a fresh manager

The Initial Setup wizard presents this flow and preserves its public artifacts. The equivalent CLI
sequence below makes the manual trust boundary explicit. Pick a unique unsigned 128-bit `AUTH_ID`
and keep the same value throughout the ceremony.

First inspect the activation plan:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  init fresh ST_REPLACE_WITH_ADMIN signer-manager /data/manager-deployment AUTH_ID
```

Render the deployment only after preflight matches:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  manager render ST_REPLACE_WITH_ADMIN signer-manager /data/manager-deployment
mkdir -p manager-deployment
docker compose cp sidekick:/data/manager-deployment/. ./manager-deployment/
```

Review the generated `.clar` source and `.deployment.json` manifest. Confirm the network, future
manager principal, PoX-5 and sBTC principals, substitutions, source hashes, Clarity version, and
`operatorReviewRequired: true`. Sidekick does not sign or broadcast the deployment. Use the
operator-approved external admin tooling to deploy it, then wait for confirmation and record the
transaction ID.

Prepare the signer-grant ceremony using the confirmed manager principal:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  signer-grant prepare ST_REPLACE_WITH_ADMIN.signer-manager AUTH_ID
```

Run only the emitted `stacks-signer generate-staking-signature ... --json` command on the signer
host. Save its public JSON stdout; do not move the signer configuration or private key to the
Sidekick host. Copy the result into the running container and verify it:

```sh
docker compose cp ./signer-grant.json sidekick:/data/signer-grant.json
docker compose exec -T sidekick node /app/dist/main.js \
  signer-grant verify ST_REPLACE_WITH_ADMIN.signer-manager AUTH_ID /data/signer-grant.json
```

Sidekick verifies the live PoX-5 grant hash, manager, auth ID, signer key, and signature before
emitting encoded `register-self` arguments. Review those arguments, then use the same approved
external admin boundary to sign and broadcast the contract call. Record the transaction ID and wait
for confirmation.

Finally verify the on-chain result:

```sh
docker compose exec -T sidekick node /app/dist/main.js \
  setup status ST_REPLACE_WITH_ADMIN.signer-manager
```

Do not treat transaction submission as success. The final setup status must show the expected
manager registration, a valid signer grant, and current/next-cycle eligibility based on live data.

## 5. Exercise and preserve the V1 evidence

In the dashboard, run **Reconcile now**, review registration and pool status, and click through the
participants, cycles, rewards, activity, settings, and diagnostics views. API/indexer lag should be
resolved or allowed to catch up before evaluating a mismatch as a Sidekick defect.

Useful container checks are:

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose logs --tail=200 sidekick
curl --fail http://127.0.0.1:3998/health/live
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/metrics
```

Preserve the reviewed deployment files, public signer-grant JSON, transaction IDs, Sidekick commit
SHA, selected compatibility profile, node release, and timestamps. Generate a redacted support
bundle before sharing a bug report. Public principals remain operationally identifying, so review
logs and artifacts before posting them.

## 6. Upgrade independently

A node release or compatible public-network upgrade should normally require only a new reviewed
network-compatibility profile, not a Sidekick release. Sidekick application upgrades remain a
separate process: back up SQLite, build the reviewed Sidekick revision, restart, and verify
readiness as described in [container deployment](deployment.md#upgrade).

Authenticated compatibility attestations are intentionally deferred until Sidekick can authorize
transaction automation. Until then, profiles are operator-reviewed setup data and every state
change stays outside Sidekick.
