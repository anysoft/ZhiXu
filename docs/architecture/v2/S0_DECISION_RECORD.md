# S0 — D1–D9 Architecture Decision Records

本文件含 9 个正式 ADR。共同状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**，待人工最终批准；没有任何记录标为 Accepted/APPROVED。用户已经冻结的产品原则单独标 PRODUCT_FROZEN。此前推荐保留为决策来源，不冒充用户已批准的具体 SQL/DTO/数值。

## ADR-V2-D1 — 公共 Workspace 身份与 Git 共享 PK 扩展

**Context**：Task、Runner、备份、锁需要一个能由数据库约束的 owner；LOCAL 不应需要 Git 或多个 nullable Git 字段。

**Decision**：采用方案 A 为正式候选。Workspaces 公共身份/生命周期/storage；GitWorkspaces 共享 PK 且仅 GIT。TaskSource FK 指 Workspace；READY GIT 必须有完整扩展，LOCAL 插扩展拒绝；不保留另一张独立 Worktrees 业务表。类型/来源 tuple 不可随普通 PATCH 变更，CREATING 的中间态必须无普通访问资格。

**Alternatives**：B 单表少 join 但 Git 字段膨胀；C 分离 identity 会导致 Task 多态 FK/锁/restore 复杂。两者不纳 MVP。

**Consequences / Gates**：Service 负责目录与 Git 操作，SQL 负责类型/owner/状态约束；SQL 不能证明 FS 原子性。见 Database 字段/guards 及内存 LOCAL/GIT/无扩展/owner/rollback 用例。产品 Workspace 统一为 PRODUCT_FROZEN，具体表/guard 为待批准技术合同。

## ADR-V2-D2 — 共享 bare，独占 checkout

**Context**：当前 ensure 按 Repository/Branch 跨 owner 复用；不适合不同 Workspace 独立 ENV/Runtime/编辑。

**Decision**：同 Repository/ref 允许多个 Workspace；只共享 bare object store。root key 与 private branch 按 Workspace ID 唯一，Branch `ws-{id}`；Tag/Commit detached 固定创建 SHA。每个 Workspace 独立 lease、policy、Profile、Config 与 Runtime default。ensure 只核验/修复给定 Workspace，不按远端 ref 寻找替代 owner。

**Concurrency / Recovery**：并发创建先分配不同 id，再按 Repository→Workspace 锁创建私有 branch/checkout；DB unique 和 Git 注册双核验。失败保留 CREATING/ERROR 与 owned checkpoint，恢复只处理该 owner；unknown 目录/branch 不认领、不递归删。回收 detach 只针对本 owner；Repository 引用保护直至相应身份最终 GC。

**Alternatives / Cost**：单 ref 单 Workspace 更简单但削弱产品配置隔离；共享可写 checkout 不可接受。代价为额外 checkout 磁盘和 Repo fetch 锁竞争，D6 与 S5 测试验证，不宣称吞吐值。

## ADR-V2-D3 — MVP 排他执行与一个持久 TaskRun 队列

**Context**：现 FORBID/QUEUE/ALLOW 是 Task 级；代码目录/Config/Node 仍共享资源。只返回 WORKSPACE_BUSY 会丢失触发、无限等待或造成两套 queue。

**Decision**：MVP 同 Workspace EXCLUSIVE，不同 Workspace PARALLEL ALLOWED。复用 TaskRuns 唯一 queue；Task policy 先判，资源 wait_mode 后判；FORBID 重复同 Task 保持 SKIPPED，QUEUE 串行，ALLOW 仍不能绕 Workspace EX。自动触发 WAIT；手动 WAIT/SKIP/FAIL_FAST。期限/数量/公平性/cancel/重启/metadata 字段按 Execution 合同，不另建第二排队器。

**Source**：admission 冻结 source/Task/Workspace/有效资源版本；租约后变更 SKIPPED/SOURCE_SUPERSEDED，零 attempt/不计失败、不默认发失败通知；未知 source 证明为 RECOVERY_REQUIRED，不自动执行最新源。

**Performance / Limits**：长任务阻同 Workspace 其他 Task 和文件读写，排队/完整 inventory 有成本；900 秒等待、32/128/1024 队列、8 并行等仅 S1 容量候选。MVP 租约不是最终并发架构。

**Future**：预留 ExecutionInputProof/lease strategy；snapshot/overlay 需要独立 ADR 与源码/配置隔离、GC/备份/恢复资格，不能靠提前释放 lease 实施。

## ADR-V2-D4 — Workspace 资源继承及稳定版本

**Decision**：Profile 归 Workspace；Task 选择同 owner Profile 优先于 Workspace default，然后 System allowlist→Global→ 选中 Profile→Task SET/UNSET。多个 Profile 不叠加。Runtime Task override→Workspace default；managed 环境不可 Host fallback。Config Workspace ATTACH→Task ATTACH/MASK；Hooks 只归 Task。

**Integrity / Secrets**：复合 FK 和 Service 拒跨 Workspace profile、错误 Runtime kind/config revision；Task 子资源与 Workspace 资源变动递增聚合 version；Global ENV 用单调 GlobalEnvironmentRevision 覆盖 membership/值变化。候选 secret 数据不出公共 DTO、source snapshot、错误或值 hash；运行选择固定 revision/build，先 readiness 再 lease/pin/物化，失败不回退。

**Alternatives / Consequences**：保留 Repo 继承会让 LOCAL 依赖 Git，拒绝；多 Profile 链叠加与既有真实选择语义不符。Global 变动可使队列中旧版本 Run 保守 SKIPPED，UI 展示 SOURCE_SUPERSEDED，safe reason 说明 effective resource changed；RESOURCE_CHANGED 不是另一错误码。具体 Field/FK/DTO 见 Database/API/Execution。

## ADR-V2-D5 — 独立 fresh-v2 identity，无自动升级

**Decision**：候选`zhixu.workspace.v2.s0.1`完整 DDL/signature，与 v9 区分。空安全数据根才 fresh 初始化；supported v2 校验后启动；不支持非空库 UNSUPPORTED_DATABASE_SCHEMA 拒绝且保留；已声明 v2 但结构/完整性损坏 DATABASE_SCHEMA_CORRUPTED 失败关闭。

**Constraints**：无旧数据迁移、无 sync force/DROP 旧库、无 frozen schema 修改；signature 不自证，DB/FS 副作用有独占 owner 与恢复 checkpoint。候选 SQL 不 import 到运行时，验证只 SQLite 内存。

**Alternatives / Consequences**：v9 自动迁移是另一个未授权项目；拒绝旧根会要求新安装使用独立根，但不会破坏旧数据。SQLite 最低版本/JSON/generation/deferred FK 能力必须在 S1 目标 driver 验证。

## ADR-V2-D6 — 资源预算类型冻结，部署数值实测

**Status split**：限额类型/单位/服务端检查位置 TECHNICAL_CONTRACT_READY_FOR_APPROVAL；数字 DEFERRED_TO_S1 容量验证。不能以未测数值声称 1GiB/16GiB 等容量合理。

**Decision**：文件源/编辑/查看 bytes、Workspace 总 bytes/entries、目录深度/路径 bytes、search/inventory 范围与 deadline、备份 payload/retained/硬上限、temporary 预算/空间 reservation、queue/active 并发均有类型和检查点。Execution D6 表给候选默认、当前限制来源、错误与测试位置。所有预算实际计数，HTTP 大小和浏览器限制不替代服务端。

**Failure**：预算不足先拒绝新写/快照，不删现文件/旧备份/最后保全 hold；完整 source inventory 不接受 truncated 作为成功证明。上传/ZIP 不是 S0/S1 前提，后续必须独立安全边界。

## ADR-V2-D7 — 发现忽略与用户覆盖

**Decision**：采用 WorkspaceDiscoverySuppressions(workspace_id,key)。明确 MANUAL/DISCOVERED/RETIRED/IGNORED；USER/DISCOVERY Cron 不同 owner。忽略后扫描不重建；源消失 retire 不硬删；重命名旧 retire+新 key；重现须显式恢复；manual 任务独立。

**Consistency**：reconcile 在 Workspace 稳定源/租约与 policy/task/trigger 版本下准备，完成事务 CAS；名称 baseline 保留用户修改，Runtime/ENV/Config/Hooks/settings 用户控制不被 scanner 覆盖。USER Cron disabled tombstone 永久阻止扫描复活，直到用户显式改定义。

**Alternative / Cost**：单纯硬删会再次发现，造成惊讶；引入 suppression 小型子资源及预览/解除忽略 API，代价可控；LOCAL 自动发现后置。

## ADR-V2-D8 — 身份历史与磁盘资产回收分离

**Context**：上一轮“历史 RESTRICT 后再移除物理源”的建议会把释放源码目录与长期日志捆绑；本次用户明确要求分离，属于技术建议收束。

**Decision**：ARCHIVE、DELETE REQUEST、TOMBSTONE、物理回收、历史 retention、metadata purge 是不同操作。TaskSource 任何引用及活跃 Run/Sync/journal 拒危险删除，绝不 cascade Task。历史 TaskRun/SyncRun RESTRICT 指轻量 Workspace 身份，source snapshot 不可变；目录可在无 live 引用、有 owner 与保全证明后回收，历史继续可读。

**Preservation / GC**：非空 LOCAL 及 GIT 默认要求覆盖当前 gen/rev/hash 的 READY 备份与持久 hold；空 LOCAL 需稳定空 inventory 证明。backup catalog 锁保护 verify→hold 安装；hold 防最后副本被 GC。reclaim 按 owned quarantine/marker/lease/journal 恢复，不递归删 unknown 目录；metadata purge 需所有 FK/hold/retention 条件满足，长期历史只占轻量 identity。

**Archive**：关闭新 admission，drain 实际 owner 后取消 queued 并禁 Task/SyncPolicy，保留定义和源码；unarchive 不自动启用旧 flag。失败 DELETE 保持原状态。候选 DDL 验证 Create→Task→Run→ 删 Task→archive/delete→RECLAIMED→Run 历史保留，不需要删 Run 来释放目录。

**Consequences**：真实 FS 安全回收/备份 hold 跨域验证待 S1；SQL 验证不能证明文件已安全删除。

## ADR-V2-D9 — 保守对账屏障与三事实同步

**Decision**：MVP 采 A。Git 实际 APPLIED、Discovery SUCCESS/FAILED、事件 NOT_COMMITTED/PENDING/DISPATCHED 分别展示；对账失败不伪装代码未变或整个 SUCCESS。记录 before/target/actual，已 apply 失败为 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION，阻整个 Workspace 普通执行/写/代码读取；只恢复 owner 可核验同 HEAD 后幂等继续，不 reset。

**Atomic success**：reconcile+applied_commit+SyncRun SUCCESS+同 id 成功 outbox 在一个事务，由延迟循环 FK/guards 约束；事务后消费。outbox→TriggerEvent→TaskRun 各有稳定去重身份，不靠 PID/内存。samecommit 重放不新 Run；source 变化在 lease 后 SKIPPED。

**A/B**：A 一致性屏障简单但降低故障时可用性；B 独立完成隔离更好但需输入 proof/多 generation/局部 ready/独立 reconciliation 及 outbox，状态空间与恢复成本大。B 保留扩展点，未经独立证明不部分放行 manual Task。完整比较/转换见 Sync 合同。

## 针对性事实澄清与建议变更记录

| ID  | 原位置/表述                                                        | 本轮证据/新合同                                                                                                                                                     | 分类与原因                                                            |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| C1  | 旧 Target/Entity 中的 Repository 或 Workspace“ATTACH/MASK”广义表述 | [TaskConfigService.save](../../../back/services/taskConfig.ts#L68)明确拒 repository MASK；SQL 字段枚举不等同 Service 接受。目标 Workspace ATTACH only，Task 可 MASK | 源码职责澄清；原 CURRENT 文件不静默改写，授权 Target 更新并引用本记录 |
| C2  | 旧 Open D8“retention 后才移除物理源”                               | 本轮用户明确分离 history/tombstone 与 physical reclaim，保全后不必等待 Run 日志删除                                                                                 | 技术建议被新要求收束，不是新发现源码缺陷                              |
| C3  | 旧 Backup 现 idle 将 QUEUED 也算 busy                              | [coordinator.idle](../../../back/services/backup/coordinator.ts#L40)属实；新合同冻结 dispatcher 后允许稳定 QUEUED 持久记录进入 snapshot                             | 明确未来行为变化，不能说当前已支持                                    |
| C4  | 旧 D3 只写排队/拒绝                                                | [ExecutionService](../../../back/services/executionService.ts)现 busy 回 QUEUED 缺持久期限/容量；本轮补单 Run 等待/timeout/限额/重启/source 语义                    | 技术契约补齐；无第二队列，无业务实现                                  |

所有 ADR 还需人工最终批准。D1/D2/D4/D5/D7 的本次候选方向由用户明确指定；具体 DDL/DTO/数值及 D3/D8/D9 细节不冒称已经批准。
