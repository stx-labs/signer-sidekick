# Operations

Reuse the `COMPOSE_FILE` value from installation.

## Upgrade

Prefer to finish or pause an active reward run between transactions. Back up SQLite and the gas
wallet together, then pull the pinned release and recreate:

```sh
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "backups/$stamp"
docker compose exec -T sidekick node /app/dist/main.js database backup /data/sidekick-backup.sqlite
docker compose cp sidekick:/data/sidekick-backup.sqlite "backups/$stamp/sidekick.sqlite"
docker compose exec -T sidekick rm /data/sidekick-backup.sqlite
if docker compose exec -T sidekick test -f /data/gas-wallet.key; then
  docker compose cp sidekick:/data/gas-wallet.key "backups/$stamp/gas-wallet.key"
  chmod 600 "backups/$stamp/gas-wallet.key"
fi
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
curl --fail http://127.0.0.1:3998/health/operational
```

The operational probe returns HTTP 503 with `operational-startup-pending` until operational
workers finish starting. This is expected briefly after `up -d`; retry the probe. Failed startup
is retried in the background, while `/health/live` and `/health/ready` remain available for diagnosis.

The database may contain API credentials; `gas-wallet.key` can spend its STX balance. Keep them as
one restore set.

## Recovery and freshness

A temporary node failure does not require a browser request or service restart to recheck the
connection. Sidekick reassesses it at a normal 30-second cadence, with exponential failure backoff
up to five minutes. Operational worker startup is awaited and retried if it fails; already-started
workers keep their existing lifecycles. A proved identity/network mismatch still blocks operations.
Connection and snapshot backoffs can combine to roughly ten minutes, plus request/startup time.
This is a timer bound after upstream recovery, not a guarantee that upstreams recover.

Use each domain's evidence rather than one global "synced" timestamp:

- The dashboard's **Current snapshot** indicator refers to its operator snapshot only.
- `/sync` records a full roster/manager reconciliation, including bounded pool/member history
  work. It is not the last successful callback verification or reward-history observation.
- Reward ledger coverage and accounting history describe their own recovered evidence.
- Callback queue/gap metrics show verification work, independently of the node's chain tip.
- `sidekick_operator_snapshot_age_seconds` and `_fresh` describe retained snapshot age. The
  `_refresh_in_progress`, `_refresh_consecutive_failures`, `_retry_backoff_seconds` and
  `_last_success_timestamp_seconds` metrics describe the refresh worker. An aged snapshot during
  a healthy in-flight refresh is not proof the node is behind. Container readiness is not indexing
  completeness either.

Visible Rewards, Pool and reward-run Settings refresh automatically and on focus. If a resource
refresh fails, retained values stay on screen with a local error; payment history also offers a
retry and reloads when reopened. A "Settings saved, but status refresh failed" notice means the
write succeeded: retry observation, not the save.

Prepared wallet transactions can be reopened from their action URL's `intentId` or Activity even
when new-action eligibility changes. Viewing and verification remain available through a stale
snapshot, but fresh evidence is required for new preparation/signing. Completion evidence rules
are unchanged. Already-halted reward runs still require operator review and explicit resume.
Running runs now wait through typed upstream/rate-limit failures and retryable anchor reads on their
existing maintenance tick, without extending the original runtime deadline. Cached connection
unavailability does not cause a manual-resume halt; a positive identity refusal still does.

## Restore

Set `restore` to the selected backup directory.

```sh
restore=REPLACE_WITH_BACKUP_DIRECTORY
docker compose down
docker compose run --rm --no-deps --user 0 --entrypoint sh \
  -v "$PWD/backups/$restore:/restore:ro" sidekick \
  -c 'set -eu
q=$(mktemp -d /data/restore-quarantine.XXXXXX)
for f in /data/sidekick.sqlite /data/sidekick.sqlite-wal /data/sidekick.sqlite-shm /data/gas-wallet.key; do
  if [ -e "$f" ]; then mv "$f" "$q/"; fi
done
cp /restore/sidekick.sqlite /data/sidekick.sqlite
chown 10001:10001 /data/sidekick.sqlite
if [ -f /restore/gas-wallet.key ]; then
  cp /restore/gas-wallet.key /data/gas-wallet.key
  chown 10001:10001 /data/gas-wallet.key
  chmod 600 /data/gas-wallet.key
fi'
docker compose run --rm --no-deps sidekick doctor
docker compose up -d
```

## Rewards

The Rewards page is one view of the reward cycle:

- **Earning** — the accruing cycle: time left in the half, the next prepare phase, what the network
  and this pool have earned or are projected to earn, and each half's distribution status.
- **Distribute** — one card per distribution that still needs you, oldest first, with its single
  next action (Collect & distribute, Distribute, Collect, Run calculation, Finish Bitcoin payouts),
  its four figures, and its payments ten per page.
- **Past cycles** — one line per cycle; open it for each distribution's payments, why a payment
  rolled forward to the Second Distribution, and CSV export of that distribution or cycle.
- **Accounting** — your fee ledger and the export of the whole history.

A ₿ beside a staker marks a Bitcoin payout; hover it to see and copy their currently registered
address. Historical manager events do not prove which address was registered when an older payout
was initiated. Once the sBTC signers sweep an accepted withdrawal, the payment shows the Bitcoin
transaction and block (read from the registry on the local node and kept), and the `txid` marker
beside a status lists every transaction behind a payment — for a Bitcoin payout, the sweep plus its
Stacks request and retirement.

## Reward runs

Submitted wallet transactions and gas-wallet sweeps are checked by the server even after the
browser closes. Checks normally run every 30 seconds. Missing transactions and unavailable reads
back off through 30 seconds, 1, 2, 4 and then 5 minutes between checks, without ever being dropped.
A late appearance can therefore take up to five minutes plus the next 30-second scan to be picked
up, with source latency, outages or a busy observation pass adding time. Manual **Check status**
or **Refresh** bypasses that wait. Restart resets the in-memory backoff and checks retained work
again. Missing does not mean failed and never authorizes another sweep.

An active run checks its broadcast transaction every 30 seconds, while the five-second maintenance
tick still enforces the original runtime deadline. Unavailable receipt reads back off through the
same five-minute schedule; upstream Retry-After hints are capped at five minutes so a single
oversized hint cannot silence observation for the remainder of the run's lifetime.
A healthy API with no terminal receipt (including pending or 404) stays on the normal 30-second
cadence. Confirmation can take the remaining wait plus source latency to appear. Explicit Resume
of a halted run rechecks its existing attempt immediately; it does not sign a replacement.

A wallet transaction with known canonical success but an unchanged, still-pending additional
checkpoint/job/semantic check also backs off to five minutes. New evidence or a changed diagnostic
returns it to the ordinary cadence. Manual Refresh still checks immediately and can complete the
action once the required evidence is available. These timing changes do not loosen completion checks.

A run starts from a Distribute card. Sidekick first prepares its sealed recipe in the background;
large pools can take a few minutes, survive a closed browser, and resume preparation after restart.
Review the resulting transaction count, then Go. Execution is also server-side, one transaction at
a time. Progress, Pause, Resume, and Cancel stay on the card, and Activity keeps the record. Pause
or cancel only between transactions; cancellation cannot undo a broadcast transaction. Another
run cannot start until the current one finishes.

The gas wallet pays only network fees. A banner on Rewards warns when its balance cannot cover the
next run — top it up from any wallet. **Settings → Reward runs → Force Observe**
halts all signing at once; **Settings → Gas wallet** disables the wallet or sweeps its STX.

If a run halts after an ambiguous broadcast, inspect its recorded transaction ID and chain evidence.
Do not send a replacement. Resume makes Sidekick reconcile the existing attempt before continuing.
During a retryable read failure the run stays running, makes no new signature from that failed read,
and logs that it is waiting for upstream recovery. Retrying reads is not retrying submission: a
failure after a signed attempt is persisted still halts rather than risking another broadcast.
After a restart, preserve the same database and gas-wallet key so recovery cannot change signer or
nonce identity.

Submitted browser-wallet transactions and gas sweeps also continue being observed after closing the
dashboard or restarting Sidekick. Disabling the gas signer does not disable observation. Normal
pages read the retained result; manual verification refresh remains available.

Once the operational runtime has started, locally signed runs and sweeps may finish observation
using the configured API during a node outage. Activity and sweep history show **configured API**,
**API + local node**, or **local node** as the execution evidence. The API is an operational trust
source; its execution record must be coherent and match the saved signing-time transaction ID and
sealed plan. Missing binding or an unresolved conflict keeps verification pending. A confirmed API
abort halts the run/fails the sweep; it never causes an automatic replacement transaction.
Preparing or signing the next transaction still needs the connected node. Browser wallets may use
API execution if Sidekick previously verified their exact mempool bytes against the same sealed
intent. If Sidekick never saw those bytes, verification waits for node recovery; an API's summary
alone does not suffice. Wallet details and Activity show the source. Manual Refresh verification
works during cached unavailability for submitted IDs, without permitting a new preparation,
submission or replacement. Extra calculation, legacy-job and asset-semantic verification may still
wait after execution is known; the UI keeps that distinction. Cold boot still waits for a connected
node to start operational workers. Migration 40 records run/sweep evidence sources; older history is not
assigned a guessed source. An older halted run with a retained diagnostic may require positive
node corroboration after resume. Preserve the automatic pre-migration database backup if rolling
back to an older binary; older versions cannot open the newer schema.

Wallet provenance uses existing observation metadata and adds no migration. Preserve the database:
its original exact mempool verification is the durable byte binding, even after later missing
observations. An unresolved positive conflict cannot be cleared by an API receipt alone.

A gas sweep with an ambiguous broadcast retains its transaction ID and wallet authorization even
if lookups report it missing for longer than the original approval window. Do not prepare a second
sweep or reset the database. Positive canonical conflicts are shown on the active sweep; the wallet
stays reserved until a verified terminal outcome. Confirmation can release it automatically, without
another signature. A permanently missing ambiguous sweep currently needs operator investigation;
there is no automatic abandonment or replacement policy.

An action marked complete records historical execution. A later fee/admin/registration change or
new rewards on the same settlement account does not undo that transaction. For a Bitcoin-route
staker claim, this means the Stacks withdrawal request succeeded, not that BTC arrived in the wallet.

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose logs --tail=200 sidekick
```

For escalation, download the support bundle under **Settings → Support & security → Support &
maintenance**. It includes Sidekick, node, signer, manager, pool, and operation evidence. It excludes
credentials, private keys, signed transactions, environment dumps, and raw logs.
