# Architecture v2 — Subscription Decomposition and Workspace Sync

状态：**CURRENT 已按源码核查；TARGET 为评审设计，未实施**。本文件将 Subscription 现有职责分配给正式 owner，不执行删除；产品原则以 [TARGET_ARCHITECTURE](TARGET_ARCHITECTURE.md) 为准。

## 1. 关键结论及风险

1. **HIGH：不能直接把 Subscription 改名为 Workspace，也不能复用当前 ensure()语义建立新 Workspace。** 当前 Worktree 以 `repository_id:remote_branch` 唯一，ensure 无条件复用已有 checkout，不检查 USER/SUBSCRIPTION purpose 或 owner；同 Repo/Branch 多个订阅实际上共享源码、dirty 状态和执行 lease。目标允许多 GitWorkspace 共用 bare storage，但每个拥有独立 checkout/私有本地分支和 sync policy。
2. **HIGH：当前“同步成功”不是 GitUpdate 派发的前置事务屏障。** Managed.run 先 discovery、逐个 receive/dispatch GitUpdate，最后更新 Subscription SUCCESS。若派发中途异常或进程在最终更新前退出，已有 TaskRun 可能存在而订阅记录失败/仍 RUNNING。v2 必须以持久同步完成记录为更新事件的唯一来源。
3. **HIGH：Subscription 删除不是无副作用的资源删除。** 默认发现 Task 引用会 409，force 会物理删除发现 Task、子资源及其 Cron；Run 历史依 SQL 保留。v2 不得把停止同步等价于删 Task/删本地文件。
4. 当前已有安全基础可保留：subscription→repository→worktree 锁、dirty/conflict 拒绝、ff-only、ahead/diverged 拒绝、执行租约、durable TriggerEvent inbox、TaskRun submission_key、发现 Cron 用户 tombstone。移除 Subscription 业务实体不能移除这些责任。

证据：[Worktree.ensure:336](../../../back/services/worktree.ts#L336)、[create:268](../../../back/services/worktree.ts#L268)、[Managed.run:88](../../../back/services/managedSubscription.ts#L88)、[Subscription.remove:250](../../../back/services/subscription.ts#L250)。GitNexus upstream ensure=HIGH，直接调用 Managed.prepare，影响 prepare/run/preflight；索引落后 HEAD 且不是完整调用证明，本文件以源码校正。

## 2. CURRENT：完整同步链

```text
Subscription create/update/enable
  → SubscriptionService.handleTask
  → ScheduleService (node-schedule Cron / toad LongIntervalJob)
  → subscription process queue
  → back/gitSubscription.ts (平台内部进程入口)
  → ManagedSubscriptionService.run(subscription_id)
  → platform shared mutation barrier + subscription lock
  → SubscriptionGitResolver (repository/credential transport validation)
  → RepositoryStorage.initialize/fetch (repository lock)
  → Worktree.ensure(repo, branch) [可能复用已有Worktree]
  → bind subscription.worktree_id
  → Worktree.withSync (repository + worktree locks)
  → snapshot → clean → safeLocalCommits → merge --ff-only
  → DiscoveryService.reconcile(subscription_id)
  → GitUpdateTriggerService.evaluate(worktree_id, old_sub_commit, new_commit)
  → TriggerEvents.receive / dispatch → ExecutionService.submit
  → update subscription.last_synced_commit / SUCCESS
```

`Sync`本来就没有写 TaskRun 来记录自身结果，而是 Subscription 最后状态与日志；只有 GitUpdate 产生脚本 TaskRun。调度入口仍使用独立子进程和 shell 命令字符串，不能将 ScheduleService 当成 Task 执行引擎。见 [subscription.ts:83](../../../back/services/subscription.ts#L83)、[schedule.ts:53](../../../back/services/schedule.ts#L53)、[subscriptionGitCommand.ts:5](../../../back/shared/subscriptionGitCommand.ts#L5)、[gitSubscription.ts](../../../back/gitSubscription.ts)。

### 调度与恢复现状

- Cron 由 node-schedule 注册，Interval 由 toad LongIntervalJob 运行；Subscription 持 schedule_type、schedule 或`{type,value}` interval。`initTask`开机重新注册未 disabled 订阅。见 [initTask.ts:18](../../../back/loaders/initTask.ts#L18)。当前 Interval 重启没有持久“下一次触发”游标，不能声称恢复了停机期间每个 tick。
- `handleTask`在当前 schedule 类型内 cancel 后注册；跨 Cron/Interval 修改需要额外审查旧注册是否同步取消，不能直接继承为 v2 幂等调度。目标 policy 版本驱动，更新应撤销所有旧类型注册。
- 手动 run 先写 queued，runSingle 再调用统一队列；Managed.exclusive 提供 subscription 进程锁，冲突由锁拒绝，状态 queued 并不证明唯一入队。多个不同 subscription 共用 Worktree 时仍可能先后同步同目录，GitUpdate 按各订阅自己的 last_synced_commit 判断。
- stop 基于 pid kill，并将 RUNNING last_sync_state 改 FAILED/CANCELLED；进程 SIGKILL 绕过 catch 时可留下 RUNNING 标识。下一次 run 会从 fetch/ensure 重新走，last_synced_commit 仍旧，借事件幂等补偿；不存在 WorkspaceSyncRun 级分阶段 journal。见 [subscription.ts:305](../../../back/services/subscription.ts#L305)。

## 3. 能力拆解：每项都有目标 owner

| 当前能力                  | 实际字段/服务                                       | 目标归属                                        | 必须保留或调整                                               |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Repository Binding        | Subscription.repository_id、SubscriptionGitResolver | GitWorkspaces.repository_id                     | 只有 GIT 扩展必填；凭证始终归 Repository                     |
| Branch Selection          | Subscription.branch，空则 repo default_branch       | GitWorkspace source ref                         | 创建时解析并冻结 source tuple；不再在每轮悄悄跟默认分支      |
| Cron Sync                 | schedule_type=crontab + schedule                    | WorkspaceSyncPolicy                             | 保存表达式/timezone/next_due/版本；只 Branch                 |
| Interval Sync             | interval_schedule.type/value                        | WorkspaceSyncPolicy                             | 保留用户能力，正规化单位/范围/起算锚点；只 Branch            |
| Fetch                     | RepositoryStorage.fetch                             | Git Repository Storage                          | 多 Workspace 共用 bare 与 repo 锁；fetch 不等于更新 checkout |
| Worktree Update           | Worktree.withSync/updateLocked                      | GitWorkspaceService / Git adapter               | 每 Workspace 独占 checkout，ff-only 和 lease                 |
| Automatic Discovery       | DiscoveryPolicy.subscription_id、DiscoveryService   | WorkspaceDiscoveryService                       | GIT 可选；LOCAL 首期 manual Task 即可                        |
| Discovered Task Ownership | Task.subscription_id + discovery_key                | Workspace                                       | task.discovered_workspace_id + source.workspace_id 一致      |
| Discovered Cron Metadata  | Task.discovery_definition、TaskTrigger.source-cron  | Task Trigger                                    | USER 接管/tombstone 优先，更新扫描基线但不覆盖用户配置       |
| GitUpdate Evaluation      | GitUpdateTriggerService.evaluate                    | Task Trigger + WorkspaceUpdate consumer         | 只消费成功持久更新，显式 GIT_UPDATE 触发器才运行             |
| ENV Profile Default       | sub.env_profile_id / repo.default_env_profile_id    | Workspace / Task                                | Profile 归 Workspace，Task override 最高                     |
| Runtime Default           | RuntimeDefaults subscription/repository owner       | Workspace / Task                                | 每 Workspace 每 kind 一个 default，无 Host fallback          |
| Sync State                | last_sync_state/phase/error/pid/status              | GitWorkspace 摘要 + SyncRun                     | pid 仅 operation owner 元信息，不再是业务 Task 状态          |
| Sync History              | Subscription logs + 最后一次状态                    | WorkspaceSyncRun + 独立 sync logs               | 独立于 TaskRun/Task health/Task notifications                |
| Sync Error                | last_sync_error                                     | WorkspaceSyncRun.error_code + GitWorkspace 摘要 | 结构化安全 code，凭证/remote URL 秘密不进日志                |
| Schedule enable/disable   | is_disabled + ScheduleService registrations         | SyncPolicy.enabled/update_mode                  | 不禁 Task、不删 Workspace、不丢代码                          |
| 日志/WebSocket            | subscription-{id}/...、runSubscriptionEnd           | workspace-sync/{run_id}与 sync 事件             | UI 监听 SyncRun，不复用 TaskRun stream                       |
| 删除保护                  | force 删 DISCOVERED Task                            | Workspace lifecycle 与引用服务                  | 停同步 ≠ 删任务；默认 archive/409；purge 独立显式            |

Worktree 服务不应该同时拥有 Cron、Discovery、ENV 和通知。建议独立 `WorkspaceService`（资源生命周期）、`WorkspaceFilesystem`（通用安全文件操作）、`GitWorkspaceService`（Git checkout 操作）、`WorkspaceSyncService`（同步编排/恢复）、`WorkspaceSyncScheduler`（due/claim）、`WorkspaceDiscoveryService`（扫描/对账）、`GitUpdateTriggerService`（更新事件转触发）、现有 RepositoryStorage（bare 与 fetch）。

## 4. CURRENT：共享 Worktree 的真实唯一性

- WorktreeModel.branch_key 为 unique；branch 创建用 `repo.id + ':' + ref_name`。创建第二个同 repo/branch 会 BRANCH_ALREADY_CHECKED_OUT。
- Worktree.ensure 在 branch 类型按 branch_key 查 existing，有则 status(existing.id)，无视传入 name/purpose；tag/commit 不会按此方式复用。
- 每个 Worktree 已经使用私有本地分支 `ql-worktree-{id}`，上游指向 origin/ref。即远端分支唯一是应用人为约束，不是 Git 要求同一远端只能一个独立本地分支。
- Managed.prepare 随后校验 lease 忙、clean 与 safeLocalCommits；绑定和 withSync 会再次在锁内验证。复用现有 USER Worktree 仍可能发生，purpose 不是 owner 授权边界。
- Repository/branch 修改会先清 sub.worktree_id，下一次 prepare 可能绑定另一个 tree；发现 TaskSources 会被 rebound 到新 tree 并递增 Task version。目标禁止这种隐式源码改变。

### TARGET：资源所有权与唯一性

1. Workspaces 是 owner；GitWorkspaces.workspace_id 共享 PK，checkout 由该 ID 确定。私有本地分支名按 workspace ID 唯一，remote ref 允许重复。
2. 同 Repository/Branch 两 Workspace 可共享 bare 对象/remote refs 缓存，独立 local_path、dirty/index/本地 commits、SyncPolicy、discovery owner、profiles、Runtime defaults 和 lease。
3. `ensureGitWorkspace(workspace_id)`仅修复/核实**该 Workspace 自己的**checkout，绝不能按 repo/ref 替代 owner；发现路径或 Git registration 指向其他 Workspace 时 PATH_CONFLICT/RECOVERY_REQUIRED，禁止认领。
4. Repository 删除必须无 GitWorkspace 引用、无运行/同步/recovery lease；Workspace 删除不会删除其他 Workspace 私有 branch 或 bare。
5. source repository/ref/type 建议创建后不可变；更换分支新建 Workspace，再显式改 manual Task source；discovered Task 保留 owner，不能暗中迁移。
6. Source tuple 和实际 HEAD/branch/registration 不一致时 STALE/RECOVERY_REQUIRED 并拒普通执行/同步；仅允许恢复 owner 核验/续作，不把 Git worktree 目录当 LOCAL 来绕过 Git 验证。

## 5. TARGET：Sync Policy 正式契约

建议 policy 子资源包含 `workspace_id, version, enabled, update_mode, schedule, next_due_at, last_claimed_slot`；schedule 为互斥联合而非同时 Cron+Interval：

```text
MANUAL: schedule=null
SCHEDULED + CRON: expression + timezone + misfire_policy
SCHEDULED + INTERVAL: duration_ms + anchor_at + misfire_policy
```

只对 branch 开放 SCHEDULED；Tag/Commit 创建时解析完整 commit 并持久 pin。Tag remote 刷新只更新 Repository refs 缓存，不改变当前 pin。Tag/Commit 的“同步”可为显式验证/补齐缺失对象或返回 PINNED_REF；不得借同名 tag 移动更新内容。Branch 只允许 clean/conflict-free、安全 ff；有本地 commits，即使 ahead-only，也应明确 BLOCKED_LOCAL_COMMITS，不强制 reset。当前普通 Worktree.update ahead-only 返回 snapshot，而 Managed.withSync 更严格 safeLocalCommits 拒绝，目标采用后者。

Cron/Interval 均建议保留，timezone 显式持久；Interval 按 anchor + N\*duration 计算 slot，重启不重置锚点。初期 misfire 默认 SKIP，可保留 FIRE_ONCE 为可选政策；不能积压停机期间无限同步。设置合法 duration/表达式/最大频率与并发上限；具体数值按容量评审冻结。修改 policy 以 expected_version/CAS，取消全部旧类型注册并按新 version 计算 next_due。

### SyncRun 建议字段

| 字段                                         | 语义/约束                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| id / workspace_id                            | 记录身份和真实 owner，不独立保存可变 Repo/Ref 配置                                              |
| policy_version / source_generation           | 本次使用的配置/源身份，开始与提交时复核                                                         |
| trigger_source                               | MANUAL / CRON / INTERVAL / RECOVERY                                                             |
| request_key / schedule_slot                  | 手动 idempotency key 或计划 slot，唯一提交防重复                                                |
| owner_token / started_at / finished_at       | owner 恢复和时间边界；PID 不代替 token/lease                                                    |
| before_commit / target_commit / after_commit | 实际检查、计划目标和最终验证的 commit                                                           |
| status / phase / error_code                  | QUEUED/RUNNING/SUCCESS/NO_CHANGE/BLOCKED/FAILED/INTERRUPTED/RECOVERY_REQUIRED；phase 可单独推进 |
| discovery_result / log_identity              | 对账摘要和独立日志，禁止 ENV/凭证内容                                                           |

`SUCCESS`代表内容和 metadata/发现对账完成并已持久 commit，`NO_CHANGE`没有新内容更新事件。BLOCKED 针对 busy/dirty/local commits 等可恢复条件，不改代码。失败不得伪造成功 after_commit 或触发事件。

**明确默认状态机（D9）**：Discovery 关闭则跳过对账；Discovery 开启则扫描/对账/用户版本冲突或完成 DB 事务失败一律阻断成功提交。Git 已更新并核验后固定进入 `RECOVERY_REQUIRED + APPLIED_PENDING_RECONCILIATION`，不能写 generic FAILED 并放行运行。`last_verified_commit`仅表示观察核验的实际 HEAD；`applied_commit`表示最近一次**内容+对账+成功记录原子提交**的 commit，两者可能暂时不同。此时无成功 outbox，Workspace 阻止新普通执行/写入，仅允许拥有恢复 lease 的续作或明确修复入口。恢复核验 actual HEAD==journal.target，重做幂等对账；若不符则保持 RECOVERY_REQUIRED 并要求人工处理，禁止 reset。最终仅在同一事务内推进 applied_commit、提交对账、SyncRun SUCCESS 及成功 outbox；事务之后才派发。

## 6. TARGET：一次同步的原子边界与恢复

```text
1. validate GIT/branch/policy/source version
2. durable request/slot去重 → 创建SyncRun QUEUED
3. platform mutation barrier + per-Workspace sync claim
4. Repository fetch（repo锁；不持Workspace锁等远端网络）
5. repo metadata锁 + Workspace exclusive lease，锁内重新验证identity/HEAD/dirty
6. journal(before,target,phase=APPLYING) → ff-only → verify(after)
   → last_verified_commit + phase=APPLIED_PENDING_RECONCILIATION
7. scan → prepare reconciliation + GitUpdate匹配计划（不dispatch）
8. 一个IMMEDIATE事务：复核policy/task/trigger版本；提交对账 + SyncRun SUCCESS/NO_CHANGE
   + GitWorkspace.applied_commit + 成功WorkspaceUpdateOutbox
9. 释放Git/Workspace写锁
10. outbox consumer幂等写TriggerEvent并dispatch → 正常Task执行引擎
```

所有锁取得按全平台统一顺序，建议 platform barrier→operation admission→repository→workspace；不得有一路先 Workspace 后 Repository 形成反序。LOCAL 只需 platform→workspace；执行持 lease 后不去获取 Repository 写锁。若实现采用当前锁序不同的 adapter，必须统一表与死锁测试后再冻结，不能局部照抄上述示意。网络 fetch 分段完成后重新验证 ref/commit，不能靠 fetch 前快照决定最终写入。持久 request claim 是并发调度语义，文件 lease 是资源安全，两者不能互替。

| 中断/失败点                        | 现状可证实                                  | v2 恢复要求                                                                                                                                                |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fetch 失败                         | Managed catch 记 FAILED；Worktree 一般未变  | SyncRun FAILED，保留原 HEAD；无 update outbox                                                                                                              |
| apply 前 dirty/lease busy          | clean/safeLocalCommits/locks 拒绝           | BLOCKED；不改变任何源码/Config                                                                                                                             |
| ff-only 执行中进程终止             | Git/锁会释放但业务 phase 可能 RUNNING       | 重启 probe owner，核对 Git registration、index locks 与 HEAD；不自动删除活跃锁或 reset                                                                     |
| apply 后、对账前 SIGKILL           | last_synced_commit 仍旧，下次从旧基线继续   | dead owner 收敛为 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION；journal 保存 before/target；actual HEAD==target 继续同一 logical SyncRun；不符保持阻断 |
| 对账/成功完成事务失败              | 已更新 Git，discovery 事务可 rollback       | 固定 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION；applied_commit 不前进；无成功 outbox；核验相同 target 后重做幂等对账                                |
| outbox 提交后、派发前 SIGKILL      | 当前没有此独立 outbox 边界                  | replay pending update，TriggerEvent 唯一键阻重复                                                                                                           |
| 事件已提交 TaskRun、ack 前 SIGKILL | TriggerEvent inbox + submission_key 防重复  | 重放同 event 不得创建第二 Run；outbox ack 可重试                                                                                                           |
| source/policy 在等待中改变         | 当前 repo/branch 变更仅 subscription 锁串行 | 复核 version/generation，旧请求 SUPERSEDED，不运行新源                                                                                                     |

同步失败不能保证 Git 内容“从未变化”：ff 成功后数据库失败客观上会形成文件/DB 不一致。目标要保证**没有成功更新事件**，同时固定以 journal/RECOVERY_REQUIRED 和 APPLIED_PENDING_RECONCILIATION 阻止不明状态执行，恢复后只提交一次成功。不得为了宣称原子性破坏性 reset 已写入内容。

## 7. Discovery 的 owner 与用户控制

### CURRENT

- DiscoveryPolicy subscription_id unique；未持久策略默认 enabled=true。Scanner 只扫描允许语言/过滤，忽略.git/node_modules/venv 等，拒 symlink 遍历，前 64KiB 解析 name/cron；discovery_key 为规范相对路径 SHA256。见 [discoveryScanner.ts:38](../../../back/services/discoveryScanner.ts#L38)。
- reconcile 以 subscription 拥有 Task 集合做 plan，key 唯一。新 Task origin=DISCOVERED、先 disabled，建立 Source/Runtime/Settings；resource READY 者才 enable。手动 Task subscription_id 为 null，因此不会进入此对账集合。
- Task 名称只在旧 name 仍等于上次扫描 baseline.name 时更新；用户手改 name 保留。Runtime/arguments/settings/task ENV/config/hooks 不被扫描全面覆盖。
- 同源 Cron 用 TaskTrigger.discovery_key='source-cron'；用户保存将 origin 置 USER，后续 reconcile 跳过；用户删除发现 Cron 保留 disabled USER tombstone，所以后续扫描不复活。
- 文件消失或被过滤出时 RETIRE：disable Task，删除仅 DISCOVERY-owned Cron，保留 Task 定义/历史；USER Cron 仍在，但 Task disabled 可阻执行。Task 本身手动删除是硬删，下一次扫描会 CREATE，当前没有 Task suppression tombstone。
- Subscription force 删除会删除发现 Task，非 force409；active Run SQL guard 可能使 force 失败并 rollback，Service 会重新注册 schedule。不能声称 force 可无条件清理。

证据：[discovery.ts:107](../../../back/services/discovery.ts#L107)、[discovery.ts:156](../../../back/services/discovery.ts#L156)、[discovery.ts:252](../../../back/services/discovery.ts#L252)、[taskTrigger.ts:179](../../../back/services/taskTrigger.ts#L179)。

### TARGET

- `DiscoveryPolicy.workspace_id`唯一，GIT 首期 optional；默认建议新 GitWorkspace **explicit opt-in**，避免创建 checkout 即自动建立运行任务。冻结提示只要求可选 Discovery，默认策略需在 API/UI 契约中明确。
- `Task.discovered_workspace_id`只有 DISCOVERED 必填；manual 必须 null。`TaskSource.workspace_id`对所有 Task 必填；DB guard 确保 discovered owner 与 source 一致，unique(owner,key)。不把 Repository/ref 作为 owner。
- key 继续 hash 规范化相对路径；大小写/Unicode 按服务器文件语义固定策略，拒可混淆路径。重命名默认旧项 RETIRE+新项 CREATE，不猜测两个脚本为同一 Task；保留用户手动 Task。
- source 消失 RETIRE 不硬删，USER Cron/名称保留；脚本重新出现不会自动抹掉用户 disabled 状态，提供显式重新启用。Task source path 不可被 discovery 迁到另一个 Workspace。
- “删除并忽略发现项”写 WorkspaceDiscoverySuppressions；下次扫描显示 IGNORED 而不重建。单纯删除与再次发现的产品语义需明确，建议 UI 将操作命名为“忽略发现项”，避免静默复活；用户可显式解除忽略。Cron 仍沿用 USER disabled tombstone。
- 扫描/对账在同 Workspace 写 lease 下，以 policy version + source generation + actual commit 为输入；保存用户修改须 CAS 或在事务中读最新定义再决定 merge。将 reconcile 计划与 SyncRun completion 同事务提交，不在扫描过程中派发任务。
- LOCAL 第一阶段只需 manual Task；Local 自动发现为后续扩展，不阻止 Local MVP 和备份验收。

## 8. GitUpdate 幂等、成功事件和执行版本

CURRENT：before==after 直接 return；否则按 TaskSources.worktree_id 找到 Task triggers，支持 ANY_CHANGE、SOURCE_CHANGE、PATH_FILTER；before 为空按 fire_on_initial 决定。diff 失败对需 path 匹配触发器记 FAILED，不猜触发。event key 为包含 repository/worktree/before/after/initial 的 metadata 摘要；TriggerEvents.unique(trigger_id,event_key)，Execution.submit 以`event:{id}`submission_key 原子创建 Run/关联，具备现有去重/恢复基础。见 [gitUpdateTrigger.ts:26](../../../back/services/gitUpdateTrigger.ts#L26)、[triggerEvents.ts:36](../../../back/services/triggerEvents.ts#L36)。

TARGET：

1. 唯一输入是已提交成功的 Workspace 内容更新 outbox；fetch 成功、sync 入队、dirty 失败、NO_CHANGE 都不能发成功事件。未配置 GIT_UPDATE Trigger 就不提交脚本运行。
2. 幂等键建议 `trigger_id + workspace_id + source_generation + after_commit`；不能包含本次 sync_run_id 作为唯一变化量，也不依赖 before 变化，否则同 commit 重新同步会重复执行。初次基线有显式 initial 与 fire_on_initial，触发禁用/过滤不匹配要持久 SKIPPED 便于审计。
3. metadata 包含 workspace_id、sync_run_id、before/after、source_generation、initial，只允许安全字段；事件序列、outbox 和 TriggerEvent 在备份恢复中保留，不因重启/restore 重新构造一批新身份。
4. 事件携 expected after_commit/source_generation；提交事务同时记录 expected Workspace ID、content_revision 与 Task definition version。状态机固定为 `QUEUED → RESOLVING → 获取Workspace排他lease → 复读DB与actual HEAD/入口hash`；若更晚同步/编辑改变预期源，则 `TaskRun → SKIPPED, error_code=SOURCE_SUPERSEDED`，不注入配置、不 spawn Runner，不自动替换成最新源或提交另一 Run。TaskRun.workspace_id 历史 RESTRICT 引用继续保留，仅清活动/recovery owner 指针并释放本次 lease；匹配才持 lease 进入 RUNNING 并保留到 child 结束与注入恢复完成。新 commit 运行仅由其自己的事件或用户显式重提决定。首期不需要 checkout 每个历史 commit；如以后需要精确排队版本，另设计 immutable execution checkout。
5. 持 lease 稳定实际执行源码；TaskRun snapshot 记录实际 Workspace/type/path-relative entry/language/cwd/generation/commit 与内容摘要，不能只相信触发器 metadata。Config 注入内容不得算作用户源码永久提交，也不能进入 GitUpdate diff。
6. 同步历史只写 WorkspaceSyncRun；TaskRun 只反映脚本，Task health/notification 不把 Git 同步错误算脚本失败。Sync 通知为后续独立事件，不复用 Task execution trigger。

## 9. 可执行验收清单

| 场景                                      | 必须断言                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同 repo/branch 两个 GitWorkspace          | 不同 root/private branch；不同 ENV/Runtime；写 A 不影响 B；A lease 不错误阻 B 文件编辑                                                                            |
| Scheduler 与 manual 同时请求              | 同 logical slot/request 仅一 SyncRun 执行；其余返回同结果或 409/202 排队，绝不重复 apply                                                                          |
| Cron→Interval→Manual→Cron                 | 老注册全部撤销；重启 next_due 符合锚点；禁用 sync 不禁 Task                                                                                                       |
| Branch dirty/conflict/ahead/diverged      | 均不强 reset；BLOCKED 理由可区分；本地文件/commits 保留                                                                                                           |
| Tag 被远端移动                            | 远端 refs 可刷新；workspace pinned commit 保持；scheduled policy 拒绝                                                                                             |
| Task 执行中同步/编辑                      | lease 阻止冲突写；不更改运行中源码；config 恢复之后才放行                                                                                                         |
| 同 commit 重复同步/重试/恢复              | 无第二内容更新事件、无第二 TriggerEvent、无第二 TaskRun                                                                                                           |
| 初次 sync                                 | fire_on_initial=false 不跑；true 仅明确 Trigger 配置后跑一次                                                                                                      |
| 部分 GitUpdate 派发后故障                 | SyncRun 成功事实已持久；重启补派缺失项，已提交项无重复                                                                                                            |
| apply 后 Discovery/完成 DB 失败或 SIGKILL | RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION；last_verified_commit 可前进而 applied_commit 不前进；无成功 outbox；journal 恢复；不自动 reset；阻普通运行/写入 |
| discovery 后用户改名称/Cron/runtime       | 用户字段保留；USER Cron tombstone 不复活                                                                                                                          |
| source 消失/重现/忽略项                   | RETIRE 保留历史；不自动抹用户 disabled；suppression 阻重建                                                                                                        |
| 手动 Task 与发现 Task 同路径              | owner 独立；reconcile 不覆盖 manual 配置                                                                                                                          |
| 删除 Workspace/Repository                 | Task/Run/recovery/lease 引用保护；不删别的 checkout/bare/唯一用户文件                                                                                             |
| GitUpdate 排队后 Workspace 继续推进       | expected source 核验，SOURCE_SUPERSEDED 而非误报旧版本运行                                                                                                        |

所有以上是未来必须新增/调整的测试需求，本轮未更改或运行这些新行为；v2 行为当前均 **UNVERIFIED**。SubscriptionService/Schedule 子进程/旧 API 菜单只能在新 owner 与这些 gate 全部承接后退出。
