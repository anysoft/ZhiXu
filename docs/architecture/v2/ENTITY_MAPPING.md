# Architecture v2 — Entity Mapping

状态：**设计评审稿；未实施**。基线 `develop@d527a46095e85b7fc61c83544cd847a6e3f237db`。本文件的 CURRENT 为源码静态事实，TARGET 为建议实施契约；动态运行、浏览器、Linux 和容器行为本轮 **UNVERIFIED**。目标原则见 [TARGET_ARCHITECTURE](TARGET_ARCHITECTURE.md)，同步细节见 [SUBSCRIPTION_SYNC_DESIGN](SUBSCRIPTION_SYNC_DESIGN.md)。

## 1. 数据库真实边界

- 当前数据库是 SQLite `db/database.sqlite`，Sequelize 默认 IMMEDIATE transaction；不是只改 TypeScript interface 就能改变数据库约束。见 [data/index.ts:5](../../../back/data/index.ts#L5)。
- [loaders/db.ts:35](../../../back/loaders/db.ts#L35) 注册 ORM models；[operationalSchema.ts:28](../../../back/shared/operationalSchema.ts#L28) 冻结 **schema v9**。Fresh 路径依次建立 task platform、execution、trigger、observability；现有平台版本有严格 signature 校验的演进路径，未知非空库拒绝，最后执行 `foreign_key_check`。见 [operationalSchema.ts:308](../../../back/shared/operationalSchema.ts#L308)。
- 当前表不仅在 `back/data/` 定义。Config/Runtime/Python/Node 的 frozen DDL 和附加 SQL guards、v9 observability 的 7 张 raw-SQL 表必须一并处理。ORM Python model 没有写出全部 FK，而实际 DDL 有复合、延迟 FK，不能以 model 中缺少 `references` 判定无关联。
- 本轮只读解析 `platformV8.ts` 的冻结 JSON，并在 SQLite `:memory:` 重放 DDL，得到 44 张表；加 `observabilitySchema.ts` 中 7 个 CREATE TABLE 后为 **51 张应用表（含 PlatformMetadata，不含 sqlite_sequence）**。未读取用户运行库、未写磁盘数据库；实际运行库是否与代码一致为 **UNVERIFIED**。以下 catalog 基于代码预计 fresh schema，并非对线上库的声明。
- GitNexus MCP 未提供；缓存 CLI 可查询，但索引落后 HEAD，动态 DI/Sequelize/SQL trigger 边不完整。关系结论以当前源码/DDL 为准，图谱零结果不证明无调用。涉及实现时仍须逐符号重新做 upstream impact，不能用本文替代。

## 2. 当前实体 → 目标实体

Action 仅使用 `KEEP / REFACTOR / MERGE / REPLACE / REMOVE`。KEEP 表示职责与持久模型可复用，仍需参加 v2 集成验证；不是允许跳过测试。下列 51 行按实际表而非仅文件名盘点。

| Current Entity / Table                                     | Current Purpose                                                              | Target Entity                                                  | Action   | Affected References                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| GitCredential / GitCredentials                             | Git 身份、READ/WRITE 能力；secret 默认 scope 隐藏                            | GitCredential                                                  | KEEP     | Repository 默认凭证、GitCommand 临时认证、备份秘密域                               |
| Repository / Repositories                                  | 标准化 URL 唯一、bare storage、远端 refs、默认凭证和 ENV profile             | GitRepository，仅 Git 来源；退出 ENV/Runtime/Config 继承根     | REFACTOR | gitResources、repositoryStorage、Task 关系、profile/config APIs                    |
| Worktree / Worktrees                                       | Repo/ref 物理 checkout；branch_key 唯一、dirty/lifecycle 状态                | GitWorkspace 扩展的物理 Git 状态，Worktree 仅内部 Git 适配概念 | REPLACE  | WorktreeService、editor、TaskSources、TaskRuns、Git backup、locks                  |
| Subscription / Subscriptions                               | Repo/branch 绑定、Cron/Interval、sync 状态、worktree 和 profile 选择         | GitWorkspace + WorkspaceSyncPolicy + WorkspaceSyncRun          | REMOVE   | ManagedSubscription、Schedule、initTask、discovery、ENV、API/UI                    |
| Task / Tasks                                               | 定义、manual/discovered 身份、subscription owner、profile、arguments/version | Task；discovered owner 为 Workspace                            | REFACTOR | identity SQL guards、TaskService、discovery、clone、notification                   |
| TaskSource / TaskSources                                   | task PK、worktree 入口、language、cwd 模式                                   | WORKSPACE_ENTRYPOINT / workspace_id                            | REFACTOR | taskDefinition、resource/execution resolvers、references、editor links             |
| TaskRuntimeBinding / TaskRuntimeBindings                   | Task 显式 Python/Node 环境或 Shell                                           | Task override；环境仍独立管理                                  | KEEP     | resolver 的 default 选择器改变；运行 build pin 不变                                |
| TaskExecutionSetting / TaskExecutionSettings               | timeout/retry/concurrency/notification 设置                                  | TaskExecutionSettings                                          | KEEP     | 不将 Sync policy 塞入任务执行设置                                                  |
| RuntimeDefault / RuntimeDefaults                           | repository 或 subscription 二选一 owner，kind 维度唯一                       | WorkspaceRuntimeDefault，workspace_id + kind 唯一              | REFACTOR | TaskService.saveRuntimeDefault、resource resolver、runtime references              |
| DiscoveryPolicy / DiscoveryPolicies                        | subscription_id 唯一、扫描过滤、version 和上次结果                           | WorkspaceDiscoveryPolicy，workspace_id 唯一                    | REFACTOR | DiscoveryService.prepare/plan/reconcile、API、restore                              |
| EnvironmentProfile / EnvironmentProfiles                   | repository_id 必填，(repository,name)唯一                                    | Workspace-owned EnvironmentProfile                             | REFACTOR | RepositoryEnvProfileService、选择/校验、Task env resolver、UI                      |
| RepositoryEnvVariable / RepositoryEnvVariables             | profile 变量 SET/UNSET，默认隐藏 value                                       | WorkspaceProfileVariable（表名可定为 ProfileEnvVariables）     | REPLACE  | scopedEnv/VariableService、SQL 查询、clone、backup；profile_id FK 职责保留         |
| TaskEnvVariable / TaskEnvVariables                         | Task 变量覆盖，(task,name)唯一                                               | TaskEnvVariable                                                | KEEP     | workspace profile 输入适配；秘密默认隐藏不变                                       |
| Env / Envs                                                 | Global 变量、唯一 name、SET/UNSET                                            | GlobalEnvironmentVariable                                      | KEEP     | System→Global→profile→Task merge                                                   |
| ConfigAsset / ConfigAssets                                 | 内容资产、secret 标记、current revision、version                             | ConfigAsset                                                    | KEEP     | usage DTO 增加 workspace 引用；禁止泄漏内容                                        |
| ConfigAssetRevision / ConfigAssetRevisions                 | 不可变文件内容/checksum/size，(asset,revision)唯一                           | ConfigAssetRevision                                            | KEEP     | materialization 与备份继续 pin revision                                            |
| RepositoryConfigBinding / RepositoryConfigBindings         | Repo 默认注入目标、ATTACH/MASK、冲突政策                                     | WorkspaceConfigBinding                                         | REPLACE  | bindings resolver、ConfigAsset usage、materialization、API                         |
| TaskConfigBinding / TaskConfigBindings                     | Task 同目标覆盖/MASK，Task 删除 CASCADE                                      | TaskConfigBinding                                              | KEEP     | resolver 改 Workspace 为下层，不再读 Repository 默认                               |
| TaskHook / TaskHooks                                       | Task BEFORE/AFTER_SUCCESS/AFTER_FAILURE/FINALLY                              | TaskHook                                                       | KEEP     | workspace root 输入通用化；不新增隐式 Workspace Hook 继承                          |
| RuntimeProvider / RuntimeProviders                         | Python/Node provider、安装目录/状态                                          | RuntimeProvider                                                | KEEP     | 不属于 Workspace 目录，不允许 Host fallback                                        |
| RuntimeInstallation / RuntimeInstallations                 | 管理的具体版本/可执行路径、健康状态                                          | RuntimeInstallation                                            | KEEP     | ExecutionContext 固定运行时/build                                                  |
| RuntimeOperation / RuntimeOperations                       | Runtime/环境构建操作与日志/恢复                                              | RuntimeOperation                                               | KEEP     | WorkspaceSyncRun 不得复用这张表                                                    |
| PythonEnvironment / PythonEnvironments                     | runtime、current revision/build、生命周期                                    | PythonEnvironment                                              | KEEP     | 被 Task override/Workspace default 引用                                            |
| PythonEnvironmentRevision / PythonEnvironmentRevisions     | 不可变依赖声明/runtime pin                                                   | PythonEnvironmentRevision                                      | KEEP     | 复合 FK 和 revision 不可变保护保留                                                 |
| PythonEnvironmentBuild / PythonEnvironmentBuilds           | venv 构建结果/freeze/health                                                  | PythonEnvironmentBuild                                         | KEEP     | 执行 lease、build 身份 pin、恢复重建保留                                           |
| NodePackageManagerToolchain / NodePackageManagerToolchains | Runtime 下 npm/pnpm 工具链                                                   | NodePackageManagerToolchain                                    | KEEP     | 同 runtime 复合 FK、版本唯一                                                       |
| NodeEnvironment / NodeEnvironments                         | runtime/toolchain、current build、安装 policy                                | NodeEnvironment                                                | KEEP     | 禁止把 node_modules 永久放入 Local 代码目录                                        |
| NodeEnvironmentRevision / NodeEnvironmentRevisions         | 不可变 dependencies/spec/install policy                                      | NodeEnvironmentRevision                                        | KEEP     | 复合 FK 完整保留                                                                   |
| NodeEnvironmentBuild / NodeEnvironmentBuilds               | package/lock/resolved 快照与 health                                          | NodeEnvironmentBuild                                           | KEEP     | materialization 仍受 Workspace lease 与恢复协调                                    |
| TaskTrigger / TaskTriggers                                 | 每 Task 触发定义、origin/version、discovery tombstone                        | TaskTrigger                                                    | REFACTOR | GIT_UPDATE 必须验证 Workspace.type=GIT；owner/Cron 语义保留                        |
| CronTrigger / CronTriggers                                 | expression/timezone/next_fire/misfire                                        | CronTrigger（执行脚本的 Cron）                                 | KEEP     | 不承接同步 Cron；用户接管后 source-cron 身份保留                                   |
| WebhookTrigger / WebhookTriggers                           | public ID、secret hash                                                       | WebhookTrigger                                                 | KEEP     | LOCAL/GIT 一致可用，secret 不得进入快照公共 DTO                                    |
| GitUpdateTrigger / GitUpdateTriggers                       | ANY_CHANGE/SOURCE_CHANGE/PATH_FILTER/initial                                 | GitUpdateTrigger                                               | REFACTOR | Workspace 成功更新事件输入、幂等和 expected commit                                 |
| TriggerEvent / TriggerEvents                               | durable inbox、trigger/event 唯一、TaskRun linkage                           | TriggerEvent                                                   | REFACTOR | metadata worktree_id→workspace_id + sync_run_id/commit/generation；DDL 可保持 JSON |
| TaskRun / TaskRuns                                         | 运行状态/提交去重、worktree 引用、快照/结果                                  | TaskRun，workspace reference + typed source snapshot           | REFACTOR | execution、observability、backup SQL、历史删除策略                                 |
| TaskRunAttempt / TaskRunAttempts                           | Run 尝试、结果/重试决策                                                      | TaskRunAttempt                                                 | KEEP     | 不为同步建立 TaskRun；snapshot 仍来自 Run/Context                                  |
| TaskRunEvents                                              | SQL 生成的 Run/Attempt 日志事件序列                                          | TaskRunEvents                                                  | KEEP     | 事件投影可能显示 Workspace metadata，不能混入 sync 事件                            |
| TaskHealthStates                                           | 每 Task 最近结果/连续失败/告警窗口                                           | TaskHealthStates                                               | KEEP     | Workspace sync 失败不能计入 Task 脚本健康失败                                      |
| NotificationChannels                                       | 渠道配置、secret、归档/版本                                                  | NotificationChannel                                            | KEEP     | Git credential/env secret 仍不能进入通知消息                                       |
| TaskNotificationPolicies                                   | Task 通知选择、失败阈值                                                      | TaskNotificationPolicy                                         | KEEP     | sync 通知若未来支持应独立事件契约                                                  |
| TaskNotificationChannelBindings                            | Task 显式渠道引用                                                            | TaskNotificationChannelBinding                                 | KEEP     | FK RESTRICT/CASCADE 现状保留                                                       |
| NotificationOutbox                                         | terminal SQL 原子生成、重试/claim/dedupe                                     | NotificationOutbox                                             | KEEP     | WorkspaceUpdateOutbox 独立，不能复用发通知 outbox 发执行事件                       |
| NotificationDeliveries                                     | 发送尝试审计                                                                 | NotificationDelivery                                           | KEEP     | 新架构重新做 Phase13 验收                                                          |
| SchedulerProjection / SchedulerProjections                 | 历史命令/调度投影存储，仍含 sub_id 等字段                                    | 冻结历史存储；不能成为 Workspace 源模型                        | KEEP     | 本次不扩大旧投影消费者；删除另需已确认 exit gate                                   |
| RunningInstance / RunningInstances                         | 历史/内部运行记录，wire cron_id 映射 task_id                                 | 保留当前内部/历史责任                                          | KEEP     | 不为 Workspace 运行新建 Shell→OpenAPI 依赖                                         |
| TaskStat / TaskStats                                       | 旧统计存储                                                                   | 历史统计存储                                                   | KEEP     | TaskRun 现行统计不迁回此表；不删除历史                                             |
| TaskView / TaskViews                                       | 视图定义存储                                                                 | TaskView（与 Workspace 无直接关系）                            | KEEP     | 不为改菜单删除用户视图                                                             |
| Dependence / Dependences                                   | 旧依赖记录存储                                                               | 历史/独立存储，不作 Runtime fallback                           | KEEP     | 当前 Python/Node 环境模型是新执行输入                                              |
| App / Apps                                                 | 开放 API 身份/scopes/token                                                   | App access identity                                            | KEEP     | 新 Workspace scope/权限映射需审查；不能绕过认证                                    |
| Auth / Auths                                               | 认证、系统设置、登录及 SDK/system alert 配置                                 | System/Auth data                                               | KEEP     | 不因前端入口合并改变安全或通知职责                                                 |
| PlatformMetadata                                           | 平台 schema version 与签名                                                   | v2 fresh schema identity                                       | REFACTOR | schema freeze、backupSchemaIdentities、validator、启动拒绝策略                     |

### 逻辑实体补充

`ExecutionContext`、`TaskSourceSnapshot`、`WorkspaceLease` 是执行契约，不另建业务表；`CodeWorkspace` 当前是 Worktree 的 UI/API 视图，不存在独立 CodeWorkspace 表，目标同样不新增 Editor 实体。`GitCredentialSecret` 当前作为 GitCredentials.secret 字段存储并由服务限权读取，不应凭逻辑模型图虚构另一张现表。

## 3. 推荐物理模型（方案 A）

统一 `Workspaces` 存公共身份、name、type、系统生成的 path key、lifecycle_state、version、source_generation、content_revision、default_env_profile_id。`GitWorkspaces` 以 `workspace_id` 共享 PK/FK 扩展，吸收当前 Worktrees 的 Git 状态：repository_id、ref_type/name、resolved/pinned commit、private branch、dirty/status、last_verified_commit、applied_commit/error。**不同时引入另一张独立 Worktrees 表**；可保留 WorktreeService 内部职责并改输入为 GitWorkspace context。

- LOCAL：无 Git 扩展，目录 `DATA_DIR/workspaces/local/ws-{id}`；用户不能提交任意绝对根目录。
- GIT：必须且仅有一条 Git 扩展；每 Workspace 独占 checkout 和私有本地分支，如 `ws-{id}`。远端 `repository/ref` 是来源，不是目录 owner；允许不同 Workspace 选择同 Repository/Branch，但绝不复用 checkout。
- 创建在 DB 建立 CREATING identity，分配目录/checkout，再转 READY；失败转 ERROR/RECOVERY_REQUIRED，保留可修复标识。DB 事务不能覆盖 Git/文件系统副作用，必须 journal/reconcile。Git 应用后、Discovery/完成事务失败固定进入 SyncRun RECOVERY_REQUIRED、phase=APPLIED_PENDING_RECONCILIATION；last_verified_commit 仅表示已核验的实际 HEAD，applied_commit 只在成功对账事务推进，二者不得混用。
- 两表的类型一致性、Git 扩展唯一性、生命周期、source 不可静默变化必须由 DB guard 与 service 双层约束。Source tuple 修改建议使用新 Workspace，已有 Task 不跟随 checkout 切换分支；明确替换源操作若以后提供，需要 version、generation 和所有 Task 失效/重新验证。
- `WorkspaceSyncPolicies` 为一对一子配置，`WorkspaceSyncRuns` 为 append-only 结果历史，`WorkspaceUpdateOutbox` 为成功内容更新的持久事件；这些均不能独立绑定 Repository/Ref 或成为 Subscription 改名。
- `WorkspaceDiscoverySuppressions` 为忽略发现项的小型子记录（workspace_id + discovery_key 唯一），服务归 Discovery；不是第三种 Task 来源。

| 方案                      | 优点                                                            | 代价/缺点                                                                            | Task / Runner                                                      | Backup / Locks                                            |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| A 公共表+Git 扩展（推荐） | 单一 Workspace FK/生命周期；Git 必填约束独立；LOCAL 无 Git 假值 | 需要两表原子校验、跨 FS 恢复；查询多一 join                                          | Source.workspace_id；Resolver 拿统一 root，仅 Git adapter 读取扩展 | 单 Workspace manifest 与 lease key；Git 恢复补充 Git 关系 |
| B 公共表+类型字段         | 读取简单、单表 identity                                         | Git 专属 nullable 字段多；CHECK 复杂、易让 LOCAL 残留 repo/ref；后续 Git policy 膨胀 | 也能统一，但每次验证要校验排他字段组                               | 仍须类型分支，单表不会消除恢复/锁的差异                   |
| C 资源接口+独立存储       | 类型模型最独立                                                  | polymorphic source 外键难保证；UNION 列表/跨类型 ID、历史、删除和 lease 更复杂       | 要额外 identity 表或双 nullable FK，抵消优势                       | 要为两个 owner 制定 ID/路径/manifest 映射；易形成双锁域   |

A 是**建议待实施契约冻结**，不把物理表选择误写成用户已冻结原则；目标 LOCAL/GIT 和统一 Task 链则已冻结。这里不编写 DDL、migration，不重写历史 schema 快照。

## 4. 外键与索引影响

核心持久模型的结构变更范围为 **11 张现表**：Repositories、Worktrees、Subscriptions、Tasks、TaskSources、RuntimeDefaults、EnvironmentProfiles、RepositoryEnvVariables、RepositoryConfigBindings、TaskRuns、DiscoveryPolicies。额外 PlatformMetadata 的版本/签名、TriggerEvents 的 JSON 契约也受影响。此计数不包括 KEEP 实体的集成测试影响；新增表数取决于最终 DDL 评审。

以下 **13 条现有 FK 关系** 需删除、重定向或转入新表。表名替换后等价 FK 仍须重新验证，不能只计新增列。

| 现有 FK                                                   | 当前 onDelete | v2 处置                                                                        |
| --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| Repositories.default_env_profile_id → EnvironmentProfiles | RESTRICT      | 退出 Repository 默认；Workspaces.default_env_profile_id 承接并验证同 Workspace |
| Worktrees.repository_id → Repositories                    | RESTRICT      | 移入 GitWorkspaces.repository_id；Repository 删除被 GitWorkspace 引用阻止      |
| Subscriptions.repository_id → Repositories                | RESTRICT      | 删除这条重复 binding；GitWorkspace 唯一来源                                    |
| Subscriptions.worktree_id → Worktrees                     | RESTRICT      | 删除重复 owner 指针；GitWorkspace 自身拥有 checkout                            |
| Subscriptions.env_profile_id → EnvironmentProfiles        | RESTRICT      | 删除；Workspace/Task 选择 profile                                              |
| Tasks.subscription_id → Subscriptions                     | RESTRICT      | discovered_workspace_id → Workspaces，manual 为空；source 必须同 Workspace     |
| TaskSources.worktree_id → Worktrees                       | RESTRICT      | workspace_id → Workspaces，必填；所有 Task 通用                                |
| RuntimeDefaults.repository_id → Repositories              | CASCADE       | 移除此 owner 列；默认改 workspace_id                                           |
| RuntimeDefaults.subscription_id → Subscriptions           | CASCADE       | 移除此 owner 列；workspace_id + kind 唯一                                      |
| EnvironmentProfiles.repository_id → Repositories          | RESTRICT      | workspace_id → Workspaces；(workspace_id,name)唯一                             |
| RepositoryConfigBindings.repository_id → Repositories     | RESTRICT      | WorkspaceConfigBindings.workspace_id → Workspaces                              |
| TaskRuns.worktree_id → Worktrees                          | RESTRICT      | workspace_id → Workspaces；历史引用与删除按下述策略                            |
| DiscoveryPolicies.subscription_id → Subscriptions         | CASCADE       | workspace_id → Workspaces，唯一；GIT-only 首期                                 |

保留的 Task.env_profile_id、ProfileVariables.profile_id、TaskRuntimeBinding 环境 FK、ConfigAsset revision/binding FK 不能只做机械改名：必须加“profile owner 等于 TaskSource.workspace_id”等跨表校验。当前 RepositoryConfigBinding.unique(repository_id,target_base,target_path)→Workspace 同组；Tasks.unique(subscription_id,discovery_key)→unique(discovered_workspace_id,discovery_key)；Worktrees.branch_key 全局唯一 → 仅私有本地分支身份唯一，repository_id/ref_name 仅普通查询索引。

SQL guards 也要改：[taskSchema.ts:66](../../../back/schema/taskSchema.ts#L66) 的 task identity/source owner/source availability、runtime default owner XOR、worktree 任务引用；[executionSchema.ts:46](../../../back/schema/executionSchema.ts#L46) 的 active run/worktree 引用；[triggerSchema.ts:64](../../../back/schema/triggerSchema.ts#L64) 的 trigger identity 及 event/run 身份。不得只更新 ORM 后保留引用旧表的 trigger。通知域 SQL 需确认仍引用 Tasks/TaskRuns 并且不把 sync 记入 TaskRun。

### 删除与历史

当前 TaskService.remove 物理 destroy；SQL guard 阻止 QUEUED/RESOLVING/RUNNING/RECOVERY_REQUIRED Task 删除；TaskRun.task_id SET NULL 保留历史，Task children CASCADE。见 [task.ts:321](../../../back/services/task.ts#L321)、[executionSchema.ts:50](../../../back/schema/executionSchema.ts#L50)。**当前 TaskRuns.worktree_id 在非 NULL 时受 RESTRICT 约束**，包括仍残留该指针的已终止 Run；但 ExecutionService 正常终止路径通常清空 worktree_id，RECOVERY_REQUIRED 保留，见[executionService.ts:520](../../../back/services/executionService.ts#L520)。不能声称每个终止 Run 都会阻 Worktree 删除，也不能只数 TaskSources 忽略 Run 指针。目标采用永久历史 workspace_id 与独立活动/recovery 指针。

目标建议 Workspace 先 archive（停 sync/discovery、新执行与写入），默认删除在任一 Task、活跃 lease、未恢复 materialization、sync operation 或受保护历史引用存在时 409。首期保留 Workspace tombstone 与历史 Run 的 RESTRICT 引用，不自动清理源文件；物理 purge 另做显式操作与资产保全确认。Task 删除继续保留 Run 历史，不级联删代码。若以后改 Run.workspace_id 为 SET NULL，必须同时冻结完整 source snapshot 和可恢复归档政策，不能为了能删除而丢审计身份。

## 5. TaskSource 完整改造

| 入口/行为       | 当前真实行为                                                                                                          | 必须调整 / 目标验收                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 创建/编辑       | TaskService.normalize 仅允许 worktree_id；save 查 Worktree；版本冲突 409；开启需 READY                                | 输入改 workspace_id；类型通用；保留 CAS，LOCAL 无需 Repository                                                                      |
| Source shape    | WORKTREE_ENTRYPOINT；cwd_mode 包含 WORKTREE_ROOT                                                                      | WORKSPACE_ENTRYPOINT；保留 relative_entrypoint/language/cwd_mode/cwd_relative_path；ROOT 枚举改 WORKSPACE_ROOT                      |
| Source 文件校验 | relativeTaskPath 拒绝绝对/..；逐段 lstat 拒绝 symlink/非普通入口                                                      | 通用安全 Filesystem provider，根由系统分配；增加 hardlink 和 TOCTOU 规范，不能只替换字符串                                          |
| 引用计数        | TaskReferenceService.worktree 查 TaskSources；repository 经 Worktrees 反查                                            | workspace 直接查 Source；repository 仅经 Git 扩展计数；历史 Run/active recovery 另列                                                |
| Clone           | 复制 source/runtime/config/hooks/ENV/trigger，清 discovery 身份；把 Subscription 默认 profile/runtime 复制为 override | 保持同 Workspace source；清 discovery owner/key；Workspace 继承仍有效，无 Subscription 快照分支；克隆 disabled；secret 只在 DB 复制 |
| 删除            | 版本校验后物理删，active Run SQL guard                                                                                | 保持原子性和 Run 历史；discovered“删除且忽略”写 suppression，避免下次自动重建                                                       |
| 自动发现        | Subscription owner；TaskSource 绑定其 Worktree；name/source-cron 保护                                                 | owner 换 Workspace；unique(owner,key)；manual Task 完全独立；owner 不可静默迁移                                                     |
| 手动 Task       | origin=MANUAL，subscription_id/discovery_key 为 null，但 Source 仍强制 Git Worktree                                   | LOCAL/GIT 均可；手动 Task 无 Discovery owner；不因同路径存在发现 Task 而自动合并                                                    |
| Runtime         | Task→Subscription→Repository，未绑定 Python/Node 不 READY                                                             | Task override→Workspace default；无 Host fallback；language/kind 一致                                                               |
| Readiness       | Source 还要求 Repository 可用、发现 owner Worktree 匹配；验证 profile 属同 Repo                                       | 先验证 Workspace READY、安全路径、语言/runtime/config；仅 GIT 分支检查 Git 元数据；LOCAL 不查 Repo/credential                       |

源码：[task.ts:129](../../../back/services/task.ts#L129)、[task.ts:194](../../../back/services/task.ts#L194)、[task.ts:336](../../../back/services/task.ts#L336)、[taskResourceResolver.ts:211](../../../back/services/taskResourceResolver.ts#L211)、[taskReferences.ts:45](../../../back/services/taskReferences.ts#L45)、[taskDefinition.ts:49](../../../back/shared/taskDefinition.ts#L49)。

## 6. Runtime / ENV / Config / Hooks 的真实优先级与目标

### CURRENT（已按读取路径核实）

1. Runtime 显式 Task 环境优先；未指定环境时按 kind 找 Subscription default，再 Repository default；SHELL 不走 Python/Node default。环境与 build/runtime/toolchain 必须 READY/HEALTHY。见 [taskResourceResolver.ts:265](../../../back/services/taskResourceResolver.ts#L265)。
2. ENV profile 是**三选一**：Task.env_profile_id ?? Subscription.env_profile_id ?? Repository.default_env_profile_id，并验证所选 profile 属于同 Repository。变量合并顺序为 System allowlist→Global→ 选中的 profile 变量 →Task 变量，逐项 SET/UNSET；不是把三份 profile 逐层叠加。见 [taskEnvironmentResolver.ts:24](../../../back/services/taskEnvironmentResolver.ts#L24)、[taskEnvironmentResolver.ts:53](../../../back/services/taskEnvironmentResolver.ts#L53)。
3. System base 只白名单 PATH/HOME/LANG/LC\_\*/TMPDIR/TZ/TERM 及平台必要路径/端口；preview 隐藏 System 值和 secret，所有变量 model 默认 exclude value。不能把全量 backend `process.env` 加入新 LOCAL 执行。
4. Config 按 Repository enabled bindings→Task enabled bindings，以 `target_base:target_path` 为 key；Task ATTACH 覆盖同 key、MASK 删除继承 key；asset current revision 有效才 READY。见 [taskResourceResolver.ts:346](../../../back/services/taskResourceResolver.ts#L346)。
5. Hook 只有 Task 所属，没有 Subscription/Repository Hook 继承；按 TaskHook phase/position 执行，cwd_base 允许 TASK_CWD/WORKSPACE_ROOT。见 [configAsset.ts:38](../../../back/data/configAsset.ts#L38)、[taskResourceResolver.ts:394](../../../back/services/taskResourceResolver.ts#L394)。

### TARGET（建议正式接口）

- `resolveWorkspace(taskId)` → `{workspace_id,type,lifecycle_state,source_generation}`，取消 `taskRepository()` 作为通用前提；Git 需要时单独 `resolveGitSource(workspace_id)`。
- `WorkspaceRuntimeDefaults.get/save(workspace_id,kind,environment_id,expected_version)`；Task 显式值优先，无值继承 Workspace；两者皆空返回 CONFIGURATION_REQUIRED，禁止 Host runtime fallback。
- `WorkspaceEnvironmentProfileService` 管 Workspace-owned profiles；一个 Workspace 可有多个 profile，Task 可选择同 Workspace 的 profile 替代默认。`TaskEnvironmentResolver` 先选 `Task.profile ?? Workspace.default_profile`，再 System Base→Global→selected Workspace Profile→Task SET/UNSET；profile 未配置时该层空，不回退 Repository。
- “Task Override”首先表示 Task 变量层最高优先，也允许 Task 选择不同的同 Workspace profile；不跨 Workspace 共享秘密 profile。创建 GitWorkspace 时如需要复制来源模板，必须显式一次性复制，之后不动态继承 Repository。
- `WorkspaceConfigBindingService` 以 Workspace 为下层；`ConfigBindingResolver(task_id,workspace_id)`按 Workspace→Task 同 key ATTACH/MASK，保持 revision pin、path 保护、materialization journal 和恢复。全局 ConfigAsset 仍可被多个 Workspace 显式绑定。
- `TaskHookService` 继续 Task-only。统一 WorkspaceRoot 输入不意味着增加 Workspace/Repository hooks，也不把 Git sync 当 Hook。
- 变量 DTO、日志、preview、source snapshot、通知保持秘密脱敏；SecretName taint 不可因普通上层覆盖被轻易取消。Runtime 环境独立于代码根，LOCAL 不得写入系统 Python/Node 路径。

RepositoryEnvProfileService 当前创建/绑定/列表 SQL/删除引用全部 Repo 硬绑定，不能只改类名：[repositoryEnvProfile.ts:18](../../../back/services/repositoryEnvProfile.ts#L18)、[repositoryEnvProfile.ts:34](../../../back/services/repositoryEnvProfile.ts#L34)、[repositoryEnvProfile.ts:43](../../../back/services/repositoryEnvProfile.ts#L43)、[repositoryEnvProfile.ts:83](../../../back/services/repositoryEnvProfile.ts#L83)。

## 7. Fresh-only 边界与实施要求

v2 是新产品 fresh install，不承诺旧 QingLong 升级兼容，不保留旧 Subscription API 作为迁移壳；但当前平台自己已有 v1–v9 身份校验和恢复职责，不能以 fresh-only 为由运行 DROP、清空目录或重置现有用户数据。建议 v2 冻结新的 schema/backup 格式身份，未知或不支持的非空库/备份明确拒绝且不修改；是否额外提供现 ZhiXu 1.0 数据导入是独立技术范围决策。新 DDL 与模型 signature 必须一起冻结，历史 platformV\*.ts 不重写，本轮不生成 DDL。

验收至少覆盖：空库完整创建；第二次启动幂等；类型/owner/FK/索引拒绝无效数据；创建过程杀进程恢复；manual/discovered/clone/delete/CAS；同 Repository/Branch 两 Workspace 隔离；Runtime/ENV/Config 覆盖；LOCAL 从建文件到执行与备份恢复；活动 Run/引用保护。全量 FK catalog 如下供下一阶段逐条回归。

## 附录 A. 当前预计 schema 的全部 FK 关系

来源：platformV8 完整 DDL + observabilitySchema 的 7 个 CREATE TABLE；用 SQLite 内存的 PRAGMA 按实际复合约束分组。`NO ACTION`为 DDL 未指定删除动作；不是无 FK。v9 新增 log/result 列不改变既有 FK。下表是 CURRENT 约束 catalog，CASCADE/RESTRICT 均不是 v2 清理命令；KEEP 历史表不因出现在 catalog 就获得删除授权，TaskRun 历史 Workspace 引用继续 RESTRICT 并保留 tombstone。

| Table                           | Column(s)                                             | Referenced Table             | Referenced Column(s)                         | onDelete  |
| ------------------------------- | ----------------------------------------------------- | ---------------------------- | -------------------------------------------- | --------- |
| ConfigAssetRevisions            | asset_id                                              | ConfigAssets                 | id                                           | RESTRICT  |
| ConfigAssets                    | current_revision_id                                   | ConfigAssetRevisions         | id                                           | RESTRICT  |
| CronTriggers                    | trigger_id                                            | TaskTriggers                 | id                                           | CASCADE   |
| DiscoveryPolicies               | subscription_id                                       | Subscriptions                | id                                           | CASCADE   |
| EnvironmentProfiles             | repository_id                                         | Repositories                 | id                                           | RESTRICT  |
| GitUpdateTriggers               | trigger_id                                            | TaskTriggers                 | id                                           | CASCADE   |
| NodeEnvironmentBuilds           | environment_id, revision_id, runtime_id, toolchain_id | NodeEnvironmentRevisions     | environment_id, id, runtime_id, toolchain_id | RESTRICT  |
| NodeEnvironmentBuilds           | toolchain_id                                          | NodePackageManagerToolchains | id                                           | RESTRICT  |
| NodeEnvironmentBuilds           | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| NodeEnvironmentBuilds           | environment_id                                        | NodeEnvironments             | id                                           | RESTRICT  |
| NodeEnvironmentRevisions        | toolchain_id, runtime_id                              | NodePackageManagerToolchains | id, runtime_id                               | RESTRICT  |
| NodeEnvironmentRevisions        | toolchain_id                                          | NodePackageManagerToolchains | id                                           | RESTRICT  |
| NodeEnvironmentRevisions        | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| NodeEnvironmentRevisions        | environment_id                                        | NodeEnvironments             | id                                           | RESTRICT  |
| NodeEnvironments                | id, current_build_id                                  | NodeEnvironmentBuilds        | environment_id, id                           | NO ACTION |
| NodeEnvironments                | id, current_revision_id                               | NodeEnvironmentRevisions     | environment_id, id                           | NO ACTION |
| NodeEnvironments                | toolchain_id, runtime_id                              | NodePackageManagerToolchains | id, runtime_id                               | RESTRICT  |
| NodeEnvironments                | toolchain_id                                          | NodePackageManagerToolchains | id                                           | RESTRICT  |
| NodeEnvironments                | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| NodePackageManagerToolchains    | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| NotificationDeliveries          | outbox_id                                             | NotificationOutbox           | id                                           | RESTRICT  |
| NotificationOutbox              | channel_id                                            | NotificationChannels         | id                                           | RESTRICT  |
| NotificationOutbox              | task_run_id                                           | TaskRuns                     | id                                           | RESTRICT  |
| NotificationOutbox              | task_id                                               | Tasks                        | id                                           | SET NULL  |
| PythonEnvironmentBuilds         | environment_id, revision_id, runtime_id               | PythonEnvironmentRevisions   | environment_id, id, runtime_id               | RESTRICT  |
| PythonEnvironmentBuilds         | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| PythonEnvironmentBuilds         | environment_id                                        | PythonEnvironments           | id                                           | CASCADE   |
| PythonEnvironmentRevisions      | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| PythonEnvironmentRevisions      | environment_id                                        | PythonEnvironments           | id                                           | CASCADE   |
| PythonEnvironments              | id, current_build_id                                  | PythonEnvironmentBuilds      | environment_id, id                           | NO ACTION |
| PythonEnvironments              | id, current_revision_id                               | PythonEnvironmentRevisions   | environment_id, id                           | NO ACTION |
| PythonEnvironments              | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| Repositories                    | default_env_profile_id                                | EnvironmentProfiles          | id                                           | RESTRICT  |
| Repositories                    | default_credential_id                                 | GitCredentials               | id                                           | RESTRICT  |
| RepositoryConfigBindings        | asset_id                                              | ConfigAssets                 | id                                           | RESTRICT  |
| RepositoryConfigBindings        | repository_id                                         | Repositories                 | id                                           | RESTRICT  |
| RepositoryEnvVariables          | profile_id                                            | EnvironmentProfiles          | id                                           | CASCADE   |
| RuntimeDefaults                 | node_environment_id                                   | NodeEnvironments             | id                                           | RESTRICT  |
| RuntimeDefaults                 | python_environment_id                                 | PythonEnvironments           | id                                           | RESTRICT  |
| RuntimeDefaults                 | subscription_id                                       | Subscriptions                | id                                           | CASCADE   |
| RuntimeDefaults                 | repository_id                                         | Repositories                 | id                                           | CASCADE   |
| RuntimeInstallations            | provider_id                                           | RuntimeProviders             | id                                           | RESTRICT  |
| RuntimeOperations               | runtime_id                                            | RuntimeInstallations         | id                                           | RESTRICT  |
| RuntimeOperations               | provider_id                                           | RuntimeProviders             | id                                           | RESTRICT  |
| SchedulerProjections            | env_profile_id                                        | EnvironmentProfiles          | id                                           | RESTRICT  |
| SchedulerProjections            | id                                                    | Tasks                        | id                                           | CASCADE   |
| Subscriptions                   | worktree_id                                           | Worktrees                    | id                                           | RESTRICT  |
| Subscriptions                   | repository_id                                         | Repositories                 | id                                           | RESTRICT  |
| Subscriptions                   | env_profile_id                                        | EnvironmentProfiles          | id                                           | RESTRICT  |
| TaskConfigBindings              | asset_id                                              | ConfigAssets                 | id                                           | RESTRICT  |
| TaskConfigBindings              | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskEnvVariables                | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskExecutionSettings           | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskHealthStates                | last_run_id                                           | TaskRuns                     | id                                           | SET NULL  |
| TaskHealthStates                | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskHooks                       | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskNotificationChannelBindings | channel_id                                            | NotificationChannels         | id                                           | RESTRICT  |
| TaskNotificationChannelBindings | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskNotificationPolicies        | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskRunAttempts                 | task_run_id                                           | TaskRuns                     | id                                           | CASCADE   |
| TaskRunEvents                   | task_run_id                                           | TaskRuns                     | id                                           | CASCADE   |
| TaskRuns                        | event_id                                              | TriggerEvents                | id                                           | SET NULL  |
| TaskRuns                        | trigger_id                                            | TaskTriggers                 | id                                           | SET NULL  |
| TaskRuns                        | worktree_id                                           | Worktrees                    | id                                           | RESTRICT  |
| TaskRuns                        | task_id                                               | Tasks                        | id                                           | SET NULL  |
| TaskRuntimeBindings             | node_environment_id                                   | NodeEnvironments             | id                                           | RESTRICT  |
| TaskRuntimeBindings             | python_environment_id                                 | PythonEnvironments           | id                                           | RESTRICT  |
| TaskRuntimeBindings             | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskSources                     | worktree_id                                           | Worktrees                    | id                                           | RESTRICT  |
| TaskSources                     | task_id                                               | Tasks                        | id                                           | CASCADE   |
| TaskTriggers                    | task_id                                               | Tasks                        | id                                           | CASCADE   |
| Tasks                           | env_profile_id                                        | EnvironmentProfiles          | id                                           | RESTRICT  |
| Tasks                           | subscription_id                                       | Subscriptions                | id                                           | RESTRICT  |
| TriggerEvents                   | task_run_id                                           | TaskRuns                     | id                                           | SET NULL  |
| TriggerEvents                   | task_id                                               | Tasks                        | id                                           | SET NULL  |
| TriggerEvents                   | trigger_id                                            | TaskTriggers                 | id                                           | SET NULL  |
| WebhookTriggers                 | trigger_id                                            | TaskTriggers                 | id                                           | CASCADE   |
| Worktrees                       | repository_id                                         | Repositories                 | id                                           | RESTRICT  |

合计：78 条 FK 约束（复合外键按一条计）；40 张子表具有 FK。内存 catalog 共 51 张表。

## 附录 B. 当前预计 schema 的全部索引/唯一性约束

主键单列 INTEGER 的隐式 rowid 不另列；SQLite autoindex 表示 DDL 内联 UNIQUE 或复合 PK。v9 新增 TaskRun/Notification 显式索引见 observabilitySchema，本表将它们一并补入。

| Table                           | Column(s)                                    | Constraint | Declared Index / SQLite index                                    |
| ------------------------------- | -------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| Apps                            | name                                         | UNIQUE     | sqlite_autoindex_Apps_1                                          |
| ConfigAssetRevisions            | asset_id, revision_number                    | UNIQUE     | config_asset_revisions_asset_id_revision_number                  |
| ConfigAssetRevisions            | storage_key                                  | UNIQUE     | sqlite_autoindex_ConfigAssetRevisions_1                          |
| ConfigAssets                    | name                                         | UNIQUE     | sqlite_autoindex_ConfigAssets_1                                  |
| CronTriggers                    | next_fire_at, trigger_id                     | INDEX      | cron_triggers_next_fire_at_trigger_id                            |
| DiscoveryPolicies               | subscription_id                              | UNIQUE     | sqlite_autoindex_DiscoveryPolicies_1                             |
| EnvironmentProfiles             | repository_id, name                          | UNIQUE     | sqlite_autoindex_EnvironmentProfiles_1                           |
| Envs                            | name                                         | UNIQUE     | sqlite_autoindex_Envs_1                                          |
| GitCredentials                  | name                                         | UNIQUE     | sqlite_autoindex_GitCredentials_1                                |
| NodeEnvironmentBuilds           | environment_id, id                           | UNIQUE     | sqlite_autoindex_NodeEnvironmentBuilds_1                         |
| NodeEnvironmentRevisions        | environment_id, id, runtime_id, toolchain_id | UNIQUE     | sqlite_autoindex_NodeEnvironmentRevisions_2                      |
| NodeEnvironmentRevisions        | environment_id, id                           | UNIQUE     | sqlite_autoindex_NodeEnvironmentRevisions_1                      |
| NodeEnvironments                | name                                         | UNIQUE     | sqlite_autoindex_NodeEnvironments_1                              |
| NodePackageManagerToolchains    | id, runtime_id                               | UNIQUE     | sqlite_autoindex_NodePackageManagerToolchains_2                  |
| NodePackageManagerToolchains    | runtime_id, manager_type, version            | UNIQUE     | sqlite_autoindex_NodePackageManagerToolchains_1                  |
| NotificationDeliveries          | outbox_id, attempt                           | UNIQUE     | sqlite_autoindex_NotificationDeliveries_1                        |
| NotificationOutbox              | task_run_id, id                              | INDEX      | notification_outbox_run                                          |
| NotificationOutbox              | status, next_attempt_at, id                  | INDEX      | notification_outbox_due                                          |
| NotificationOutbox              | dedupe_key                                   | UNIQUE     | sqlite_autoindex_NotificationOutbox_1                            |
| PythonEnvironmentBuilds         | runtime_id                                   | INDEX      | python_environment_builds_runtime                                |
| PythonEnvironmentBuilds         | environment_id, id                           | UNIQUE     | sqlite_autoindex_PythonEnvironmentBuilds_1                       |
| PythonEnvironmentRevisions      | runtime_id                                   | INDEX      | python_environment_revisions_runtime                             |
| PythonEnvironmentRevisions      | environment_id, id, runtime_id               | UNIQUE     | sqlite_autoindex_PythonEnvironmentRevisions_2                    |
| PythonEnvironmentRevisions      | environment_id, id                           | UNIQUE     | sqlite_autoindex_PythonEnvironmentRevisions_1                    |
| PythonEnvironments              | name                                         | UNIQUE     | sqlite_autoindex_PythonEnvironments_1                            |
| Repositories                    | normalized_url                               | UNIQUE     | sqlite_autoindex_Repositories_1                                  |
| RepositoryConfigBindings        | repository_id, target_base, target_path      | UNIQUE     | repository_config_bindings_repository_id_target_base_target_path |
| RepositoryEnvVariables          | profile_id, name                             | UNIQUE     | repository_env_variables_profile_id_name                         |
| RuntimeDefaults                 | subscription_id, kind                        | UNIQUE     | runtime_defaults_subscription_id_kind                            |
| RuntimeDefaults                 | repository_id, kind                          | UNIQUE     | runtime_defaults_repository_id_kind                              |
| RuntimeInstallations            | provider_id, implementation, version         | UNIQUE     | runtime_installations_provider_id_implementation_version         |
| RuntimeOperations               | provider_id, status                          | INDEX      | runtime_operations_provider_id_status                            |
| RuntimeOperations               | log_identity                                 | UNIQUE     | sqlite_autoindex_RuntimeOperations_1                             |
| RuntimeProviders                | language, provider_type                      | UNIQUE     | runtime_providers_language_provider_type                         |
| SchedulerProjections            | sub_id, discovery_key                        | UNIQUE     | sqlite_autoindex_SchedulerProjections_1                          |
| TaskConfigBindings              | task_id, target_base, target_path            | UNIQUE     | task_config_bindings_task_id_target_base_target_path             |
| TaskEnvVariables                | task_id, name                                | UNIQUE     | task_env_variables_task_id_name                                  |
| TaskHooks                       | task_id, phase, position                     | UNIQUE     | task_hooks_task_id_phase_position                                |
| TaskNotificationChannelBindings | task_id, channel_id                          | UNIQUE     | sqlite_autoindex_TaskNotificationChannelBindings_1               |
| TaskRunAttempts                 | task_run_id, attempt_number                  | UNIQUE     | task_run_attempts_task_run_id_attempt_number                     |
| TaskRunEvents                   | task_run_id, sequence                        | UNIQUE     | sqlite_autoindex_TaskRunEvents_1                                 |
| TaskRuns                        | finished_at, id                              | INDEX      | task_runs_finished                                               |
| TaskRuns                        | trigger_type, submitted_at, id               | INDEX      | task_runs_trigger_submitted                                      |
| TaskRuns                        | task_id, finished_at, id                     | INDEX      | task_runs_task_finished                                          |
| TaskRuns                        | status, finished_at, id                      | INDEX      | task_runs_status_finished                                        |
| TaskRuns                        | task_id, status, id                          | INDEX      | task_runs_task_id_status_id                                      |
| TaskRuns                        | submission_key                               | UNIQUE     | task_runs_submission_key                                         |
| TaskRuns                        | status, id                                   | INDEX      | task_runs_status_id                                              |
| TaskRuns                        | log_identity                                 | UNIQUE     | sqlite_autoindex_TaskRuns_1                                      |
| TaskSources                     | worktree_id                                  | INDEX      | task_sources_worktree_id                                         |
| TaskStats                       | ref_id, date                                 | UNIQUE     | task_stats_ref_id_date                                           |
| TaskStats                       | date                                         | INDEX      | task_stats_date                                                  |
| TaskTriggers                    | task_id, type                                | INDEX      | task_triggers_task_id_type                                       |
| TaskTriggers                    | task_id, discovery_key                       | UNIQUE     | task_triggers_task_id_discovery_key                              |
| TaskViews                       | name                                         | UNIQUE     | sqlite_autoindex_TaskViews_1                                     |
| Tasks                           | subscription_id, discovery_key               | UNIQUE     | tasks_subscription_id_discovery_key                              |
| TriggerEvents                   | trigger_id, event_key                        | UNIQUE     | trigger_events_trigger_id_event_key                              |
| TriggerEvents                   | task_id, id                                  | INDEX      | trigger_events_task_id_id                                        |
| TriggerEvents                   | status, id                                   | INDEX      | trigger_events_status_id                                         |
| TriggerEvents                   | task_run_id                                  | UNIQUE     | sqlite_autoindex_TriggerEvents_1                                 |
| WebhookTriggers                 | public_id                                    | UNIQUE     | sqlite_autoindex_WebhookTriggers_1                               |
| Worktrees                       | branch_key                                   | UNIQUE     | sqlite_autoindex_Worktrees_1                                     |
