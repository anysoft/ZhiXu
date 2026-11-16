# ZhiXu v2.0 — Release Readiness

结论：**重构验收PASS，功能发行准备YES，可提交人工发布审批；尚未获得发布授权。** 本轮按[发布范围决策](V2_RELEASE_SCOPE_DECISION.md)核对既有RC15，未重跑S5全矩阵、未重新构建、未继续CVE专项。

## Version / Candidate

| 项目 | 本次审批对象 |
|---|---|
| 产品范围 | ZhiXu v2.0架构，Fresh Installation |
| 已验证代码RC15 | `58cfda832bf556a96e0ebc1b0722116d9c20fd4e` |
| Code tree | `70a730f0599b201158bf3115badcde5cec132f7f` |
| 入场HEAD | `ce58ea3d860399f2005e35c411296e27a7c5bc7a`，相对RC15仅S5.R报告/证据提交 |
| 包内版本 | `package.json` / `version.yaml`均为 `1.0.0-rc.6`，本轮保持不变 |
| 发行状态 | 本地封存，未Push/Tag/Publish/Deploy，未生成带v2.0.0版本的新包 |

本次审批针对表中确切RC15字节及本轮发行说明。“架构v2.0”与内嵌SemVer分别记录。如正式发布要求改为v2.0.0，发布阶段须记录新版本/新产物Hash并检查相关影响，不能将重封后的包称为原RC15归档。

## Functionality / Regression

以下全部为 **REUSED_VERIFIED_EVIDENCE**，本轮未重新执行：

| 项目 | RC15既有结果 |
|---|---|
| S0 / S1.A / S2 / S1.B / S3 / S4 | 86/86、68/68、112/112、36/36、81/81、58/58 |
| relevant v9回归 | 210/210 +44/44；不等于支持v9迁移 |
| LOCAL/GIT、Sync/Discovery/GitUpdate、API/Web UI、Subscription退役 | PASS |
| 源码保全、CAS、本地Git修改保留、执行状态、停机/崩溃恢复 | PASS |
| Native Linux AMD64/ARM64、Docker AMD64/ARM64 | PASS，沿用各自实测范围 |
| Managed Runtime / 可信离线安装 / 完整A毁→独立B灾备 | PASS；恢复后物理Runtime需重建 |
| 应用Node / 浏览器 | Node22.23.5、24.22.3；Chromium/Firefox/WebKit业务及停机场景PASS |

精确平台/libc/内核和场景边界见[S5.R报告](S5R_REMEDIATION_REPORT.md)。不外推Windows、Alpine/musl、其他libc/Node patch或任意多租户隔离能力。

## Smoke Test / Artifact Integrity

安装冒烟复用RC15 `S5-COMPILED-CLI`：全新根→initialize→真实CLI启动→管理员登录→LOCAL Workspace/脚本→Task1/Run1 SUCCESS、一次Attempt及真实日志→正常停止→新PID重启→任务/运行/Attempt持久化。原PID19093→19360，原回执SHA `831b6909c8df8aa3c515b303a6e0540ca4fa9ef064d4fbd0b5fe702cc8e9ac9d`。独立真实v9根由v2默认入口安全拒绝exit1，40路径身份/内容不变。两项均为复用证据。

**NEWLY_EXECUTED**：核对当前Git关系、受保护文件、版本/lock输入；实际重算634个backend和227个frontend文件清单；重算源码、Darwin发行、两个OCI及两个Docker归档Hash；验证双架构manifest/config和代码revision。未重建归档。完整值见[简洁机器记录](../../../tests/workspace-v2/v2-release-readiness.json)。

| 工件 | SHA256 / digest |
|---|---|
| 源码归档 | `62f645a5f411715eaed90fe092f6e1ae7da6b65f19b8278a62728ab374e4df52` |
| Backend manifest | `ee67403fd90d9dd4bf478f34c7eb8812e0b5c61b257edb0f3367b17bbbb77d48` |
| Frontend manifest | `486b58c36a885146cbc164e3e0c919d58dd190a610a61c818f58d329a1ffd4a2` |
| Darwin ARM64发行A | `9bc592ea5ce178856202c0dc868a357bd6f332b4ccf91bba6f9b31ebcd0c7b9a` |
| AMD64 OCI manifest | `sha256:12ec4578346c2874a83239e183ab7e7e507d42a4344a6d3145eed6759aeef679` |
| ARM64 OCI manifest | `sha256:916d9d6f8cd615e85772b1cbdbad87c63086bbe7e133e2ac7f6f1964ff51ef38` |
| AMD64 Docker归档 | `e2ebb41f93f58be649f19698b6a79e2d429dcee30fc3cdd945377d11d4864dcf` |
| ARM64 Docker归档 | `d98ffc47927917dee4b69ec91c0f8985f87d616365653fbfada5d05e81b2315b` |

本地OCI digest不是已发布的registry地址；镜像缓存已按S5.R清场，审核包仍保留两种归档。当前默认 `Dockerfile` 构建 fresh-v2；重新构建产生的新镜像不得冒充上述 RC15 候选。

## Fresh-v2 Installation / Configuration

1. 从受控审核包取得本机架构的上述 **Docker格式归档**，校验Hash后 `docker load --input "$ZHIXU_V2_DOCKER_ARCHIVE"`。该变量指已取得的实际文件；OCI格式归档不要当作Docker格式文件混用。
2. 在专属env文件中设置 `ZHIXU_V2_IMAGE` 为load输出的本地tag/ID、`ZHIXU_V2_PUBLIC_ORIGIN=http://127.0.0.1:5600`。使用从未承载旧数据的新Compose项目名；不复用v9的env、项目名、data卷或备份目标。
3. 在仓库根目录使用[默认 Compose 配置](../../../compose.yaml)，例如：

```sh
# /path/to/v2.env与项目名由安装管理员选择；其中须配置上述两个变量。
docker compose --env-file /path/to/v2.env -p zhixu-v2-fresh -f compose.yaml config --quiet
docker compose --env-file /path/to/v2.env -p zhixu-v2-fresh -f compose.yaml run --rm --service-ports platform-v2 --initialize
# 首次初始化正常就绪后Ctrl+C停止前台实例，再常规启动同一新项目：
docker compose --env-file /path/to/v2.env -p zhixu-v2-fresh -f compose.yaml up -d --pull missing
```

打开 <http://127.0.0.1:5600> 创建管理员并登录。容器为UID/GID10001、只读rootfs、drop ALL capabilities；只对可信管理员开放脚本管理入口。远程访问使用匹配public origin的认证/TLS入口。

| 目录 | 用途 |
|---|---|
| `/data/state` | fresh-v2数据库、Workspace、Runtime和运行数据；挂载父卷 `/data` |
| `/data/state.platform-control` | 同父卷内独立恢复控制域；不得当成无用临时文件清理 |
| `/backup/state` | 独立备份域；容器挂载父卷 `/backup` |
| `/scratch/tmp` | 独立临时卷，需预检物理空间及至少2GiB余量 |

单数据卷只运行一个活跃实例，不执行 `down --volumes` 来升级。旧v9继续使用其原镜像/项目/卷，v2不得自动接管。原始非空未知根会拒绝启动，不会自动清空或迁移。

### Managed Runtime

Compose基础示例默认支持在线安装受管Python/Node：pyenv从官方GitHub固定提交获取，Python通过python-build下载校验并编译，Node按官方SHA256校验，依赖通过PyPI/npm安装。镜像通过apt提供编译工具和系统开发库，不要求额外批准清单。

仅在选择预批准/离线制品模式时，配置以下四项环境变量，并挂载正确平台的只读package、独立受保护allowlist及应用UID拥有的私有可写Store。它们不能位于Workspace、DataRoot或已安装Runtime内。

| 环境变量 | 内容 |
|---|---|
| `ZHIXU_V2_RUNTIME_ARTIFACT_MODE` | `OFFLINE_VERIFIED`或显式 `ONLINE_VERIFIED` |
| `ZHIXU_V2_RUNTIME_ARTIFACT_STORE` | 应用UID拥有、mode0700的独立可写Store路径 |
| `ZHIXU_V2_RUNTIME_ARTIFACT_TRUST_ANCHOR` | 独立批准、应用不可修改的allowlist文件 |
| `ZHIXU_V2_RUNTIME_ARTIFACT_MANIFEST` | 正确OS/架构的受信任package manifest |

这四项须写入独立Compose override的service `environment`，输入/Store的mount也在该override配置；仅添加到 `--env-file` 不会自动透传进容器。后续命令同时指定基础Compose与该override。

按照[Runtime导入与安装指南](S5R_OFFLINE_RUNTIME_GUIDE.md)执行编译后importer。容器默认入口仅接收 `--initialize`；导入时在相同Compose/override及卷配置下使用 `run --rm --no-deps --entrypoint node platform-v2 /app/scripts/release-v2/runtime-artifacts.cjs import`，并附指南列出的data/package/四Runtime参数。之后经正式Provider安装、Environment Build、Task绑定与readiness验证。默认在线模式不执行此导入流程；显式配置制品模式后仍严格检查信任配置，不会静默退回普通在线安装。不得用宿主Runtime替代受管环境。现有离线PNPM及未支持的非空pip依赖闭包限制仅适用于制品模式，不限制默认在线pip/npm安装。

## Backup / Restore / Rollback

通过Web UI备份入口创建完整snapshot，认证加密导出并下载到独立位置，口令分开保存；API入口分别为 `/api/backups` 和 `/api/restores` 的相关操作，具体DTO见[S4产品报告](S4_IMPLEMENTATION_REPORT.md#backup--restore)。恢复须导入→校验/预览→确认stage→正常重启并核对COMPLETE，再重建Managed Runtime后执行任务。

升级前先完成并验证完整加密备份，再正常停止服务并保留备份。只复用已证明兼容的fresh-v2冻结Schema；现有回滚资格仅覆盖报告中同Schema版本，不承诺任意降级。必要时在独立安装根恢复兼容备份，先验证原源码/历史/任务，不直接覆盖唯一旧数据。v9→v2迁移不属于本次支持。

## Known Security Risks / Deferred Work

保留原[S5.R安全结果](S5R_REMEDIATION_REPORT.md#b1-security)，不重新扫描或改写B1=NO。v2内部使用受控Git；Shell可信脚本仍可调用环境中的系统Git/工具并访问平台账号获授予的资源。系统包、构建依赖、SDK及完整供应链审计另立专项，延期不表示修复。当前证据未留下已证实且未修复的核心直接严重缺陷；若发现此类问题，仍阻止受影响范围发布。

## Release Readiness / Approval Required

```text
ZHI_XU_V2_REFACTOR_ACCEPTANCE=PASS
ZHI_XU_V2_FUNCTIONAL_RELEASE_READY=YES
FULL_SECURITY_AUDIT=DEFERRED
V9_AUTO_MIGRATION=NOT_SUPPORTED
READY_FOR_RELEASE_APPROVAL=YES
RELEASE_APPROVAL_GRANTED=NO
```

以上是本轮范围下的新结论，不替换历史S5/S5.R的NO。本轮只提交文档和验证记录；不执行Merge/Rebase/Push/Tag/GitHub Release/Docker Publish/生产部署。正式发布操作、对外版本名及具体产物由用户另行审批。
