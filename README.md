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

## Release Candidate

当前版本为 `v1.0.0-rc.5` 候选源码。Qualified source `505c0bac` 已通过 [Container Qualification #6](https://github.com/anysoft/ZhiXu/actions/runs/36816777711)；品牌迁移后的提交仍需重新完成同一资格流程，之后才会创建 RC tag 和发布产物。

从同一个已验证 GitHub Release 下载 `compose.yaml`、`.env.example`、`release-manifest.json` 和 `SHA256SUMS`。校验后运行：

```bash
cp .env.example .env
# 按 release-manifest.json 设置 DOCKERHUB_IMAGE 和 PLATFORM_VERSION
docker compose config --quiet
docker compose pull
docker compose up -d --wait
```

默认访问地址为 <http://127.0.0.1:5700>。数据卷挂载到 `/data`，实际 `DATA_DIR=/data/state`；备份卷挂载到 `/backup`。镜像使用 UID/GID `10001`，只读根文件系统且不需要 Docker socket 或特权模式。

完整说明见 [Docker 部署文档](./docs/deploy/docker.md)。

## 本地开发

```bash
git clone https://github.com/anysoft/ZhiXu.git
cd ZhiXu
npm install -g pnpm@8.3.1
pnpm install
pnpm start
```

打开 <http://127.0.0.1:5700>。

## 项目状态

- 功能架构基线：[Platform 1.0 freeze](./docs/architecture/21-platform-1.0-freeze.md)
- Linux 资格：[Phase 15](./PHASE15_REPORT.md)
- 容器与发布工程：[Phase 16B](./PHASE16B_REPORT.md)
- 品牌迁移与 RC：[Phase 17](./PHASE17_REPORT.md)

## 名称

正式产品名为 ZhiXu，没有中文别名。ZhiXu 源于经过大规模重构的 QingLong 代码库，当前作为 Git-native 自动化与任务调度平台继续发展。

## License

[Apache License 2.0](./LICENSE)
