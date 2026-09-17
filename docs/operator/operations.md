# Operations

Reuse the `COMPOSE_FILE` value from [installation](deployment.md). Commands below affect only
Sidekick, not the Stacks node or signer.

## Upgrade

1. Review the target release notes. Finish or pause reward work at a transaction boundary and record
   unresolved transaction IDs. Do not approve new work during the upgrade.
2. Back up with the **current image and configuration**, before selecting the new version:

```sh
umask 077
backup="backups/$(date -u +%Y%m%dT%H%M%SZ)"
(
set -eu
mkdir -p "$backup"
docker compose stop sidekick
docker compose run --rm --no-deps sidekick database backup /data/sidekick-backup.sqlite
docker compose cp sidekick:/data/sidekick-backup.sqlite "$backup/sidekick.sqlite"
docker compose run --rm --no-deps --entrypoint rm sidekick /data/sidekick-backup.sqlite
)
```

Stop if any backup step fails. If a gas wallet exists, also copy its key before proceeding:

```sh
docker compose cp sidekick:/data/gas-wallet.key "$backup/gas-wallet.key"
chmod 600 "$backup/gas-wallet.key"
```

Keep the database, key, protected `.env`/profile configuration and old image/commit identity as one
restore set. The database can contain API credentials; the key can spend the gas balance. A backup
is incomplete if a configured gas-wallet key is missing. Keep Sidekick stopped until the set is safe.

3. Select the target release checkout and set its `SIDEKICK_IMAGE_TAG` in `.env`. On large stores,
   first time migration on an isolated database copy with `doctor`; do not start workers or signing
   against that copy. Then recreate:

```sh
docker compose pull sidekick
docker compose up -d --no-deps sidekick
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/health/operational
```

4. Retry the operational probe while startup is pending, then check build identity, history,
   submitted work and background freshness. Do not mistake container health for indexing completion.

Migration 40 records run/sweep execution sources and preserves legacy halted-run diagnostics.
Schema 41 adds ten Activity/observer indexes; schema 42 indexes settings revisions. Schema 43 adds
snapshot retention metadata and history-read indexes. These migrations do not delete or rewrite
financial rows. File-backed upgrades take an automatic pre-migration backup. Older binaries refuse
newer schemas; rollback needs the
compatible database, not just the old image. Never restore over newer submissions without reconciling
them first.

## Restore

A restore discards everything recorded since the backup, including attempts the chain may still
execute. Stop and investigate if the current database contains a newer approval or submission.
Keep its evidence; do not restore to make an ambiguous transaction disappear.

Set `SIDEKICK_ENGINE_MODE=observe` in `.env` before restoring. Select the intended image and a
validated, matching-network/manager backup. If the backup had a gas wallet, its original key is
required. The commands quarantine existing data rather than deleting it:

```sh
(
set -eu
restore=REPLACE_WITH_BACKUP_DIRECTORY_NAME
test -f "$PWD/backups/$restore/sidekick.sqlite"
docker compose stop sidekick
docker compose run --rm --no-deps --user 0 --entrypoint sh \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  -v "$PWD/backups/$restore:/restore:ro" sidekick \
  -c 'set -eu
test -f /restore/sidekick.sqlite
q=$(mktemp -d /data/restore-quarantine.XXXXXX)
for f in /data/sidekick.sqlite /data/sidekick.sqlite-wal /data/sidekick.sqlite-shm /data/gas-wallet.key; do
  if [ -e "$f" ]; then mv "$f" "$q/"; fi
done
cp /restore/sidekick.sqlite /data/sidekick.sqlite
chown 10001:10001 /data/sidekick.sqlite
chmod 600 /data/sidekick.sqlite
if [ -f /restore/gas-wallet.key ]; then
  cp /restore/gas-wallet.key /data/gas-wallet.key
  chown 10001:10001 /data/gas-wallet.key
  chmod 600 /data/gas-wallet.key
fi'
docker compose run --rm --no-deps sidekick doctor
docker compose up -d --no-deps sidekick
)
```

Check identity, history and every unresolved transaction before re-enabling operator-run. Preserve
the quarantined data until reconciliation is complete. Never run two services against one store
or enable signing on a copied production database.

## Recovery and freshness

A temporary node failure is rechecked without a browser or restart. Connection/startup retries and
snapshot refresh back off to five minutes each; combined recovery can take about ten minutes plus
request/startup time after upstream recovery. Positive identity/network refusals still block work.

| Probe | Meaning |
| --- | --- |
| `/health/live` | Process liveness |
| `/health/ready` | Sidekick and its database can serve requests; a node outage alone does not fail it |
| `/health/operational` | Workers started, connection/preflight pass and node-health evidence is available |

The operational probe returns 503 `operational-startup-pending` until workers start, including
during automatic startup retries. Diagnostic warning findings alone do not fail it.

Read each domain separately: `/api/v1/sync` describes roster/history reconciliation, reward coverage
describes recovered accounting, and callback queue/gap metrics describe verification. None alone
proves everything is current.

`sidekick_operator_snapshot_age_seconds` and `sidekick_operator_snapshot_fresh` describe retained
generation age (60-second default budget). The `sidekick_operator_snapshot_refresh_*` metrics
describe in-progress work and failures; `sidekick_operator_snapshot_last_success_timestamp_seconds`
records last success and `sidekick_operator_snapshot_retry_backoff_seconds` the retry delay.
An aged snapshot during a healthy read is not proof the node is behind.

Visible pages refresh automatically and on focus. Failures retain dated values with a local retry.
A “Settings saved, but status refresh failed” notice means retry observation, not the save.
Saved wallet intents remain accessible by ID even when new preparation is unavailable.

## Rewards

- **Earning:** current accrual and the next one-week calculation forecast, kept separate.
- **Distribute:** oldest pending distribution first, with its next action and paged payments.
- **Past cycles:** distributions, payments, rolled-forward reasons and per-cycle/distribution CSV.
- **Accounting:** indexed earned fees and whole-history export; unknown fees are not zero.

Use **Older cycles** / **Newer cycles** for retained reward history. Accounting exports walk all
cycle pages; selected-cycle exports stay scoped. Unavailable evidence or a safety limit produces a
`-partial` download and `x-sidekick-history-complete: false`. The fee-refund event list retains its
1,000-row display limit and marks truncation separately; older events remain in Activity/SQLite.
Downloads spool to private temporary storage before sending headers, so completeness covers every
page. Large exports need `/tmp` space; an exhausted filesystem fails the download, never silently
truncates it. A disconnect or process exit releases the anonymous file.
Exports describe the evidence read during pagination, not an atomic database snapshot.

Pool/position detail is kept for 21 days, then compacted in small background batches. Position
changes, first/latest state, cycle/weekly-distribution boundary samples, and unclassifiable legacy
rows remain. Payments and signing/reconciliation evidence are never pruned by this policy. Old
detail catches up gradually after an upgrade; database files need not shrink as free pages are
reused. Do not run an automatic `VACUUM` or remove migration backups as part of routine cleanup.

Partial/estimated allocations are labeled. Contract-rounding reserve is not operator fee income.
Missing interpretation or evidence means details unavailable, not that the pool earned nothing.
The Overview card distinguishes accruing, ready, distributing, complete, needs attention and overdue.

A ₿ marker shows the staker's **currently registered** Bitcoin address, not a proved historical
destination. Stacks withdrawal-request success is not BTC delivery. Payment details distinguish
the request, registry acceptance/Bitcoin sweep proof and manager retirement. The accepted-withdrawal
cache currently has a known-reorg display limitation; investigate conflicting evidence rather than
treating a cached arrival as fresh proof.

## Reward runs

Start from a Distribute card. Recipe preparation is server-owned and resumes after restart.
Review the sealed count, amounts and gas budget, then **Go**. Defaults: start approval within
30 minutes, at most 200 transactions, and a six-hour runtime once started. One run or sweep owns
the gas wallet; only one transaction is in flight.

Pause/Cancel stop further work but cannot undo a broadcast. A halted run requires review and
explicit Resume; an expired run cannot resume. Resume reconciles the saved attempt, never blindly
signs a replacement. Preserve the database and gas-wallet key across restart.

Typed transient read failures wait within the original deadline. Positive conflicts, hard refusals
and ambiguous submission halt. **Settings → Reward runs → Force Observe** or gas-wallet Disable
stop signing, not observation. Future work still requires fresh anchored node checks and approval.

## Transaction observation

The server observes submitted work without a browser or enabled gas signer, after operational
startup. Cold boot still needs an accepted node connection before these workers start.

| Work | Normal checks | Backoff |
| --- | --- | --- |
| Running run's broadcast child | 30 seconds, including API pending/404 | Unavailable/throwing reads and Retry-After, capped at five minutes |
| Submitted wallet or broadcast sweep | 30 seconds | Missing/unavailable reads, or unchanged wallet success with an extra check pending: 30, 60, 120, 240, then 300 seconds |

Wallet/sweep scans add up to 30 seconds to the per-item wait; source latency or a busy pass adds
time. Missing work is not retired by age. Manual Refresh bypasses pacing and coalesces in-flight
reads; explicit run Resume checks its existing attempt immediately. Restart resets pacing, not
the run deadline or transaction identity.

Details show **local node**, **API + local node** or **configured API** execution evidence.
Runs/sweeps can use coherent API execution with revalidated signing-time binding; wallets need
retained exact mempool verification of the same intent/txid, otherwise node bytes. An API summary
alone is insufficient. Positive conflicts veto API-only completion. Calculate verifies the sealed
cycle/checkpoint from its receipt; historical-job or asset-semantic checks may remain pending. See
[ADR 0008](../architecture/decisions/0008-chain-evidence-and-reconciliation.md).

An eligible missing browser-wallet submission may be explicitly replaced only after fresh absence
checks and its 15-minute propagation grace. Unavailable reads and conflicts do not grant replacement.
An ambiguous sweep keeps its authorization until a verified terminal result; there is no automatic
abandonment or second sweep. An expired run with a broadcast child likewise needs investigation,
not blind re-approval.

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose logs --tail=200 sidekick
```

Use **Settings → Support bundle** to download retained diagnostics with original timestamps.
Missing sections are unavailable; asynchronous sections have a two-second collection bound.
The export starts no live balance, connection or health probe. It excludes credentials, private
keys, signed transactions, environment dumps and raw logs. For a stopped service, CLI `doctor`
opens and may migrate the selected store; use the intended image.

## API traffic

Background collection continues with the browser closed. Compatible indexed/comparison status
reads share a 30-second advisory result, without caching fresh preparation or transaction evidence.
The Bitcoin timing display refreshes one recent page every five minutes and reconciles its
200-block window hourly; changed overlap triggers a full refresh.

Local health samples are collected every ten seconds. Observer-gap checks reuse a successful node sample
up to twenty seconds old, falling back to RPC if it is missing, failed, stale or from another configuration.
Background reward/forecast reads share at most 512 contract values for one node and exact block hash,
for up to five minutes, with eight concurrent reads. Canonicality is checked before reuse; local
projections still rebuild. Failures/reorgs clear the cache. Explicit refresh and preparation bypass it.

`/metrics` is outside API bearer authentication; keep the listener private (loopback by default).
It exposes `sidekick_upstream_requests_total` by normalized origin, route,
method and status. It counts HTTP attempts including retries; `no_response` means no headers arrived.
Validation failure after HTTP 200 still counts as 200; checks blocked before HTTP are not counted.
Credentials, queries and transaction/principal IDs are omitted; excess labels roll into `other`.
Counters reset on restart and are separate from incoming dashboard traffic.

Compare stable windows for one instance:

```promql
sum by (origin, route) (rate(sidekick_upstream_requests_total[15m])) * 60
sum by (origin) (increase(sidekick_upstream_requests_total[24h]))
```

Backfill, active work, retries and manual requests add traffic. Measure them separately; no timer
estimate is a daily quota. Reusing a failed advisory result does not restart its cooldown. Fresh
transaction checks do not use that advisory cache.

Contract-read savings depend on how long the roster anchor stays unchanged; a moving anchor,
large pool or repeated failure reduces reuse. Compare endpoint counts **and** node RPC latency/CPU
before and after upgrading, with separate idle, catch-up and payout windows.

## Local read performance check

After building:

```sh
node scripts/benchmark-runtime-reads.mjs 20000
node scripts/benchmark-runtime-reads.mjs 220000
```

The script creates/removes its own synthetic SQLite fixture and reports 30 warmed p50/p95/max
reads, event-loop delay and SQL prepares for Activity, maintenance, observer and health status.
It includes empty polls, callbacks interleaved with status reads, and a 100-child run. Callback
lifecycle timings include ingestion and completion, not just cached GETs. No live source,
production database or financial action is used. Compare the same fixture, runtime and hardware.
This is not HTTP/browser latency, callback lag or daily API usage; validate those per instance.

Observer lifetime totals rebuild on first use or an external database commit, then follow committed
inbox changes. Queue/gap reads remain fresh and do not require that rebuild. No history is deleted.
