<div align="center">
<img width="100" src="./src/assets/zhixu-logo.svg" alt="ZhiXu">

# ZhiXu

简体中文 | [English](./README-en.md)

**Git 原生的自动化与任务执行平台**

[问题反馈](https://github.com/anysoft/ZhiXu/issues) · [安全策略](./SECURITY.md) · [Docker 部署](./docs/deploy/docker.md)
</div>

## 核心能力

- Repository、Worktree 与 Git 原生代码工作区
- Shell、Python、JavaScript 和 TypeScript 任务
- 受管 Python/Node Runtime 与隔离依赖环境
- Cron、Webhook 与 Git 更新触发器
- 任务运行、实时日志、重试、通知与恢复
- 配置资产、Hooks 和 Global/Repository/Task 作用域环境变量
- 一致性备份、加密导出、恢复与灾难恢复基础
- `linux/amd64` 与 `linux/arm64` 容器资格验证

## v2.0.0 安装

默认 `Dockerfile` 和 `compose.yaml` 均为 fresh-v2。v2 使用统一的 LOCAL/GIT Workspace，只支持全新安装，不自动迁移或接管 v9 数据。使用新项目和独立数据卷，保留旧数据。

从已完成且校验通过的 GitHub Release 获取镜像身份和发行附件。在新的部署目录操作，保留旧安装的 `.env`；仓库内可按以下步骤准备；从 Release 安装时，将其中的 `container.env.example` 复制为 `.env`：

```sh
cp .env.example .env
# 按 release-manifest.json 设置 ZHIXU_V2_IMAGE，优先使用 image@sha256:digest。
# 选择新的 COMPOSE_PROJECT_NAME，设置匹配访问地址的 ZHIXU_V2_PUBLIC_ORIGIN。
docker compose config --quiet
docker compose pull
docker compose run --rm --service-ports platform-v2 --initialize
# 完成首次初始化和管理员设置后 Ctrl+C 停止，再正常启动：
docker compose up -d --wait
```

默认访问地址为 <http://127.0.0.1:5600>。默认配置保留 `v2-data`、`v2-backup`、`v2-scratch` 三个卷；应用数据根为 `/data/state`，备份根为 `/backup/state`，临时目录为 `/scratch/tmp`。容器以 UID/GID `10001` 运行，使用只读根文件系统。重启已有 v2 安装时保持原项目名和卷，不再次初始化。

配置、受管 Runtime、备份与恢复步骤见 [Docker 部署文档](./docs/deploy/docker.md)。版本号不表示镜像已经发布，具体产物以实际 Release 为准。

## 源码构建

```sh
git clone https://github.com/anysoft/ZhiXu.git
cd ZhiXu
npm install -g pnpm@10.34.9
pnpm install --frozen-lockfile
pnpm build:v2
```

使用默认 `Dockerfile` 构建发行镜像，部署参数参照上述 Compose 配置。

## 发布与验收

- 当前发布流程：[v2 release workflow](./docs/release/01-release-process.md)
- 发布范围：[v2 scope decision](./docs/architecture/v2/V2_RELEASE_SCOPE_DECISION.md)
- 已有验收记录与安装限制：[v2 release readiness](./docs/architecture/v2/V2_RELEASE_READINESS.md)

RC15 历史资格对应其封存产物，重新构建的镜像具有新的提交和产物身份。完整 CVE 与供应链审计作为后续专项处理，不代表已通过。

## 名称

正式产品名为 ZhiXu，没有中文别名。ZhiXu 源于经过大规模重构的 QingLong 代码库，当前作为 Git-native 自动化与任务调度平台继续发展。

## License

[Apache License 2.0](./LICENSE)
