# Operations

Reuse the `COMPOSE_FILE` value from installation.

## Upgrade

Wait for submitted transactions to resolve. Back up SQLite, pull the pinned release, and recreate:

```sh
backup="sidekick-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
mkdir -p backups
docker compose exec -T sidekick node /app/dist/main.js database backup "/data/$backup"
docker compose cp "sidekick:/data/$backup" "backups/$backup"
docker compose exec -T sidekick rm "/data/$backup"
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3998/health/ready
```

The database may contain API credentials. Store backups accordingly.

## Restore

Replace `SIDEKICK_BACKUP.sqlite` with the selected backup filename.

```sh
docker compose down
docker compose run --rm --no-deps --user 0 --entrypoint sh \
  -v "$PWD/backups:/backups:ro" sidekick \
  -c 'set -eu
q=$(mktemp -d /data/restore-quarantine.XXXXXX)
for f in /data/sidekick.sqlite /data/sidekick.sqlite-wal /data/sidekick.sqlite-shm; do
  if [ -e "$f" ]; then mv "$f" "$q/"; fi
done
cp /backups/SIDEKICK_BACKUP.sqlite /data/sidekick.sqlite
chown 10001:10001 /data/sidekick.sqlite'
docker compose run --rm --no-deps sidekick doctor
docker compose up -d
```

## Diagnose

```sh
docker compose exec -T sidekick node /app/dist/main.js doctor
docker compose exec -T sidekick node /app/dist/main.js doctor connectivity
docker compose logs --tail=200 sidekick
```

For escalation, download the support bundle under **Settings → Support & security → Support &
maintenance**. It includes Sidekick, node, signer, manager, pool, and operation evidence. It excludes
credentials, private keys, signed transactions, environment dumps, and raw logs.
