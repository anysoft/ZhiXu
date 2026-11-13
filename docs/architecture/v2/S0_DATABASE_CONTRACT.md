# S0 — Fresh v2 数据库技术合同

状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**。本文件是待人工批准的技术候选，不能解读为已批准或已部署。产品原则为 PRODUCT_FROZEN。实际 ORM、`back/schema/`、启动代码、用户数据库及 frozen v1–v8 文件均未修改。

## 1. 规范、产物和验证边界

- [fresh-v2.sql](contracts/fresh-v2.sql) 是完整、可独立解析的非运行时候选：全部字段/类型、PK/FK、UNIQUE/CHECK、复合/延迟外键、partial indexes、SQL guards 和 safe-read view 均以该文件为准；本文件解释不变量和应用事务。
- [validate_ddl.py](contracts/validate_ddl.py) 只创建 `sqlite3.connect(':memory:')`，不导入应用、不接受数据库路径，不对文件目录执行创建/删除/迁移；可用 `python3 docs/architecture/v2/contracts/validate_ddl.py --write-receipt` 重现。
- [ddl-validation.json](contracts/ddl-validation.json) 包含实际计数、全部 FK/index catalog、每项正负例的预期和结果、DDL SHA256、normalized schema signature、SQLite 版本及完整性检查。
- 现有 [ENTITY_MAPPING](ENTITY_MAPPING.md) 的 51 表、11 核心表、13 旧 FK 是输入；本轮只核对冻结契约需要的 SQL，不重做全仓审计或生成 899 文件清单。旧 CURRENT 事实保持原样。
- S0 的 `DYNAMICALLY_VERIFIED` 仅指候选关系/触发器在内存 SQLite 实际执行。没有生产 Schema 部署，没有真实 root/文件/lease/Runtime/backup 灾难恢复 PASS；这些仍是 S1–S5 的 NOT_RUN 门。

## 2. Fresh identity、签名与初始化

固定身份：`schema_identity='zhixu.workspace.v2.s0.1'`、`schema_version=1`、`model_contract='S0-2026-11-13'`；这里的 version 1 是独立 v2 epoch 的首个候选版本，不能与现平台 schema v1/v9 混用。

签名算法：读取 `sqlite_schema` 中 `name NOT LIKE 'sqlite_%' AND sql IS NOT NULL` 的对象，按 type/name 排序；每对象保留 type/name/table/SQL；SQL 以保留引号内容的词法 token 归一化空白；UTF-8 紧凑 JSON 后 SHA256。隐式 UNIQUE 由所属 CREATE TABLE SQL 覆盖，不单独依赖 autoindex 名。Metadata 行内容不进入对象签名，避免自引用。候选 SQL 内已写入预计算签名，validator 独立重算后对比，不信任其常量。

正式 fresh driver 必须先完成只读 root/DB 分类，再在一个 IMMEDIATE 事务内创建全部对象、seed GlobalEnvironmentRevision、写 PlatformMetadata、复算 signature、`foreign_key_check`，最后 COMMIT；任何中途错误整事务 rollback。SQL 文件包含 BEGIN/COMMIT 与完整 seed，但它不是可直接用于已有库的安装脚本。绝不调用 `sync({force:true})`、DROP/清空旧库或重建用户目录。

| 输入事实                    | 冻结启动行为                                                                                                  | 安全结果                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| EMPTY DATA ROOT             | 必须同时证实系统拥有的 root 为空/允许的初始控制材料、SQLite 无用户对象；再执行 fresh 初始化                   | SQLite 空库本身不能证明文件根为空；未知已有文件不删除 |
| SUPPORTED FRESH V2          | 唯一匹配 Metadata，expected signature 与实际 schema 一致，FK/integrity 通过；再做 Workspace/root/journal 验证 | 数据根内容完整且恢复完成才启动运行/写入               |
| UNSUPPORTED EXISTING SCHEMA | 非空未知库、旧 v9/其他 identity/version、缺 Metadata，返回现有安全 schema 拒绝语义                            | 不写 Metadata、不升级、不删除、不自动导入             |
| CORRUPTED V2 SCHEMA         | 身份匹配但签名、对象、FK/integrity 不符，拒绝正常启动；保留诊断/受控恢复入口                                  | 不以重建表/空 root 伪装成功                           |

内存 validator 对四种**数据库部分分类**实际验证；磁盘 root 内容、损坏文件、启动恢复和进程互锁由 S1/S5 额外验证，不用分类 helper 冒充真实启动测试。未来实现的公开错误统一由 [S0_ERROR_CODES](S0_ERROR_CODES.md) 映射，不向客户端回传 SQL 原文。

## 3. Workspace 身份、类型和存储是三个不同维度

`Workspaces` 是唯一业务身份；`GitWorkspaces.workspace_id` 是共享主键的扩展。没有独立持久 `Worktrees`、`Subscriptions` 表。LOCAL 无扩展；GIT 以 `(workspace_id,'GIT') → Workspaces(id,type)` 复合 FK 防止挂到 LOCAL。

- 创建只可插入 `CREATING / PROVISIONING`。GIT 此时可暂时无扩展，目录也未完成，普通文件/Task/执行不可用。设置 READY 的 SQL guard 要求有效扩展、Repository、已核验/已应用 commit；还要求系统 root marker、PRESENT 与 inventory hash。Service 必须在 lease 内核验真实 Git/FS，而非只 SELECT 一条 CREATING 记录就运行。
- `root_key` 是 SQLite generated stored 列：`workspaces/<lower(type)>/ws-<id>`，不允许客户端或 Service 自选绝对路径。新 DATA_DIR 只重解析此相对键；root_device/root_inode/root_owner_token 表示本次受控物理目录身份，不能作为跨根恢复的旧宿主机路径。
- type、source_generation、Git Repository/ref/private branch 的来源身份不允许普通 UPDATE。改变来源通过新 Workspace 与显式 Task 绑定处理。内容修改推进 `content_revision + content_inventory_hash`，资源/default/Profile/Config 修改推进 `version`；二者不能替代。
- Branch 私有本地 branch 必须为 `ws-{workspace_id}` 且 UNIQUE；Tag/Commit 为 detached、private_branch NULL。Repository/ref 是普通查询 index，绝不 UNIQUE，因此同 repo/ref 多 Workspace 合法。每份 checkout/lease/Runtime/ENV/Config/SyncPolicy 独立。
- `ReadyWorkspaceResources` 是定义查询的安全关系，排除非 READY/PRESENT、缺 Git 扩展、active WorkspaceOperation、待恢复 SyncRun。它不代替真实路径/FD lease；执行仍必须通过 requireReady + EX lease + 实际 hash/HEAD 二次核验。

lifecycle：`CREATING / READY / ARCHIVED / DELETE_REQUESTED / TOMBSTONED / ERROR / RECOVERY_REQUIRED`。storage：`PROVISIONING / PRESENT / RECLAIMING / RECLAIMED`。合法转移由 SQL guard 与 S0 Lifecycle 合同共同限定；READY/ARCHIVED 必须 PRESENT；RECLAIMED 必须 TOMBSTONED 且物理 marker 已清、reclaimed_at 非空。

## 4. D8：释放目录不等于删除身份

此处**收束并替代上一轮“受保护历史可能一直挡物理删除”的技术建议**，不是改写当前源码审计事实。

| 关系/操作                             | FK/约束                                                                                               | 允许/阻止的事情                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| TaskSource → Workspace                | NOT NULL RESTRICT；Task/Source 延迟复合 FK 双向保证 owner                                             | 任何现存 TaskSource 都阻危险删除；Workspace 不级联删 Task，用户先显式删除/重绑                                               |
| TaskRun → Workspace identity          | NOT NULL RESTRICT；独立 active_workspace_id 临时指针；admission/source snapshot 保留                  | 历史 FK 阻身份行 purge，**不阻源码目录 reclaim**；活跃/恢复指针阻 reclaim                                                    |
| WorkspaceSyncRun → Workspace identity | NOT NULL RESTRICT；immutable admission source snapshot + final facts                                  | 完成的历史不阻 reclaim；QUEUED/RUNNING/RECOVERY_REQUIRED 必须先安全收束                                                      |
| WorkspacePreservationHold             | Workspace FK RESTRICT + snapshot_key + 精确 generation/revision/hash + authenticated manifest receipt | 非空 LOCAL 与任何 GIT 回收前，要求匹配活跃 hold；外部 backup READY/完整性由 Backup Service 真实验证，SQL 不虚构跨文件系统 FK |
| WorkspaceOperations                   | PENDING/RUNNING/DRAINING/RECOVERY_REQUIRED 的 per-Workspace UNIQUE partial index                      | async archive/delete/file mutation 有持久 owner/phase；全局 request_key UNIQUE 防 CREATE 重试分配多个 ID                     |

DELETE precheck 失败必须返回冲突，保持原 lifecycle，不留下 active operation/DELETING。成功请求在同事务创建 owner gate 与 DELETE_REQUESTED；需要保全的目录必须先有符合本次源码的 READY backup hold，再持 EX lease 验证 owner、隔离/回收，最后 TOMBSTONED/RECLAIMED。无法证明 ownership 的目录保持 RECOVERY_REQUIRED，绝不递归删除。

历史 TaskRun/SyncRun 仍引用 tombstone，源文件已经可释放。metadata purge 只在 storage RECLAIMED、保留期到期、无 Task/active/recovery/operation/hold/事件/outbox/历史 FK 后执行；按真实 FK 顺序处理自身子资源，不自动把历史删掉。要保留历史的用户可以永久保留轻量 tombstone，却无需永久保留源码目录。

基线首次同步标识另行保留 `GitWorkspaces.baseline_established`，只可 0→1。`baseline_sync_run_id` 是可 retention 的单列 FK/SET NULL：历史过期删除 SyncRun 后关联可空，marker 仍 1，不重新发初始事件。禁止用 pointer NULL 当“从未建立基线”。

## 5. TaskSource、Profile、默认和版本

`Tasks.workspace_id` 必填；TaskSources.task_id 为 PK；双方均有 `(task_id,workspace_id)` UNIQUE/复合 FK，其中 Task→Source 为 DEFERRABLE INITIALLY DEFERRED。因此事务内可先建 Task 再建 Source，但 COMMIT 不允许任何无 Source Task；没有可公开绕过的 DRAFT 状态。Task 删除 CASCADE 其 Source/子定义，Run.task_id SET NULL 保留历史。

MANUAL：发现 owner/key 必须 NULL，不受扫描覆盖。DISCOVERED：discovered_workspace_id 与 source owner 相同、key 为 64 位路径 SHA256，只有 GIT；RETIRED 必须 disabled，任何新 Run admission/QUEUED claim 都 TASK_NOT_READY，即使文件重新出现。忽略项写 WorkspaceDiscoverySuppressions，扫描不可重建。名称/Cron 用户接管、retirement proof 由成功 reconcile 事务维护；JSON 中的退休证明只允许 Backup 接受已知缺失，绝不授予执行资格。

Profile 关系使用 `(workspace_id,profile_id) → EnvironmentProfiles(workspace_id,id)`，覆盖 Workspace default 与 Task selection，拒绝跨 Workspace。选择 Task Profile，否则 Workspace Default，多个 Profile 不叠加；System allowlist→Global→ 选定 Profile→Task SET/UNSET。UNSET value 必须 NULL。secret 值/名称污点、preview 脱敏、禁止 Host fallback 由 ENV/Runtime Service 保持；SQL 存储 secret 不等于允许在 DTO/snapshot 中暴露。

Runtime：Task override→WorkspaceRuntimeDefault；kind/环境互斥并有 FK 和删除保护。Config：Workspace ATTACH→Task ATTACH/MASK；Workspace 不支持 MASK，Task MASK 的 asset/revision 必须 NULL。同 asset 的显式 revision pin 用复合 FK 防止跨资产，revision NULL 在解析时选择 current，并把实际不可变 revision 固定到执行快照；运行中不漂移。Hooks 继续 Task-only。

Task child mutation 的 AFTER triggers 推进 Tasks.version；Profile variables 推进 Profile.version，再推进 Workspace.version；Workspace defaults/config/profile metadata 推进 Workspace.version。GlobalEnvironmentRevision 是 singleton monotonic counter，Envs INSERT/UPDATE/DELETE 均推进，覆盖增删 membership。多行批次可推进多次，客户端必须读取最终版本，不能假设恰好 +1；CAS 检查与聚合更新仍在同 IMMEDIATE 事务。

## 6. TaskRun 队列、租约与历史快照

仅 TaskRuns.status=QUEUED 是持久队列，不另建 WAITING 表或第二模型。保留 FORBID/QUEUE/ALLOW 与 wait_mode WAIT/SKIP/FAIL_FAST；queue_reason、absolute queue_deadline_at、next_eligible_at、queue_attempt_count、submitted_at/id FIFO 票据全部持久。

- expected_workspace_version/global_env_version/task_definition_version/source_generation/content_revision/git_commit/inventory_hash 在 admission 捕获，admission_snapshot 不可改；effective resource revisions/builds/Profile/config pins 的安全标识放在该快照，不含 Secret 值/其可泄露 hash。
- source_snapshot 初始必须 NULL，只有 RESOLVING 阶段可以写一次已核验实际源；type/Git commit/entry checksum/版本/hash 与预期一致，随后不可覆盖。snapshot_metadata 同样只允许首次写入解析后的运行资源事实；不能把未取得租约的排队快照称为实际执行快照。
- active_workspace_id UNIQUE partial index 保证同 Workspace 只有一个执行/恢复 owner；QUEUED 不持该指针/owner，RUNNING 必须有 pointer/token/source snapshot。Task concurrency ALLOW 不绕过该约束；不同 Workspace 可以并行。
- 入队及 QUEUED→RESOLVING 都检查 READY/PRESENT、operation/recovery gate；TaskRun.task_id 不能改绑，仅 terminal 后 Task 删除允许 SET NULL。
- FORBID 同 Task 重复排队有 guard；QUEUED cancel→CANCELLED；source stale→SKIPPED/SOURCE_SUPERSEDED；timeout/queue cap、事件与手动选择规则见 [Execution Contract](S0_EXECUTION_LOCK_CONTRACT.md)。部署数值是 S1 待验证候选，不硬编码为关系库容量保证。

OS EX FD、controller/child ownership、journal、Runtime pin、stable tree fingerprint 的证明在 Service/安全文件层完成；数据库 partial index 不能证明持有实际 flock。Backup 只可捕获无 owner/FD 的稳定 QUEUED，先冻结 producers/dispatcher，再 drain 真正执行 owner，deadline 不因恢复延长。

## 7. Sync SUCCESS、初始基线、Outbox 和事件

三事实独立持久：`git_update_status`、`discovery_status`、`event_status`；before/target/actual/after commit 均保留。Git APPLIED 但 Discovery/完成事务失败，只能 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION，不产生成功 Outbox；SQL 拒绝把 APPLIED 写成 generic FAILED 放行。

成功变更（或首次基线）事务：

1. 核验 actual HEAD、stable inventory、source/policy/Task/trigger/resource versions，写对账和 GitWorkspace.applied_commit/Workspace content revision。
2. 将 SyncRun 设 SUCCESS，令 update_outbox_id=id；其外键是延迟的，事务内可暂时缺 Outbox。
3. 插入 WorkspaceUpdateOutbox.id=sync_run_id，guard 验证对应 SUCCESS、相同 Workspace/gen/revision/实际 commit/hash/对账完成与 immutable trigger_plan。
4. 首次 initial=1 时，Outbox 的 generated baseline_required=1 通过延迟复合 FK 要求 GitWorkspace.baseline_established=1；此时设 marker 及 baseline_sync_run_id，guard 反向确认初始 SUCCESS+Outbox 已存在。
5. COMMIT，之后才允许 dispatcher。缺 SUCCESS/Outbox/marker 任意一边均不能提交。

首次物理 A→A 允许 initial SUCCESS + UNCHANGED，不虚增 content_revision；其后同 commit 是 initial=0 NO_CHANGE，无新 Outbox。初始化 marker 不因基线历史过期 SET NULL 而重置。Outbox UNIQUE(workspace_id,source_generation,after_commit) 保留同 commit 重放幂等；TriggerEvent origin_trigger_id 无 FK、immutable，与 event_key 形成持续去重，live trigger_id 可 SET NULL。

GIT_UPDATE Event 必须有 workspace_update_id FK 指向成功更新，其他 Event 无此字段；TaskRun.event_id/submission_key='event:{id}' 与 durable inbox 一起防重复 Run。Outbox/事件 owner/claim expiry/attempt 持久，不能只看 PID/内存旗标。SQL 证明关系一致性；外部派发必须发生在 COMMIT 之后的 Service 协议由 S3 实测，不冒称 SQL 能监督任意进程 spawn。

## 8. 全部 13 条旧 FK 的去向

| #   | 旧 FK                                                   | 候选处置                                                                           |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Repositories.default_env_profile_id→EnvironmentProfiles | 删除来源层默认，Workspaces(id,default_env_profile_id)→ 同 Workspace Profile        |
| 2   | Worktrees.repository_id→Repositories                    | GitWorkspaces.repository_id RESTRICT                                               |
| 3   | Subscriptions.repository_id→Repositories                | 重复来源绑定移除；GitWorkspace 唯一拥有                                            |
| 4   | Subscriptions.worktree_id→Worktrees                     | 独立 Sub owner 指针移除                                                            |
| 5   | Subscriptions.env_profile_id→EnvironmentProfiles        | Workspace 默认/Task 同 Workspace selection                                         |
| 6   | Tasks.subscription_id→Subscriptions                     | Tasks.discovered_workspace_id→Workspaces，且与 Tasks/Source.workspace_id 一致      |
| 7   | TaskSources.worktree_id→Worktrees                       | TaskSources.workspace_id→Workspaces NOT NULL RESTRICT                              |
| 8   | RuntimeDefaults.repository_id→Repositories              | WorkspaceRuntimeDefaults.workspace_id→Workspaces                                   |
| 9   | RuntimeDefaults.subscription_id→Subscriptions           | 删除旧 owner XOR；新 Workspace + kind UNIQUE                                       |
| 10  | EnvironmentProfiles.repository_id→Repositories          | workspace_id→Workspaces；unique(workspace_id,name/id)                              |
| 11  | RepositoryConfigBindings.repository_id→Repositories     | WorkspaceConfigBindings.workspace_id→Workspaces                                    |
| 12  | TaskRuns.worktree_id→Worktrees                          | 永久 workspace identity RESTRICT + 独立 active_workspace_id，目录回收不删 identity |
| 13  | DiscoveryPolicies.subscription_id→Subscriptions         | WorkspaceDiscoveryPolicies.workspace_id→GitWorkspaces，首期 GIT-only               |

以上 13 条是旧关系变更计数，候选新增 composite/queue/history/event/hold 约束另计。当前 v9 的其他 Runtime、ConfigAsset、notification、安全/运维/历史存储关系按既有职责保留；候选不是旧数据复制或迁移脚本，也不为新 Workspace 建立 legacy adapter。具体保留声明在完整 SQL 中，不能凭存在旧表名而重新给它脚本执行职责。

## 9. SQL 与 Service 的责任边界

SQL 可证：类型/owner/FK、一对一 Git 扩展、READY 前置、Source 完整、Profile 隔离、唯一队列 owner、历史引用、合法状态转移、write-once 事实、Outbox 成功事务、初始基线、preservation 关系和基本相对路径格式。

Service/OS 仍须证：Panel 鉴权、CAS affected rows、认证请求 key/hash replay、实际 Repo object/FF/dirty/local commits、no-follow/open/fstat/nlink、稳定 root/树 hash、配额扫描、EX FD 与全局锁序、真实 backup READY/hold、unlink ownership、跨根恢复、临时 Config/Node journal、source retirement proof、Secret/日志/通知隔离。SQL 字符串 CHECK 不是完整路径安全解析器，也不能证明某个 TaskSource 文件存在；MANUAL/ACTIVE 缺源必须 fail closed，只有受审 RETIRED proof 可让 Backup 接受预期缺失。

真实 DDL driver 不应允许任意 actor 更新 lifecycle、root marker、source version、baselines 或 snapshots；这些字段只由拥有相应 lease/operation 的 Service 写。所有聚合 CAS/owner 转移都在短 IMMEDIATE 事务完成，不跨网络/子进程持 DB 写事务；锁序见执行与备份合同。

## 10. S0 实际验证结果

在 SQLite `3.53.4` 的 `:memory:` 上执行 **86 项**正负例，全部达到预期。候选 **58 表 / 94 FK / 91 索引（其中 35 显式）/ 144 SQL guards / 1 safe-read view**；foreign_key_check=`[]`，integrity_check=`ok`。

Schema Signature：`f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`。
DDL SHA256：`ffa7b469ff5844fab2fc49b6046447b542f0cf6fc2a7a6dc50246ae47b501655`。

重点实际用例：LOCAL 无需 Repo、GIT 缺 Repo/扩展拒绝、同 repo/ref 多 Workspace、private branch/owner/type/lifecycle 拒绝、Task 无 Source 提交失败、跨 Workspace Profile、ignored/retired 发现、同 Workspace 排他 owner、FORBID/取消/Source snapshot/claim gate、D8 保留 Run 历史且可目录关系回收及最终 metadataGC、SUCCESS/Outbox/marker 缺边拒绝、初始同 commit 一次、基线 history retention 不重发、事件成功边界和事务 rollback。完整用例名称及拒绝原因以 receipt 为准。

以上是 DYNAMICALLY_VERIFIED（isolated relational contract）；物理目录释放、进程 lease、backup/restore、API authentication runtime 和所有 S1–S5 产品执行均 NOT_RUN。不能将 fixture preservation receipt 当作真实 READY 备份，不能把内存 TaskRun 状态推进当作 Runner 已执行。

## 附录：候选核心字段字典

全部 58 表的完整字段/类型/默认/约束在 SQL 规范中。此字典列出 14 项必需候选表与新增控制/保全部分，便于 API 和执行实现对照；FK/index 详细对象可机读 receipt。

### Workspaces

| Field                  | SQLite Type | Nullable | PK  | Default / Generated        |
| ---------------------- | ----------- | -------- | --- | -------------------------- |
| id                     | INTEGER     | NO       | 1   | —                          |
| name                   | TEXT        | NO       | —   | —                          |
| type                   | TEXT        | NO       | —   | —                          |
| root_key               | TEXT        | YES      | —   | generated STORED（见 SQL） |
| lifecycle_state        | TEXT        | NO       | —   | 'CREATING'                 |
| storage_state          | TEXT        | NO       | —   | 'PROVISIONING'             |
| version                | INTEGER     | NO       | —   | 1                          |
| source_generation      | INTEGER     | NO       | —   | 1                          |
| content_revision       | INTEGER     | NO       | —   | 1                          |
| file_count             | INTEGER     | NO       | —   | 0                          |
| total_bytes            | INTEGER     | NO       | —   | 0                          |
| content_inventory_hash | TEXT        | YES      | —   | —                          |
| root_device            | INTEGER     | YES      | —   | —                          |
| root_inode             | INTEGER     | YES      | —   | —                          |
| root_owner_token       | TEXT        | YES      | —   | —                          |
| default_env_profile_id | INTEGER     | YES      | —   | —                          |
| last_error_code        | TEXT        | YES      | —   | —                          |
| deleted_at             | TEXT        | YES      | —   | —                          |
| reclaimed_at           | TEXT        | YES      | —   | —                          |
| metadata_purge_after   | TEXT        | YES      | —   | —                          |
| createdAt              | TEXT        | NO       | —   | CURRENT_TIMESTAMP          |
| updatedAt              | TEXT        | NO       | —   | CURRENT_TIMESTAMP          |

### GitWorkspaces

| Field                | SQLite Type | Nullable | PK  | Default / Generated |
| -------------------- | ----------- | -------- | --- | ------------------- |
| workspace_id         | INTEGER     | NO       | 1   | —                   |
| workspace_type       | TEXT        | NO       | —   | 'GIT'               |
| repository_id        | INTEGER     | NO       | —   | —                   |
| ref_type             | TEXT        | NO       | —   | —                   |
| ref_name             | TEXT        | NO       | —   | —                   |
| private_branch       | TEXT        | YES      | —   | —                   |
| resolved_commit      | TEXT        | NO       | —   | —                   |
| last_verified_commit | TEXT        | YES      | —   | —                   |
| baseline_established | INTEGER     | NO       | —   | 0                   |
| baseline_sync_run_id | INTEGER     | YES      | —   | —                   |
| applied_commit       | TEXT        | YES      | —   | —                   |
| dirty_state          | TEXT        | NO       | —   | 'UNKNOWN'           |
| status_snapshot      | JSON        | NO       | —   | '{}'                |
| last_update_at       | TEXT        | YES      | —   | —                   |
| last_error_code      | TEXT        | YES      | —   | —                   |
| createdAt            | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt            | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceSyncPolicies

| Field             | SQLite Type | Nullable | PK  | Default / Generated |
| ----------------- | ----------- | -------- | --- | ------------------- |
| workspace_id      | INTEGER     | NO       | 1   | —                   |
| enabled           | INTEGER     | NO       | —   | 0                   |
| update_mode       | TEXT        | NO       | —   | 'MANUAL'            |
| schedule_kind     | TEXT        | NO       | —   | 'NONE'              |
| cron_expression   | TEXT        | YES      | —   | —                   |
| timezone          | TEXT        | NO       | —   | 'UTC'               |
| interval_ms       | INTEGER     | YES      | —   | —                   |
| anchor_at         | TEXT        | YES      | —   | —                   |
| misfire_policy    | TEXT        | NO       | —   | 'SKIP'              |
| next_due_at       | TEXT        | YES      | —   | —                   |
| last_claimed_slot | TEXT        | YES      | —   | —                   |
| version           | INTEGER     | NO       | —   | 1                   |
| updated_at        | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceSyncRuns

| Field             | SQLite Type | Nullable | PK  | Default / Generated |
| ----------------- | ----------- | -------- | --- | ------------------- |
| id                | INTEGER     | NO       | 1   | —                   |
| workspace_id      | INTEGER     | NO       | —   | —                   |
| policy_version    | INTEGER     | NO       | —   | —                   |
| source_generation | INTEGER     | NO       | —   | —                   |
| request_key       | TEXT        | NO       | —   | —                   |
| request_hash      | TEXT        | NO       | —   | —                   |
| trigger_source    | TEXT        | NO       | —   | —                   |
| schedule_slot     | TEXT        | YES      | —   | —                   |
| initial           | INTEGER     | NO       | —   | 0                   |
| source_snapshot   | JSON        | NO       | —   | —                   |
| before_commit     | TEXT        | YES      | —   | —                   |
| target_commit     | TEXT        | YES      | —   | —                   |
| actual_commit     | TEXT        | YES      | —   | —                   |
| after_commit      | TEXT        | YES      | —   | —                   |
| status            | TEXT        | NO       | —   | 'QUEUED'            |
| phase             | TEXT        | NO       | —   | 'QUEUED'            |
| git_update_status | TEXT        | NO       | —   | 'NOT_STARTED'       |
| discovery_status  | TEXT        | NO       | —   | 'NOT_REQUESTED'     |
| update_outbox_id  | INTEGER     | YES      | —   | —                   |
| event_status      | TEXT        | NO       | —   | 'NOT_COMMITTED'     |
| content_revision  | INTEGER     | YES      | —   | —                   |
| owner_token       | TEXT        | YES      | —   | —                   |
| cancel_requested  | INTEGER     | NO       | —   | 0                   |
| error_code        | TEXT        | YES      | —   | —                   |
| started_at        | TEXT        | YES      | —   | —                   |
| finished_at       | TEXT        | YES      | —   | —                   |
| submitted_at      | TEXT        | NO       | —   | —                   |
| log_identity      | TEXT        | NO       | —   | —                   |

### WorkspaceUpdateOutbox

| Field             | SQLite Type | Nullable | PK  | Default / Generated        |
| ----------------- | ----------- | -------- | --- | -------------------------- |
| id                | INTEGER     | NO       | 1   | —                          |
| workspace_id      | INTEGER     | NO       | —   | —                          |
| sync_run_id       | INTEGER     | NO       | —   | —                          |
| source_generation | INTEGER     | NO       | —   | —                          |
| content_revision  | INTEGER     | NO       | —   | —                          |
| initial           | INTEGER     | NO       | —   | 0                          |
| baseline_required | INTEGER     | YES      | —   | generated STORED（见 SQL） |
| before_commit     | TEXT        | YES      | —   | —                          |
| after_commit      | TEXT        | NO       | —   | —                          |
| inventory_hash    | TEXT        | NO       | —   | —                          |
| trigger_plan      | JSON        | NO       | —   | '[]'                       |
| status            | TEXT        | NO       | —   | 'PENDING'                  |
| attempt_count     | INTEGER     | NO       | —   | 0                          |
| next_attempt_at   | TEXT        | NO       | —   | CURRENT_TIMESTAMP          |
| owner_token       | TEXT        | YES      | —   | —                          |
| claimed_at        | TEXT        | YES      | —   | —                          |
| claim_expires_at  | TEXT        | YES      | —   | —                          |
| last_error_code   | TEXT        | YES      | —   | —                          |
| created_at        | TEXT        | NO       | —   | CURRENT_TIMESTAMP          |
| dispatched_at     | TEXT        | YES      | —   | —                          |

### WorkspaceDiscoveryPolicies

| Field              | SQLite Type | Nullable | PK  | Default / Generated                            |
| ------------------ | ----------- | -------- | --- | ---------------------------------------------- |
| workspace_id       | INTEGER     | NO       | 1   | —                                              |
| enabled            | INTEGER     | NO       | —   | 0                                              |
| includes           | JSON        | NO       | —   | '["**/*"]'                                     |
| excludes           | JSON        | NO       | —   | '[]'                                           |
| languages          | JSON        | NO       | —   | '["PYTHON","JAVASCRIPT","TYPESCRIPT","SHELL"]' |
| version            | INTEGER     | NO       | —   | 1                                              |
| last_reconciled_at | TEXT        | YES      | —   | —                                              |
| last_result        | JSON        | YES      | —   | —                                              |

### WorkspaceDiscoverySuppressions

| Field               | SQLite Type | Nullable | PK  | Default / Generated |
| ------------------- | ----------- | -------- | --- | ------------------- |
| workspace_id        | INTEGER     | NO       | 1   | —                   |
| discovery_key       | TEXT        | NO       | 2   | —                   |
| relative_entrypoint | TEXT        | NO       | —   | —                   |
| reason              | TEXT        | NO       | —   | 'USER_IGNORED'      |
| version             | INTEGER     | NO       | —   | 1                   |
| created_at          | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### TaskSources

| Field               | SQLite Type | Nullable | PK  | Default / Generated    |
| ------------------- | ----------- | -------- | --- | ---------------------- |
| task_id             | INTEGER     | NO       | 1   | —                      |
| workspace_id        | INTEGER     | NO       | —   | —                      |
| type                | TEXT        | NO       | —   | 'WORKSPACE_ENTRYPOINT' |
| relative_entrypoint | TEXT        | NO       | —   | —                      |
| language            | TEXT        | NO       | —   | —                      |
| cwd_mode            | TEXT        | NO       | —   | 'ENTRYPOINT_DIR'       |
| cwd_relative_path   | TEXT        | YES      | —   | —                      |
| createdAt           | TEXT        | NO       | —   | CURRENT_TIMESTAMP      |
| updatedAt           | TEXT        | NO       | —   | CURRENT_TIMESTAMP      |

### Tasks

| Field                   | SQLite Type | Nullable | PK  | Default / Generated |
| ----------------------- | ----------- | -------- | --- | ------------------- |
| id                      | INTEGER     | NO       | 1   | —                   |
| workspace_id            | INTEGER     | NO       | —   | —                   |
| name                    | TEXT        | NO       | —   | —                   |
| description             | TEXT        | NO       | —   | ''                  |
| enabled                 | INTEGER     | NO       | —   | 0                   |
| origin                  | TEXT        | NO       | —   | 'MANUAL'            |
| discovered_workspace_id | INTEGER     | YES      | —   | —                   |
| discovery_key           | TEXT        | YES      | —   | —                   |
| discovery_definition    | JSON        | YES      | —   | —                   |
| discovery_state         | TEXT        | NO       | —   | 'ACTIVE'            |
| env_profile_id          | INTEGER     | YES      | —   | —                   |
| arguments               | JSON        | NO       | —   | '[]'                |
| version                 | INTEGER     | NO       | —   | 1                   |
| createdAt               | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt               | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### TaskRuns

| Field                            | SQLite Type | Nullable | PK  | Default / Generated |
| -------------------------------- | ----------- | -------- | --- | ------------------- |
| id                               | INTEGER     | NO       | 1   | —                   |
| task_id                          | INTEGER     | YES      | —   | —                   |
| workspace_id                     | INTEGER     | NO       | —   | —                   |
| active_workspace_id              | INTEGER     | YES      | —   | —                   |
| result                           | JSON        | YES      | —   | —                   |
| task_definition_version          | INTEGER     | YES      | —   | —                   |
| expected_workspace_version       | INTEGER     | NO       | —   | —                   |
| expected_global_env_version      | INTEGER     | NO       | —   | —                   |
| expected_task_definition_version | INTEGER     | NO       | —   | —                   |
| expected_source_generation       | INTEGER     | NO       | —   | —                   |
| expected_content_revision        | INTEGER     | NO       | —   | —                   |
| expected_git_commit              | TEXT        | YES      | —   | —                   |
| expected_inventory_hash          | TEXT        | NO       | —   | —                   |
| admission_snapshot               | JSON        | NO       | —   | —                   |
| source_snapshot                  | JSON        | YES      | —   | —                   |
| trigger_type                     | TEXT        | NO       | —   | —                   |
| trigger_id                       | INTEGER     | YES      | —   | —                   |
| event_id                         | INTEGER     | YES      | —   | —                   |
| submission_key                   | TEXT        | YES      | —   | —                   |
| status                           | TEXT        | NO       | —   | 'QUEUED'            |
| submitted_at                     | TEXT        | NO       | —   | —                   |
| started_at                       | TEXT        | YES      | —   | —                   |
| finished_at                      | TEXT        | YES      | —   | —                   |
| attempt_count                    | INTEGER     | NO       | —   | 0                   |
| cancel_requested                 | INTEGER     | NO       | —   | 0                   |
| log_identity                     | TEXT        | NO       | —   | —                   |
| result_code                      | TEXT        | YES      | —   | —                   |
| exit_code                        | INTEGER     | YES      | —   | —                   |
| signal                           | TEXT        | YES      | —   | —                   |
| error_code                       | TEXT        | YES      | —   | —                   |
| error_summary                    | TEXT        | YES      | —   | —                   |
| snapshot_metadata                | JSON        | YES      | —   | —                   |
| concurrency_policy               | TEXT        | NO       | —   | —                   |
| wait_mode                        | TEXT        | NO       | —   | 'WAIT'              |
| queue_reason                     | TEXT        | NO       | —   | 'NONE'              |
| queue_deadline_at                | TEXT        | NO       | —   | —                   |
| next_eligible_at                 | TEXT        | NO       | —   | —                   |
| queue_attempt_count              | INTEGER     | NO       | —   | 0                   |
| owner_token                      | TEXT        | YES      | —   | —                   |
| log_size                         | INTEGER     | NO       | —   | 0                   |
| last_log_at                      | TEXT        | YES      | —   | —                   |
| log_truncated                    | INTEGER     | NO       | —   | 0                   |
| createdAt                        | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt                        | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceRuntimeDefaults

| Field                 | SQLite Type | Nullable | PK  | Default / Generated |
| --------------------- | ----------- | -------- | --- | ------------------- |
| id                    | INTEGER     | NO       | 1   | —                   |
| workspace_id          | INTEGER     | NO       | —   | —                   |
| kind                  | TEXT        | NO       | —   | —                   |
| python_environment_id | INTEGER     | YES      | —   | —                   |
| node_environment_id   | INTEGER     | YES      | —   | —                   |
| version               | INTEGER     | NO       | —   | 1                   |
| createdAt             | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt             | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### EnvironmentProfiles

| Field        | SQLite Type | Nullable | PK  | Default / Generated |
| ------------ | ----------- | -------- | --- | ------------------- |
| id           | INTEGER     | NO       | 1   | —                   |
| workspace_id | INTEGER     | NO       | —   | —                   |
| name         | TEXT        | NO       | —   | —                   |
| description  | TEXT        | NO       | —   | ''                  |
| status       | TEXT        | NO       | —   | 'enabled'           |
| version      | INTEGER     | NO       | —   | 1                   |
| createdAt    | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt    | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceProfileVariables

| Field      | SQLite Type | Nullable | PK  | Default / Generated |
| ---------- | ----------- | -------- | --- | ------------------- |
| id         | INTEGER     | NO       | 1   | —                   |
| profile_id | INTEGER     | NO       | —   | —                   |
| name       | TEXT        | NO       | —   | —                   |
| value      | TEXT        | YES      | —   | —                   |
| status     | TEXT        | NO       | —   | 'enabled'           |
| operation  | TEXT        | NO       | —   | 'SET'               |
| is_secret  | INTEGER     | NO       | —   | 0                   |
| position   | REAL        | NO       | —   | 0                   |
| labels     | JSON        | NO       | —   | '[]'                |
| createdAt  | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt  | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceConfigBindings

| Field                | SQLite Type | Nullable | PK  | Default / Generated |
| -------------------- | ----------- | -------- | --- | ------------------- |
| id                   | INTEGER     | NO       | 1   | —                   |
| workspace_id         | INTEGER     | NO       | —   | —                   |
| asset_id             | INTEGER     | NO       | —   | —                   |
| revision_id          | INTEGER     | YES      | —   | —                   |
| operation            | TEXT        | NO       | —   | 'ATTACH'            |
| target_base          | TEXT        | NO       | —   | —                   |
| target_path          | TEXT        | NO       | —   | —                   |
| materialization_mode | TEXT        | NO       | —   | 'COPY'              |
| conflict_policy      | TEXT        | NO       | —   | 'FAIL_IF_EXISTS'    |
| writable             | INTEGER     | NO       | —   | 0                   |
| enabled              | INTEGER     | NO       | —   | 1                   |
| version              | INTEGER     | NO       | —   | 1                   |
| createdAt            | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| updatedAt            | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |

### WorkspaceOperations

| Field                      | SQLite Type | Nullable | PK  | Default / Generated |
| -------------------------- | ----------- | -------- | --- | ------------------- |
| id                         | TEXT        | NO       | 1   | —                   |
| workspace_id               | INTEGER     | NO       | —   | —                   |
| operation_type             | TEXT        | NO       | —   | —                   |
| status                     | TEXT        | NO       | —   | —                   |
| phase                      | TEXT        | NO       | —   | —                   |
| request_key                | TEXT        | NO       | —   | —                   |
| request_hash               | TEXT        | NO       | —   | —                   |
| expected_workspace_version | INTEGER     | NO       | —   | —                   |
| owner_token                | TEXT        | YES      | —   | —                   |
| journal_key                | TEXT        | NO       | —   | —                   |
| root_marker                | JSON        | NO       | —   | '{}'                |
| preservation_receipt       | JSON        | YES      | —   | —                   |
| error_code                 | TEXT        | YES      | —   | —                   |
| submitted_at               | TEXT        | NO       | —   | —                   |
| started_at                 | TEXT        | YES      | —   | —                   |
| finished_at                | TEXT        | YES      | —   | —                   |

### WorkspacePreservationHolds

| Field             | SQLite Type | Nullable | PK  | Default / Generated |
| ----------------- | ----------- | -------- | --- | ------------------- |
| id                | INTEGER     | NO       | 1   | —                   |
| workspace_id      | INTEGER     | NO       | —   | —                   |
| snapshot_key      | TEXT        | NO       | —   | —                   |
| source_generation | INTEGER     | NO       | —   | —                   |
| content_revision  | INTEGER     | NO       | —   | —                   |
| inventory_hash    | TEXT        | NO       | —   | —                   |
| manifest_hash     | TEXT        | NO       | —   | —                   |
| receipt           | JSON        | NO       | —   | —                   |
| created_at        | TEXT        | NO       | —   | CURRENT_TIMESTAMP   |
| released_at       | TEXT        | YES      | —   | —                   |

### GlobalEnvironmentRevision

| Field        | SQLite Type | Nullable | PK  | Default / Generated |
| ------------ | ----------- | -------- | --- | ------------------- |
| singleton_id | INTEGER     | NO       | 1   | —                   |
| version      | INTEGER     | NO       | —   | 1                   |

### PlatformMetadata

| Field            | SQLite Type | Nullable | PK  | Default / Generated |
| ---------------- | ----------- | -------- | --- | ------------------- |
| schema_identity  | TEXT        | NO       | 1   | —                   |
| schema_version   | INTEGER     | NO       | —   | —                   |
| model_contract   | TEXT        | NO       | —   | —                   |
| schema_signature | TEXT        | NO       | —   | —                   |
| initialized_at   | TEXT        | NO       | —   | —                   |
