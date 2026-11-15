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

## v2.0.0 installation

The default `Dockerfile` and `compose.yaml` run fresh-v2 with unified LOCAL/GIT Workspaces. Use a new project and dedicated volumes. Automatic v9 migration and in-place upgrades are unsupported; retain the original data.

Obtain image identity and assets from a completed, verified GitHub Release. Use a new deployment directory and retain any existing installation’s `.env`. In a repository checkout, prepare the service as follows. For release assets, copy `container.env.example` to `.env` instead:

```sh
cp .env.example .env
# Set ZHIXU_V2_IMAGE from release-manifest.json; prefer image@sha256:digest.
# Choose a new COMPOSE_PROJECT_NAME and the exact ZHIXU_V2_PUBLIC_ORIGIN.
docker compose config --quiet
docker compose pull
docker compose run --rm --service-ports platform-v2 --initialize
# After initialization and owner setup, stop with Ctrl+C and start normally:
docker compose up -d --wait
```

Open <http://127.0.0.1:5600>. The default configuration retains `v2-data`, `v2-backup` and `v2-scratch` volumes, with application data at `/data/state`, backups at `/backup/state` and temporary work at `/scratch/tmp`. The container runs as UID/GID `10001` with a read-only root filesystem. Keep the original project name and volumes when restarting an existing v2 installation, without reinitializing it.

See the [Docker deployment guide](./docs/deploy/docker.md) for configuration, verified managed runtimes, backup and restore. The source version does not prove that an image has been published; use the actual release assets.

## Build from source

```sh
git clone https://github.com/anysoft/ZhiXu.git
cd ZhiXu
npm install -g pnpm@10.34.9
pnpm install --frozen-lockfile
pnpm build:v2
```

Use the default `Dockerfile` for container builds and the Compose settings above for deployment.

## Release and qualification

- Current publication: [v2 release workflow](./docs/release/01-release-process.md)
- Accepted scope: [v2 scope decision](./docs/architecture/v2/V2_RELEASE_SCOPE_DECISION.md)
- Existing evidence and installation limits: [v2 release readiness](./docs/architecture/v2/V2_RELEASE_READINESS.md)

Historical RC15 qualification identifies its sealed artifacts. Rebuilt images have a new commit and artifact identity. Full CVE and supply-chain audits remain deferred and are not claimed as passed.

## Name

“Zhi” refers to Git branches, repositories, and worktrees. “Xu” refers to orchestration, execution order, and reliable recovery. References to the former project name remain only in historical records, upstream attribution, and explicit compatibility documentation.

## License

[Apache License 2.0](./LICENSE)
