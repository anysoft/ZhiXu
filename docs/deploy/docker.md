# Docker deployment — ZhiXu 1.0 RC

ZhiXu 1.0 RC packages the Git-native scheduling platform as a non-root, read-only-root container for Linux AMD64 and ARM64. The previous platform source at `505c0bac15b18e403ae59fabb2841caa4f53f367` passed native hosted qualification on both architectures. The Phase 17 branding commit must pass the same workflow before `v1.0.0-rc.1` is tagged or published.

No public RC image has been published yet. Use only the image digest and release assets recorded in a completed ZhiXu GitHub Release.

## Start from a verified release

Download `compose.yaml` and `.env.example` from the same verified release. Check `SHA256SUMS`, copy `.env.example` to `.env`, set `DOCKERHUB_IMAGE` from `release-manifest.json`, and select the exact `PLATFORM_VERSION`. Then run:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --wait
docker compose ps
```

Open <http://127.0.0.1:5700> and create the first administrator. The port is loopback-only by default. Use an authenticated TLS reverse proxy for remote access. Internal gRPC stays inside the container and is not published.

## Storage and identity

| Path | Responsibility |
|---|---|
| `/app` | Immutable application and production dependencies |
| `/data` | Persistent named volume owned by UID/GID 10001 |
| `/data/state` | `DATA_DIR`: database, repositories, worktrees, managed runtimes and environments |
| `/data/state.platform-control` | Restore staging, journals and recovery control |
| `/data/home` | Controlled Git/runtime home |
| `/data/.platform-jwt` | Persisted private JWT signing secret, mode 0600 |
| `/backup` | Separate persistent `BACKUP_DIR` volume |
| `/tmp` | Temporary writable `tmpfs` removed with the container |

Restore atomically renames the live data directory, so the volume mounts at `/data` while `DATA_DIR` is `/data/state`. Run one active instance per data volume. Never share a live SQLite directory between replicas.

Named volumes inherit the image's non-root ownership. Prepare UID/GID 10001 access for administrator-provided bind mounts. Startup deliberately avoids recursively changing ownership of user data. The platform runs as `10001:10001`, drops all capabilities, enables `no-new-privileges`, and uses a read-only root filesystem. It does not require a Docker socket, privileged mode, host PID, or host networking.

## Managed tasks

The application Node runtime runs the platform only. Tasks use explicitly installed Managed Runtimes and built Dependency Environments. Install a provider/runtime, create and build an environment, bind it to a Task, and verify readiness before execution. Host runtimes are deliberately fail-closed.

## Stop, upgrade and recover

Use `docker compose stop` and allow the 30-second grace period before maintenance. Before an upgrade, create a platform backup and encrypted portable export, copy it outside the Docker host, and store its passphrase separately. A backup volume alone does not protect against host loss. Do not run `docker compose down --volumes` unless permanent data deletion is intended.

For upgrades, stop the service, retain the backup/export, pull the exact qualified version, and start against the existing volumes. Arbitrary downgrade is not guaranteed; restore a verified compatible backup into a separate installation when rollback is required.

Portable restore imports logical runtime/environment records but excludes physical runtime installations. After restore and restart, rebuild runtimes and environments before executing tasks.

## Verification and platforms

The supported RC matrix is native `linux/amd64` and `linux/arm64`. Each release SHA must pass the hosted Container Qualification workflow before multi-architecture publication. `HEALTHCHECK` calls `/api/health`; initial startup may take up to the configured health start period.
