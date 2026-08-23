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

The database may contain API credentials; `gas-wallet.key` can spend its STX balance. Keep them as
one restore set.

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
was initiated.

## Reward runs

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
After a restart, preserve the same database and gas-wallet key so recovery cannot change signer or
nonce identity.

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose logs --tail=200 sidekick
```

For escalation, download the support bundle under **Settings → Support & security → Support &
maintenance**. It includes Sidekick, node, signer, manager, pool, and operation evidence. It excludes
credentials, private keys, signed transactions, environment dumps, and raw logs.
