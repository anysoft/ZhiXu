# Docker deployment — ZhiXu v2.0.0

The default `Dockerfile` and `compose.yaml` run fresh-v2 on Linux AMD64 and ARM64. Install into a new project with dedicated data, backup and scratch volumes. Existing v9 data cannot be upgraded in place, automatically migrated or cleared to make v2 start. Use only an image recorded in a completed, verified release; the source version alone does not prove publication.

## Start from a verified release

Work in a new deployment directory and retain any existing installation’s `.env`. Download `compose.yaml`, `container.env.example`, `release-manifest.json` and `SHA256SUMS` from the same release. Verify the downloaded files with `sha256sum --check SHA256SUMS` (macOS: `shasum -a 256 --check SHA256SUMS`). Then:

```sh
cp container.env.example .env
# Set ZHIXU_V2_IMAGE to image@manifest_digest from release-manifest.json.
# Choose a new COMPOSE_PROJECT_NAME and set the exact ZHIXU_V2_PUBLIC_ORIGIN.
docker compose config --quiet
docker compose pull
docker compose run --rm --service-ports platform-v2 --initialize
```

For a repository checkout, copy the root `.env.example` instead. Keep `.env` private and use the same file and project name for all subsequent commands. The shipped release template pins its image by digest. `ZHIXU_V2_PORT` controls the host port; if it changes, also update `ZHIXU_V2_PUBLIC_ORIGIN` to match the exact browser origin.

Open <http://127.0.0.1:5600>, create the first administrator and log in. After initialization and owner setup, stop the foreground service with Ctrl+C, then start normally without `--initialize`:

```sh
docker compose up -d --wait
docker compose ps
```

Initialization is explicit and only intended for a fresh data root. The entrypoint rejects unknown nonempty roots. The default port binds only to localhost; remote access needs a correctly configured public origin and authenticated TLS reverse proxy.

## Storage and identity

| Path | Responsibility |
|---|---|
| `/app` | Immutable application and production dependencies |
| `/data` | Persistent `v2-data` volume owned by UID/GID 10001 |
| `/data/state` | Fresh-v2 database, Workspaces, runtimes, environments and execution data |
| `/data/state.platform-control` | Restore staging, journals and recovery control; keep it with the data volume |
| `/data/home` | Private application home |
| `/backup/state` | Backup domain inside the separate `v2-backup` volume mounted at `/backup` |
| `/scratch/tmp` | Temporary work in `v2-scratch`; physical capacity plus at least 2 GiB free is required |
| `/tmp` | Private writable, executable tmpfs removed with the container |

Restore renames the data root, so mount its parent `/data`, not `/data/state`. Run one active service per data volume. Retain the existing `v2-data`, `v2-backup`, `v2-scratch` volume keys and the existing project name when restarting an established v2 installation. These keys deliberately differ from the retired v9 `data` and `backup` keys. Switching Compose files does not authorize deleting old containers or volumes.

Named volumes inherit UID/GID 10001 ownership from the image. Prepare that ownership yourself for bind mounts; startup does not recursively change user data. Keep the service non-root, read-only root filesystem, dropped capabilities, `no-new-privileges` and private executable temporary mounts. A Docker socket, privileged mode and host networking are unnecessary.

## Managed runtimes

The application Node runs the platform; Shell tasks work with the base Compose configuration. Managed Python/Node installation works online by default without an external artifact manifest: pyenv is fetched from its official GitHub repository at the pinned revision, Python is built with python-build, Node distributions are checked against official SHA256 checksums, and packages use the standard PyPI/npm registries. The image already supplies compiler and development libraries through apt.

For optional preapproved/offline artifact installation, use explicit artifact settings and mounts. Configure `ZHIXU_V2_RUNTIME_ARTIFACT_MODE`, `ZHIXU_V2_RUNTIME_ARTIFACT_STORE`, `ZHIXU_V2_RUNTIME_ARTIFACT_TRUST_ANCHOR` and `ZHIXU_V2_RUNTIME_ARTIFACT_MANIFEST` in a Compose override, with the protected trust anchor, correct platform package and private writable store. Adding these values only to `.env` does not inject them into the service.

See the [verified runtime installation guide](../architecture/v2/S5R_OFFLINE_RUNTIME_GUIDE.md) and [runtime configuration details](../architecture/v2/V2_RELEASE_READINESS.md#managed-runtime). Bind the installed runtime and built environment to the Task and check readiness before execution. Host runtimes do not substitute for verified managed runtimes.

## Stop, backup and restore

Use `docker compose stop` and allow the 30-second grace period before maintenance. Create a full backup through the application, export it encrypted, verify it and copy it outside the Docker host; store the passphrase separately. The backup volume alone does not protect against host loss.

Restore through the application's import, validation/preview and confirmation flow. Restart normally, verify recovery is complete, then rebuild the physical managed runtimes and environments before executing tasks. Keep the data root and its control domain together. Do not delete volumes or overwrite the only copy of source files to recover.

If SQLite is damaged or the Web service cannot start, use the image's independent [v2 backup CLI and disaster recovery procedure](disaster-recovery.md). It uses the same volumes and backup format without starting the Web service or opening the damaged database.

There is no v9-to-v2 upgrade path. Future v2 upgrades require an explicitly compatible schema and a verified backup. Arbitrary downgrade is not guaranteed; restore a compatible backup into a separate installation for rollback.

## Logs and storage maintenance

Compose keeps Docker stdout/stderr on the `json-file` driver with `max-size: 10m` and `max-file: '3'`. Equivalent standalone Docker options are `--log-driver json-file --log-opt max-size=10m --log-opt max-file=3`. The application never deletes Docker Engine log files and requires no cron or logrotate package.

Settings → Storage maintenance manages application-owned history and logs in the data volume. Daily maintenance defaults to 90 days for Task history, 30 days for Runtime operation history and 30 unused days for rebuildable download caches. Each retention can be set to keep forever. Running/recovering or referenced records are skipped; installed runtimes, environments, verified artifact stores, Workspaces, repositories and backups are preserved. Scans show counts and bytes before manual confirmation. Large cleanups are bounded batches and may require another scan.

## Release checks

The release workflow validates the repository's default Compose configuration and the exact Compose/environment assets attached to the release. Native AMD64/ARM64 image checks cover explicit initialization, the v2 system endpoint and frontend, owner login, real Shell execution and persisted state after restart. `HEALTHCHECK` reads `/api/system` and validates the fresh-v2 schema identity. Full CVE clearance remains deferred under the [accepted release scope](../architecture/v2/V2_RELEASE_SCOPE_DECISION.md).
