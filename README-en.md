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

## Release candidate

The current source prepares `v1.0.0-rc.5`. Qualified source `505c0bac` passed [Container Qualification #6](https://github.com/anysoft/ZhiXu/actions/runs/36816777711). The branding commit must pass the same qualification before an RC tag or release is created.

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
npm install -g pnpm@8.3.1
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
