# ZhiXu v2.0 — S1.A Implementation Report

本交付为隔离的内部候选组件。最终联合验收：**68/68 PASS，0 fail，0 skip**。
未开放 LOCAL 产品入口，未切换生产 Schema，未进入 S2 或 S1.B。

## Baseline

| 项目                            | 结果                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Branch                          | `develop`                                                                                                      |
| Entry HEAD                      | `d527a46095e85b7fc61c83544cd847a6e3f237db`                                                                     |
| S0 Commit                       | `3c96fd3aed1ed8de2b4a58b7e94b2f9bf5709105`                                                                     |
| Final HEAD                      | 包含本报告的 S1.A 本地提交；精确 SHA 在最终回复及 `git rev-parse HEAD` 中记录，避免文档自引用提交哈希          |
| Original User Changes Preserved | `.gitignore` 原改动完整保留且不提交；SHA256 `78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893` |
| 其他用户文件                    | 未纳入提交或清理 `.DS_Store`、`归档.zip` 等非交付文件                                                          |

## S0 Contract Freeze

单独提交 `docs: freeze ZhiXu v2 S0 architecture contracts`，共 **37** 个文件：原 15 份报告、10 份 S0 报告、12 份 contracts 材料；3 份更新报告的最终版本包含在其中。显式路径强制暂存，仅解决忽略规则，不修改 `.gitignore`。

封存前运行 `validate_contracts.py`：3407 个原跟踪源文件未变化、129 条路线、74 个错误码、1208 条链接校验通过。该程序绑定历史入场 HEAD，封存后不改写其历史断言来伪造重新通过。封存后逐文件以 Git 对象与 SHA256 核实全部 37 个文件可读且字节不变。

`validate_ddl.py` 本轮真实重跑：**86/86**，58 tables、94 foreign keys、144 SQL guards、91 indexes（35 explicit），`integrity_check=ok`、无 FK violation。

Schema identity：`zhixu.workspace.v2.s0.1`。Schema signature：

```text
f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c
```

## Workspace

| 能力              | 实现与证据                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Identity / LOCAL  | `WorkspaceStore` 仅打开显式、已存在的 fresh-v2 库，验证完整 frozen signature、metadata、integrity/FK；LOCAL 不建 Repository 或 Git 扩展   |
| GIT               | `GitWorkspaceStorageAdapter` 建独立 checkout；同 Repo/ref 可多 Workspace，branch 使用 `ws-{id}` 私有分支，tag/commit 固定 pin 并 detached |
| Lifecycle         | 持久 CREATE/ARCHIVE/UNARCHIVE/DELETE_RECLAIM operations、幂等键、CAS、恢复及状态检查；创建未验证完成不宣称 READY                          |
| Root Ownership    | 只由 ID/type/显式 DATA_DIR 推导 `workspaces/{local\|git}/ws-{id}`；验证 owner token、ID/type、父链、uid/mode、dev/ino；未知或替换根不认领 |
| Repository Assets | 所有 READY bare 仓库均检查核心文件、外部配置/链接、对象完整性；包括没有 Workspace 的仓库。恢复后统一重建相对身份对应的新路径              |

## Storage

内部文件服务组合现有 `WorkspaceFiles`，未改写或削弱旧版算法。所有读写使用同一 Workspace EX lease 和 `sha256("workspace:{id}")` resource key；Git 基础操作共享该身份。子进程通过已有 POSIX supervisor 继承 FD，controller 被杀不释放仍活跃 child 的保护。

支持文件/目录创建、读取、保存、删除、rename、tree、search；保留 expected hash/CAS、no-clobber、原子发布、fsync、稳定文件身份、BOM/CRLF/权限。拒绝 traversal、编码歧义、绝对路径、symlink、hardlink、FIFO、socket、特殊文件、保留平台路径及 root replacement。候选 TaskSource 入口和祖先路径受引用保护。

文件 journal 绑定 operation、owner、root identity、before/after inventory。SQLite intent、文件发布、数据库完成和 journal 清理均有重启恢复。真实 native writer 中断后，若遗留随机临时/rollback 文件无法从外层 journal 证明所有权，保留全部字节并进入 `RECOVERY_REQUIRED`；不靠删除未知文件制造 READY。

Store 对并发事务串行化；已退出事务的异步上下文不能绕过串行保护进入另一事务，其独立写入不会随另一事务回滚而丢失。

### 有界默认值

| 类别                          | S1.A 默认值                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| Source / Edit / View          | 64 / 2 / 10 MiB                                             |
| Workspace                     | 1 GiB、20000 entries、64 层、相对路径 4096 bytes            |
| Search                        | 10000 entries、32 MiB、单文件 256 KiB、200 matches、3000 ms |
| Inventory                     | 30000 ms，流式 hash、逐成员稳定身份验证                     |
| Backup / Retained / Temporary | 16 / 64 / 32 GiB，便携导入导出也检查累计 catalog 容量       |
| Free-space margin             | 2 GiB，实际 statfs 检查；不能通过删除保全副本腾空间         |
| Archive drain                 | 最多 300000 ms，重启沿用原绝对期限                          |

内部选项只能降低默认值，不能提高。它们是本阶段组件上限，不代表 Linux/container 或生产容量资格已通过。

## Lifecycle / Reclaim

Archive 在持久 DRAINING operation 建立后阻止新准入，安全 drain 实际 owner，再在事务内取消 QUEUED Run/Sync、禁用 Task/SyncPolicy 并 bump version。超时不强杀 owner，不提前改变 queued/Task flags。Unarchive 重新验证 root、journal、source inventory 及 GIT 身份，不恢复旧启用标志、不补跑队列。

冻结 SQL 限制每 Workspace 只能有一个 active operation，因此正在进行的正常 FILE_MUTATION 与 ARCHIVE gate 不能同时插入。实现保守处理：在同一固定总期限内等待正常文件操作完成，再原子安装 archive operation；恢复中及其他冲突操作继续拒绝。等待前半段尚未接受归档，不伪造第二个 admission 标志，也不放宽 SQL guard。真实文件操作等待和超时测试覆盖此边界。

DELETE 检查任何 TaskSource、活动 Run/Sync/outbox/event、lease、journal、精确 source 和 owner；失败保留原 lifecycle。非空 LOCAL（包括仅目录）与 GIT 需要真实 READY snapshot 和持久 hold。空 LOCAL 仅在 lease 内证明稳定空 inventory 时适用 S0 豁免。

Git 保全另比对实际 HEAD、private branch、admin identity、porcelain/dirty 和稳定 index bytes。仅暂存区变化而 HEAD/工作字节/状态标志相同，也不能使用旧快照回收。

回收使用已认证 journal、无覆盖 quarantine rename、逐成员 inode/hash 核验、unlink/rmdir 和 fsync；没有业务 `rm -rf workspace_path`。未知源、未知 quarantine 成员或身份变化全部保留。完成后保留 TOMBSTONED identity、Git 来源、历史 Run/Sync FK、源摘要和 hold，在线目录可以 RECLAIMED。最终 metadata purge、hold 解除/转移没有暴露服务，保持保守保留。

## Backup / Restore

| 能力               | 本轮结果                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest           | family/version、schema、DB/inventory checksum、Workspace ID/type/key/state、完整内容 inventory、Source/ENV/Config/Runtime 引用、Sync/Discovery/outbox/event/queued identity、preservation holds            |
| Domain Validator   | DB ↔ manifest ↔ owned root ↔ actual bytes 双向核验；Config revision canonical key/size/hash 与所有 READY bare 仓库真实校验；不以目录递归拷贝代替业务完整性                                                 |
| Admission          | 复用平台 backup barrier；正常已准入 mutation drain 后再 freeze/recheck；稳定 QUEUED 元数据保留 ID/deadline；未恢复临时配置、创建/回收/恢复中资源不得成功快照                                               |
| Secret Handling    | manifest 只含非秘密引用，不含 ENV/Config 值或值 hash；trigger plan 仅投影安全身份/版本/过滤结果/source expectation，原始计划保留在私有 DB；便携所有 bytes 加密，口令 Buffer 在成功/失败均清零              |
| Preservation       | catalog FD 串行 verify→hold→GC；SQLite hold 与回收接受同事务；catalog receipt 跨 DATA_DIR 防止 GC 绕过；独立 live/preservation payload 计量                                                                |
| Portable Holds     | 快照携带已验证保全依赖；认证 DAG 限制深度 16、节点 1024；源数据和原备份域全部销毁后仍能恢复唯一资产及 GC 保护                                                                                              |
| Reclaimed GIT      | manifest 保留明确 RECLAIMED 的逻辑 Git tuple 与 snapshot keys；不伪造已经不存在的 live HEAD/admin/dirty 状态；实际证明位于持有的已验证源快照                                                               |
| Cross-root Restore | 复用 SQLite snapshot、authenticated inventory、archive/envelope、FD 和 backend lifetime 算法，候选整根验证、atomic publish、rollback、journal crash recovery；保留 ID 并重建物理 owner/Git/Repository 路径 |
| Restart            | `WorkspaceRestoreService.recoverAt` 在新进程中从 journal 已证明的真实候选/旧根 DB 启动恢复；live 根暂时不存在时也可继续，不依赖存活的 JS Store 对象                                                        |
| Runtime Readiness  | 复用现有离线 reconciler，保留逻辑绑定和不可变依赖/build 快照；缺失物理 Runtime 标 MISSING、Environment/Toolchain 标 ERROR、build health 标 MISSING，无 Host fallback                                       |
| Failure Injection  | 缺源码、owner/manifest 篡改、错误密钥、容量预算、statfs 不足及注入 ENOSPC、未恢复 journal、unknown target、候选最终校验失败和真实 SIGKILL 均有负例                                                         |

未直接复用 v9 coordinator/domain 的 schema 入口，因为它们绑定现有 v9 关系；新服务组合同一批已验证的底层能力，只对显式 fresh-v2 候选库执行。原有 Backup/Restore/WorkspaceFiles/Runtime/Lock 源文件均未修改。

## Database

- Schema Mode：隔离 fresh-v2 fixture；完整 **58** 表，不是只建 Workspace 的玩具库。
- Service 写入主体：Workspaces、GitWorkspaces、WorkspaceOperations、WorkspacePreservationHolds；归档按冻结合同维护候选关联 flags；恢复只做离线资产身份/readiness reconciliation。
- Constraints：94 FK、144 guards 和 frozen signature 不变；不以修改 DDL、放宽 CHECK/FK/Guard 让测试通过。
- Task/Source/Run/Runtime 测试行是候选引用和状态 fixture，不是实际 TaskService/Runner 或安装成功证明。
- v9 Production Wiring Changed：**NO**。无旧库升级、数据清空、ORM 切换或默认数据根操作。

## Tests

最终运行记录及逐测试名称保存在 [validation-results.json](../../../tests/workspace-v2/validation-results.json)。重跑入口与边界见 [README](../../../tests/workspace-v2/README.md)。

| 检查                                              | 结果                                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| Backend TypeScript                                | PASS：`tsc -p back/tsconfig.json --noEmit --skipLibCheck` |
| Project TypeScript                                | PASS：`tsc --noEmit --skipLibCheck`                       |
| Backend Build                                     | PASS：`node scripts/build-back.cjs`                       |
| Isolated Fresh-v2 DDL                             | PASS：86/86                                               |
| Fresh-v2 Foundation / Security / Backup / Restore | PASS：68/68，含 20 项真实 SIGKILL 用例，0 skip            |
| Existing Regression                               | PASS：72/72，0 skip                                       |
| Browser E2E                                       | NOT_RUN                                                   |
| Managed Runtime qualification                     | NOT_RUN                                                   |
| Linux / AMD64 / ARM64 Container qualification     | NOT_RUN                                                   |

现有回归分别隔离运行：phase12 files、phase2 locks、phase14 barrier/portable/sqlite（27）；platform fresh-schema、phase12 git/api（14）；phase14 production/operation-read（31）。包括真实 schema v9 重启、旧 CAS/锁继承、备份恢复 SIGKILL，以及 100000 历史 Run + 100 MiB log + 2000 Git 文件样本；不把这些旧版测试冒充 v2 Runner 资格。

## Impact / Scope Review

GitNexus MCP 未提供，使用本机缓存 CLI。编码前原索引对新符号返回 UNKNOWN，不能视为无风险。旧 WorkspaceFiles 上游影响为 CRITICAL（direct 2、11 processes），已告知用户并保持原符号不变。

随后执行 `analyze --index-only` 刷新图，不注入 AGENTS/skills。WorkspaceRootResolver 为 CRITICAL（direct 13、18 processes）、Git adapter HIGH（direct 12、4 processes）、BackupDomain CRITICAL（direct 6、33 processes），恢复 reconcile 为 HIGH；均在后续修改前警示。图有 receiver/name-fallback 和流程截断限制，UNKNOWN/未解析调用不解释为无消费者。

提交前运行 `detect_changes` 与 `scope=compare, base_ref=develop`，再以 Git diff 和静态 import 边界核实只新增候选服务、隔离测试及本报告。新 namespace 没有生产入口消费者；现有 back/src/shell/scripts/package/lockfile 保持原字节。

最后一次完整 staged 检查为 39 files / 392 symbols / 158 affected processes，risk=critical；compare 为 40 files / 392 symbols / 158 processes，risk=critical，额外一项是未暂存的用户 `.gitignore`。首次 staged 输出的 742 symbols / 239 processes 也在证据中保留，不把不同工具输出混作固定精确调用数。影响图包含共用辅助函数及名称解析关联，不据此把旧流程当成已接线或已迁移；Git 实际变更路径、代码 hash 和 72 项旧版回归共同限定本轮修改范围。

交叉审查实际修复了 Config payload 缺失检查、Runtime readiness、目录型 LOCAL 保全、portable 累计配额、unused Repository 恢复、全新进程 restore bootstrap、Git local commit/index 保全及已退出事务异步上下文隔离；没有以冻结合同变更消除负例。

## Interface / Stage Status

逐项内部能力及 **129** 条 S0 公共路线的状态见 [contract-status.json](../../../tests/workspace-v2/contract-status.json)。公共 v2 语义均 `DEFERRED_TO_S4`；保留现有 v9 入口。生产初始化/epoch switch、metadata purge/hold release 明确 PARTIAL；Task/Execution/Runtime 继承接线 `DEFERRED_TO_S2`，Sync/Discovery/事件执行 `DEFERRED_TO_S3`。

| 阶段                     | 状态                            |
| ------------------------ | ------------------------------- |
| S1.A                     | PASS — INTERNAL FOUNDATION ONLY |
| S2                       | NOT STARTED                     |
| S1.B_FULL_ASSET_RECOVERY | NOT_RUN — DEPENDS_ON_S2         |
| S3 / S4 / S5             | NOT STARTED                     |

## Git / Final

S0 commit：`3c96fd3aed1ed8de2b4a58b7e94b2f9bf5709105`。
S1.A commit：包含本报告的 `feat: add v2 workspace storage and backup foundation` 本地提交，精确 SHA 见最终回复。
Push / Tag / Publish / Deployment：**NOT PERFORMED**。

```text
ZHI_XU_V2_S1A_FOUNDATION_PASS=YES
READY_FOR_S2_REVIEW=YES
S1B_FULL_ASSET_RECOVERY=NOT_RUN — DEPENDS_ON_S2
```

Remaining Blockers：无 S1.A 必需项阻塞。未运行的 Task/Runner 完整灾难恢复依赖 S2；未知 native 临时文件保守停留 RECOVERY_REQUIRED、最终 metadata GC/hold release 未开放、生产 epoch switch 未接线，均已明确说明。已停在 S1.A，等待人工审查；不自动进入 S2 或 S1.B。
