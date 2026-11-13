# ZhiXu 2.0 — Execution、Runtime 与 Backup/Restore 设计

状态：静态架构评审；目标尚未实现。基线与证据等级见 [CURRENT_ARCHITECTURE](CURRENT_ARCHITECTURE.md)。所有下文“目标 / 必须 / 建议”为实施契约，不代表本轮已修改代码或通过运行资格。产品冻结原则见 [TARGET_ARCHITECTURE](TARGET_ARCHITECTURE.md)，实施门禁见 [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md)。

## 1. 当前执行链的真实边界

| 环节                      | 当前源码事实                                                                                                                                                                                                      | LOCAL/GIT 统一后的修改                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TaskResourceResolver      | 批量读取 TaskSource.worktree_id→Worktrees→Repositories；DISCOVERED Task 还比较 Subscription.worktree_id；缺 Repository 会标不可用（[源码](../../../back/services/taskResourceResolver.ts#L125)）                  | Workspace 是必需资源，Repository 仅 GIT 分支检查；discovery owner 改为 Workspace；LOCAL READY 不查询 Git                                                                                                |
| Definition-time readiness | 校验 Source/Runtime/ENV/Config/Hooks/Settings；deep 可检查真实入口；声明明确禁止在这里执行 materialization、lease 或 process（[源码](../../../back/services/taskResourceResolver.ts#L93)）                        | 保持纯定义资源解析；返回 workspace_id/type/version、可选 Git 状态，代码缺失与恢复待办分开诊断                                                                                                           |
| ExecutionResolver         | 事务读快照 →Worktree 独占 lease→ 按 Repository/Worktree ID 算 root→ 校验 stored local_path→Source 文件检查 →pin runtime/build→ 第二事务重读比 hash（[源码](../../../back/services/executionResolver.ts#L39)）     | WorkspaceRootResolver.requireReady(id) 按类型算 root，Repository 不成为 LOCAL 依赖；重读包含 workspace version/source version；保持锁前/锁后再验证                                                      |
| ExecutionContext          | source.repositoryId/worktreeId 均为必填；entry checksum；workspace.root/cwd/resourceKey；冻结普通快照数据（[源码](../../../back/shared/execution.ts#L52)）                                                        | source.workspaceId/workspaceType 必填；git 信息可选且独立；禁止伪造 repositoryId；保留不可变快照与所有 settings                                                                                         |
| Attempt                   | attempt dir→Node binding→Config prepare→Hook lifecycle→Runner；逆序 cleanup；清理失败升级 RECOVERY_REQUIRED（[源码](../../../back/services/executionAttemptCoordinator.ts#L87)）                                  | orchestration 复用，Workspace identity 参数同步切换；两种 Workspace 相同恢复要求                                                                                                                        |
| RunnerV2                  | 只用已解析 absolute executable/entrypoint 与 argv；Shell 固定 /bin/sh；TS 要求 tsx；Hook 后再次清除 loader 注入并重设 PATH（[源码](../../../back/services/runnerV2.ts#L8)）                                       | 可原样复用运行算法；引用新的 Context 类型，不能为 LOCAL 分支直接 spawn host Python/Node                                                                                                                 |
| TaskRun                   | 执行前记录 executionMetadata + worktree_id；terminal 通常清空 worktree_id；RECOVERY_REQUIRED 保留，以供恢复（[源码](../../../back/services/executionService.ts#L357)）                                            | workspace_id 作为历史 FK 保留并 RESTRICT；另设 active/recovery_workspace_id 活跃恢复指针；历史 source_snapshot 独立保留 workspace/type/entry/版本/Git commit，terminal 清除活跃指针不得清除历史 FK/快照 |
| Crash recovery            | owner EX lease→ 重读 run/owner token→Worktree EX lease→canonical path→Config recover→Node recover→temp cleanup→INTERRUPTED；不确定则 RECOVERY_REQUIRED（[源码](../../../back/services/executionService.ts#L538)） | 同流程用 Workspace，不能只改正常运行路径而遗漏恢复；root/source 丢失时 fail closed                                                                                                                      |

当前 frozen Context 不是文件内容快照：`Object.freeze` 只冻结 JS 数据；执行从活跃 Worktree 读文件。当前 metadata 有入口 checksum，却没有完整目录内容快照或 Git commit 字段（[executionMetadata](../../../back/shared/execution.ts#L124)）。因此“同一版本可无限重现整个脚本依赖图”是 **UNVERIFIED**，不能由 immutable Context 推导。

## 2. 统一执行协议

推荐最小正式接口边界：

```ts
WorkspaceRootResolver.requireReady(workspaceId, lease)
  -> { workspaceId, type, canonicalRoot, version, sourceGeneration, contentRevision, git?: { repositoryId, commit } }
WorkspaceLeaseService.acquire(workspaceId, owner)
  -> exclusive lease + inherited FDs
TaskResourceResolver.resolve(taskIds, transaction, deep)
  -> definition-only resource facts
ExecutionResolver.resolve(taskId, runId)
  -> frozen context + live leases + release
```

Workspace.local_path 是系统派生的持久缓存/诊断字段，不是让客户端指定路径的能力。LOCAL root 为 `DATA_DIR/workspaces/local/ws-{id}`；GIT root 由 GitWorkspace 专属 Worktree owner 派生。恢复后的 root 必须在新 DATA_DIR 重建和重验，不能相信旧绝对路径。所有 ID 是正整数，所有 relative_entrypoint、cwd_relative_path 都独立校验。

保留 `relative_entrypoint`、`language`、`cwd_mode`、`cwd_relative_path`；把 root 模式表达为 `WORKSPACE_ROOT`，其余 `ENTRYPOINT_DIR/CUSTOM_RELATIVE` 语义不变。禁止因为 LOCAL 不存在 Repository 而跳过目录、regular-file、symlink、hardlink 或 runtime readiness 验证。

执行顺序必须是：取得平台 mutation admission→run owner claim→Workspace EX lease→ 重读 Workspace/Task→root 与入口验证 →Runtime/Environment pin→Config/Hooks/ENV snapshot→ 再次比较定义版本 → 持久化 source snapshot→attempt。数据库事务不能跨 Git fetch/子进程运行。锁获取失败需要可重试的 BUSY；不能静默改绑其他代码目录。

当前路径验证逐段 `lstat`，入口 regular-file 检查没有检查 `nlink===1`（[validateTaskSourceFiles](../../../back/shared/taskDefinition.ts#L85)）；而编辑器与备份的 regular-file open 已有 hardlink 拒绝。目标需在 execution source 检查补齐单链接和稳定 open/fstat 身份验证，不能宣称现在三者保证完全一致。

## 3. Lease、编辑和并发

当前 [ExecutionPaths](../../../back/services/executionPaths.ts#L9) 使用 `.locks/worktree-{id}.lock`，`RuntimeLease.acquire` 默认 EX；resourceKey 为 `sha256(worktree:{id})`。当前 [CodeWorkspaceService.access](../../../back/services/codeWorkspace.ts#L21) 经 Repository storage 取得相同 Worktree lease，连读取也加锁，避免看到临时配置。Git helper [锁持有与子进程](../../../shell/git_workspace_lock.py#L35) 在 controller 断开后终止并 reap child，才释放 FD。现有策略是同一 Worktree 串行执行，不能以 Task execution concurrency 字段推导同目录可安全并行。

目标选择：初期继续每个 Workspace 一个 EX lease。执行、文件读写、rename/delete、Git update、stage/commit/push 和恢复共享同一 `workspace:{id}` 资源键和同一个 lock inode。TaskRun 并行策略可排队/跳过，但不能绕过 Workspace lease；不同 Workspace 可以并发，shared Runtime 使用既有 pin/lease。

- 所有 lease 路径、Config resourceKey、Node binding journal、editor recovery scan 和 backup 检查在同一实施切片切换；不能一端锁 Worktree、另一端锁 Workspace。
- Git 操作采用平台 admission→Repository lock→ 按 Workspace ID 排序的 Workspace EX lock。纯 LOCAL 文件操作不取得 Repository lock。跨多资源操作遵守统一顺序，不持有 DB 写事务等待 OS 锁。
- 执行不需要 Repository lock；只取得自己的 Workspace，随后 pin runtime。禁止出现拿 Workspace 后反向等待 Repository 的执行路径。
- UI 的未保存编辑 buffer 不属于磁盘；执行已保存版本。Run 返回确切 source version/checksum；用户 Save 碰到正在运行返回 BUSY，保留 buffer，释放锁后重新获取 hash 再保存。
- 当前 `expectedHash/identity` 乐观控制（[WorkspaceFiles.expected](../../../back/services/workspaceFiles.ts#L247)）需保留；Workspace.version 管资源元数据，file hash 管单文件，不能互相代替。
- 初期执行中 Files 读取也阻止，以免配置注入内容泄漏。后续若需要“执行时编辑”，应设计隔离 execution snapshot/overlay，并重新评估恢复/备份；不允许先释放锁实现并行。

Advisory lease 保护平台合作进程；它不是恶意脚本的 OS sandbox。脚本以同一用户运行、主动写目录或非平台进程写 volume 的能力没有被这些锁消除。可信脚本运维边界应明确；多租户强隔离/只读代码快照另行立项，不能写成当前已具备。

## 4. Config、Node binding 与中断恢复

[ConfigMaterializationService](../../../back/services/configMaterialization.ts#L67) 要求匹配的 EX MaterializationLease；journal 记录 resourceKey/root、original/installed inode、校验和、backup/copy/temporary；prepare 先 recover；restore 逆序处理，只恢复已证明归属的文件。目标保留其算法，收敛到 Workspace ID 和 root，LOCAL/GIT 相同。

[ExecutionNodeBinding](../../../back/services/executionNodeBinding.ts#L28) 当前 journal 名为 `worktree-{id}.json`，会拒绝源码目录中已有任何 node_modules，暂挂 managed build 的 node_modules，按 owned symlink inode/destination 清理；目标改用 Workspace owner，不把依赖安装到 LOCAL 源码目录。这个受控临时链接与用户创建任意 symlink 是不同权限。

当前 [CodeWorkspaceService](../../../back/services/codeWorkspace.ts#L52) 发现残留 Config 或 Node journal 即拒绝访问。目标先恢复再开放任何文件读取、Sync、Run、Backup：

| 中断点                              | 必须保持的事实                    | 重启动作/验收                                                          |
| ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| 注入前 journal 已写                 | 原文件仍可证明或 backup 已有身份  | 正确继续/回滚，不删除未知内容                                          |
| 原文件备份后、替换前                | original inode/checksum 可验证    | 恢复原文件；重复恢复幂等                                               |
| 注入后 main 运行                    | EX lease 与 FD 由 supervisor 持有 | SIGKILL controller 后等待子孙退出；恢复前新操作 BUSY/RECOVERY_REQUIRED |
| cleanup 中断                        | 已处理条目与剩余 journal 可验证   | reverse recovery 可重复；不覆盖用户意外替换文件                        |
| 所有 OS lease 已消失但 journal 尚在 | 未完成恢复不能等价 READY          | owner claim→Workspace lease→ 恢复；不扫描并删除任意 .platform 文件     |
| journal 被改写/owner 不符           | 用户唯一原始内容仍保留            | RECOVERY_REQUIRED + 诊断；禁止自动 reset/清空目录                      |

首次成功启动 LOCAL/GIT 执行前都必须覆盖 Config COPY/SYMLINK、遮蔽已有文件、Node binding、Hook 失败、timeout/cancel、重试和强杀注入恢复。不能只测 happy path 的本地脚本。

## 5. Runtime、ENV、Config、Hooks 的实际继承

真实 ENV 行为见 [TaskEnvironmentResolver](../../../back/services/taskEnvironmentResolver.ts#L25)：Profile **选择** `Task.env_profile_id > Subscription.env_profile_id > Repository.default_env_profile_id`，不是将三个 Profile 逐层叠加；变量合并 `allowlisted System base → Global → 所选 Repository Profile variables → Task variables`，支持 enabled/disabled、SET/UNSET、secret names。preview 遮蔽 secret 与 System 值。

真实 Runtime 见 [TaskResourceResolver](../../../back/services/taskResourceResolver.ts#L259)：明确 Task binding 优先；未绑定的 Python/Node 查 Subscription default，再查 Repository default；Shell 固定专用执行程序。Python/Node Environment 与 build/runtime/toolchain 都需 READY/HEALTHY，不存在无条件 host runtime fallback。

真实 Config 见 [TaskResourceResolver](../../../back/services/taskResourceResolver.ts#L346)：Repository binding→Task binding，以 `target_base:target_path` 为键，Task MASK 删除继承项；[ExecutionResolver](../../../back/services/executionResolver.ts#L192) 再拒绝 .git/node_modules/.platform 目标。Hooks 当前由 Task 读取，不存在隐式 Repository/Subscription hook 继承。

目标正式顺序：

1. Profile 归 Workspace，Task 可选择同 Workspace 的 Profile 或明确继承 Workspace default；LOCAL 同样可拥有 Profile。Profile 选择后变量仍仅合并该 Profile 一层。
2. ENV `allowlisted System base → Global → selected Workspace Profile → Task variables`。Task UNSET 胜过继承，disabled variable 不参与；secret 标记/preview/日志 redaction 保持。
3. Runtime `Task override > Workspace default`，Python/Node 无候选即 CONFIGURATION_REQUIRED，禁止尝试系统 python/node；不同 Git branch Workspace 可选不同 Environment。Repository 只保存 Git 来源，不携带运行配置。
4. Config `Workspace binding → Task binding/MASK`；asset revision pin 不变；Hooks 维持 Task 独有定义。持久 hook 内容不靠 Git sync 执行。
5. Resolver 产生完整 child env；Runner 在 Hooks 输出后再次清除 loader、依赖路径和动态链接器注入变量。不要继承后台 process.env 中的数据库/通知/Git 凭证。

接口修改边界包括 `TaskEnvironmentResolver` 的 owner/origin/metadata version、`RepositoryEnvProfileService` 的 Workspace binding 校验、`TaskConfigService` 的 Workspace binding merge、`RuntimeDefaultModel` 的 owner、更名后的 readiness/origin 文案。详细实体与 FK 见 [ENTITY_MAPPING](ENTITY_MAPPING.md)。

## 6. 备份实际覆盖：复制路径与业务完整性必须分开

当前 [BackupCoordinator.create](../../../back/services/backup/coordinator.ts#L104) 从 **整个 DATA_DIR** 递归复制，排除 `runtime/.locks/syslog/cache/runtime/cache/python/pip/cache/node/tmp/runtime/tmp/execution/tmp/config-materialization` 及 DB 主文件/WAL/SHM/journal；数据库随后在平台 barrier 下用 [VACUUM INTO](../../../back/services/backup/sqlite.ts#L67) 一致快照追加到 inventory。因此未来 `DATA_DIR/workspaces/local/ws-{id}` 在未改变排除规则时会被**通用字节复制层**遍历，不能误报为当前只备份 Worktrees。

但 **当前不存在 LOCAL Workspace 业务完整性保证**：

- manifest `included_components` 列表是 database/git/worktrees/config-assets/log/other-user-data，没有 Workspace identity、type/root/source checksum 的显式清单（[coordinator](../../../back/services/backup/coordinator.ts#L165)）。
- [BackupValidator.domains](../../../back/services/backup/validator.ts#L13) 校验 schema signature、SQLite/FK、active runs、Config revision、日志；不查询 Workspace 或验证每个 TaskSource 是否对应本地脚本。`other-user-data` 覆盖字节不是新业务验收。
- [Git repair](../../../back/services/backup/git.ts#L140) 仅读 Repositories/Worktrees；缺 READY Worktree fail，Git fsck、路径修复可证，但不会发现“LOCAL 记录在、代码丢失”。
- [idle](../../../back/services/backup/coordinator.ts#L40) 未检查 Workspace CREATING/DELETING、WorkspaceSyncRun 或 LOCAL file operation journal；mutation admission 的全程持有必须由新服务加入。
- [restore](../../../back/services/backup/restore.ts#L247) 对整棵 DATA_DIR 做候选构建/交换，修复 Git 路径、reconcile runtime；尚无 Workspace root 重建步骤。

结论：**复制机制可复用，LOCAL 领域覆盖与恢复完整性 UNVERIFIED，必须设计并实施。** 本轮未创建 LOCAL、未运行新结构备份恢复，也不将历史 Phase14 PASS 当作 v2 证据。

## 7. Backup 子模块逐项归属

| 模块                                                               | 当前职责                                                                               | v2 处置                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| backup/coordinator.ts                                              | quiesce→ 完整数据复制 →SQLite snapshot→manifest→validate→READY；portable import/export | MODERATE：增加 Workspace/Sync idle 与 manifest，保持单一 Backup owner                                                                     |
| backup/barrier.ts、platform.ts、apiLifetime.ts、inheritedLeases.ts | 跨进程 admission，QUIESCING/SNAPSHOTTING/RESTORE_PENDING，FD 继承                      | 算法复用；新文件/同步/create/delete API、服务与异步子进程必须全程接入                                                                     |
| backup/inventory.ts、files.ts、archive.ts                          | safe paths、owner、regular file、checksums、symlink 边界、limits、fsync                | 通用算法复用；加 Workspace 级不变量验证和新测试；不能放宽原校验                                                                           |
| backup/sqlite.ts、schemaIdentities.ts                              | SQLite integrity/FK、VACUUM snapshot、schema 身份                                      | 新模型签名和 v2 format/identity 契约；本轮不更新任何值                                                                                    |
| backup/validator.ts                                                | format/READY/inventory/DB/domain/Git 校验                                              | MAJOR：Workspace inventory↔DB↔TaskSource 全覆盖，新类型 fail closed                                                                       |
| backup/git.ts                                                      | bare fsck、Worktree admin 安全校验与跨根 repair、canonical path 更新                   | MODERATE：从 GitWorkspace 扩展读取持久 Git 字段（不再保留独立 Worktrees 业务表），支持每 Workspace 私有分支，禁止把 LOCAL 送去 Git repair |
| backup/materializations.ts                                         | runtime ownership/残留审核                                                             | MINOR：统一 Workspace journal/resourceKey；运行时物理安装仍排除                                                                           |
| backup/restore.ts                                                  | hash 绑定的 restore journal、candidate、safety snapshot、atomic root swap/rollback     | MODERATE：候选与最终 publish 后都执行 Workspace reconciliation 和 TaskSource 验证                                                         |
| backup/runtimeRestore.ts、rebuild.ts                               | runtime 物理资源排除后标 MISSING/ERROR，显式重建                                       | 算法保留，Workspace runtime binding 重新解析；不能自动 host fallback                                                                      |
| backup/paths.ts、bootstrap.ts、operations.ts                       | 外部 backup/control roots、owner inode、backend lease、私有 DB、运维操作               | 保留根切换结构；新增状态诊断，严格拒绝路径重叠                                                                                            |
| backup/envelope.ts                                                 | scrypt + AES-256-GCM authenticated portable envelope，解密认证后提取                   | 可复用；新目录进入同一 payload 即被加密，必须端到端验证完整覆盖                                                                           |

## 8. 目标 snapshot 与恢复设计

LOCAL 文件是不可从 Git 再取回的核心资产；GIT 的 dirty/untracked 文件、本地提交及本地分支也可能是用户唯一资产。完整备份对两者均保存真实文件；不能用重新 clone 替代脏工作区备份。

建议在 manifest/domain 段增加 `workspaces`，每项至少 `{id,type,storage_key,lifecycle_state,content_inventory_hash,task_source_count,git?:{repository_id,head,private_branch,admin_key}}`。路径在快照中用相对 key，绝不保存可由客户端任意指定的 absolute root。`WorkspaceSyncRun`、policy、discovery ownership 和 GitUpdate dedup/outbox 状态随 DB 一并保存。format/schema 版本策略见 [OPEN_DECISIONS](OPEN_DECISIONS.md)。

一致备份过程：关闭新写入 admission→ 允许已准入操作 drain→ 确认 TaskRun/Runtime/Sync/Workspace lifecycle 全 idle→ 取得 mutation EX→ 复查 idle→ 拒绝任何未恢复的文件/Config/Node/Sync journal→ 拷文件并作 DB snapshot→ 校验 DB FK、所有 Workspace root/type/owner、所有 TaskSource entry/cwd、Git refs→READY。异步操作不能在 HTTP 返回时提前释放 barrier。

| 类型             | Candidate 恢复动作                                                                                                                                      | 错误策略                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| LOCAL            | 保留 DB Workspace ID，按 ID 在新 DATA_DIR 派生 root；从已校验 inventory 还原 bytes/mode；证明 owner，核对每个 TaskSource                                | READY Workspace 缺 root/入口不能显示恢复成功；保留候选/旧 live、安全快照和诊断，阻止 Task 启动 |
| GIT              | 同样恢复文件与 bare 对象；修复 .git/admin 双向 registration；重建 GitWorkspace→ 内部 Worktree admin owner/private branch 和 canonical path；验证 commit | 缺 objects/admin、unsafe config、owner mismatch/本地历史丢失即 fail，禁止 reset/clone 覆盖     |
| Runtime          | 还原声明/锁文件/版本和历史快照；物理安装排除，显式 rebuild                                                                                              | Task 保持资源不可用直至 health pass，不以 host executable 顶替                                 |
| Run/Sync history | 保留历史 task/source/sync metadata、dedup key 和通知/outbox 状态                                                                                        | 历史不可变快照不因 root 改变而覆写；新执行使用重建后的 canonical root                          |

整根 restore 已有状态：PENDING→PREPARING→PREPARED→OLD_ROOT_MOVED→CANDIDATE_PUBLISHED→VALIDATING→COMPLETE，并用 dev/ino 证明重试与回滚（[restore journal](../../../back/services/backup/restore.ts#L21)）。目标沿用，不另造“只换 DB”的恢复路径。候选 validation 时与最终 DATA_DIR publish 后都重算 root，避免候选路径残留。ID 在完整恢复中不重排；未来 merge import 不属于本轮，禁止悄悄 remap ID。

数据库成功恢复但 LOCAL 代码缺失：必须在候选阶段拒绝，使旧根不动；若 final validation 才发现，则回滚整根，并保留 incident。若系统只剩损坏根，则进入 RESTORE_RECOVERY_REQUIRED，停用调度与运行，不能生成空目录伪装恢复完成。手动创建的空 Workspace 与丢失脚本 Workspace 需要不同状态。

## 9. 文件安全、加密和容量

[copyInventory](../../../back/services/backup/inventory.ts#L69) 当前最多 1,000,000 entries、深度 128、单文件 128 GiB、数据 1 TiB；[archive limits](../../../back/services/backup/archive.ts#L18) 与 [portable envelope](../../../back/services/backup/envelope.ts#L18) 同样限制实际大小；inventory path 字节累计另有限制。它们是技术硬上限，不代表合理的产品 quota。LOCAL 要设 Workspace/平台容量和文件数预检、磁盘空间不足错误、操作进度/取消策略；值属于待审技术参数。

Backup `privateDirectory/openRegular` 检查 owner、symlink、single link；archive 对可接受的内部相对 symlink 做逐组件解析（[validateLink](../../../back/services/backup/archive.ts#L52)），拒绝逃逸、循环过深与特殊文件。LOCAL 首期文件 API 不允许用户 symlink/hardlink；备份遇到非平台产生的 unsafe link 必须失败，不能悄悄跳过唯一代码。平台受控 config/node symlink 应在 quiesce/recovery 后消失，不能作为用户源持久化。

所有新 Workspace bytes 必须进入 authenticated inventory 和同一个 archive/encrypted payload；[export/import](../../../back/services/backup/coordinator.ts#L292) 现有整包加密流程可以复用。新增目录是否被加密取决于是否纳入 inventory，不靠目录名推定。需要实测 LOCAL sentinel 在 encrypted export 中不可明文搜索、正确口令可完整恢复、修改 header/tag/ciphertext 均失败、认证失败无提取目录。

## 10. 实施和验收门禁

不把 Backup 放在发布后补做。可在隐藏开发 fixture 中先建 Workspace model/path 以推进依赖；**首次允许用户持久写 LOCAL 的阶段，必须同时具备安全文件服务、Backup/Restore 完整性和强杀恢复验收**。若该门禁未完成，API/UI 不得开放可丢失的 LOCAL 资产。

必需新/调整测试，不在本轮新增或运行：

1. LOCAL 无 Repository/Credential/Git 初始化，Python/Node/TS/Shell 完整 Task→Run；运行环境缺失 fail closed。
2. 同 Workspace run/save/delete/sync/restore 竞争、不同 Workspace 并行、锁 inode 一致；controller 与 helper 强杀、子孙进程退出前不释放。
3. Config/Node/Hook 在准备、main、cleanup 各点强杀；残留 journal 不向 editor/backup 暴露 secret；恢复幂等、未知文件不删除。
4. LOCAL-only 与混合 LOCAL/GIT 完整备份；空 Workspace、嵌套文件、BOM/CRLF/executable bit/大文件；同一 DB snapshot 下内容和 source 一致。
5. 真正删除源 DATA_DIR 后跨根 restore；阻断远端网络验证 GIT 本地历史/dirty/untracked 恢复；LOCAL 无 Git 服务仍恢复。
6. 注入缺 root/entry、owner mismatch、hardlink、symlink 逃逸、FIFO、manifest 与 DB 不匹配；不得 READY/COMPLETE，不得启动 Task。
7. 复用 Phase14 restore fault points，并增加 Workspace reconciliation 前后、source validation 前后强杀；旧根/候选身份与 rollback 保证。
8. 加密端到端、限额、磁盘耗尽、长操作 drain、RESTORE_PENDING 下所有新写 API/调度拒绝，只读恢复状态/诊断保留。

现有可扩展测试入口包括 [phase10](../../../tests/phase10/execution.test.cjs)、[phase2](../../../tests/phase2/workspace.test.cjs)、[Phase12 lease worker](../../../tests/phase12/lease-worker.cjs)、[Phase14 restore worker](../../../tests/phase14/restore-worker.cjs)、[Phase15 lease tree](../../../tests/phase15/lease-tree-worker.cjs)、[container backup operation](../../../tests/phase16b/backup-operation.test.cjs)。这些只是当前文件定位，不是 v2 测试已通过。Linux、container、ARM64/AMD64 的实际结果均 **UNVERIFIED**，按 roadmap 重新资格验证。
