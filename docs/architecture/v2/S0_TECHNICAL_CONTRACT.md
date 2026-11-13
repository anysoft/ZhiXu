# ZhiXu v2.0 — S0 Technical Contract

合同版本：`zhixu.workspace.v2.s0.1`。状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**，不是 APPROVED，不授权 S1–S5。本次授权仅设计、候选 DDL 与隔离验证。

## 1. 权威、基线与输入

- PRODUCT_FROZEN：通用脚本自动化平台、LOCAL/GIT 统一持久 Workspace、统一 Task/Execution 链、Git Workspace 所有同步、显式 GitUpdate Trigger、无独立 Subscription、fresh-v2 且不自动清空/迁移旧数据。
- TECHNICAL_RECOMMENDED：上一轮 15 报告中的技术建议；本轮经针对性源码复核、D1–D9 ADR 与隔离验证，收束为 TECHNICAL_CONTRACT_READY_FOR_APPROVAL。
- DEFERRED_TO_S1：容量/部署数值实测、文件系统与 FD/child crash 验证、生产 ORM/schema/服务接线；不是把安全不变量推迟决定。
- 源码基线：`develop@d527a46095e85b7fc61c83544cd847a6e3f237db`。起始已有`.gitignore`修改并忽略本目录，保持不变；15 份原报告已存在但未 tracked。业务源码 HEAD 未变。
- 本轮完整输入由并行责任域阅读：主代理读总评、Target/Current/Open/Roadmap、Sync/Backup/Security 与矩阵/验证；实体代理读 Entity 及后端清单；执行代理读执行/安全及测试/CI 清单；API 代理读 API/前端及对应清单；899 文件清单按段完整阅读，**不重新生成**、不重新全仓 audit。
- GitNexus 缓存 CLI 1.6.12，registry=ZhiXu，索引 8b8dd39 落后 HEAD 两提交，未刷新；query 用于定位，当前源码为契约依据。无既有业务符号编辑，S0 不是上一轮 impact 结果的实施豁免。

若旧技术建议与本轮新用户明确 D3/D8/D9 要求不同，以本 S0 合同及 ADR 为设计候选。原报告 CURRENT 事实不改写；具体澄清见 Decision Record。规范优先级：用户冻结产品 → 经最终批准后的 S0 合同；当前候选 SQL/API/DTO 必须互相一致，有矛盾则 READY=NO，不由实施者任选。

## 2. 合同目录

| 规范                                               | 内容/权威范围                                               |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [Decision Record](S0_DECISION_RECORD.md)           | 9 个正式 ADR、状态/原因/替代/代价                           |
| [Database](S0_DATABASE_CONTRACT.md)                | 完整字段/约束/索引/SQL guards、13 旧 FK、新 schema 身份     |
| [API](S0_API_CONTRACT.md)                          | 路由、Panel 认证授权、请求/响应、CAS/幂等、合法状态/副作用  |
| [Execution / Locks](S0_EXECUTION_LOCK_CONTRACT.md) | 单 Run 队列、等待/跳过、source proof、lease/owner/恢复与 D6 |
| [Sync / Events](S0_SYNC_EVENT_CONTRACT.md)         | 3 事实、A/B 取舍、同步/发现/outbox/事件/Run 状态机          |
| [Backup / Restore](S0_BACKUP_RESTORE_CONTRACT.md)  | manifest、admission、跨根恢复、保全 hold/回收               |
| [Errors](S0_ERROR_CODES.md)                        | 唯一安全错误表，HTTP/Retryable/Resource/Operation/Recovery  |
| [Acceptance Gates](S0_ACCEPTANCE_GATES.md)         | S0 实证层级与 S1–S5 可测试门/停止条件                       |
| [Review Report](S0_REVIEW_REPORT.md)               | 结果、执行命令/receipt、范围检查及最终 gate                 |
| [contracts](contracts/)                            | 非运行时 DDL、DTO、路由/错误/状态数据和隔离验证工具/receipt |

所有 contracts 文件都是设计材料，不得 import 到 back/src/build/bootstrap，也不能以复制 SQL 到用户库的方式“验收”。

## 3. Workspace 及 D8 生命周期

Canonical 持久模型采用方案 A：Workspaces 公共身份；GitWorkspaces 共享 PK 扩展，吸收 Worktrees 状态，不另建独立持久 Worktrees 业务表。type/Repository/ref 创建后不可普通 PATCH；同 Repo/ref 允许多个 Workspace，独立 root/private branch/lease/ENV/Runtime/Config/policy。Branch 私有 branch `ws-{workspace_id}`；Tag/Commit detached、创建解析 commit 固定。

| 维度             | Canonical 值                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| WorkspaceType    | LOCAL / GIT                                                                             |
| lifecycle_state  | CREATING / READY / ARCHIVED / DELETE_REQUESTED / TOMBSTONED / ERROR / RECOVERY_REQUIRED |
| storage_state    | PROVISIONING / PRESENT / RECLAIMING / RECLAIMED                                         |
| public identity  | workspace_id、type、version、source_generation、content_revision                        |
| root identity    | 系统派生 root_key + root_device/root_inode + private owner marker；不接受 host 绝对路径 |
| content identity | content_inventory_hash 为稳定用户 tree fingerprint；不是完整执行 snapshot               |

root key 固定为 `workspaces/{local|git}/ws-{id}`。LOCAL 没有 Git 扩展，READY GIT 必须有合法 Repository/ref/checkout 扩展。CREATING 可在建 FS 期间暂缺扩展，但无执行/编辑资格；READY 切换前 SQL 和 Service 双层校验。普通 SELECT 不授予 requireReady 能力。

| 操作                 | 接受条件/持久事实                                                                                  | 结束及历史                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CREATE               | Panel 授权，CREATING identity+WorkspaceOperations；目录/checkout 所有权可证明                      | 完整 root/扩展/hash 校验后 READY/PRESENT；失败 ERROR 或 RECOVERY_REQUIRED，不自动删除未知文件                                  |
| ARCHIVE              | active operation 原子关闭新 admission，安全 drain 实际 owner                                       | 完成事务取消 QUEUED Run/Sync（CANCELLED/WORKSPACE_ARCHIVED），禁 Task/SyncPolicy 并 bump 版本，ARCHIVED/PRESENT；不删任务/代码 |
| UNARCHIVE            | 显式 CAS，验证 root/journal/source/readiness                                                       | READY/PRESENT；不重新启用 Task/SyncPolicy，不补跑旧 slot                                                                       |
| DELETE REQUEST       | 无任何 TaskSource 及活动 Run/Sync/file/journal/recovery；精确 source 保全证明；失败 409 保持原状态 | 接受后 202+durable op，DELETE_REQUESTED 阻新 admission，不级联删 Task                                                          |
| LOGICAL DELETION     | 有 owner/保全检查的回收操作                                                                        | 轻量 TOMBSTONED identity 保留 source 摘要与历史 FK                                                                             |
| PHYSICAL RECLAMATION | 所有权确定、保全 hold 安装、同锁内安全 quarantine/reap/fsync                                       | RECLAIMED，无 root 是合法状态；历史 Run/SyncRun 仍可读                                                                         |
| FINAL METADATA PURGE | storage 已回收，retention 满足，无历史/业务/outbox/event/hold 或 recovery 引用                     | 内部审计 GC；不提供 force UI 绕过，无 identity 复用                                                                            |

ARCHIVED 只允许安全 metadata/history GET、持 lease 的文件读取、显示名称、unarchive/delete 以及回收前必要引用解除/Task 删除/default 解绑；不允许新增 Profile/ENV/Runtime/Config/policy 配置。WorkspaceOperations active 行推导 admission 关闭，不新增另一份会漂移的 admission_state 列。Archive 操作有候选 300000ms drain deadline，保留 Task timeout_seconds=null 的现有语义；超时仍有 owner 则 op FAILED/WORKSPACE_BUSY、原 READY 与 admission 恢复，queued/Task flags 不提前变更，不能强杀 child；cleanup 未知则 RECOVERY_REQUIRED。

历史 TaskRun/SyncRun 使用 RESTRICT 指 Workspace identity/tombstone；活动/恢复指针单独保留和释放。历史 FK 只阻 metadata purge，**不阻目录回收**。必要案例“创建 Workspace→ 建 Task→ 运行 → 删除 Task→archive/delete→ 回收文件 → 仍保留 Run 历史”必须可完成；候选 DDL 隔离测试覆盖身份/FK 路径，真实 FS 回收待 S1。

## 4. D3 执行与输入契约

TaskSource 统一 WORKSPACE_ENTRYPOINT，workspace_id/relative_entrypoint/language/cwd_mode/cwd_relative_path；无 Repository 前提。Tasks 和 TaskSources 用延迟复合 FK 保证同 owner，COMMIT 不能留下无 Source Task；同事务构造中间态不可执行。

唯一 durable 队列为 TaskRuns。FORBID/QUEUE/ALLOW 保留 Task 粒度语义；任何策略都不能绕过 Workspace EX 租约。同 Workspace 不同 Task 不并行，不同 Workspace 可并行。WAIT/SKIP/FAIL_FAST 只调资源等待，不是第二个 Task policy；自动触发固定 WAIT，手动可显式选择。完整期限/队列上限/公平性/misfire/cancel/restart 见 Execution 合同，默认值标记 S1 容量候选。

admission 冻结 Workspace/Task/Source 与有效资源版本；Workspace profile/default/config mutation 与 Task 子资源 mutation 必须递增对应聚合 version，Global ENV 使用 GlobalEnvironmentRevision 单调 counter。secret 值或其值 hash 不能作为公开版本。获取 Workspace lease 后复核实际 tree/hash/HEAD 与版本；变化则 SKIPPED/SOURCE_SUPERSEDED，无 attempt/注入/spawn，不自动换源重跑；未知/不稳定 source proof 走 RECOVERY_REQUIRED。

锁序：可选 backup catalog EX→platform admission→Repository（需要时）→Workspace→runtime pin；不持 DB 写事务等待 OS 锁。相同 workspace-{id}.lock inode、sha256("workspace:{id}") resource key、按 Workspace 标识的 Config/Node/恢复 journal 适用于 Editor/File/Git/Run/recovery。child 继承 FD，controller SIGKILL 不能提前释放仍在写入的 child 资源。

未来 Execution Snapshot/Overlay 是独立策略/ADR；本 MVP 排他租约明确有同 Workspace 吞吐与长任务阻编辑限制，不是最终并发架构。

## 5. D4 继承与 ready

Profile 选择是 Task 选中同 Workspace Profile > Workspace Default Profile（二选一），然后变量 System allowlist→Global→ 选中 Profile→Task SET/UNSET。多个 Profile 从不顺序叠加；跨 owner 复合 FK/Service 拒绝。UNSET 移除变量；disabled 项不生效；secret 默认隐藏，preview/日志/TaskRun 只保存安全标识。

Runtime：Task override→Workspace default，Python/Node managed 环境，revision/build pin 后执行；缺环境/构建无效阻 readiness，绝无 Host fallback。Config：Workspace **ATTACH** → Task ATTACH/MASK；同 target_base/path 覆盖。Workspace MASK 不纳 MVP；Task MASK 屏蔽继承目标，不创建文件。选定 Config revision 在 execution snapshot 冻结，注入/清理/journal 保留；Hooks 仅 Task。

ready 错误用[统一注册表](S0_ERROR_CODES.md)：Source 缺失、Workspace 非 READY、恢复屏障、Runtime 不可用、ENV 跨 owner/禁用、Config/Hook 无效分别可诊断；不以“LOCAL 无 Repo”替代安全验证。

## 6. D5 Fresh 初始化与签名

候选 identity 为 `zhixu.workspace.v2.s0.1`，与当前 platform schema v9 不同。候选 SQL 定义完整 schema，signature 与 raw artifact digest 记录于 ddl-validation.json；实际 ORM/启动仍未改变。

| 数据根分类                  | 识别/启动行为                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EMPTY DATA ROOT             | 缺失或安全空目录；即使 SQLite 无表也要确认无未知用户资产。仅在独占初始化 owner 下以事务创建 fresh-v2、签名/完整性验证、fsync 后 READY                     |
| SUPPORTED FRESH V2          | metadata 唯一且 family/epoch/contract/signature 完全支持；quick/integrity+foreign_key_check 及 Workspace/source/FS 恢复门通过后可启动                     |
| UNSUPPORTED EXISTING SCHEMA | v9/旧 QingLong/未知 family/version 或无受支持 metadata 的非空根：UNSUPPORTED_DATABASE_SCHEMA，拒绝且原样保留，不自动升级/导入/清空                        |
| CORRUPTED V2 SCHEMA         | 已声明 v2 但 DDL/signature 缺失漂移、FK/数据库损坏、metadata 数量错误：DATABASE_SCHEMA_CORRUPTED；fail closed，只允许离线诊断/受控 restore，不 sync force |

目录含用户源码但无 DB 不能当空根接管；root marker、安全父链和独占 lifetime owner 必须先核验。禁止 sync({force:true})、DROP/重建旧库或重写 frozen platformV1..V8。当前 1→9 演进路径仅是历史源码事实，不被接成 v2 自动升级。

Signature 规范由 Database 合同给出：SQLite catalog 排除内部对象，按 type/name 确定排序和 UTF-8 规范序列化计算 SHA256；不错误删除字符串字面量内空白。expected signature 必须来自经批准候选 artifact，不能把启动时现库自身 hash 当 expected 自证。

## 7. D6、D7、D9 与备份硬门

D6 限额类型/单位/检查位置为合同，具体部署数字 DEFERRED_TO_S1 实测；文件/Workspace/entries/depth/search/inventory/backup/temp reservation/queue 预算全纳服务端，不靠浏览器限制。上传和 ZIP 后置。

D7 有 WorkspaceDiscoverySuppressions；MANUAL/DISCOVERED/RETIRED/IGNORED 与 USER/DISCOVERY Cron 区分，用户修改不被扫描覆盖。

D9 采 A：Git 应用、Discovery、event 分别持久显示；Git 已变但对账失败为 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION。所有普通 Workspace 执行和代码访问阻断；只恢复 owner 核验 actual HEAD==target 后续作，不 reset。对账+applied_commit+SyncRun SUCCESS+Outbox 同事务，提交后才 dispatch；same successful content→no duplicate TaskRun。

Backup 首次保护 LOCAL 即补 manifest/validator/跨根恢复；稳定 QUEUED 可快照，实际 owner/临时注入/未知 sync 必须 drain 或拒绝；不能借备份清队列。S1 文件组件与 S2 真实 Task/Runner 联合完成资产灾难恢复门之前，不开放正式 LOCAL 持久写入口。

## 8. 验证等级与最终边界

DESIGN_VERIFIED 是关系/状态/锁序/恢复设计审阅；STATICALLY_VALIDATED 是 DTO 编译、路由/错误/字段/链接等静态检查；DYNAMICALLY_VERIFIED 仅限此次真实运行的 SQLite :memory:候选 DDL 正反例；平台/FS/Git/FD/backup/浏览器/Linux/Container 一律 NOT_RUN。

精确结果与 receipt 见 Review Report。S0 ready 意味着技术材料可供最终批准；USER_APPROVAL_OF_S1=NOT REQUESTED / NOT GRANTED。完成后停止，不自动进入 S1。
