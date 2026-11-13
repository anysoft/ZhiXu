# S0 Execution / Lease / Concurrency Contract

状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**。产品 LOCAL/GIT 与统一 Workspace 是 PRODUCT_FROZEN；本文是 S0 候选技术合同，不是用户批准、S1 实现或生产资格。候选默认数值为 TECHNICAL_RECOMMENDED，部署合理性 DEFERRED_TO_S1。SQL 以 [数据库合同](S0_DATABASE_CONTRACT.md) 和 [候选 DDL](contracts/fresh-v2.sql) 为准，DTO 示例见 [execution.dto.ts](contracts/execution.dto.ts)。

## 1. 针对性源码复核与设计差异

本轮完整复用 [执行与备份评估](EXECUTION_AND_BACKUP.md)、[安全与生命周期评估](SECURITY_AND_LIFECYCLE.md)，读取文件影响表的全部测试、CI/容器/脚本边界，以及诊断表第 101–200 项；没有重建 899 文件清单。

| 当前源码事实                                                                                   | 证据                                                                      | S0 收束                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 默认 Task concurrency=FORBID，另有 QUEUE/ALLOW                                                 | [taskDefinition](../../../back/shared/taskDefinition.ts#L150)             | 三种 Task policy 保留；不新增另一个任务排队域                         |
| submit 在 IMMEDIATE 事务内检查同 Task 所有 pending；FORBID 建立 SKIPPED，重复 event 返回同 Run | [ExecutionService.submit](../../../back/services/executionService.ts#L49) | 保留其幂等及 FORBID 语义，Workspace 排他是额外资源约束                |
| QUEUED 按 ID 轮询；同 Task 非 ALLOW 互斥；当前 worker 最多 8 个 active                         | [tick](../../../back/services/executionService.ts#L264)                   | 单一 TaskRuns durable queue；加界限、deadline 与跨 Workspace 公平调度 |
| resolver 遇 runtime busy/snapshot changed 会回同 Run QUEUED，无持久期限/队列上限               | [execute catch](../../../back/services/executionService.ts#L478)          | 有界等待，源变化不自动使用新版本重试                                  |
| QUEUED cancel 直接 CANCELLED；active 通过 cancel flag/child 协调；recovery 不能当普通 cancel   | [cancel](../../../back/services/executionService.ts#L195)                 | 保持同 Run 身份，不取消后另建替代 Run                                 |
| Cron missed 且 SKIP 仅创建 SKIPPED TriggerEvent；FIRE_ONCE 处理一个旧 slot 后推进到 now 以后   | [TriggerScheduler.tick](../../../back/services/triggerScheduler.ts#L25)   | Cron misfire 与资源排队各司其职，不重新计算已入队 Run 的触发时刻      |
| TriggerEvent 收到后，Run 创建、submission key 与 event linkage 在同事务                        | [TriggerEvents](../../../back/services/triggerEvents.ts#L16)              | 继续是唯一自动触发入口，不添加 Workspace 专用运行队列                 |
| 当前 TaskRun SKIPPED 不增加连续失败且不进入默认 success/failure 通知                           | [observability SQL](../../../back/schema/observabilitySchema.ts#L58)      | SOURCE_SUPERSEDED/等待过期/并发跳过保留这项语义                       |

静态结论为 STATICALLY_VALIDATED；MVP 新行为仅 DESIGN_VERIFIED，具体 POSIX/运行时/浏览器/容器结果 NOT_RUN。原报告的“immutable Context 不等于文件快照”仍然成立。

## 2. 执行身份、根目录与冻结输入

### 2.1 内部接口

- `WorkspaceRootResolver.requireReady(workspace_id, lease, expected?)`：仅在真实 Workspace EX lease 内检查生命周期、storage state、root marker、dev/ino、完整安全 source inventory、可选 Git 实际 HEAD，返回内部 canonical root。客户端不能提供根路径。
- `WorkspaceLeaseService.acquire(workspace_id, owner, admission, mode)`：取得同一 inode 的排他 FD；mode 仅内部 `TRY`（非阻塞）或有界恢复控制，普通 dispatcher 不持锁等待。返回 owner token、resource key、继承 FD 与 assertHeld/release。
- `TaskResourceResolver.resolve(task_ids, transaction, depth)`：纯定义/关联/版本解析，不能注入配置、构建 Runtime 或取得文件租约；admission 使用数据库与已核验的 Workspace source 摘要。
- `ExecutionResolver.resolve(run_id, run_owner, workspace_lease)`：复读不可变 admission expectation，验证 source 与 effective resource 版本，pin managed runtime，形成一次冻结 Context；任何 git 信息只存在 GIT 分支。

`WorkspaceRootResolver`不可在无 lease 的普通 SELECT 之后就宣告 root 安全。数据库 READY、source hash、真实路径与恢复 journal 是共同前置，不能互相替代。

Workspace 可用与 Task 可执行分开：DISCOVERED 且 RETIRED 的 Task 不因文件重现就获得手动或自动执行资格，必须显式恢复并复核，入场失败用 TASK_NOT_READY。普通 MANUAL Task 的用户禁用标志与显式手动运行沿用原有政策，不把此例外扩大为运行 RETIRED 发现任务。Backup 中经成功 reconcile 生成并复验的`RETIRED_MISSING_EXPECTED`引用，只证明退休缺源是已知状态，不授予执行资格；任意 disabled Task 或缺失 LOCAL 活跃源不能借此绕过 SOURCE_MISSING。

### 2.2 admission_snapshot 与 source_snapshot

TaskRun admission 的 IMMEDIATE 事务持久化：`workspace_id`历史 FK、`expected_workspace_version`、`expected_source_generation`、`expected_content_revision`、`expected_task_definition_version`、`expected_global_env_version`、`expected_git_commit`（仅 GIT）、`expected_inventory_hash`、有效 Profile/Runtime Environment revision/build/Config revision 的 IDs 与版本，以及 system allowlist 的构建版本字符串。Task 的 ENV/Config/Hooks/settings/runtime 子资源变更须同事务递增 Task definition version；Workspace Profile 变量/default/runtime/config binding 变更须同事务递增 Workspace.version。

Global Envs INSERT/UPDATE/DELETE 由`GlobalEnvironmentRevision(singleton_id=1,version)`触发器单调递增，覆盖值和成员变化；不能靠 updatedAt 毫秒精度或公开 secret 值/hash 检测。所有排队 Run 遇全局 ENV 版本改变，保守地 SKIPPED/SOURCE_SUPERSEDED（reason RESOURCE_CHANGED）；这是可解释的 MVP 可用性代价，不自动吸收最新 ENV。

admission_snapshot 一次写入不可改；source_snapshot 初始 NULL，在真实 lease 内验证并 pin 成功后只允许填充一次。手动/Cron/Webhook 提交从当前已核验的数据库 source tuple 冻结期待；GitUpdate 必须从成功 outbox/event 冻结完整 `(workspace_id, source_generation, content_revision, inventory_hash, after_commit)`，不把当前 B 的 hash/revision 和迟到 A 事件的 commit 混合。若 admission 时已经被 B 推进，建立可审计 SKIPPED/SOURCE_SUPERSEDED，不运行 B 冒充 A。记录真实执行源 identity 与相对入口、CWD、language、commit/hash 及 Runtime/Config revision 标识，不记录完整 child ENV、secret 值、凭证或绝对宿主路径。后续文件回收不删除这些历史事实。

Workspace 的`content_inventory_hash`是已安全核验的源码清单摘要，不是内容归档：受控文件写入、Git 应用/完成以及 child 终止后 Config/Node 清理完成，都必须在 lease 内稳定核验，并把 hash 与 content_revision 共同提交。受控临时注入不能成为源码版本；清理失败不能发布新稳定摘要。

清单按规范相对路径排序，逐项编码 path/type/mode/size/sha256；纳入真实源文件和目录，排除`.git`管理域与受控平台保留目录/注入项；文件必须 regular、single-link、no-follow 且读取前后身份稳定。平台保留项由独立 journal/integrity gate 审核，排除不表示可以任意往里面藏用户代码。清单预算完整遍历失败不能返回 truncated 后当 READY。

### 2.3 lease 内最终复核

| 复核结果                                                                                          | Run 最终动作                                                                                                         | Workspace 动作                                                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| source generation/revision/inventory/Task 或 Workspace 版本/Git commit/effective resources 均匹配 | 形成 source_snapshot，继续 pin/attempt                                                                               | 保持 READY，lease 持续持有                                           |
| 可证明源或定义已变化                                                                              | `SKIPPED / SOURCE_SUPERSEDED`；reason SOURCE_CHANGED / TASK_CHANGED / RESOURCE_CHANGED；不注入、不 spawn、不自动重提 | 安全核验后的新 source 摘要可按受控 mutation 提交；不把差异伪装旧版本 |
| 源根丢失、owner/inode 不符、未知 journal、无法得到稳定安全 inventory                              | `RECOVERY_REQUIRED / SOURCE_UNVERIFIED`或更具体`SOURCE_MISSING`；不 spawn                                            | RECOVERY_REQUIRED；只有修复 owner 可进入文件恢复路径                 |
| 临时 runtime/build 锁忙且未发生注入/child 副作用                                                  | 原 Run 回 QUEUED、reason RUNTIME_CAPACITY                                                                            | 释放本次 FD，按原 deadline 重试                                      |

源码期待变化不是普通 retryable busy，不能使用当前`EXECUTION_SNAPSHOT_CHANGED→QUEUED→latest`的方式无限重试。生命周期变为 ARCHIVED/DELETE_REQUESTED 也阻止入场；按生命周期合同安全终结/拒绝，不偷偷切到其他 root。

同 UID 的非合作外部进程可绕 advisory lock 写文件；可信脚本也可能主动修改源码。平台在 child 结束与清理后重新核验，令后续排队预期失效，但不声称锁或 hash 提供恶意同 UID 进程的 OS 隔离。完整可重现 import 依赖、运行时不可变代码树仍需未来 Execution Snapshot/Overlay。

## 3. D3：一套队列、两层约束

### 3.1 Task policy 先于 Workspace 资源

Task concurrency 是“同 Task 是否接纳/排序”的逻辑政策；Workspace lease 是“一个可写目录是否可被进程使用”的物理约束。二者都必须满足。MVP 同 Workspace 的不同 Task 也不能同时执行；不同 Workspace 在全局容量内可并行。

| Task policy（随 Run 快照） | 同 Task 已有 QUEUED/RESOLVING/RUNNING/RECOVERY_REQUIRED                                        | 允许接纳后如何运行                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| FORBID（默认）             | 不论手动/定时/事件，建立一个可审计 SKIPPED Run，code TASK_CONCURRENCY_FORBID；event 绑定此 Run | 无 pending 则接纳；随后仍需 Workspace lease         |
| QUEUE                      | 接纳到同一个 TaskRuns 表；同 Task 按(submitted_at,id) FIFO                                     | 较早 Run 尚未终结时 WAIT，之后竞争 Workspace 资源   |
| ALLOW                      | 不因同 Task 已有 Run 拒绝                                                                      | MVP 仍被 Workspace EX 串行；不承诺同 Workspace 并行 |

重复 Idempotency-Key 或 TriggerEvent 先查 submission identity，直接返回已有 Run，再考虑 FORBID 和 quota；不得因重试把同事件生成为第二个 SKIPPED Run。

### 3.2 资源等待选择

新增请求偏好`wait_mode: WAIT | SKIP | FAIL_FAST`只决定 Workspace 资源忙时的处理，不取代 Task concurrency、Cron misfire 或 Runtime pin 规则。手动/受权 API 可选择，默认 WAIT；CRON/WEBHOOK/GIT_UPDATE 及内部自动来源固定 WAIT，不能由不可信 payload 改策略。

| 条件                                     | WAIT                                                            | SKIP                                     | FAIL_FAST                                                 |
| ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| 同 Task FORBID 已 pending                | 都是 SKIPPED/TASK_CONCURRENCY_FORBID                            | 同左                                     | 同左                                                      |
| 同 Task QUEUE 尚未轮到                   | 保持 QUEUED/TASK_CONCURRENCY                                    | 同左；不绕过 Task FIFO                   | 同左；不绕过 Task FIFO                                    |
| Workspace 首次真实 TRY acquire 忙        | QUEUED/WORKSPACE_LEASE，释放 owner/FD 后有界再试                | 同 Run SKIPPED/WORKSPACE_BUSY，0 attempt | 同 Run SKIPPED/WORKSPACE_BUSY，0 attempt，不进入资源等待  |
| 手动 FAIL_FAST admission 非阻塞 probe 忙 | 不适用                                                          | 不适用                                   | HTTP409 WORKSPACE_BUSY，无 TaskRun；幂等重放已有 Run 例外 |
| Workspace 状态为 RECOVERY_REQUIRED       | 不是可等待的普通 BUSY；拒新提交/恢复已排队 Run 按专门 gate 处理 | 同左                                     | 同左                                                      |

probe 只反映当时占用，不预留资源；FAIL_FAST 的 HTTP202 受理不能保证立即 RUNNING。若 probe 后出现竞态，dispatcher 第一次真实 TRY acquire 失败即把已受理 Run SKIPPED，不返回 WAIT。初始 probe 失败的 409 不消费 Run identity；再次提交可以重试同请求 key。不能用无锁 probe 成功作为执行许可。

资源忙时不持 Workspace/Runtime FD 或长数据库事务睡眠。同步、文件操作与运行共享相同 lease；即使 Task ALLOW 也不可用“另一个执行锁”绕过。

### 3.3 durable 字段、期限与公平性

只有 TaskRuns 是任务等待队列，不建立 WorkspaceTaskQueue 或内存权威队列。必须持久：`concurrency_policy`、`wait_mode`、`queue_reason`、`queue_deadline_at`、`next_eligible_at`、`queue_attempt_count`以及第 2 节 expectation。状态仍是 QUEUED；WAIT 不新增状态枚举。

queue_reason：`NONE / TASK_CONCURRENCY / WORKSPACE_LEASE / PLATFORM_QUIESCING / RUNTIME_CAPACITY`。deadline 从 submitted_at 计算，绝对 UTC，重启、backup 暂停、owner 重试不延长；Run 运行超时仍由独立 timeout_seconds/attempt 规则处理，不把 queue wait 计作执行超时。

候选默认：wait timeout **900,000 ms**；每 Task 最多 **32** 个 QUEUED、每 Workspace **128**、全平台 **1,024**；同时 active 执行 **8**。这些数值是 S1 容量试验输入，未证明吞吐/容量合理；硬边界检查必须存在，即使部署值调整。

- 计数和接纳在同一 IMMEDIATE 事务内；判定顺序是幂等重放 → 生命周期/readiness→FORBID 已有 pending→queue quota→ 建立 Run。FORBID 跳过不占 QUEUED quota。
- quota 满：手动/API 返回 HTTP429 EXECUTION_QUEUE_FULL，不创建 Run；自动事件建立 SKIPPED/EXECUTION_QUEUE_FULL 并原子关联 TriggerEvent，防止永久重投。事件本身仍有全平台存储/速率限制，不能用无限 SKIPPED 记录绕过磁盘 quota。
- QUEUED 期限到达：同 Run 转 SKIPPED，code WORKSPACE_WAIT_TIMEOUT，无 attempt；不生成替代 Run。TASK_CONCURRENCY 或容量等待也消耗同一 Workspace 调度 deadline，code 表示未能在该期限取得执行资源，不是脚本运行失败。
- dispatcher 按 Workspace head-of-line 候选选择，跳过正被占用/未来 next_eligible_at 的 Workspace，以避免热 Workspace 把全局扫描 limit 占满。每 Workspace 最早可运行票据按 submitted_at/id；跨 Workspace 采用有界轮转，不承诺严格全局 FIFO。
- TRY busy 后 queue_attempt_count+1；next_eligible_at 采用 250 ms 起、上限 5,000 ms 的有界退避及不超过 10% jitter；不改变 Run 身份/deadline。多个 worker 用短 run-owner lease+数据库 CAS 抢同 Run；状态/owner 不匹配立即退出。
- 启动先做恢复，再 dispatch；QUEUED 不持 OS 锁，重启从数据库继续。内存 timer 只是唤醒器，不决定队列事实。

### 3.4 Cron、取消、源码和重启

Cron SKIP：若错过至少一个后续 slot，记录 SKIPPED TriggerEvent/CRON_MISFIRE_SKIPPED 并将 next_fire 推进到 now 后，不建立 TaskRun；FIRE_ONCE：仅将一个 durable occurrence 提交一次 Run，不补齐每个停机 tick。已经提交 Run 后不能再次用 Cron misfire 丢弃/重造它；它服从 Task policy、原 deadline 与 source expectation。

QUEUED 取消在一个事务中写 cancel_requested、CANCELLED、finished_at/result 并保留 event→Run 关联；dispatcher 事务复查后不得 claim。若 CAS 竞态已到 RESOLVING/RUNNING，则发 cancel intent，由 coordinator 监督子进程、恢复 Config/Node 后终结；不可直接清 FD。RECOVERY_REQUIRED 不接受普通 cancel 来掩盖待恢复资产。

进程重启：live run-owner FD 忙则保留当前 owner；只有证明 owner 已死且子孙不再持 lease 后才接管。QUEUED 在同一 ID 上先判取消/绝对 deadline/源期望，再取 Workspace；active ghost 在安全恢复后 INTERRUPTED，未知情况 RECOVERY_REQUIRED。不自动把已启动过的未知 Run 变为新的 QUEUED 执行。

显式 Archive 是另一个明确的用户副作用：WorkspaceOperations 先关闭新 admission，并等待已取得资源的 owner 安全结束；不等待 QUEUED 先运行。归档完成事务原子把该 Workspace 仍 QUEUED 的 TaskRun/SyncRun 记为 CANCELLED、error_code=WORKSPACE_ARCHIVED，保留 ID/event linkage，TaskRun attempt_count=0 且沿用 notify_cancelled；同时禁用 Task 与 SyncPolicy 并递增版本，然后进入 ARCHIVED。归档未完成不得先取消这些队列再声称仍正常可用；Unarchive 不恢复 enabled、不重建队列、不补跑。当前 Task 的 timeout_seconds 允许 NULL，S0 保留此运行语义，不新增归档强制 kill 或全 Run 超时。单独 Archive operation 持久 drain_deadline（候选 300,000ms）：届时仍有正常活跃 owner，操作 FAILED/WORKSPACE_BUSY、Workspace 保持原 READY 并安全重开 admission，queued/flags 不变，原 Run 继续；用户可显式 cancel Run 后重试归档。cleanup 无法确认则进入 RECOVERY_REQUIRED 而非成功或安全重开。ARCHIVED 禁止 Runtime/ENV/Config 等运行配置改写，仅允许生命周期操作、安全元数据展示/改名，以及显式删除 Task、解绑引用/default 等为回收准备的操作。

## 4. Workspace 交互矩阵

| 竞争                                   | 合同动作                                                                                         | 原因与结果                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 同 Workspace 两个 TaskRun              | 物理串行；Task policy 决定接纳/FIFO，资源 wait_mode 决定 WAIT/SKIP                               | 不同 Task 也不并行；ALLOW 不是跳过 lease                                               |
| TaskRun vs Git Sync                    | 同一 EX inode；Sync 默认 TRY 忙记 BLOCKED/WORKSPACE_BUSY 或按 SyncRun 策略排队，不能覆盖运行源码 | 不把 Git 同步当 TaskRun；sync apply 后有恢复屏障则 Run 不可入场                        |
| TaskRun vs File Read/Edit/Search       | 文件操作全程同一 EX lease；即时 UI 请求忙返回 409，保留草稿                                      | 不让 GET 读取临时 secret 注入；不为 UI 加入第二 durable 任务队列                       |
| TaskRun vs Config/Node materialization | materialization 只能是该 Run 持有 lease 后的内部阶段，复用同一个 lease 能力                      | 禁止嵌套再取同 Workspace 锁而自死锁；cleanup 后才 release                              |
| TaskRun vs Backup                      | 新 claim 关闭；已持 lease 操作安全 drain；稳定 QUEUED 可进快照                                   | 不取消/清空排队 Run 换取 backup 成功；详见[Backup 合同](S0_BACKUP_RESTORE_CONTRACT.md) |
| File/Git restore vs Run                | backend lifetime/restore admission 先关闭；待真实 owner 释放；候选与最终源验证后重新开放         | RESTORE_PENDING 是平台状态，不作为普通 WORKSPACE_BUSY 轮询                             |
| Runtime build/delete vs Run            | Workspace lease 后取得 managed runtime/build pin；反向删除按 reference/lease 拒绝或等待          | 同一 build 可供不同 Workspace 只读并行，源码根不安装依赖                               |

## 5. 单一 lease identity、锁序与 journal

| 项                 | 正式候选                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace identity | 正整数 workspace_id；LOCAL/GIT 共用 ID 空间；类型不改变锁键                                                                              |
| root key           | 系统派生`workspaces/local/ws-{id}`或`workspaces/git/ws-{id}`；不是客户端路径                                                             |
| lock inode         | `${DATA_DIR}/.locks/workspace-{id}.lock`；安全创建后不 unlink/recreate，所有调用方打开同一 dev/ino                                       |
| resource key       | `sha256(UTF8("workspace:" + canonical_decimal_id))`，lowercase64hex；不混入 Repo/ref/path/PID                                            |
| journal key        | `workspace-{id}`；Config 与 Node 分域目录下用此 owner key，journal 内容同时含 resource key/root marker/source generation/operation token |
| run owner          | `.locks/execution-{run_id}.lock`或等价现 run-owner FD；随机 owner_token 绑定 run/operation instance，PID 仅诊断                          |
| child FD           | supervisor/helper 以显式继承 FD 持有 platform admission、Workspace 与 Runtime pin；不依赖父进程内存 finally                              |
| release            | child 树确认退出 →Config/Node 逆序恢复 → 稳定 source 核验 → 持久 Run 结果/源摘要 → 释放 runtime/Workspace/run owner/admission            |

全局顺序固定为：**可选 rank 0 Backup catalog/owner EX → Platform admission → operation/run claim →（Git 需要时）Repository lock → Workspace locks（多资源按 ID 升序）→ Runtime/Environment/build pins（稳定 ID 顺序）**。普通执行、文件操作和 Git 同步略过 rank 0；物理回收需要验证 READY backup 并安装 preservation hold 时，必须先取得与 backup delete/GC 共用的 catalog/owner EX（现 backup.lock 责任），再取 mutation SH 与后续 Workspace 资源。禁止持 Workspace 后等待 backup 锁，也禁止在持 Workspace 时临时创建备份来补保全。Snapshot 采用 backup owner → mutation EX，符合相同顺序。execution/LOCAL 路径不取 Repository 锁；持 Workspace 后不得反向等 Repository。run-owner claim 是无等待 TRY；busy 释放已得短 claim 并退回队列。短 IMMEDIATE 事务只做状态/CAS，不跨 OS 锁等待、网络 fetch、源码遍历或进程运行。

Git fetch 可先单独取得 Repository 锁完成，再释放；apply 时仍必须按 Repository→Workspace 取得所需锁并重新验证 target/HEAD。Repository 共享 bare 对象不代表不同 Workspace 共享 checkout 或 lease。未来新增跨 Workspace 操作必须先列出全部资源排序，不逐步发现后反向加锁。

控制器 SIGKILL 时，继承 FD 持锁直到 supervisor 确认子孙终止/reap；未知 child 仍活跃时新操作 BUSY，不因超时删除 lock 文件。所有 OS owner 消失但 journal 存在时仍 RECOVERY_REQUIRED，恢复 owner 持同 Workspace EX 按 dev/ino/hash 识别原件/注入件，逆序恢复；不能扫描删除未知`.platform`、node_modules 或临时目录。

Workspace.identity 可永久作为历史 tombstone 保留；source storage_state=RECLAIMED 时没有可执行 root，requireReady 必须拒绝，不能 mkdir“恢复”空目录。历史 FK 不授予文件保留/执行权限，也不阻止经生命周期合同批准的物理回收。

## 6. 正式 Run 转移与可观察性

精确机器表见 [execution-transitions.json](contracts/execution-transitions.json)，完整四状态机边界见 [Sync/Event 合同](S0_SYNC_EVENT_CONTRACT.md)。

| From              | To                                                             | 必要条件/事务                                                                                             |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 无 Run            | QUEUED 或 SKIPPED                                              | submission 身份去重、Task/workspace/source 资源快照、quota/并发判断和 TriggerEvent 关联同事务             |
| QUEUED            | RESOLVING                                                      | ownerTRY 成功；取消/期限/FIFO/平台 admission 复核，owner_token CAS；未取得 Workspace 时不伪造 active 指针 |
| QUEUED            | SKIPPED/CANCELLED                                              | deadline/政策/取消；无 attempt，不触及 Config/Runner                                                      |
| RESOLVING         | QUEUED                                                         | 仅无副作用可重试资源 busy；清 owner/active 指针并释放全部 FD，原 deadline 不变                            |
| RESOLVING         | SKIPPED                                                        | SOURCE_SUPERSEDED 或非等待 busy；Config/Runner 未开始                                                     |
| RESOLVING         | RUNNING                                                        | expected source/resource 全匹配；pin/context/source_snapshot 已持久；持 Workspace lease                   |
| RESOLVING         | FAILED/CANCELLED/INTERRUPTED/RECOVERY_REQUIRED                 | 非重试解析失败、取消、owner 恢复或资产未清；按错误事实选择，不把未知副作用标已清理                        |
| RUNNING           | SUCCESS/FAILED/TIMEOUT/CANCELLED/INTERRUPTED/RECOVERY_REQUIRED | attempt 规则完成，child 退出；仅 cleanup 成功才能离开资产恢复责任                                         |
| RECOVERY_REQUIRED | INTERRUPTED                                                    | 专门恢复 owner 已证明无活跃 child、所有 journal 清理、root/source 一致；禁止自动重新执行                  |
| 任一终态          | 无                                                             | 不恢复为 QUEUED 或改 source snapshot；重提是新 submission identity                                        |

active_workspace_id 是运行/恢复资产责任指针，正常终止清空；workspace_id 是不可变历史身份 FK，不清空。QUEUED 只有历史 workspace_id，没有 active_workspace_id/owner 长期 FD。S0 SQL guard 能拒绝非法状态/FK 组合，真实 FD、文件恢复与进程树仍是 S2 动态 gate。

SOURCE_SUPERSEDED 结果：status/result_code=SKIPPED，error_code=SOURCE_SUPERSEDED，attempt_count=0；安全 reason enum 说明 SOURCE_CHANGED/TASK_CHANGED/RESOURCE_CHANGED，附仅版本/安全 ID。日志事件至少 RUN_SUBMITTED、RUN_QUEUED、SOURCE_SUPERSEDED、RUN_SKIPPED；没有虚构 command output、exit_code 或 signal。Run 历史可检索，Task health 最近终态可显示 SKIPPED，但不增加 consecutive_failures，不清既有 failure streak，不默认投递成功/失败通知。等待超时同类 SKIPPED 规则；queued cancel 保留现有 notify_cancelled 显式选择。

## 7. D6：限额类型、单位、位置与候选默认

以下类型、服务端校验位置与失败语义为合同；数值均待 S1 容量与 S5 双架构压力验收，不宣称“合理容量已验证”。Bytes 使用二进制 MiB/GiB（1MiB=1,048,576 bytes，1GiB=1,073,741,824 bytes），时间均整数 ms；全平台配置不能由单次 HTTP 请求提高。

| Limit key                                           |                            候选默认 | 校验位置/行为                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| max_source_file_bytes                               |                 67,108,864（64MiB） | 文件发布/Git 入场/完整 inventory/restore 校验；超额拒绝或保持非 READY，不截断源码                                                                         |
| edit_text_max_bytes                                 |                   2,097,152（2MiB） | editor 请求流实际字节与最终文件；沿[当前 EDIT_LIMIT](../../../back/services/workspaceFiles.ts#L11)                                                        |
| view_text_max_bytes                                 |                 10,485,760（10MiB） | 文件读取服务；大文件只报告受限 metadata，不泄露部分秘密                                                                                                   |
| max_workspace_bytes                                 |               1,073,741,824（1GiB） | create/save/Git apply 后验证、backup preflight/restore、source inventory；aggregate 实际 regular-file bytes                                               |
| max_workspace_entries                               |                              20,000 | 文件+目录计数；发布前完整计划及发布后验证；不是只计 HTTP 请求文件                                                                                         |
| max_directory_depth                                 |                                  64 | 规范 root 相对段数；文件/目录创建、Git/restore 完整遍历                                                                                                   |
| max_relative_path_bytes                             |                               4,096 | 所有文件/root-relative API 与 manifest 成员；沿现 workspaceRelative                                                                                       |
| search_max_entries/bytes/file_bytes/matches         | 10,000 / 33,554,432 / 262,144 / 200 | 搜索服务预算；沿现 search 边界，达到时合法返回 truncated=true 与扫描统计，不用于 source 证明                                                              |
| search_deadline_ms                                  |                               3,000 | 服务端单调时钟；取消遍历/child 并释放 lease                                                                                                               |
| inventory_max_entries/bytes/deadline_ms             |     20,000 / 1,073,741,824 / 30,000 | 执行/admission 摘要更新与备份领域验证；必须完整；耗尽 SOURCE_UNVERIFIED，不能返回 partial READY                                                           |
| backup_snapshot_payload_bytes                       |             17,179,869,184（16GiB） | snapshot 预估与实际流量双计数；超额不生成 READY                                                                                                           |
| backup_retained_total_bytes                         |             68,719,476,736（64GiB） | 新 backup reservation；quota 满拒绝，不自动删旧备份/唯一源码                                                                                              |
| backup_archive_hard_entries/depth/bytes/entry_bytes |     1,000,000 / 128 / 1TiB / 128GiB | 当前[backup inventory](../../../back/services/backup/inventory.ts#L69)/[archive](../../../back/services/backup/archive.ts#L18)硬上界保留；产品 quota 更小 |
| temporary_max_total_bytes                           |             34,359,738,368（32GiB） | Workspace staged write、snapshot/restore candidates、archive/encryption 暂存共同 reservation ledger                                                       |
| minimum_free_bytes                                  |               2,147,483,648（2GiB） | 每个涉及磁盘操作预检+流式预算，至少保留此余量；不影响证明必要回滚文件的保留                                                                               |
| temporary_reservation_multiplier                    |                                1.10 | 对必要 candidate+rollback+archive 暂存最大同时占用估算，加 10%余量；预留不足即拒入场，运行中仍核对真实 bytes                                              |
| run_queue_wait_timeout_ms                           |                             900,000 | durable queue_deadline_at；不与执行 timeout 混用                                                                                                          |
| archive_drain_timeout_ms                            |                             300,000 | Archive operation 独立 deadline；正常 owner 未结束则 FAILED/WORKSPACE_BUSY，不强制终止 Run 或先取消 queue                                                 |
| run_queue_max_per_task/per_workspace/global         |                    32 / 128 / 1,024 | IMMEDIATE 接纳事务计数，HTTP429 或自动事件 durable SKIPPED                                                                                                |
| max_active_executions                               |                                   8 | dispatcher 全平台 claim 上限；不同 Workspace 不超过此值                                                                                                   |

source quota 与 bare Git object store/运行日志/备份临时空间分域计费；不能把`.git`排除 source hash 误解为其磁盘无限。Git fetch/create 须另预留 bare/checkout 占用，checkout 超额保持可恢复/非 READY，不 reset 用户内容。上传/ZIP 未开放，不能接受任意容器绝对路径来绕 quota。

reservation 是操作身份绑定的持久计费声明，只有安全证明操作已结束/可恢复后释放；不是立即占满磁盘的文件。disk free 仍可能被外部进程消耗，因此中途 ENOSPC 进入有 journal 的失败恢复，不以删用户文件回收空间。restore 同时保留旧根、候选和 safety backup，估算必须包含三者实际共存峰值，不能只按压缩包大小。

## 8. S0 验证与 S2 退出要求

S0 完成：状态/字段与 DDL/DTO 静态一致；队列政策与当前 FORBID/QUEUE/ALLOW、Cron、取消、通知语义有源码对照；无反向锁序；单 Workspace EX 和未来 snapshot 边界已明确。这里没有运行新 Runner、FD helper、备份或浏览器，全部动态用例 NOT_RUN。

S1/S2 至少测试：同 Workspace 两 TaskRun（含不同 Task 和 ALLOW）、不同 Workspace 并行、资源 WAIT/SKIP/FAIL_FAST probe 竞态、32/128/1024 边界、绝对 deadline 与重启、CronSKIP/FIRE_ONCE、cancel 与 claim 竞态、Source/Task/Workspace/GlobalENV/Runtime/config revision 变更、0-attempt superseded 日志/health/通知、Run-vs-read/edit/sync/backup、child/controller/helper 各点 SIGKILL、Config/Node 恢复、hardlink/symlink/FIFO、unknownowner 拒删、sourcefingerprint 耗尽和磁盘不足。SQLite 内存通过只验证数据库约束，不替代这些 POSIX 与产品测试。

未来 Execution Snapshot/Overlay 应实现新的 ExecutionSourceProvider，交付不可变代码 artifact 及其 lease/GC/backup 合同，再决定是否允许相同 Workspace 多任务并行。此时 Task concurrency 逻辑可继续使用，物理资源由 snapshot identity 隔离；必须独立 ADR 及资格，不提前加入当前 API 可选模式，不把 MVP 排他规则称为最终并发架构。
