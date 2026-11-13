# ZhiXu v2.0 — S0 Contract Review

## Baseline

Branch: `develop`  
HEAD: `d527a46095e85b7fc61c83544cd847a6e3f237db`  
Working Tree: 本轮开始已有`.gitignore`修改，将本目录忽略；原 15 报告已存在且未 tracked。本轮保留该修改，只在文档目录新增 S0 合同/候选验证材料并更新指定 3 份报告。未改业务源码。

本轮是 S0 技术设计收束，不是重新 Architecture Audit；未重生成 899 文件清单。输入分段完整阅读，针对 queue/认证/配置 MASK/同步/backup 等契约复核源码。GitNexus 缓存 CLI 1.6.12 索引 8b8dd39 落后 HEAD 两提交，未刷新，源码优先；未修改已有业务符号。

## Technical Decisions

全部正式 ADR 见 [S0_DECISION_RECORD](S0_DECISION_RECORD.md)，具体状态 TECHNICAL_CONTRACT_READY_FOR_APPROVAL，不是 APPROVED。

| Decision | 收束                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D1       | A：Workspaces+GitWorkspaces sharedPK，SQL/Service 双层 owner/type/READY 约束                                                               |
| D2       | 同 repo/ref 多 Workspace，共享 bare，独占 checkout/privatebranch/lease/ENV/Runtime/Config/policy                                           |
| D3       | MVP 同 Workspace 排他；TaskRuns 唯一 queue，Task policy 与 WAIT/SKIP/FAIL_FAST 分层；timeout/cap/misfire/cancel/restart/source 变更完整    |
| D4       | 同 Workspace Profile 单选、Task 优先；System/Global/Profile/Task 合并；Task Runtime 覆盖；Workspace ATTACH→Task ATTACH/MASK；Hooks 仅 Task |
| D5       | 独立 fresh-v2 identity/signature，四类启动；未知/损坏拒绝，不升级/清空                                                                     |
| D6       | 类型、单位、检查点冻结；候选容量数字 DEFERRED_TO_S1，不以未测默认宣称合理容量                                                              |
| D7       | suppression 持久忽略；manual/discovered/retired/ignored 与 Cron owner 明确；用户覆盖保留                                                   |
| D8       | archive/delete/tombstone/reclaim/history/purge 分离；保全 snapshot+hold；历史 FK 不阻物理源码回收                                          |
| D9       | A 原子对账；Git/Discovery/Event 三事实；成功事务 outbox；失败恢复全 Workspace 屏障，未来 B 须 proof                                        |

## Workspace Model

公共 lifecycle 与 storage 状态分离，系统派生 root_key，禁止 host 路径输入。CREATING 中间态无执行资格；LOCAL 无 Git 扩展；READY GIT 完整扩展；Source/owner 复合 FK，type/source tuple 不可普通 PATCH。详见 [主合同](S0_TECHNICAL_CONTRACT.md)。

## Database

Candidate Tables: **58**（完整候选 fresh schema，非仅示意 14 表）。  
FK: **94**（含 composite）；原 13 旧 FK 逐项映射。  
Indexes: **91**（含自动 UNIQUE，显式 35）。  
SQL Guards: **144**。  
Isolated DDL Validation: **86 cases，SQLite :memory:，DYNAMICALLY_VERIFIED，仅候选 DDL**。

Candidate identity: `zhixu.workspace.v2.s0.1`；SQLite 验证器版本 `3.53.4`。  
Schema signature: `f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`。

`foreign_key_check=[]`、`integrity_check=ok`。覆盖用户所有指定正负例及 NULL 三值、deferred Task/Source、成功 Sync/outbox/initial marker 三边原子约束、队列 claim、SourceSnapshot 一次写、初始事件仅一次和 baseline 历史清理、archive/reclaim 保留 Run 历史。详细 [Database](S0_DATABASE_CONTRACT.md)、[SQL](contracts/fresh-v2.sql)、[真实 receipt](contracts/ddl-validation.json)。没有部署 ORM/实际数据库。

## Execution

Source: WORKSPACE_ENTRYPOINT，完整预期 source/Task/Workspace/有效资源版本；GitUpdate 完整 tuple 来自成功 outbox，不能混 A 的 commit 与 B 的 hash。变化 SKIPPED/SOURCE_SUPERSEDED，零 attempt/不 spawn/不自动换源；不稳定证明 RECOVERY_REQUIRED。  
Lease: 同 workspace 锁 inode/resource/journal；可选 backup catalog→platform→repo→workspace→runtime，FD 继承到 child，controller SIGKILL 不能提前释放。  
Concurrency: 保持 Task FORBID/QUEUE/ALLOW，单 durable queue；WAIT/SKIP/FAIL_FAST、限额/绝对 deadline/cancel/restart/misfire 与日志通知完整。  
Recovery: child/Config/Node/Run owner 恢复合同，真实 POSIX 执行 NOT_RUN；snapshot/overlay 只预留扩展点。

## Git Sync

Policy: Branch MANUAL/CRON/INTERVAL、safe FF；Tag/Commit pin。  
SyncRun: 独立于 TaskRun，before/target/actual/after 真实记录。  
Discovery: 可选；retire/ignore/userCron 不覆盖；retired 缺源证明仅用于合法备份，不给执行资格。  
Outbox: SUCCESS/对账/applied_commit/同 id outbox 及首次 marker 同事务，提交后才 dispatch。  
GitUpdate: 同 commit 不重复；initial marker writeonce 允许首次 UNCHANGED 逻辑 SUCCESS、真实 Git 未移动，fire_on_initial 默认 false；retention 清指针不重放 initial。

## Lifecycle

Archive: 关闭 admission，drain deadline 内等待实际 owner；成功才取消 queued/禁 Task 和 Sync flags；超时失败保留原状态、不杀 child。  
Delete: 无 live 引用、所有权和保全证明才接受 202，失败 409 原状态不变，不级联 Task。  
Tombstone: 轻量 identity 保留历史 source snapshot/FK。  
File Reclamation: 同 lease、verified backup+hold、owned quarantine/journal；历史 Run 存在仍可回收代码。  
Historical Retention: 不等物理代码回收；metadata 最终 GC 要求无引用/hold、retention 满足、安全拆延迟环，不能误删唯一资产。

## Backup / Restore

Manifest: Workspace/type/storage key/state/inventory/source/env/config/sync/discovery/outbox 与保全证明完整；active/manual 缺源失败，已成功对账 retired 缺失有严格证明例外。  
Validation: producer/dispatcher 冻结，实际 owner 安全 drain；稳定 QUEUED 可快照，不清队列、不延 deadline；没有未知注入/同步 checkpoint 才 READY。  
Cross-root Recovery: preserved IDs、relative keys、新 owner/inode、Git dirty/untracked/admin repair、整根 candidate/rollback，缺唯一代码不 COMPLETE。  
Failure Gates: 保全 hold/GC 竞态、kill、认证/磁盘满/缺源；内部 private 快照与 portable 整包加密边界分清。真实灾难恢复 NOT_RUN。

S1.A 组件 →S2 真实 Task/Runner→S1.B“create/file/task/run/backup/destroy A/restore B/validate/run”硬门；通过前不开放正式 LOCAL 持久写入口。见 [Backup](S0_BACKUP_RESTORE_CONTRACT.md)。

## API

DTO: **129 条相关路由**的请求/响应/状态/type/副作用精确定义；复用单一 Execution DTO。  
Authorization: 新 Workspace/file/sync/discovery 明确 Panel session/JWT+membership；App scopes、/open rewrite 不得绕过；Webhook 独立认证；mutation 保护不等于鉴权，未知 API 在 SPA fallback 前安全 JSON404。  
CAS: metadata/policy/Task/resource 版本、file expected_hash、Discovery 小 HMAC 预览令牌+重算 planhash。  
Idempotency: actor/method/operation 作用域与 payload hash；集合 CREATE 分配 ID 前稳定键，DB 唯一防二次创建；Sync/Event/Run 稳定身份。  
Errors: **74 个 canonical 错误码**具 HTTP/Retryable/SafeMessage/Resource/Operation/Recovery；不含 secret/hostpath/raw credential output。

API/auth 是 STATICALLY_VALIDATED 设计和源码检查，未执行网络集成或浏览器测试。见 [API](S0_API_CONTRACT.md)、[错误表](S0_ERROR_CODES.md)。

## S1-S5

Acceptance Gates: 每阶段 Preconditions/Deliverables/Invariants/RequiredTests/FailureInjection/Exit/Stop 完整；S0 验证与未来实现资格分开。  
Dependencies: S1.A→S2→S1.B 资产恢复 →S3→S4→S5，new schema/lease/journal 同 epoch，无 legacy adapter。  
Stop Conditions: unique source 无保护、owner/锁分裂、跨 Workspace/secret 越界、失败 sync 发事件、缺源 restore 成功、未经同 HEAD 双 arch 资格均停止。

[精确门禁](S0_ACCEPTANCE_GATES.md)不能用旧 Phase12/13/14、Phase15/16A/16B 或旧镜像 PASS 代替。

## Validation Evidence

| Class                | 实际范围                                                                                              | 本轮状态                |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| DESIGN_VERIFIED      | 9 ADR/13 旧 FK/状态/锁序/ownership/生命周期/备份/Auth 合同与独立交叉审阅                              | VERIFIED                |
| STATICALLY_VALIDATED | DTO 独立 strict/noEmit、API route/error/fields、状态图、链接/表格、prior 报告/源文件 hash 与 Git 范围 | VERIFIED                |
| DYNAMICALLY_VERIFIED | 候选完整 DDL 在 SQLite :memory:真实执行 86 正负例，约束/事务/完整性                                   | VERIFIED_CANDIDATE_ONLY |
| NOT_RUN              | 生产 ORM/schema/API/FS/Git/Runner/FD/真实 backup/browser/Linux/container/AMD64ARM64/容量              | NOT_RUN                 |

实际静态检查确认：3,407 个 tracked 文件与入场 hash 一致（包含用户已有.gitignore 修改）；原 15 报告仅指定 Target/Open/Roadmap 更新，899 清单未变；两份 DTO strict/noEmit 零诊断；129 路由/74 错误引用和字段完整；1,208 个本地链接/表格结构检查通过。检查结果为 STATICALLY_VALIDATED，不能作为产品运行资格。

复核工具：[validate_ddl.py](contracts/validate_ddl.py)、[validate_contracts.py](contracts/validate_contracts.py)；结果：[ddl-validation.json](contracts/ddl-validation.json)、[contract-validation.json](contracts/contract-validation.json)。原 899 清单与 12 份未授权更新旧报告内容 hash 必须保持一致，仅 Target/Open/Roadmap 按要求同步。

## Remaining Decisions

具体容量数值与目标 driver/文件系统/架构的实测是 S1 验证项；上传/ZIP、Execution Snapshot/Overlay、D9 方案 B 独立后续 ADR。其余 D1–D5/D7–D9 均已有可直接评审的候选决定；尚待人工最终批准，而非假定批准。未解决 critical contradiction：**0**。设计、静态与隔离数据库验证已完成，后续产品动态验证仍为 NOT_RUN。

## Git

Business Code Modified: **NO**  
Database/ORM Modified: **NO**（仅非运行时候选 SQL）  
API/UI/Config/Tests/CI Modified: **NO**  
Pre-existing .gitignore Modification: **PRESERVED**  
GitNexus detect_changes(compare develop / all): 仅报告已有.gitignore hunk，无 indexed symbol 变化；这不是 clean tree 声明，ignored 文档以 hash/文件验证为准。  
Commit / Push / Tag / Publish: **NOT PERFORMED**

## Final

ZHI_XU_V2_S0_CONTRACT_READY_FOR_APPROVAL: **YES**  
USER_APPROVAL_OF_S1: **NOT REQUESTED / NOT GRANTED**

S0 已完成并停止。READY 不等于 APPROVED，不请求或授予开始 S1 的权限。
