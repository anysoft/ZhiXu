<div align="center">
<img width="100" src="./src/assets/zhixu-logo.svg" alt="ZhiXu">

# ZhiXu

[简体中文](./README.md) | English

**Git-native automation and task execution**

[Issues](https://github.com/anysoft/ZhiXu/issues) · [Security](./SECURITY.md) · [Docker deployment](./docs/deploy/docker.md)
</div>

## Capabilities

- Repository, Worktree, and Git-native code workspaces
- Shell, Python, JavaScript, and TypeScript tasks
- Managed Python/Node runtimes and isolated dependency environments
- Cron, webhook, and Git update triggers
- Task runs, live logs, retries, notifications, and recovery
- Config assets, hooks, and scoped global/repository/task environments
- Consistent backups, encrypted exports, restore, and disaster recovery foundations
- Qualified `linux/amd64` and `linux/arm64` containers

## v2 architecture release preparation: fresh-v2 only

v2 unifies LOCAL/GIT Workspaces and is prepared for fresh installation. Read the [release readiness and installation steps](./docs/architecture/v2/V2_RELEASE_READINESS.md) and [scope decision](./docs/architecture/v2/V2_RELEASE_SCOPE_DECISION.md). Use `compose.v2.example.yaml`, a new project with dedicated volumes, and port 5600. The default Dockerfile/Compose and the historical 1.0 instructions below are not a v9-to-v2 upgrade path.

The qualified code candidate is RC15. Its sealed embedded version remains `1.0.0-rc.6`; no `v2.0.0` package or tag has been created or published. Automatic v9 migration and in-place schema upgrades are unsupported. Never clear existing data to upgrade. Full security auditing is deferred with known risks retained; publication requires separate human approval.

## Historical 1.0 release candidate instructions

The current source prepares `v1.0.0-rc.6`. Qualified source `505c0bac` passed [Container Qualification #6](https://github.com/anysoft/ZhiXu/actions/runs/36816777711). The branding commit must pass the same qualification before an RC tag or release is created.

Download `compose.yaml`, `.env.example`, `release-manifest.json`, and `SHA256SUMS` from the same verified GitHub Release. After checking the hashes:

```bash
cp .env.example .env
# Set DOCKERHUB_IMAGE and PLATFORM_VERSION from release-manifest.json
docker compose config --quiet
docker compose pull
docker compose up -d --wait
```

The service listens at <http://127.0.0.1:5700> by default. The persistent volume is mounted at `/data`, with `DATA_DIR=/data/state`; backups use `/backup`. The image runs as UID/GID `10001` with a read-only root filesystem and requires neither a Docker socket nor privileged mode.

See the [Docker deployment guide](./docs/deploy/docker.md) for details.

## Development

```bash
git clone https://github.com/anysoft/ZhiXu.git
cd ZhiXu
npm install -g pnpm@10.34.9
pnpm install
pnpm start
```

Open <http://127.0.0.1:5700>.

## Status

- Functional baseline: [Platform 1.0 freeze](./docs/architecture/21-platform-1.0-freeze.md)
- Linux qualification: [Phase 15](./PHASE15_REPORT.md)
- Container and release engineering: [Phase 16B](./PHASE16B_REPORT.md)
- Branding and RC preparation: [Phase 17](./PHASE17_REPORT.md)

## Name

“Zhi” refers to Git branches, repositories, and worktrees. “Xu” refers to orchestration, execution order, and reliable recovery. References to the former project name remain only in historical records, upstream attribution, and explicit compatibility documentation.

## License

[Apache License 2.0](./LICENSE)
