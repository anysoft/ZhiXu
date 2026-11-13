# S0 — Sync / Discovery / Outbox / Trigger Contract

状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**，不是 APPROVED。产品约束为 PRODUCT_FROZEN；本合同只定义未来实现。候选持久化见 [Database](S0_DATABASE_CONTRACT.md) 和 [fresh-v2.sql](contracts/fresh-v2.sql)，执行排队见 [Execution](S0_EXECUTION_LOCK_CONTRACT.md)。

## 1. D9：选择 A，三个事实分别记录

| 方案                         | 一致性与失败隔离                                                                             | UX / 状态空间                                                                             | 实现与恢复 / 事件幂等                                                                    | 手动 Task                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **A 保守原子对账，MVP 候选** | Git 文件不能和 SQL 原子提交，但对账、完成事实、成功 outbox 必须同一 SQL 事务；发现失败阻成功 | 独立展示 Git 已应用/Discovery 失败/事件未提交，Workspace 显示待恢复；可用性较低、状态较少 | 持久 before/target/actual 与 phase；核验同 target 后重做对账；一个成功更新身份；不 reset | 同 Workspace 所有新执行暂时阻断，避免人工 Task 误读更新后源码/继承配置；其他 Workspace 不受阻 |
| B 独立完成状态，后续 ADR     | Git 成功与 Discovery 完成分开，故障隔离较好；必须证明部分 Task 的完整输入一致                | 需多 generation、Task/Source/Runtime/Config 一致性屏障与局部 ready 集合                   | 独立 reconciliation run、依赖版本、outbox 及恢复；跨版本幂等更复杂                       | 只有拿到可验证的代码、任务定义、运行环境、配置快照证明才可放行，不能按名称/手动标签猜测       |

A 不否认 Git 已经变了。固定 API 事实：

```json
{
  "status": "RECOVERY_REQUIRED",
  "phase": "APPLIED_PENDING_RECONCILIATION",
  "git_update_status": "APPLIED",
  "discovery_status": "FAILED",
  "event_status": "NOT_COMMITTED",
  "before_commit": "<before-sha>",
  "target_commit": "<resolved-target-sha>",
  "actual_commit": "<verified-head-sha>",
  "after_commit": null,
  "execution_blocked": true
}
```

`GitWorkspaces.last_verified_commit`是最近核验 HEAD；`applied_commit`创建时为已验证检出基线，之后为最近一次完整对账/成功事务提交的 commit。`baseline_established`才是首次逻辑 Sync 成功事实，不靠 applied_commit 是否 NULL 判断。失败中 verified/applied 可以不同。`after_commit`只在成功完成事务固定；actual_commit 必须保留，包括失败/取消时的实际状态，不能把旧 applied_commit 当成当前 HEAD。

屏障范围：Workspace 普通 Run、源码读取/搜索/编辑、Git 修改/再次 sync、Discovery apply、Profile/Runtime/Config/Task 定义修改全部拒绝；只允许脱敏 metadata/history/operation 诊断、取消排队、恢复 owner 在同租约下续作。原有已排队 Run 保留身份，恢复后重新检查预期源，变化则 SKIPPED；不让其绕过屏障。其他 Workspace 可执行。备份遵循恢复门，不能把未知注入/未完成同步当成成功快照。

B 的扩展点是 `ExecutionInputProof`（源码快照标识、Task/有效资源版本、Config revision pin、lease 策略）；未取得独立评审和资格之前，`ACTIVE_WORKSPACE_EXCLUSIVE`为唯一实现策略。没有实现 snapshot/overlay。

## 2. Ref / Policy 与重复调度

- Branch：`MANUAL` 或 `SCHEDULED`；只安全 FF。Dirty、conflict、本地 commits/ahead、diverged 均 BLOCKED，保留字节/历史；不 stash/reset/clean。remote fetch 只改变 bare refs，不改变 checkout、不建立 TaskRun。
- Tag/Commit：创建时解析固定完整 SHA，checkout detached；Tag 之后移动不改变 pin。拒绝 scheduled policy；手动 verify 可记录 NO_CHANGE，不把 refresh 远端 tag 当 update。
- 每 Workspace 一个 SyncPolicy；mode MANUAL 时 schedule=null；SCHEDULED 使用互斥 CRON(expression/timezone/misfire)或 INTERVAL(interval_ms/anchor_at/misfire)。持久时间为 UTC ISO8601 毫秒精度 TEXT；duration/interval_ms 是整数毫秒，occurrence key 可用 epoch 毫秒，不能将三种表示混存比较。timezone 使用明确 IANA 标识，时区解析在 Service 验证。
- `request_key`为手动 Idempotency-Key，作用域 workspace+operation；相同 key 相同 body 返回同 SyncRun，不同 body 返回 IDEMPOTENCY_KEY_CONFLICT。计划请求键为 policy_id/version/UTC occurrence；Interval 按 anchor+N\*duration，不按重启时间重置。
- 同 Workspace 最多一个 QUEUED/RUNNING/RECOVERY_REQUIRED SyncRun，partial unique index 约束。手动重复且 key 相同返回同资源；不同 key 遇 active 返回 SYNC_ALREADY_RUNNING。定时遇 active 只跳过/合并本 slot，不另建等待链，持久 next_due 及 skip 原因；停止/改类型取消所有旧 callback，旧 policy version 无权 apply。
- 同步 misfire 采用与 Task Cron 相同 SKIP/FIRE_ONCE 词义，停机最多补一次，不建立无限补跑队列。Task Cron 与 Sync policy 的游标、inbox 与任务类型分别保存。

## 3. 一次同步及 SQL 事务边界

1. Panel/内部 scheduler 授权与 platform admission；读取 policy/source version，IMMEDIATE 事务去重并创建 QUEUED SyncRun，保存不可变 source_snapshot 的 DB last-applied/逻辑 baseline。before_commit 此时不冒充真实 HEAD，实际取得 Workspace lease 后核验填入；journal.before 与 row.before 必须同一真实 HEAD。
2. dispatcher 短 claim 记录 owner_token/到期时间，持 platform 共享 mutation FD。Repository 锁内 fetch，不持 Workspace 锁等待远端；释放 fetch 锁后重新按 Repository→Workspace 顺序取得资源。
3. 租约内复查 Workspace 生命周期/storage/active operations、source_generation、policy version、真实 Git registration/private branch、HEAD/dirty/index/本地 commits。source tuple 不可静默改变。
4. fsync journal 记录 workspace/run/owner/root identity/before/target/phase=APPLYING；先有 checkpoint 才改 checkout。FF 完成后核验 HEAD，记录 actual_commit、last_verified_commit 和 APPLIED_PENDING_RECONCILIATION。Git 故障无法确定是否 apply 时直接 RECOVERY_REQUIRED，不能猜 FAILED 后放行。
5. Discovery 关闭：NOT_REQUESTED。开启：对相同实际 HEAD/稳定 inventory 构建计划；对用户 Task/Trigger/Policy 版本做 CAS，在同 Workspace 租约内准备 reconcile 与 GitUpdate 过滤计划；不 dispatch。
6. **完成事务**：复核所有版本和 actual HEAD 对应的 checkpoint；提交 Task/Trigger 对账，更新 Workspace.content_revision/content_inventory_hash、GitWorkspace.applied_commit，SyncRun 写 SUCCESS 及不可变 before/target/actual/after/结果。已建立 baseline 且内容未变则 NO_CHANGE、initial=false、无 outbox。真正用户内容未变不虚增 content_revision。
7. 内容变化/初始基线 SUCCESS 使用同一成功更新身份：`WorkspaceUpdateOutbox.id = sync_run_id = WorkspaceSyncRuns.id`。首次逻辑同步以 baseline_established=0 判定 initial=true：即使物理 A→A，也以 SUCCESS、git_update_status=UNCHANGED、before=target=actual=after=A 真实记录，建立一次 initial outbox；不伪造 Git 移动、不虚增 revision。事务顺序：SUCCESS/update_outbox_id=id→ 插同 id outbox→ 首次时 GitWorkspace.baseline_established=1 及 baseline_sync_run_id=id。延迟循环 FK/initial baseline_required FK 要求三者在 COMMIT 时完整；缺一回滚。baseline marker 不可 1→0，关联 SyncRun 指针因 history retention 置 NULL 也不重发 initial。fire_on_initial=true 的显式 Trigger 才消费这一次 initial 事件，默认 false；之后新配置不回放历史 initial。
8. 成功 outbox 与不可变 trigger_plan 一起提交后才可被另一连接消费。先释放 Git/Workspace 锁；消费者不能在完成事务内调用 ExecutionService 或保留锁跨 Runner。

SQL 事务不能覆盖 Git 文件副作用。第 6 步失败：数据库回滚，但 Git 实际字节保留；同 logical run 进入 RECOVERY_REQUIRED / APPLIED_PENDING_RECONCILIATION，Workspace 阻断，不插成功 outbox。若连错误记录都未落库，fsync journal 与 RUNNING 死 owner 恢复分支仍阻断普通操作。

## 4. WorkspaceSyncRun 合法转换

| From              | To                      | 条件/动作                                                                                                 |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| QUEUED            | RUNNING                 | owner CAS 成功，资源与 policy 仍有效                                                                      |
| QUEUED            | CANCELLED / BLOCKED     | 用户取消或开始前政策/owner 不可用；无文件副作用                                                           |
| RUNNING           | SUCCESS                 | 实际 HEAD 核验、Discovery 成功/关闭、完整事务与 outbox 同时提交；initial 可 UNCHANGED，其余需真实 APPLIED |
| RUNNING           | NO_CHANGE               | 目标已是同一成功内容，无待恢复对账，无 outbox                                                             |
| RUNNING           | BLOCKED / FAILED        | 能证明未改 checkout，分别为安全前置条件阻断/网络等失败                                                    |
| RUNNING           | CANCELLED / INTERRUPTED | 仅能证明 apply 未发生且子进程已 reap、租约清理完成                                                        |
| RUNNING           | RECOVERY_REQUIRED       | apply 可能/已经发生、对账失败、owner 中断或清理不确定                                                     |
| RECOVERY_REQUIRED | RUNNING                 | 仅恢复 owner：相同 run/checkpoint、HEAD==target 且资源关系一致，继续对账                                  |
| RECOVERY_REQUIRED | RECOVERY_REQUIRED       | actual 未知/不符、dirty 来源未知、journal 损坏；保留诊断与数据                                            |
| 终态              | 原终态                  | 幂等读取；禁止倒回 QUEUED，重试未 apply 失败需新 request/run                                              |

SUCCESS 后的 event_status 允许 PENDING→DISPATCHED/BLOCKED 投影更新，不能修改成功 content/source snapshot。UNKNOWN 不是伪造 commit 的许可。apply 后取消只停止进一步工作并转 RECOVERY_REQUIRED，不能抹掉已改变事实。

## 5. Outbox、TriggerEvent 与 TaskRun

| 状态机                       | 合法转换                                                                                                                                                                                             | 持久约束与恢复                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkspaceUpdateOutbox        | PENDING→PROCESSING；PROCESSING→DISPATCHED/RETRY/DEAD/CANCELLED；RETRY→PROCESSING；dead-owner PROCESSING→RETRY；DEAD 只可显式 RETRY 或 CANCELLED                                                      | claim 用 owner_token/expires_at CAS；重投同 id、同 trigger_plan；DEAD 不回滚 Sync 成功，Sync.event_status=BLOCKED；删除/归档按明确原因 settle，不伪造 DISPATCHED                                                                |
| TriggerEvent（沿用现有集合） | RECEIVED→PROCESSING/SKIPPED；也允许现有 submit 事务直接 RECEIVED→SUBMITTED；PROCESSING→SUBMITTED/SKIPPED/FAILED；dead-owner PROCESSING 同 state CAS 换 owner 后重投；SUBMITTED/SKIPPED/FAILED 为终态 | origin_trigger_id 保留原身份；UNIQUE(origin_trigger_id,event_key)在 trigger 被 SET NULL 后仍有效；Git 事件必须有 workspace_update_id→ 成功 outbox；claim 有 token/到期而非 PID；暂态事务失败 rollback，不把 FAILED 终态自动复活 |
| TaskRun（沿用现有集合）      | QUEUED→RESOLVING→RUNNING→SUCCESS/FAILED/TIMEOUT/CANCELLED；QUEUED/RESOLVING→SKIPPED/CANCELLED；不确定清理 →RECOVERY_REQUIRED；死 owner 核验后 INTERRUPTED 或 RECOVERY_REQUIRED                       | 唯一 submission_key=event:{event_id}；Run 创建、Event 关联和 SUBMITTED 同事务；资源等待回到同 Run QUEUED，不复制 Run；详细合法边见 Execution 合同                                                                               |

幂等键：

```text
successful_update = (workspace_id, source_generation, after_commit)
git_event_key = SHA256("gitupdate:v2:" + origin_trigger_id + ":" + workspace_id
                      + ":" + source_generation + ":" + after_commit)
task_submission_key = "event:" + trigger_event_id
```

不把 sync_run_id、attempt、PID、before_commit 或 dispatch 重试次数作为造成新脚本运行的变化量。content_revision 进入成功事实与 snapshot；同 commit 重试不建立第二成功 outbox/Run。Local 编辑不产 GitUpdate。

trigger_plan 在完成事务冻结：目标 trigger ID/version、Task definition version、过滤结果、source expectation。Consumer 先复核当前 trigger 仍存在/启用、Task/Workspace 未删除/归档，再幂等记录 TriggerEvent 或 SKIPPED 决策。已删除目标在 outbox dispatch_summary 中持久 TASK_DELETED/TRIGGER_DELETED，不用 NULL FK 制造新事件；处理半途重启只补尚未记录项。过滤/禁用/initial 规则明确为 SKIPPED，不猜测运行。只有全部计划项已有持久结果才 DISPATCHED；若计划为空，DISPATCHED 表示“零目标已结算”，不是有脚本运行。

GitUpdate 提交 TaskRun 固定 expected workspace/version/generation/content revision/Git commit/inventory、Task 版本及有效资源版本。Git 源 tuple 必须完整来自已成功 outbox/event，不能把事件 A 的 commit 与当前 B 的 revision/hash 混合；入场已不匹配即 durable SKIPPED，未变才排队并在租约后复核。变化为`SKIPPED / SOURCE_SUPERSEDED`，零 attempt、零 spawn、不自动改为最新源。Manual/Cron/Webhook 从入场时当前稳定 DB tuple 取期望。所有通知/health 只消费真正 TaskRun 事实，Sync 失败不算脚本失败。

## 6. D7：发现的状态与用户所有权

| 对象/事件       | 状态/动作                                                                                                          | 不得发生                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| MANUAL Task     | 无 discovery owner；用户独立维护                                                                                   | reconcile 修改其 name/source/runtime/cron  |
| 新发现项        | owner=workspace，discovery_key=SHA256 规范相对路径；新 DISCOVERED Task 先完成 Source/资源 readiness 后才可 enabled | 同路径重复创建；在另 Workspace 借用 owner  |
| 脚本消失/过滤出 | DISCOVERED→RETIRED，保留 Task/历史；禁用执行，移除仅 DISCOVERY-owned Cron                                          | 删除用户配置/USER Cron；把 Task 移到新路径 |
| 脚本重新出现    | RETIRED 仍保留，显示 SOURCE_RETURNED；显式恢复后复核 readiness，不自动消除用户 disabled                            | 静默重新启用                               |
| 重命名          | 旧 key RETIRED，新 key 为新发现项；除非用户明确 rebind                                                             | 用相似文件名推断同一任务并覆盖配置         |
| 用户忽略        | 同事务建立 WorkspaceDiscoverySuppressions(workspace_id,key)，安全 retire/禁用发现 Task                             | 后续扫描重建/启用；删除 manual Task        |
| 解除忽略        | 显式 CAS 删除 suppression；下一次 preview 展示候选，由 apply 按规则协调                                            | 顺带复活用户 Cron/清空覆盖                 |
| USER Cron       | 保留 discovery_key='source-cron'作为接管 tombstone；用户删除为 disabled USER tombstone                             | scanner 覆盖或重新创建                     |
| DISCOVERY Cron  | 只维护其发现元数据与来源 baseline                                                                                  | 覆盖用户已接管定义                         |

Task 名称仅在仍等于旧 baseline 时自动更新；Runtime、ENV、Config、Hooks、arguments、执行设置和用户 enabled 意图由用户拥有。缺源 retire 在 Tasks.discovery_definition.retirement 记录服务生成的 workspace/gen/revision/hash/commit/key/path/reason 证明；每次成功 reconcile 仍为缺源 retired 时刷新到当前 stable 源，供 Backup 验证 RETIRED_MISSING_EXPECTED；禁用 manual Task 不能伪造此资格。预览令牌绑定 Workspace/version、source gen/revision/hash/HEAD、policy version 和所涉 Task/Trigger versions；apply 不匹配返回 DISCOVERY_PREVIEW_STALE，不 blind retry。LOCAL 首期只有 manual Task，不引入 LOCAL discovery 前置。

## 7. 未来 B 与必须验证的故障

B 只能在独立 ADR 中新增可验证 input proof/独立 reconciliation generation 和局部 admission，保持成功 outbox 与唯一 Run 链；不能删除 A 的 pending 事实重标成功。升级必须重验手动 Task、发现任务、Config/Runtime 选择、backup 重放及历史 source snapshot。

S3 必须测试：apply 前后 kill、Discovery/CAS/DB 提交失败、提交 outbox 后 kill、半 dispatch 后 kill、相同 commit 重放、手动/定时重入、Tag 移动、同 repo/ref 独立 Workspace、A 事件排队后 B 推进。S0 仅验证候选 DDL 与状态契约，未执行 Git/Runner 的故障实验；这些运行结果均 NOT_RUN。
