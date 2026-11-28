# Backups and restore

What to keep safe: **the database** and **`KEEL_SECRET_KEY`**. The key decrypts stored credentials (Slack,
GitHub, model keys). Lose it and a restored database needs those reconnected.

## Docker Compose

```bash
docker compose exec keel keel backup                      # → /backups/keel-20261128-0300.dump (a named volume)
docker compose exec keel keel backup -o - > keel.dump     # or stream it to the host
```

Nightly, from the host's cron:

```cron
17 3 * * *  cd /srv/keel && docker compose exec -T keel keel backup && docker compose exec -T keel sh -c 'ls -1t /backups/keel-*.dump | tail -n +15 | xargs -r rm -f'
```

Restore (stops nothing; run it on a quiet install):

```bash
docker compose exec -T keel keel restore - --yes < keel.dump
docker compose restart keel
```

## Helm

`--set backup.enabled=true` adds a CronJob (`backup.schedule`, default 03:17 daily) that writes
`keel backup` dumps to a PersistentVolumeClaim and keeps the newest `backup.keep` (14). Copy them off the cluster
with your usual volume snapshots, or:

```bash
kubectl exec deploy/keel-web -c web -- keel backup -o - > keel.dump
kubectl exec -i deploy/keel-web -c web -- keel restore - --yes < keel.dump
kubectl rollout restart deploy/keel-web deploy/keel-worker
```

With a managed Postgres (RDS, Cloud SQL, Azure), its own point-in-time backups are the better first line;
`keel backup` gives you a portable copy.

## How it works

`keel backup` runs `pg_dump --format=custom` (SQLite: the online backup API). `keel restore` replays the dump
into the configured database inside one transaction, then runs migrations, so a dump from an older Keel
restores into a newer one. Passwords go to `pg_dump`/`psql` through the environment, never the command line.
The image ships Postgres 17 client tools; restoring into a Postgres 16 server works (Keel drops the one
setting 16 doesn't know). Tested with Postgres 16.
