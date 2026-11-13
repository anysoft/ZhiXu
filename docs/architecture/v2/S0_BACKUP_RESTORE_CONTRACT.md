# S0 — Backup / Restore / Source Preservation Contract

状态：**TECHNICAL_CONTRACT_READY_FOR_APPROVAL**。本轮不改备份实现、不接实际数据根、不运行真实灾难恢复。候选 manifest 及 DDL 通过只说明设计/隔离验证；生产备份资格 NOT_RUN。

## 1. 保留的算法与新增领域合同

现有 [coordinator](../../../back/services/backup/coordinator.ts)、[barrier](../../../back/services/backup/barrier.ts)、[restore](../../../back/services/backup/restore.ts)、[git repair](../../../back/services/backup/git.ts)、[envelope](../../../back/services/backup/envelope.ts) 的一致快照、FD admission、SQLite snapshot、认证 inventory、加密和整根恢复 journal 是基础。v2 补充 Workspace/Source 关系、队列冻结、生命周期及保全 hold，不能只因为 DATA_DIR 递归复制会包含新目录就称完成。

## 2. Manifest v2 必需字段

顶层 `format_family="zhixu-workspace-backup", format_version=2`，保存 schema family/epoch/signature、backup UUID、creation UTC、数据库校验和、authenticated inventory hash、统计与加密/导出描述。Workspace 记录如下（字段名统一）：

| 字段                                                          | 类型/语义                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspace_id / workspace_type                                 | 正整数 / LOCAL 或 GIT，保留 identity                                                                                                                                                                                                                                          |
| storage_key                                                   | 相对系统 key `workspaces/{local\|git}/ws-{id}`，禁止绝对路径/..                                                                                                                                                                                                               |
| lifecycle_state / storage_state                               | 与同一 DB snapshot 一致；TOMBSTONED+RECLAIMED 允许无源码目录                                                                                                                                                                                                                  |
| source_generation / content_revision / content_inventory_hash | 稳定用户源码 tree fingerprint，非执行快照/完整复现承诺                                                                                                                                                                                                                        |
| root_identity                                                 | backup 源 owner marker 与 dev/ino 仅作校验；恢复不得照抄旧 inode                                                                                                                                                                                                              |
| file_count / entry_count / total_bytes                        | 与 inventory 重新计算一致，受预算限制                                                                                                                                                                                                                                         |
| source_references                                             | Task ID、相对 entry/cwd/language、definition version；不得包含秘密或宿主 root                                                                                                                                                                                                 |
| git                                                           | GIT 必需：repository_id、bare storage key、ref type/name、固定 pin/private branch、实际 HEAD、applied/verified commit、index/dirty/untracked inventory、admin 关系；LOCAL 必须 null                                                                                           |
| environment_config_references                                 | Workspace Profile/default、变量 SET/UNSET 记录、Runtime default、Workspace/Task config binding 与 revision 引用；manifest/公开摘要无秘密值。private 内部 snapshot 的 0600 SQLite 可含 secret；portable export 所有 bytes 进入同一加密 payload，不冒称现有内部快照自动全盘加密 |
| sync_discovery_event_references                               | SyncPolicy/SyncRuns、DiscoveryPolicy/ownership/suppressions、成功 outbox/trigger_plan/事件幂等身份、queued Runs                                                                                                                                                               |
| preservation_holds                                            | 工作区被回收后其保全 snapshot key 与 gen/rev/hash，不将 hold 误当普通可删除历史                                                                                                                                                                                               |

完整 DB 和 Config asset revision 文件仍纳入快照；不可只保存 manifest 引用而遗漏内容。GIT dirty/untracked/local commits 是资产，不是可丢 cache；bare 与 checkout/index/admin 关系需一致保留。Runtime 物理构建沿用现有重建策略，逻辑绑定/不可变依赖声明与身份必须备份，restore 后未重建时 readiness 阻断，无 Host fallback。

## 3. Admission 与队列边界

1. 取得 backup 全局 owner 锁，发布 QUIESCING durable marker；拒绝新 producer（Run/Sync/create/文件写/Discovery apply/配置变更），停止新的 dispatcher claim。所有异步 mutation 和子进程全程保留既有共享 FD。
2. 已持 lease 的 RESOLVING/RUNNING、正在 apply 的 Sync、file operation、Config/Node 注入、Workspace create/archive/delete/reclaim/recovery 安全完成/恢复；deadline 内无法收敛则 BACKUP_BUSY/BACKUP_RECOVERY_REQUIRED，不能强杀后自称安全。
3. **稳定 QUEUED 不是活动文件资源**：未 claim TaskRuns/SyncRuns、PENDING/RETRY outbox 可作为 durable 元数据保留，不能为备份删除或重建队列。它们不长期持有 mutation/Workspace FD。此项是对当前 coordinator.idle 将 QUEUED 也判 busy 的明确改造，尚未实现。
4. 取得 mutation EX 后再次验证 idle、所有 claim 停稳、无未恢复注入/journal、无未知 Git apply checkpoint；才进入 SNAPSHOTTING。不能只看 PID 或一次 DB 查询。
5. 持 freeze 完成 SQLite snapshot 和用户文件 inventory/copy、Workspace domain validation、Git repair/verify、manifest/hash/fsync；全部成功才标 READY。失败 staging 不 READY，旧备份不删除。
6. release 顺序保留现算法：不在 freeze 释放前恢复 producer；清 marker 后 release EX/owner，恢复 dispatcher。排队 deadline 使用绝对 UTC，不因 backup 暂停延长。

未知 Config/Node journal、未核验 Git apply、storage RECLAIMING 或 owner 不符时，正式完整快照拒绝；原数据保留。不能以“备份需要”删除 journal/unknown 文件。已证明安全的 ERROR 资源只能按显式不可执行 manifest 记录，不自动补空目录成为 READY。

## 4. DB ↔ Files 完整性

对每个 storage=PRESENT 的 Workspace：按 type/id 推导 root，验证父链、private owner marker、uid/mode/dev/ino、regular/single-link 成员、file/entry/byte 总量及稳定 inventory hash；DB 的 TaskSource 必须落在同 Workspace，所有可执行/手动 Task 入口存在且 safe，Profile/Config/Runtime 默认 FK 合法。

source_references 增加 availability=PRESENT 或 RETIRED_MISSING_EXPECTED。后者只允许 origin=DISCOVERED、discovery_state=RETIRED、enabled=false，并有成功 reconcile 在 Tasks.discovery_definition.retirement 写入当前 workspace/source_generation/content_revision/inventory_hash/after_commit/discovery_key/path/reason 的服务生成证明；Backup 在同 snapshot 重新验证当前源与实际缺失。每次成功 reconcile 刷新此证明，不依任务名称猜测。正常 Git 删除脚本 → 任务 retire 可以备份/恢复；恢复后仍 retired、不可执行、不造空文件、不自动复活。任意禁用 Task 或 manual/active LOCAL 入口缺失不属于此例外，仍拒绝。SQL 不证明文件存在，以上是 Service/Backup 验证合同。

对每个 managed workspace 目录：必须恰好有匹配 DB Workspace 或可验证的进行中 owned 操作记录；未知目录不删除、不隐式认领，正式快照报告受控错误而不悄悄丢唯一源码。storage=RECLAIMED 必须有 TOMBSTONED 身份和合法回收审计；无源码是明确事实，不是 SOURCE_MISSING。PRESENT 缺 root 或无上述 retirement 证明而缺 entry 时失败关闭。

Git metadata 的 HEAD、private branch、worktree registration 与 manifest 对应；Tag/Commit pin 不因 restore 重新解析移动的远端 ref。恢复后不联网也应保留 dirty/untracked/本地 commit；不能 fresh clone 替代物理资产恢复。

## 5. Restore 与跨根

1. Offline/backend lifetime EX 与 RESTORE_PENDING 在可交换 DATA_DIR 外持久化；认证/校验 archive 与 format/schema identity，不支持旧格式明确拒绝，不迁移、不清空 live。
2. 在受控 candidate 根提取 authenticated inventory；逐成员 no-follow/regular/single-link/预算检查，拒绝 traversal、绝对路径、unsafe symlink/hardlink/device/重复冲突；认证失败不得提取。
3. candidate SQLite quick/integrity 与 foreign_key_check；验证同一 DB/manifest/源码双向映射。preserve IDs 和 source/event/dedupe identity；不在 restore 中“重新分配 Workspace ID”。
4. 由新 DATA_DIR 推导每个 storage key，重建新的 root owner marker 与 dev/ino；旧绝对路径/inode 只能审计，不能作为目标写路径。Git admin 路径 repair 只针对已验证 GitWorkspace owner，不转换成 LOCAL、不认领其他目录。
5. Config/Node 临时注入必须在 snapshot 时已恢复；若 candidate 发现残留未知 journal 立即拒绝。Runtime 物理 rebuild 需求单独标 readiness，不回退 host。
6. 使用既有 whole-root candidate/live/rollback journal 推进：prepared→old moved→candidate live→validated→complete；每步 fsync 目录及身份，kill 后依 journal 证明继续或回滚。不可在新 DB 已 live 但本地代码缺失时返回 COMPLETE/开放 HTTP 执行。
7. 新 lifetime owner、root/schema/source/lease/journal 再次验证后才开放 admission。QUEUED Run 保持原 ID、deadline、expected source/资源版本；开 gate 后按同队列判断过期/变更，绝不重建事件或新 Run。

## 6. D8：保全与目录回收

DELETE 不等于删除 Workspace identity，更不级联删除 Task。接受 DELETE 前无 TaskSource、活动 Run/Sync/file/journal/recovery，且 root owner 可证明；失败 409 保留原 lifecycle。历史 TaskRun/SyncRun FK 指轻量 tombstone，**只阻最终 metadata purge，不阻物理代码回收**。

非空 LOCAL 以及 GIT 目录回收都要求 READY 且 domain 验证通过的保全 snapshot，精确覆盖当前 workspace_id/gen/rev/hash；空 LOCAL 由租约内稳定空 inventory 证明可豁免。统一默认要求 GIT 备份，避免误以远端包含 dirty/untracked/local commits。调用者提交 confirm_reclaim 与保全 backup UUID，服务重新验证；无 force 或跳过备份开关。

`WorkspacePreservationHolds`持久记录 workspace/backup snapshot key/源 generation/revision/hash。snapshot 位于现有备份域，SQL 无法对文件 manifest 建立真实 FK：Service 必须核验 READY manifest、authenticated inventory、same identity 并由备份删除/retention GC 读取 hold。安装 hold 与 WorkspaceOperations 接受回收在同一 DB 事务；备份域锁和 Workspace lease 按全局锁序串行，防 verify 到 hold 期间 snapshot 被删。

有 hold 的备份不能被自动 GC；保全转移只在另一个已验证快照覆盖同资产后同事务/日志替换 hold。没有明确的资产销毁授权时不自动解除最后一个 hold。最终 Workspace metadata purge 须满足历史和保留规则，并保留备份域的保全证明/审计，不能 cascade 掉 hold 后让唯一源码无保护。

保全验证/hold 安装/Backup 删除和 GC 共用 backup catalog/owner EX 锁（复用 backup.lock 的协调身份）。严格顺序是可选 catalog EX→platform mutation admission→Repository（Git 需要时）→Workspace→runtime pins；普通执行省略 catalog。禁止持 Workspace 锁再等待 backup 锁，禁止在 reclaim 租约内部创建快照；所需保全 snapshot 必须已完成。catalog 锁保护“验证 READY snapshot→ 安装 hold”的间隙；失败则目录不回收。

回收步骤：durable DELETE_RECLAIM op→DELETE_REQUESTED→ 排他 lease 内复核 →storage RECLAIMING→ 将已证明 owner 目录 rename 至同文件系统 owned quarantine 并 fsync→ 核验 marker 后递归删除该 quarantine→TOMBSTONED/RECLAIMED 与审计。Git 需 Repository→Workspace 锁，先安全 detach 该 worktree admin/private branch，保留 Git 扩展来源记录至 metadata GC；不删其他 Workspace/bare store。unknown root/quarantine 或 child 仍活跃则 RECOVERY_REQUIRED，绝不递归删未知路径。

Tombstone 保留 Workspace id/type/name、source tuple 摘要、最后 gen/rev/hash、删除/回收时间、操作/保全证明；TaskRun/SyncRun 不可变 snapshot 保留。metadata GC 仅在无 TaskSource/Run/SyncRun/outbox/event/hold 引用、规定 retention 到期、storage 已 RECLAIMED 且无恢复操作时运行，按引用顺序审计删除；永久保留历史只保留轻量 identity，磁盘代码已可回收。

## 7. 容量、加密与失败

限额类型和位置见 [Execution D6](S0_EXECUTION_LOCK_CONTRACT.md)。manifest 累计真实 bytes/entries；空间 reservation 覆盖 candidate、rollback、archive/encryption 暂存和安全余量。预算不足拒绝新操作，不删除最旧/最后保全备份腾空间。新 Workspace 所有 bytes 进入同 authenticated inventory 与加密 payload；公开 history/下载元数据不含 secret ENV、Git credential、绝对路径。

| 故障注入                                        | 必须结果                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| producer/file/save 刚进入、backup 开始          | 全程 FD 决定 drain；freeze 后无新写；DB 与源码属于同一快照                |
| Config/Node prepare/main/cleanup kill           | child/recovery 收敛；秘密不进 editor/备份；未知 inode 不删                |
| Sync apply 后 Discovery 失败                    | 备份不当成 SUCCESS；先同 run 恢复或明确阻断，保留实际 HEAD                |
| 缺 LOCAL root/entry、hash 篡改、DB-owner 不一致 | snapshot 不 READY、restore 不 COMPLETE、运行不开 gate                     |
| 解密认证失败/磁盘满                             | 未提取或 owned staging 清理，live/旧备份不动                              |
| restore 每个 rename/checkpoint 后 kill          | 原 live 或完整 candidate 可证明恢复；不产生 DB 有而源无的开放状态         |
| reclaim 在 quarantine rename/delete 后 kill     | 按 op+marker 续作，历史 Run/保全 hold 完整，unknown 目录保留              |
| 备份 GC 与安装 hold 并发                        | 要么 hold 成功保留 snapshot，要么回收拒绝；不能先删唯一源再发现备份不存在 |

## 8. S1 硬门与 S2 集成门

验收链：LOCAL 创建 → 创建文件 → 绑定 Task→ 执行 →Backup→ 销毁源环境 A→ 不同 DATA_DIR 的 B Restore→ 校验 source→ 再次执行成功。必须验证实际唯一源码丢失后恢复、正确口令、无 Git/远端、ID/source/hash 一致、无临时秘密泄漏。

依赖纪律：S1 负责受保护存储/文件/manifest/恢复组件，且**首次正式开放 LOCAL 持久写入口之前此端到端门必须通过**。Task/Runner 属于 S2，故 S1 的文件级验收可独立完成，但 S1→S2 集成门必须用真实 v2 Task/Runner 完成上述链，未通过不能把 S1 标成“已具备正式 LOCAL 开放资格”；不用测试桩或旧 TaskSource 冒充。S4 公开入口还必须依赖该门。S0 仅合同和内存 DDL 验证，不运行此灾难恢复链。
