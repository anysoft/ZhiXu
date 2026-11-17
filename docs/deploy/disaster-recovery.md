# ZhiXu v2 offline backup and disaster recovery

The image includes `node /app/static/build/backupCliV2.js`; no source checkout, ts-node, Web service or browser login is needed. It uses the existing full v2 snapshot and encrypted Portable formats. Keep the same Compose project, `.env`, image and `v2-data`, `v2-backup`, `v2-scratch` volumes throughout recovery. Do not run `docker compose down -v`.

Commands below run from the deployment directory containing `compose.yaml` and `.env`. The CLI reads `/data/state` and `/backup/state` from the service's existing environment. For a different location, explicitly pass `--data-root /absolute/path --backup-root /absolute/path`.

## Stop the service and inspect backups

```sh
docker compose stop platform-v2
docker compose ps -a
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js status
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js list
```

`run` starts one temporary maintenance container on the existing volumes and removes that container afterward. It does not publish the Web port. The normal backend must be stopped; the CLI refuses to replace a data root with an active backend owner. SQLite may be damaged: listing, inspection and verification use the backup directory and the backup's own database.

Copy an ID returned by `list`, then inspect and verify it:

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js info SNAPSHOT_ID
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js verify SNAPSHOT_ID
```

Use the actual ID in place of `SNAPSHOT_ID`. Verification checks the Manifest, SQLite integrity and file hashes before recovery. A failed command exits nonzero and reports an error code and a next-step hint; do not continue with a rejected backup.

## Create a local snapshot while offline

When the current database is healthy and all operations have ended, a stopped instance can create a full local snapshot:

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js create
```

This command requires a valid existing v2 installation. It cannot create a backup from a corrupt database. Export an encrypted Portable file through the existing application flow while the application is healthy and keep an external copy, with its passphrase stored separately.

### Choose a backup mode

`create` defaults to `FULL`, as does the Web backup page. You can select the mode explicitly:

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js create --mode full
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js create --mode lightweight
```

`FULL` preserves the current complete local Git repositories and checked-out files, alongside the database, LOCAL Workspaces and business data. It can restore those saved bytes when the remote repository is unavailable. Remote-only objects and external LFS/submodule data that were never downloaded are not an offline guarantee; check the backup's warnings.

`LIGHTWEIGHT` keeps the database, configuration and LOCAL Workspaces in full, and saves Git references, exact commit IDs and local deltas instead of complete Git repositories and checkouts. Git restoration needs the original remote repository, required base objects and working credentials/proxy. The candidate is rebuilt and checked before publication; if the remote is unavailable, keep the original data and use a `FULL` backup. Both modes use the same encrypted Portable format and restore commands below. `list`, `info` and `verify` report the mode and recovery dependencies.

### Daily automatic backups

Settings → Backup / Restore includes automatic backups. The default is enabled at 03:00 every day in the platform timezone, falling back to `Asia/Shanghai`, with the latest three successful automatic snapshots retained. The timezone is explicit and independent of the container's clock display. The page shows the next execution/retry time, supports changing the retention count or disabling the schedule, and can run one automatic LIGHTWEIGHT backup immediately.

Automatic backups and retries always use LIGHTWEIGHT; manual Web and CLI backups still default to FULL. After downtime, startup catches up at most one missed daily cycle. Busy operations are not terminated; failures retry at most twice, about 15 minutes apart. Recent execution results and any disk-space or cleanup error appear on the same page.

Retention starts only after a new automatic snapshot succeeds and passes validation. It never deletes manual or legacy snapshots, Preservation-held snapshots or backups referenced by an active Restore Journal. Protected backups may leave more files than the configured count. Keep sufficient room for a new snapshot: an existing valid backup is not deleted to make the next attempt fit. Automatic settings and scheduling do not replace the offline CLI recovery flow below.

## Restore a local snapshot

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js restore --snapshot SNAPSHOT_ID
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js status
```

Recovery validates a separate candidate before switching the data directory. Existing data, including a damaged SQLite file, is retained in the control domain's quarantine directory. Keep `/data/state.platform-control` and the reported preserved-data paths until the restored instance has been checked. Do not manually copy a backup database over `/data/state/db/database.sqlite`.

## Restore an encrypted Portable file

The target may be an existing stopped installation or an empty data volume. Use the normal Compose volumes; do not initialize a new business database first. A fresh Compose project is appropriate when recovering onto new volumes.

Copy the encrypted file into the backup volume as the service UID. This also avoids bind-mount ownership differences between Docker hosts:

```sh
docker compose run --rm --no-deps -T --entrypoint sh platform-v2 \
  -c 'umask 077; cat > /backup/recovery.encrypted' < ./backup.encrypted
```

Create a private passphrase file interactively in that volume. The passphrase is not echoed or placed in command arguments:

```sh
docker compose run --rm --no-deps --entrypoint bash platform-v2 -c \
  'umask 077; IFS= read -r -s -p "Backup passphrase: " backup_passphrase || exit 1; printf "\n"; printf "%s" "$backup_passphrase" > /backup/recovery.passphrase; unset backup_passphrase'
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js restore \
  --file /backup/recovery.encrypted \
  --passphrase-file /backup/recovery.passphrase
```

The CLI also accepts `--passphrase-stdin` instead of `--passphrase-file`; use `docker compose run -T` for a pipe. Pass only the password bytes on stdin. A wrong password or rejected file stops recovery before replacing target data.

After successful recovery, remove only the temporary passphrase file:

```sh
docker compose run --rm --no-deps --entrypoint sh platform-v2 \
  -c 'rm -- /backup/recovery.passphrase'
```

## Restart and confirm

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js status
docker compose up -d --wait platform-v2
docker compose ps
docker compose logs --tail 100 platform-v2
```

Restart normally, without `--initialize`. Log in and check the restored Workspaces, repository files, Tasks and settings. Full snapshots preserve their logical configuration; physical managed Python/Node runtimes and dependency environments need rebuilding before their Tasks are ready. Follow the existing Runtime readiness guidance rather than deleting restored configuration.

If recovery was interrupted, keep the service stopped and run `status` first. When its next action is `RESTORE_RESUME`, resume the existing journal:

```sh
docker compose run --rm --no-deps --entrypoint node platform-v2 \
  /app/static/build/backupCliV2.js restore --resume
```

If LIGHTWEIGHT Git reconstruction fails because the remote or required base objects are unavailable, the existing Journal/candidate may remain at `PREPARING` while the original data stays unchanged. Restore remote access (including credentials/proxy), then use `restore --resume`. A pending Journal blocks selecting another backup on the same data root. To use a `FULL` backup instead, restore it to a separate fresh data root (`--data-root /absolute/new/root`) or a new data volume, retaining the original root and Journal; verify that recovery before changing the deployment to use it.

Preserve the candidate, quarantine and failed directories; do not delete journals or guess which SQLite file to copy. If `status` reports a rejected journal, a busy owner, insufficient space or failed validation, resolve the reported issue before starting the service.
