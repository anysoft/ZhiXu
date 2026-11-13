# ZhiXu Architecture v2.0 Assessment

## Baseline

Branch: `develop`  
HEAD: `d527a46095e85b7fc61c83544cd847a6e3f237db`  
Working Tree: 初始干净；交付仅新增 `docs/architecture/v2/` 架构报告。未提交。

证据以此 HEAD 当前源码为准；GitNexus CLI 1.6.12 的 registry 索引 `8b8dd39` 落后两提交，已执行 query/context/upstream impact/detect_changes，关键行为经源码核实。图谱不是动态 DI、SQL、Shell/Python 的完整可达性证明；本轮未刷新索引、未访问用户运行数据库。详细基线与图谱影响见 [Current Architecture](CURRENT_ARCHITECTURE.md)。

## Target Architecture

Status: **FROZEN**（产品原则；具体技术默认方案待人工评审）。

Workspace: **LOCAL / GIT**  
Subscription: **REMOVED AS BUSINESS ENTITY**（目标，当前尚未移除）  
TaskSource: **WORKSPACE_ENTRYPOINT**  
Git Sync: **WORKSPACE-OWNED**

建议方案 A：`Workspaces + GitWorkspaces` shared PK；Git 扩展吸收当前 Worktrees 持久 Git 状态，Worktree 仅内部适配概念。每个 Git Workspace 独占目录/私有本地 branch，同 Repository/ref 可多个 Workspace，不复用可写 checkout。任务统一经过 Workspace → Task → ExecutionContext → Runner → TaskRun。LOCAL 无 Git 前置，Repository 仅为代码来源。完整不变量及 A/B/C 取舍见 [Target Architecture](TARGET_ARCHITECTURE.md)。

## Current Architecture

当前仍为 Repository / Worktree / Subscription 共同驱动的 Git 平台；TaskSource 只支持 WORKTREE_ENTRYPOINT。现 `/workspaces/:worktreeId` 是 Worktree 编辑器，不是通用 Workspace 实体。

三个直接影响设计的事实：

1. Worktree.ensure 按 Repository/Branch 复用现目录；多订阅可共享源码、dirty 状态与 lease。GitNexus upstream 评为 HIGH（1 直接调用、4 影响、3 过程组）。
2. TaskResourceResolver 上游 HIGH（13 直接依赖项、50 影响、4 过程组）；Task/运行/发现/API 需整体改造，不能只替换字段名。
3. Managed 同步当前先 Discovery/GitUpdate 派发，再写最终 SUCCESS；需要持久同步成功事务与 update outbox，防失败同步已经触发运行。

ENV 实际先从 Task/Subscription/Repository 默认选择一个 Profile，再合并 System allowlist→Global→ 所选 Profile→Task；Runtime 为 Task→Subscription→Repository；Config 为 Repository→Task，Hook 仅 Task。v2 承接有效用户能力，而不是机械删 Subscription 默认。

## Model Impact

Entities affected: **完整盘点 51 张现有应用表**；模型和字段、读写、索引、删除限制均有逐项记录。  
Tables affected: **11 张核心现表需结构调整**；另 PlatformMetadata 身份、TriggerEvents JSON/TaskTrigger 语义及新增 Workspace/Sync 子资源需协同。  
Foreign keys affected: **13 条现有 FK 需删除/重定向/转入新 owner**；catalog 记录全部 78 条现有 FK 及 62 个索引。

计数来自源码 DDL 的内存解析/重放，不是对线上库的检查。推荐新 fresh schema，拒绝不支持库而不清空；无需 QingLong 升级兼容，不重写历史 frozen DDL。详见 [Entity Mapping](ENTITY_MAPPING.md)。

## Backend Impact

- Services: Workspace 身份生命周期、通用文件、Git 扩展、同步编排、同步调度、发现、Trigger 各有单一 owner；不建巨型 WorkspaceService。
- APIs: 统一 Workspace 资源与 files/tree/sync-policy/sync/history/discovery 子资源；Repository/Credential 继续独立；保留鉴权、CAS、幂等与安全错误。
- Execution: LOCAL/GIT 统一 root 与 source snapshot；TaskSource、Editor、Sync、Config/Node journal 和恢复必须同时切换到相同 Workspace 锁 inode。
- Discovery: owner 改 Workspace；保留用户名称/Runtime/Cron 接管；脚本消失 retire，显式忽略可用 suppression；手动 Task 独立。
- Sync: Branch 只安全 FF；Tag/Commit 固定 SHA；保留 Cron/Interval 用户能力；SyncRun 与 TaskRun 分离。Discovery 启用且失败时阻成功提交；Git 已 apply 则进入待恢复，不发事件。
- Locks: platform admission→Git 需要时 Repository→Workspace→runtime pins；MVP 同 Workspace 读写/执行串行，源变化则 SKIPPED/SOURCE_SUPERSEDED，不运行新代码冒充旧提交。

详见 [API / Service](API_SERVICE_MAPPING.md)、[Subscription / Sync](SUBSCRIPTION_SYNC_DESIGN.md)、[Execution / Backup](EXECUTION_AND_BACKUP.md)。

## Frontend Impact

Menus: 采用冻结的 10 项主导航；移除 Subscription 独立菜单，Code Editor 并入脚本工作区。  
Pages / Routes: 全部现有 TSX 页面、约定路由 helper、Settings 入口和深链均映射；不能信任陈旧生成`.umi`路由。  
Creation workflow: 选择/创建 LOCAL 或 GIT Workspace → 入口 → Runtime → Trigger → 保存/运行；LOCAL 不得强制 Repository。

Workspace 详情统一 Overview/Files/Tasks/Environment/Config，GIT 额外 Git 状态/同步策略/历史/Discovery；上传与 ZIP 后置。当前两 locale 和 ui-catalog 一并列入影响。详见 [Frontend Information Architecture](FRONTEND_INFORMATION_ARCHITECTURE.md)。

## Backup/Restore

Impact: **CRITICAL**。当前 coordinator 递归复制 DATA_DIR，未来 LOCAL 目录在通用复制层可能被捕获；但 manifest、domain validator、Git 恢复查询与 TaskSource 校验尚无 LOCAL 模型，不能宣称已受完整保护。

Risks: DB 恢复但唯一代码缺失、save/执行/注入与快照交错、旧绝对路径被信任、恢复后 TaskSource 失效、秘密配置进入备份、容量耗尽。

Required redesign: 首次允许 LOCAL 持久写入时，必须同时完成 Workspace manifest、DB/root/source 一致性校验、相对路径重建、quiesce/注入恢复、加密覆盖、限额及跨根/强杀恢复。核心验收是“源实例 A 及仅本地代码被销毁 → 从备份在 B 恢复 →Task 可运行”；缺源码必须失败关闭。具体模块处置见 [Execution / Backup](EXECUTION_AND_BACKUP.md)。

## Security

Critical risks: LOCAL 唯一源码丢失；路径/链接逃逸；新旧锁键分裂；临时 Config 秘密未恢复；未成功同步发 GitUpdate；同 ref 目录共享；删除/恢复所有权误判。

Required protections: 系统分配 root、逐层路径验证、no-follow/regular/single-link、atomic/CAS、同一 EX lease、Config/Node journal/recovery、managed Runtime 隔离、源码版本复核、引用 RESTRICT/tombstone、成功事务 outbox、加密一致备份。当前 Context 冻结不等于完整源码快照；source validator 现少入口 nlink 检查；可信脚本的 Runtime 隔离不等于 OS 租户沙箱。

15 项 Current/Target/Change/Failure/Test 矩阵与生命周期、上传 ZIP 边界见 [Security and Lifecycle](SECURITY_AND_LIFECYCLE.md)。

## Implementation Roadmap

Stages: S0 契约 → S1 安全 Workspace+Backup → S2Task/Execution/继承原子集成 → S3Git 同步/发现/Trigger 与 Subscription 退场 → S4API/Editor/菜单双语 → S5 全平台资格。

Dependencies: Backup 提前到 S1；源码、锁和 schema epoch 必须整体一致。S1–S3 只能在隔离 candidate/fresh-v2 fixtures 验收，不把半成模型部署到现有数据根；S4 才形成完整功能候选。

Acceptance gates: 新 HEAD 上的 TS/build、active platform、managed Runtime、Phase12 Browser、Phase13 Notification、Phase14 Backup、Linux、Container、AMD64/ARM64、安全及收据/清理门全部重跑。本轮这些目标运行资格均 **NOT RUN / UNVERIFIED**；历史 Phase15/16A/16B 不能替代新源码或新镜像资格。

每阶段文件/实体、风险、自动化测试、退出条件、独立验收与 schema 冻结要求见 [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)。

## Open Decisions

9 项尚需技术确认的建议：A 物理模型、多 Workspace 同 ref、排他执行、Workspace Profile 表达、schema epoch、容量限额、发现忽略、历史/purge、Discovery 失败状态机。均有推荐默认与最晚确认阶段；不会重开已冻结产品原则。详见 [Open Decisions](OPEN_DECISIONS.md)。

## Deliverables

| Report                                                                       | 内容                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| [ASSESSMENT_REPORT.md](ASSESSMENT_REPORT.md)                                 | 正式评审入口与结论                             |
| [TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md)                             | 冻结产品原则、A/B/C 与推荐边界                 |
| [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md)                           | 当前真实源码、基线和图谱限制                   |
| [ENTITY_MAPPING.md](ENTITY_MAPPING.md)                                       | 51 表映射、13 旧 FK 变化、完整 FK/索引 catalog |
| [SUBSCRIPTION_SYNC_DESIGN.md](SUBSCRIPTION_SYNC_DESIGN.md)                   | Subscription 拆责、同步/发现/更新状态机与恢复  |
| [API_SERVICE_MAPPING.md](API_SERVICE_MAPPING.md)                             | 实际 API 注册/端点/Service/鉴权/CAS/错误       |
| [FRONTEND_INFORMATION_ARCHITECTURE.md](FRONTEND_INFORMATION_ARCHITECTURE.md) | 全页面/路由/菜单/流程/I18N 映射                |
| [EXECUTION_AND_BACKUP.md](EXECUTION_AND_BACKUP.md)                           | 执行/Runtime/Config/Locks 及备份恢复全模块     |
| [SECURITY_AND_LIFECYCLE.md](SECURITY_AND_LIFECYCLE.md)                       | 15 项安全矩阵与资源生命周期                    |
| [ARCHITECTURE_V2_IMPACT_MATRIX.md](ARCHITECTURE_V2_IMPACT_MATRIX.md)         | 全 20 领域正式影响与验收矩阵                   |
| [IMPACT_MATRIX.md](IMPACT_MATRIX.md)                                         | 建议文件名入口，指向同一正式矩阵               |
| [FILE_IMPACT_INVENTORY.md](FILE_IMPACT_INVENTORY.md)                         | 899 个现有文件逐项分级及拟新增实现文件         |
| [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)                       | 依赖驱动阶段及完整重新资格认证门               |
| [OPEN_DECISIONS.md](OPEN_DECISIONS.md)                                       | 未冻结技术决策及建议                           |
| [REVIEW_VALIDATION.md](REVIEW_VALIDATION.md)                                 | 本轮实际静态验证与边界                         |

## Git

Business code modified: **NO**  
Schema modified: **NO**  
API / Menu / Config / Tests / CI modified: **NO**  
Commit: **NOT PERFORMED**  
Push: **NOT PERFORMED**  
Tag: **NOT PERFORMED**  
Publish: **NOT PERFORMED**

## Final

ARCHITECTURE_IMPACT_ASSESSMENT_COMPLETE: **YES**  
READY_FOR_IMPLEMENTATION_REVIEW: **YES**

这表示设计材料可提交人工审查，不表示代码已实现、技术默认已获批准或取得发布资格。本轮到此停止；下一阶段实施需人工审查和明确授权。
