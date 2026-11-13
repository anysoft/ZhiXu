# 当前架构：源码基线与差异

## 基线、证据范围及限制

- Branch：`develop`；HEAD：`d527a46095e85b7fc61c83544cd847a6e3f237db`；评审开始 `git status --porcelain=v1` 为空。
- 当前源码优先于历史报告。本文记录实现现状；[TARGET_ARCHITECTURE](TARGET_ARCHITECTURE.md) 记录尚未实现的 v2。
- GitNexus MCP 未暴露，AGENTS 引用的 `.claude/skills/gitnexus/*/SKILL.md` 不存在。已查找并使用本机缓存 GitNexus 1.6.12 CLI，未安装/升级项目依赖。项目 runner 尝试 dlx 时已中止；后续直接调用缓存 CLI。
- 当前 `.gitnexus/gitnexus.json` 仍含旧 qinglong 路径/提交；CLI registry 正确指向 ZhiXu，索引 `8b8dd39`，落后本次 HEAD **2 commits**。未刷新索引；其 runner 依赖指纹与当前缓存不同，图谱结果只作导航，不作完整可达性证明。所有关键结论以当前源码复核。
- 只执行静态检查、关系检索、内存 DDL 验证与报告完整性检查；未启动平台、访问用户数据库或执行浏览器/Linux/容器验收。运行时/平台行为未经本轮复验的部分一律 **UNVERIFIED**，历史 PASS 不算本轮 PASS。

## 真实架构链路

当前不是通用 LOCAL/GIT 平台。现有业务链是 `GitCredential → Repository → Worktree ← Subscription → Discovery → TaskSource(WORKTREE_ENTRYPOINT) → TriggerEvent → ExecutionResolver → Runner v2 → TaskRun / Attempts / Logs / Notification Outbox`。

“Code Workspace” 已经是 Worktree 编辑器，但 **不存在持久通用 Workspace 表**。`/api/workspaces/:worktreeId` 的 ID 实际为 Worktree ID；read/info 都进入 Git 检查，LOCAL 不能绕过 Repository 创建目录即用。证据：[CodeWorkspaceService](../../../back/services/codeWorkspace.ts)、[API](../../../back/api/codeWorkspace.ts)、[前端](../../../src/pages/workspace.tsx)。

| 当前域                 | 源码行为                                                                                                        | v2 差距                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Repository / storage   | Repository 元数据、credential、bare Git storage；还有默认 ENV/Runtime/Config 继承与引用保护                     | 来源职责保留，执行默认转 Workspace                                        |
| Worktree               | Repository 强 FK；branch_key 按 repository/ref 全局唯一；状态/FF/锁/生命周期                                    | 统一 Workspace 身份，Git 扩展吸收状态；多个同 ref Workspace 不再共享目录  |
| Subscription           | Repository/ref、绑定 worktree、Cron/interval 调度、执行前后状态、同步结果和错误、discovery owner                | 按职责拆到 Workspace、policy、SyncRun、discovery、trigger，不可直接删服务 |
| Task                   | Task + Source + RuntimeBinding + ExecutionSettings；有 subscription ownership；来源仅 WORKTREE_ENTRYPOINT       | Workspace FK 和 ownership guards；LOCAL/GIT 统一 readiness                |
| Runtime / ENV / Config | Task override；Subscription/Repository 默认；选定 Repository profile；Repo Config 继承                          | Workspace defaults/profile/config，Repository 不再决定运行环境            |
| Execution              | Worktree 排他 FD lease、immutable context DTO、环境解析、注入 journal、managed runtime、Runner/attempt/recovery | workspace 锁键/路径/source snapshot 原子转换；LOCAL 不绕安全边界          |
| Editor                 | 通用 WorkspaceFiles 包含安全文件操作，但 CodeWorkspaceService access 强制 Git/Repo                              | 抽取类型无关授权/root/lease；Git 操作留扩展                               |
| Backup                 | 全 DATA_DIR inventory、排除策略、SQLite snapshot、Git repair、加密 envelope、restore journal/quiesce            | 未建 Workspace manifest/完整性语义；LOCAL 不能据目录会被复制就声称受保护  |
| UI                     | Subscription、Repository、Code Workspace 独立入口；Task 创建选 worktree；ENV 面板需要 repo                      | 统一脚本工作区，LOCAL 快速创建，Git 特有功能按类型展示                    |

## 数据库与启动

[db loader](../../../back/loaders/db.ts) 显式注册 ORM models，调用 [initializeOperationalSchema](../../../back/shared/operationalSchema.ts)。`PLATFORM_SCHEMA_VERSION=9`；启动不是对未知非空数据库任意 sync：检查 PlatformMetadata、model/schema signatures、foreign_key_check，事务中处理已知平台版本。

Frozen `platformV1..V8.ts` 和相应 JSON 是现有升级/指纹证据，不能从最新 ORM 重生成或用全局替换改 worktree 字段。v9 由 observabilitySchema 增加观测通知表；没有 `platformV9.ts`。静态重放 v8 DDL 到 SQLite `:memory:` 有 44 表，v9 新增 7 表，当前 fresh 设计预期 **51 表（包含 PlatformMetadata，不含 SQLite 内部表）**；不代表检查过任何真实用户库。详细字段、13 条旧 FK 变化、SQL guard/索引见 [ENTITY_MAPPING](ENTITY_MAPPING.md)。

启动先 [RestoreService.apply / abandoned snapshot / backup operation recovery](../../../back/app.ts)，再初始化 DB/HTTP/gRPC，说明恢复与运行入口有强顺序依赖。目录初始化当前创建 `db/config/log/syslog/upload/git/worktrees/.locks/tmp`，没有 `workspaces/local`，见 [bootstrapDirectories](../../../back/shared/bootstrapDirectories.ts)。

## Subscription / Git 当前重要语义

1. [WorktreeService.ensure](../../../back/services/worktree.ts#L336) 按 branch_key 返回已有工作树，不检查调用者 owner/purpose；已有私有本地分支名称并不消除远端 Repository/Branch 唯一性。
2. [ManagedSubscriptionService.run](../../../back/services/managedSubscription.ts) 先 update、discovery、GitUpdate evaluate，最后落同步成功状态。GitUpdate evaluate 可先 dispatch，故后续异常存在“整体失败但已触发脚本”的窗口。
3. Subscription 删除有 discovered Task 引用保护；force 分支会物理删除发现任务。Task 删除为硬删，随后发现可能重建；用户删除 Cron 则保留 disabled USER tombstone。目标不能把这些不同行为统一描述成现已安全保留。
4. 同步以 repository/worktree/subscription 等锁保护，进程/恢复语义必须随 owner 迁移。Branch 安全 FF 与 dirty/ahead/diverged 检查可复用；sync 不应再借用 TaskRun。

详见 [SUBSCRIPTION_SYNC_DESIGN](SUBSCRIPTION_SYNC_DESIGN.md)。

## 当前继承、执行和保护边界

Runtime 实际为 Task 显式 binding → Subscription default → Repository default。ENV 先选 Task profile → Subscription profile → Repository default profile（三选一），再 System allowlist → Global → 所选 Profile → Task SET/UNSET；并非顺序叠加多个 profile。Config Repository bindings → Task 同目标覆盖，Hooks 仅 Task。见 [taskResourceResolver](../../../back/services/taskResourceResolver.ts)、[taskEnvironmentResolver](../../../back/services/taskEnvironmentResolver.ts)、[taskConfig](../../../back/services/taskConfig.ts)。

[ExecutionPaths](../../../back/services/executionPaths.ts) 的 `worktree()` 和 Git/编辑器使用相同 `worktree-{id}.lock` inode；materialization resource key 为 `hash(worktree:id)`。只把 DTO 换成 workspace_id 会把保护拆成两套锁，属于高风险。当前 context 不可变只是 DTO 性质，真实工作树仍需 lease 防止执行期间变更；不能宣称已有源码完整快照。

安全文件底层和 execution/config recovery 可复用，但必须改 owner/root/key 及恢复识别；备份通用 inventory 会包含未来未排除的 local 目录，但 manifest、Git verification、恢复后资源关联目前不认识 Workspace。详见 [EXECUTION_AND_BACKUP](EXECUTION_AND_BACKUP.md) 和 [SECURITY_AND_LIFECYCLE](SECURITY_AND_LIFECYCLE.md)。

## GitNexus 影响证据（旧索引，有界上游 depth=3）

| Target                 | Direct | Total | Process groups | Tool risk | 当前源码核实/评估含义                                                                                                                                                               |
| ---------------------- | -----: | ----: | -------------: | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorktreeService.ensure |      1 |     4 |              3 | **HIGH**  | Managed.prepare 直接调用；run/withBinding/preflight 上游；不能静默改复用规则                                                                                                        |
| TaskResourceResolver   |     13 |    50 |              4 | **HIGH**  | TaskService、Discovery、ExecutionResolver.snapshot、ExecutionService.submit、TaskReferences.environment、Validator.validate 及导入文件；涉及 resolve/run/taskRoutes/discoveryRoutes |
| ExecutionResolver      |      2 |    11 |              0 | LOW       | executionService 导入与构造；0 process 不是低架构风险或无影响证明                                                                                                                   |
| WorkspaceLocks         |      5 |    15 |              0 | MEDIUM    | RepositoryStorage、GitCommand、GitUpdateTrigger、Worktree；源码另核实 lease/helpers/backup                                                                                          |

TaskResourceResolver 的 13 个直接项是 8 个类/文件依赖（TaskService；discovery.ts、executionResolver.ts、executionService.ts、runObservability.ts、task.ts、taskReferences.ts、taskResourceValidator.ts）及 5 个方法（reconcile、snapshot、submit、environment、validate）；不可将 imports 与 CALLS 全称为直接调用者。图谱结果分页及动态 DI/SQL/Python/Shell 不完备，完整改造范围由 [FILE_IMPACT_INVENTORY](FILE_IMPACT_INVENTORY.md) 补足。HIGH 告警已在评审过程中告知用户；本轮未编辑任何业务符号。

## 资格状态

Phase15/16A/16B 证据仅证明其绑定源码/镜像。架构 v2 尚未实现，其 TS/build、platform、Phase12 browser、Phase13 notification、Phase14 backup、Linux、容器、arm64/amd64、安全门均 **NOT RUN / UNVERIFIED**。本轮报告静态通过不授予发布资格。重验矩阵见 [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md)。
