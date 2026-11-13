# S0 — Acceptance Gates for S1–S5

状态：TECHNICAL_CONTRACT_READY_FOR_APPROVAL。下文 S1–S5 均**未执行**。S0 真实结果见[Review Report](S0_REVIEW_REPORT.md)，不能用这些未来测试要求填充当前 PASS。

## 1. 证据等级

| Label                | 能证明                                                               | 不能证明                                      |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| DESIGN_VERIFIED      | D1–D9/状态/owner/FK/锁序/恢复边界经审阅无已知矛盾                    | 代码已实现、生产安全/性能                     |
| STATICALLY_VALIDATED | DTO 独立编译、route/error/字段一致、链接/表格/hash/diff 检查实际成功 | 网络认证或真实文件系统行为已通过              |
| DYNAMICALLY_VERIFIED | 本轮真实 SQLite :memory:候选 DDL 正/反例、事务/约束执行结果          | ORM 或用户库部署、真实 Git/进程/备份/容器资格 |
| NOT_RUN              | 没有执行的产品/文件系统/Git/浏览器/Linux/container/容量测试          | 不能引用历史 PASS 改写标签                    |

## 2. 依赖关系与禁止半成模型上线

S0 待最终批准 →S1.A 安全存储/备份组件 →S2 真实 Task/Execution 接入 →S1.B 资产端到端恢复门 →S3 同步/发现/Subscription 退场 →S4 公开 API/Editor/UI→S5 资格。S1.B 明确依赖 S2 是为了用真实新 Task/Runner 验收，不形成“先开放本地脚本、以后补备份”的窗口。S1.A 可独立组件验收，不能宣称正式 LOCAL 开放资格；S4 仍不得早于 S1.B。

所有候选实现使用隔离 fresh-v2 根；现 v9 服务不可连半完成 v2 schema，source/lease/journal keys 必须同 epoch 切换，不另加 legacy adapter。

## 3. 阶段门

| Stage                         | Preconditions                                                       | Deliverables                                                                                              | Invariants                                                                           | Required Tests                                                                                 | Failure Injection                                                                 | Exit Criteria                                                                                | Stop Conditions                                                                             |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1.A Workspace/FS/Backup 组件 | 人工批准 S0，isolated root，候选 SQLite 能力支持                    | Model/path/owner marker/lease/files CRUD/search/manifest/validator/restore/hold 与 reclaim                | LOCAL 无 Git；root 系统分配；稳定 inode/atomic/CAS；未知目录不删；原始源受备份       | S1-01..09；正反路径/links/special、CRUD/CAS、archive/reclaim identity、文件级跨根恢复          | create/rename/save/copy/restore/reclaim 各 checkpoint kill、磁盘满/owner 篡改     | 组件真实测试通过；格式/容量上限检查，不开放 public LOCAL                                     | 唯一源无备份、误删 unknown、FD 分裂、缺源仍成功、类型/owner 绕过                            |
| S2 Execution/资源继承         | S1.A；完整 source/queue/错误 DTO；schema 共同接线                   | Workspace TaskSource、单 Runqueue、Context/lease、Runtime/ENV/Config/Hook/recovery                        | sameWorkspace 不并行；Source 变更 SKIPPED；无 Hostfallback；秘密注入可恢复           | S2-01..10；所有语言/两类型；policy/wait/misfire/cancel/restart/资源版本/queuecap               | claim/lease/spawn/timeout/cleanup/retry 边界 kill，globalENV/源改变               | 原执行安全断言保留、新 queue 和输入版本通过、进入 S1.B                                       | skip 当 failure、无限等待、第二 queue、source 改了仍 spawn、敏感 ENV 泄漏                   |
| S1.B 正式本地资产门           | S1.A+S2 真实 v2 Task/Runner，独立根 A/B                             | LOCAL 完整灾难恢复证据；新 manifest/schema/source 关系及实际运行                                          | Backup A 被毁后 B 可执行同源；无 Git 前置；加密/hold/IDs 完备                        | S1-10..12：LOCAL create/file/task/run/backup/destroyA/restoreB/validate/run；空/混合 workspace | 篡改 inventory/缺源码/错误口令/restore 多点 kill/留 queuedRuns                    | 真删除 A 后 B 运行成功且 hash/IDs 一致，所有安全负例 failclosed；才获 LOCAL 资产保护组件资格 | 只 copy 回同根、使用测试桩/旧 Worktree TaskSource、缺源返回 READY、未恢复临时秘密           |
| S3 GitSync/Discovery/退场     | S1.B+S2、Git owner/branch/DB guards、旧消费者清点                   | SyncPolicy/Run/outbox/恢复、suppression/userCron、Internal scheduler，完整 Sub 职责替换                   | apply≠reconcile≠dispatch；无成功 commit 无事件；samecommit 不重复 Run；独占 checkout | S3-01..10；同 Repo/ref 并发 Workspace、Branch/Tag/Commit、manual/cron/interval、发现用户覆盖   | apply 后 Discovery/DB 失败、outbox 前后/半 dispatch kill、source 进展、queue 恢复 | 全 Sub 能力 owner 已承接，SQL/API/UI 引用退出计划一致，失败无早发                            | 直接删 Sub、ensure 跨 owner 复用、force reset、把 SyncRun 写 TaskRun、部分放行无 proof      |
| S4 API/Editor/UX/I18N         | S1.B 与 S3 后端候选；Panel-only/CAS/errors 已测试                   | 冻结路由/DTO/权限、统一 Workspace Files/详情、10 项菜单、任务向导、双语                                   | LOCAL 无需 Repo；/open/App 不可用新 API；无 secret/hostpath；引用文件删改受保护      | S4-01..07；129 相关路由矩阵参数化鉴权与约束；两 locale 浏览器/深链/冲突 buffer                 | JWT/app-token 冒充、originalUrl rewrite/base URL、同时保存、恢复中请求、草稿冲突  | 完整 fresh 用户流程可用、API registry 与实现一致、无额外技术信息进入普通产品流程             | App scope 字符串穿透 Panel、UI capabilities 替授权、silent overwrite、未受保护 LOCAL 公开写 |
| S5 平台资格                   | 候选源码/新 schema/镜像冻结、active manifest 更新、无 critical 矛盾 | 新 HEAD 全套 Build/Platform/Managed/Browser/Notification/Backup/Linux/双 arch Container/Security receipts | 0fail/0skip；commit/run/arch/digest 匹配；收集/清理/上传成功                         | S5-01..08；真实 amd64 和 arm64，非 root/空 volume/readonly root/重启恢复                       | controller/child/host 进程断电、volume/网络/磁盘失败、篡改 receipt                | 同新 HEAD 真实完整资格；只获得申请发布资格，不自动 tag/push/release                          | 借旧镜像/历史 Phase 证据、缺 job/skip 伪 PASS、单 arch 替双 arch、诊断 secret 泄漏          |

## 4. 可直接转测试的用例 ID

| IDs       | 精确可观测断言                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-01..03 | LOCAL create 无 Repository/Git；越界/编码路径/symlink/hardlink/FIFO/device/root replacement 全拒绝；Create/Save/rename 原子且旧 bytes 保持                                               |
| S1-04..06 | 同文件 CAS stale 拒 409 保留 buffer；被 TaskSource 引用入口/父目录删改拒绝；操作中 kill/restart 仅处理 owned root/quarantine                                                             |
| S1-07..09 | Archive drain+取消 queued+禁 flags；unarchive 不补跑；Delete Task 后 Workspace 回收而 Run 历史仍可读；Hold 阻备份 GC，unknown 目录不删                                                   |
| S1-10..12 | 真毁源 A 跨根 B restore 并执行；missingroot/entry/manifest mismatch/认证失败不得 COMPLETE；queued IDs/deadline/dedupe restore 后不变                                                     |
| S2-01..03 | FORBID 重复同 Task SKIPPED；QUEUE 同 Task 串行；ALLOW 同 Workspace 仍互斥、跨 Workspace 可并行；WAIT/SKIP/FAIL_FAST 分别可观察                                                           |
| S2-04..06 | 900s 等候选 timeout/cap 用可控时钟验证，queue 满不同 source 处置；queued cancel/重启同 Run 恢复；Cron SKIP/FIRE_ONCE 不建立第二 queue                                                    |
| S2-07..10 | source/task/ws/global/profile/runtime/config 版本变化 → 零 attempt SKIPPED；unknownproof→RECOVERY_REQUIRED；托管 Python/JS/TS/Shell 与 Hook 各 phase；Config/Node 强杀恢复无 secret 残留 |
| S3-01..03 | 相同 repo/ref 双 Workspace 目录/privatebranch/ENV/Runtime 不同；dirty/ahead/diverged 字节/HEAD 不变；Tag 移动不改 pin                                                                    |
| S3-04..06 | source 已 apply 而 Discovery 失败显示 APPLIED/FAILED/NOT_COMMITTED 并全 Workspace 屏障；恢复不 reset；完成事务少 SUCCESS/outbox 任一则 rollback                                          |
| S3-07..10 | samecommit/outbox/event 重复最多一 Run；半 dispatch 后只补缺；manualTask 不被发现改、USER Cron 不复活、suppression/rename/reappear 规则；旧 Sub 所有有效职责被覆盖                       |
| S4-01..03 | Panel JWT 验证+当前 session membership 成功；App/无 token/过期/伪装/open rewrite 拒绝；GET 秘密不可见；有效类型/lifecycle/CAS/幂等校验                                                   |
| S4-04..07 | LOCAL 纯网页创建到运行日志；GIT 创建同步/历史/发现；十菜单/全部真实页面目标、helper 深链处理；中英 locale/toast/恢复/冲突 buffer                                                         |
| S5-01..04 | TS strict-zero、back/front build、active platform/managed、Phase12 browser+Phase13 notification+Phase14 backup 全链；绑定新 sourceSHA                                                    |
| S5-05..08 | Linux FD/flock/socket/crash/scale；native AMD64/ARM64 OCI+Compose/volume 资格；secret/vuln/path gates；完整 receipt/cleanup/upload 缺一失败                                              |

候选数值通过可控时钟/小预算测试不等于部署吞吐容量已测。测试实现文件名由阶段实施确定，以上是要求而非已经存在或已运行的产品测试。

## 5. S0 最终 gate 检查清单

PRODUCT_FROZEN；D1–D5/D7–D9 ADR 完整；D6 类型冻结/数字 S1 验证；Workspace 模型完整；完整候选 DDL 在内存执行；13 旧 FK 逐项映射；Subscription 责任全部重分；Task/Execution/lease/recovery、Sync/Discovery/events、Backup/Restore、API/Auth/Error 合同完整；S1–S5 门可测试；critical contradiction=0；业务代码/ORM/实际 schema/API/UI/config/tests/CI 改动=0。

Review Report 必须分别列 DESIGN_VERIFIED、STATICALLY_VALIDATED、DYNAMICALLY_VERIFIED（内存 DDL 范围）与 NOT_RUN。任何缺失或互相矛盾的核心契约，最终 READY_FOR_APPROVAL=NO；即使 YES，也不请求/授予 S1 授权。
