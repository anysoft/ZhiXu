# ZhiXu v2.0 — S4 Implementation Report

> S4 产品整合验收通过。本轮实际执行的 58 个 S4 唯一用例全部通过，28 个测试文件完整覆盖；必需回归与独立审查通过，收集器未发现未决门禁。首次失败与精确重试均保留，资格范围止于 S4。

## Baseline

| 项目 | 记录 |
|---|---|
| Branch | `codex/v2-s4-product-integration` |
| Entry HEAD | `f869cd1efb4b1aab360e0663109b132df0e3da61` |
| Code Commit | `3527f6601394e331ca77b5d604287672ae5fd009`，源代码与测试提交 |
| Final HEAD | `SELF`，包含本报告与机器证据的本地提交；其父提交为上述 Code Commit，可由 Git 独立解析 |
| 实施阶段 | S4 — Fresh-v2 Application Integration / API / Frontend / Product Experience |
| 资格日期 | 2026-11-14，Asia/Singapore |
| User Changes Preserved | 用户原有 `.gitignore` 保持未暂存、逐字节不变；SHA-256：`78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893` |

本轮把已实现的 Workspace、执行、Git、Runtime 和备份领域装配为独立应用，补齐实际 HTTP、前端和产品流程。没有新增另一套 Workspace/Task/运行队列，没有引入旧数据迁移，不变更 S0 冻结 DDL、DTO、状态机或错误注册表。历史阶段报告和历史验证记录不被重写为本轮结果。

公开机器证据交付位置为 [s4-validation-results.json](../../../tests/workspace-v2/s4-validation-results.json)。最终计数、源文件与测试哈希、命令、退出码、初次失败、精确重试及私有证据别名以该文件为准。下文只列日志文件名，不公开测试私有根的绝对路径、口令、Token、Git 凭证或 ENV/Config 明文。

## Application

### Fresh-v2 Startup

新增独立入口 [back/appV2.ts](../../../back/appV2.ts) 和 [applicationV2](../../../back/applicationV2/application.ts)。原 `back/app.ts` 继续作为 v9 入口；没有把 v2 路由偷偷挂到 v9 自动装配链。

显式构建与启动方式为：

```sh
npm run build:v2
npm run start:v2 -- --data-root "$ZHIXU_V2_DATA_ROOT" --initialize --host 127.0.0.1 --port 5600
```

`ZHIXU_V2_DATA_ROOT` 必须由操作者指定为规范化的绝对私有目录；首次初始化必须显式授权。未知非空根、旧 `data` 域、旧 `QL_DATA_DIR` 及其祖先/后代重叠、根链接、外来所有权和错误 schema 均拒绝启动，不自动迁移、覆盖或修复用户未知目录。启动器在访问数据前检查 Node 主版本。声明允许 Node 22/24；本轮应用 HTTP、CLI 与浏览器的实际资格使用 Node **22.23.2**，不能据此声称 Node 24 应用全矩阵已认证。Node 26 的既有鉴权依赖不兼容被保留为初始环境失败，没有使用兼容 shim。

### Schema Identity

Schema Identity：`zhixu.workspace.v2.s0.1`。Schema Signature：`f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`。首次建库使用原样冻结 `fresh-v2.sql`，其 SHA-256 为 `ffa7b469ff5844fab2fc49b6046447b542f0cf6fc2a7a6dc50246ae47b501655`。

本轮重新执行结构与 DDL 验证：58 张表、94 个外键、35 个显式索引、144 个 SQL guard、86 个动态 DDL 检查，`integrity_check=ok`，`foreign_key_check=[]`。结构验证仍覆盖 129 条冻结路由与 74 个冻结错误码；这些静态检查与真实 HTTP/浏览器资格分别记账。

独立审查实际复现了未知 WAL 数据库的 P1：即便只为检查 schema 打开 SQLite，RW 连接关闭时也可能 checkpoint 原文件，READONLY 也可能修改 SHM。修复后的 [schemaPreflight.ts](../../../back/applicationV2/schemaPreflight.ts) 在原库建立任何 SQLite 连接前，以不跟随链接的只读 FD 复制已验证主库及已知 sidecar 到带私有所有权标记的临时域，在副本上执行完整 schema、完整性与外键验证。取得实际 backend owner 后再次比较原始目录、文件身份和代际证明，才允许原库 RW 打开。

该处理也遵循 SQLite 对 WAL checkpoint、只读访问条件及共享 WAL-index 协调的公开说明：不能仅凭连接名义上的 READONLY 就证明未知输入没有 sidecar 副作用。参见 [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html) 与 [SQLite WAL File Format](https://www.sqlite.org/walformat.html)。具体三文件不变结论来自本轮实际回归，不能由文档链接代替。

实际负例验证了未知 main/WAL/SHM 三份哈希不变、链接 sidecar 拒绝、真实并发 SQLite writer 使代际校验失败、未知 recovery quarantine 不被接管。真实全 58 表且唯一已提交数据仍在 WAL 内的有效库可正常启动。稀疏 32 GiB 文件用例证明临时容量预算提前拒绝；它不是把宿主磁盘写满的 ENOSPC 试验。

反向隔离也有独立实际证据：未修改的 v9 operational schema initializer 对真实完整 v2 库返回 `UNSUPPORTED_DATABASE_SCHEMA`，数据库目录、表目录、行数和唯一源码保持不变。该证据证明真实 v9 schema gate，**不宣称完整 v9 HTTP 服务在 v2 根上启动**。

### Service Container / Recovery Ordering

[container.ts](../../../back/applicationV2/container.ts) 显式注入候选 `WorkspaceStore`、根解析器、真实 FD leases、备份 barrier 与领域服务。Runtime 只把保留的 provider/handler 工厂绑定到该候选域，不依赖 v9 全局 ORM 初始化。实际模块加载检查分别在 import、boot、真实 LOCAL Task 执行后观察缓存，没有旧 UserService、全局 Keyv/Store 或旧数据模型的隐式启动；没有用测试 loader 替换模块来制造这项结论。

恢复顺序为：先处理根替换恢复与 schema 预检，取得 backend owner；再核验 Workspace 根、恢复 Workspace 操作、Runtime、Task/Config/Node 物化、Sync/Outbox 和 Webhook inbox；确认未决操作与实际 backup idle 状态后才开放 admission 和调度器。显式恢复使应用重新 READY 时也启动通知 dispatcher。正常关闭等待生产者与活动所有者清理，服务和 FD 不靠 PID/超时猜测接管。

LOCAL 写入另受当前构建能力探针保护：在新的私有 A/B 域执行真实源码、加密备份、销毁 A 和 B 恢复后才开放 `local_write_admission`。历史 S1.B 报告不替代当期门禁。实际编译后的 HTTP/CLI 复核为 5/5，通过独立进程重启验证稳定 ID、原队列与调度 occurrence；不是只检查类可实例化。

## API

### Routes Implemented

实际 Express 注册与路由 catalog 分开审计：

| 范围 | 数量 | 含义 |
|---|---:|---|
| FROZEN_S0 | 129 | method/path 与冻结合同精确一致，映射到实际 controller 与领域服务 |
| RETAINED_DOMAIN | 148 | 账户、Runtime、通知、备份等保留公开域；明确标注退场项，不伪称全部可成功写入 |
| S4_EXTENSION | 5 | 明确记录的新增只读/产品操作路由 |
| 注册目录合计 | 282 | 实际挂载目录数量，不能当作 282 条成功业务调用或 282 个测试 |

五个路由扩展为：`GET /system/git-identity`、`POST /tasks/:id/restore-discovered`、`GET /backups/usage`、`GET /restores/:id/preview`、`GET /backups/:id/preservation`。另对既有 `GET /tasks` 明确扩展四种语言枚举过滤；这不是新增路由或悄悄修改冻结工件。

`POST/PUT /user/init` 按真实实现登记，没有把 `app.all` 展开成不支持的全部动词。旧账户通知写入和 Subscription retention 具有明确退场状态与安全错误，不算成功实现的替代领域。catalog 为每条路由记录 controller、service、请求/响应 DTO 及状态。

### DTO Validation / Authentication / Authorization

输入校验显式拒绝未知字段、错误类型、非法 ID/版本、跨 Workspace Profile、旧 Source 类型及不支持的枚举；公开输出只投影合同字段。文件只暴露相对路径、hash、版本和签名目录身份，Runtime/失败日志不公开宿主私有路径，凭证和 Secret 不读回。分页日志保留原始字节 cursor 语义，跨页命中私有根也脱敏，保留的原历史日志字节不被重写。

业务 API 按冻结合同使用 **Bearer**；浏览器 cookie 不能替代它。实际 JWT 签名/时效/平台会话成员关系均校验，App-like Bearer、失效 session 和 cookie-only 请求不获得 Panel 权限。写请求校验同源 Origin 与 `X-CSRF-Token`；受保护的 2FA 初始化读取也要求 CSRF。首次设置、登录、退出、真实 TOTP 激活/登录/停用、密码和用户名修改、session 撤销都有真实 HTTP 证据。

鉴权配置以事务和代际 CAS 保护。旧 2FA 配置下已开始的登录不能在配置变化后签发新有效 session；非法 auth reset 请求在写入前完整校验，不能先改密码再返回失败。弱默认新密码拒绝。Secret 只在明确的一次性设置/轮换响应中返回；UI Token/CSRF 仅存内存，不写 LocalStorage、SessionStorage 或认证 cookie。

### CAS / Idempotency / Error Codes

资源修改使用合同规定的 `expected_version` 或文件 `expected_hash`。全局 ENV 保留数组 DTO 和 PATCH 语义，通过 `ETag: "global-env-N"` 与 `If-Match` 做 CAS；删除发送明确 tombstone，不把遗漏当删除。Task/Profile 变量使用合同的完整替换语义。目录 rename 使用 tree 捕获的签名身份，文件 delete/rename 使用用户读取时的 hash，不能事前重读最新 hash 逃避冲突。

创建 Workspace、恢复别名、执行提交、Webhook、Sync、GitUpdate 等使用各自冻结的持久身份与去重规则。**`POST /tasks` 的冻结幂等约定为 `NONE`**：本轮没有擅自添加持久 Task-create 幂等性，也没有 shadow store。UI 防止同一弹窗的重复并发提交，并不保证跨刷新、连接中断重试或同一 header 的持久创建去重。TaskRun 则使用冻结 `submission_key`；这是两种不同保证。

错误使用 `{code,error_code,message,retryable,resource?,operation?,details?}` 安全信封。版本冲突、权限、忙、恢复拒绝与校验错误保持明确 HTTP 状态；multipart 大小/格式错误映射为 413/400，而不是未知 500。不得公开底层 Git stderr、原始凭证或异常对象。

## Workspace

LOCAL 不要求 Repository：真实浏览器从空库创建 LOCAL、建文件、保存和执行，数据库仍无 Repository。GIT 绑定现有 Repository/ref，独立 private checkout、所有权和来源身份沿用 S1/S3，初始 Sync/Discovery policy 在创建 READY 事务内持久化。

生命周期支持创建、Archive/Unarchive、恢复、来源重建/回收及 preservation 约束。归档允许读取和解绑，禁止普通写入/运行；未知物理根替换保持原样并拒绝接管。恢复别名只复用真实既有 WorkspaceOperation，不制造已成功的 RECOVER 行。回收不删除历史身份。

文件入口提供有界 tree/search/read/create/save/rename/delete 和目录创建，使用实际文件服务与 held Workspace lease。CodeMirror 编辑器保留 dirty buffer；离开页面、切换破坏性上下文和重载会要求显式处理草稿。真实两个浏览器会话验证 B 保存后 A 返回 409，A 草稿仍在、重复保存关闭、B 物理字节不变，显式重新加载才接受新内容。

独立审查复现并修复了文件回执 P1：A 保存后若另一次 snapshot 读到 B 内容，A 可能误收到 B 的 hash。现在五类文件修改在原 held lease 内捕获自身物理 hash 与已发布 Workspace 行，返回自身原子回执。实际 HTTP 交错用例包含 BOM/CRLF 原始字节：B 在 A 响应前提交，A 仍拿到自身 hash/版本，A 后续旧写 409，B 内容保留。

## Task & Execution

TaskSource 唯一为 `WORKSPACE_ENTRYPOINT`，引用 LOCAL/GIT 的 Workspace 和相对入口。没有脚本 staging 副本、Worktree TaskSource、Subscription 或 Repository 执行默认值。手动 Task 与 Discovery Task 复用同一 S2 服务，原定义版本、来源代际/修订、Git commit、inventory/entrypoint hash 和生效资源身份保留到 TaskRun 历史。

Runtime 选择为 Task override 优先于 Workspace default。PYTHON/NODE 只能使用真实 managed environment/revision/build/runtime；Shell 使用冻结 fixed Shell。没有 PATH/系统 Python/Node 回退，也没有把逻辑行手工写成 READY。RuntimeOperation 和物理 provider 安装/构建/验证结果均真实产生。

ENV 遵守 System allowlist→Global→同 Workspace Profile→Task 覆盖/UNSET；Config 遵守 Workspace ATTACH 与 Task ATTACH/MASK，保留 Secret 替换/保留/清除语义、不可变修订、CAS 和原始内容恢复。Task Hook 顺序和阶段沿用实际 HookExecutor；TaskRuns 是唯一持久执行队列，实际 Runner/FD、取消、重试、资源 pin、日志上限/分页与历史恢复沿用 S2。

参数 UI 的实测数据损坏已修复：逐项 TextArea 保留 `[]` 与 `['']`、首尾空格和参数内换行；不再用按行分割/trim 的文本框改写 argv。真实 UI 创建、三次编辑（包括只修改名称）和实际 Shell child 同时证明逐字保留。

### Runtime 证据范围

| 证据 | 实际执行范围 | 不能扩大为 |
|---|---|---|
| Runtime domain 最终 2/2 | 在同一 marker/devino 验证的原私有根重开，保留此前真实成功的七项操作，实际 Python 3.13.15 和 Node/tsx Task 执行 | 最终命令重新冷安装了所有 runtime |
| Runtime HTTP 最终 2/2 | 同一真实已安装域的独立应用重启，HTTP 配置、Node 24.21.0/tsx 4.20.6、真实 TypeScript Task 与历史/日志检查 | 从其他实例拷贝 build 或导入旧 receipt 后伪造冷启动 |
| 浏览器 managed 用例 | 全新私有实例，通过 UI 刷目录、安装 Node 24.21.0、安装 NPM、建立 environment/build、选择 Task override 并真实执行 JavaScript | Python 浏览器安装资格或所有外部 provider 网络可用性 |
| 本轮 S1.B full 精确重试 | 新 A 的实际受管环境、加密导出、销毁 A、退出 A 进程、独立 B 冷构建并执行八个原 Task ID | 用 A cache/process/FD 的复用替代独立恢复 |

Runtime 的初次冷安装失败、外部下载超时和 owned-reopen 命令均保留。没有把 owned-reopen 改名为 cold-install，也没有借历史 receipt 满足本轮浏览器安装要求。

## Git

Repository/Credential 入口复用真实凭证解析与安全 Git 命令。公开路径不允许测试用 file transport；受控本地 remote 只由测试构造能力验证规范路径、私有 UID/devino 后使用。Repository 只管理源码与凭证，不重新承载 Runtime、ENV 或 Config 默认值。凭证输出只有安全元数据/指纹和使用引用，不读回 Secret。

Git Workbench 支持真实状态、diff、显式 stage/unstage、持久 CAS identity、commit/push，并继承 Repository→Workspace lease 顺序和 argv/transport 安全策略。Git identity 确认通过真实 full backup/restore 保留。两个 Git helper 固定使用平台 helper Python 路径，避免宿主 pyenv shim 链导致不可控启动时间；这不是 Task runtime 回退。

Sync 调用实际 S3 safe fetch、ref/object 校验、ancestry 与 FF-only apply；dirty/staged/untracked/local-only/diverged、未知 admin、unsafe/casefold 目标和弱 stat 隐藏编辑继续 fail closed，不 reset/clean 用户文件。物理 HEAD、SQL 成功、恢复 fence/journal 和完整 inventory 发布各自可核验。

Discovery Preview 只读，Apply 重新验证完整 preview/source/policy/Task/Trigger CAS，并在真实事务内完成全部对账；错误诊断作为安全 error details 返回，不伪造部分成功。新发现 Task 默认 disabled；执行配置必须由用户明确启用。Retired 来源重现后须显式 restore，不自动启用。

真实浏览器链验证：创建 Repo/GIT Workspace→实际 Sync→只读 Discovery Preview→确认 Apply→编辑并启用 Task→添加 GIT_UPDATE trigger→执行；再修改真实 remote commit→Sync SUCCESS→Outbox DISPATCHED→实际 GIT_UPDATE TaskRun SUCCESS，来源 commit 与新 commit 相等。后续 NO_CHANGE 不新增 Outbox 或运行。保留原事件身份、完整 S2 admission pin 和至少一次分发规则，不声称任意外部副作用 exactly-once。

## Frontend

显式 `ZHIXU_FRONTEND_MODE=v2` 使用 [v2Routes](../../../src/v2/routes.ts) 和 `static/dist-v2`；不设置该变量仍使用原 v9 路由与 `static/dist`。真实默认模式构建成功，原 v9 路由 chunks 存在；构建前后 v2 全部 242 个文件逐项 hash 相同。

| 产品入口 | 实际对接 |
|---|---|
| Dashboard / Tasks | 概览、Workspace/类型/启用状态/语言过滤、创建/编辑/克隆、可运行性、立即运行、Triggers、Health/Stats |
| Runs | 状态、等待、Attempt、取消、分页真实日志、不可变历史源码与资源身份、事件 |
| Workspaces | LOCAL/GIT 创建、状态/能力、详情、文件编辑、环境/Runtime/Config、生命周期、Git/Sync/Discovery/history |
| Git Repositories | Repository 与 Credential 元数据、安全初始化/fetch/refs/repair、使用引用 |
| Runtime / ENV / Config | 实际 provider/operation、安装与构建、Workspace default/Task override、Profile/Global CAS、Secret 与修订 |
| Notifications | 通道、安全 Secret 操作、测试、Task policy/bindings、投递与重试 |
| Settings | 账户/2FA、存储状态、备份创建/验证/导出/导入、恢复预览/确认、重启/重建状态 |

前端只使用同源 `/api`。读取 `/system` 后必须确认 `mode==='v2'`，再读 `/user` 或允许登录/初始化；错误服务模式只显示翻译后的错误，表单与写入关闭。独立真实 HTTP health 服务上的浏览器负例确认没有登录/初始化 mutation 或 `/user` 读取；它是协议拒绝测试，不是业务 API mock 资格。

### i18n

复用既有语言控制器、共享资源注册表和 ICU formatter，支持 `en-US`/`zh-CN`。新增 `v2.*` namespace，没有第二套翻译源或自制替换器；每一条旧界面消息的键和值保持不变。严格全局扫描仍覆盖 v2，补充准确的 `useText` import/词法绑定解析，未排除新目录或放宽缺失断言。新静态 literal 例外逐项说明品牌、版本/ID、Cron/IANA 时区或用户内容组合原因。

最终 24/24 i18n 测试通过；两语言各 2,592 个共享键，无重复、缺失、语言不对齐或未分类 literal。浏览器实际切换中文，刷新后重新登录仍能查看原 Run ID 与历史；Token/CSRF 不因语言或刷新落盘。

### Sealed Browser Artifact

最终 v2 前端构建退出码 0，242 个文件，共 21,552,599 bytes。`index.html` SHA-256：`6a74a7add30deebe41a87d8d2765632059a873382f8e7476a3239be8d87214d6`。逐项 manifest SHA-256：`bd84f3e88849bc92da0d9884c912136f23077d5d35275fd02d54326baedf2458`。

每个浏览器用例先复制完整构建到自身私有域、计算每项 hash，再由真实应用同源服务该不可变副本。核心、Git、managed、argv 与模式负例的被选定结果均核对同一 manifest；没有在后台持续 build 改变正在验证的页面。

## Backup / Restore

API 和 UI 调用真实 WorkspaceBackupService、WorkspaceRestoreService 与持久 BackupOperations，延续冻结 FULL_PORTABLE 和认证加密格式。显示真实 validation、Workspace coverage、preservation hold、retained/live usage 和容量门禁；不把物理 managed runtime/cache 塞入可移植快照。

实际 HTTP 3/3 证明加密导出/download、multipart 导入、错误口令拒绝、真实 quota/hold 防删除、确认 stage、PENDING 与匹配取消。stage 在持久化 PENDING 前不丢失原活动根；受控重启在 operation durable SUCCESS 和 HTTP 响应完成后请求。另一个独立应用进程完成恢复并经鉴权 HTTP 验证源码，不能把浏览器看到 PENDING 等同恢复已经完成。

真实 COMPLETE 恢复记录的启动审查修复了目标身份缺口：原 quarantine 正确也不能授权接管另一个已替换的合法 schema 根。当前恢复必须核验 published candidate identity；未知替换拒绝启动，原源码、数据库、journal/barrier 不变，匹配 COMPLETE 遗留 barrier 可安全清理。当前 schema-preflight 组合 10/10 包括这两个用例，不能把旧 terminal-restore 2/2 另外加总成新的唯一覆盖。

备份、恢复、rebuild 和正常执行的活动 barrier、leases 与日志保密不因 UI 装配绕过。S4 继续区分可恢复 PENDING、恢复拒绝、逻辑绑定待物理重建和实际 READY；不自动宣称受管运行时已重装成功。

## Notifications

保留的 24 个 provider adapter 与 WEBHOOK 复用原消息协议/序列化算法；抽取纯 parser 和懒加载移除了 v2 import 时意外打开旧 Keyv/数据库/日志的副作用。provider AST 等价与 schema 测试属于静态/单元资格，不宣称用真实外部凭证逐个调用了所有供应商。

实际受控 HTTP 接收方验证 503→持久 RETRY→重试→200/SENT 及稳定幂等键；真实 Shell TaskRun 的终态 SQL trigger 生成一项持久通知并真实发送。另有实际 controller SIGKILL 发生在请求处理中，由全新进程恢复 SENDING、标记 INTERRUPTED attempt 并实际再次发送。系统通知使用 SYSTEM outbox，不伪造 Task/Run。投递规则是至少一次，接收方是否去重决定外部重复副作用。

## Subscription Retirement

| 旧职责/入口 | v2 处置 | 实际证据 |
|---|---|---|
| Subscription CRUD、菜单与创建流程 | v2 无此领域/菜单/先决条件 | 实际 LOCAL/GIT 全流程及导航截图、模块加载与 route 负例 |
| `/subscriptions`、`/worktrees`、Repository worktrees、旧 TaskSource entries | 404 `API_ROUTE_NOT_FOUND` | 实际已鉴权 GET/POST 共 18 项 namespace 负例，非落回 SPA HTML |
| Repository/Subscription scoped ENV、Runtime defaults、Config bindings | 旧作用域路由不挂载，未知 DTO 字段拒绝 | 当前资源 handler/HTTP 与 namespace 检查 |
| 源码与私有 checkout | Repository + GitWorkspace + S1 根/FD | 真实 Git 和生命周期服务 |
| Sync policy/schedule/history | WorkspaceSyncPolicies / SyncRuns / Scheduler | S3 服务、当前 HTTP、浏览器与重启 |
| Discovery/suppression/retirement | Workspace Discovery 与同一 Task 领域 | Preview/Apply/restore，实际来源身份 |
| Runtime / ENV / Config 执行默认值 | Workspace default / Profile / binding + Task override | 实际资源与 managed TaskRun |
| 更新触发 | GitUpdate TriggerEvent / Outbox / TaskRun | 实际 remote commit 到 TaskRun 链 |
| 旧 Subscription storage-retention 写操作 | 明确退场，不创建伪实体 | 保留 endpoint 返回安全退场错误，catalog 不宣称成功实现 |
| 旧 `PUT /user/notification{,/init}` | 410，转到 NotificationChannels 领域 | 实际 route catalog 与 HTTP |
| v9 原入口与默认界面 | 保留默认选择，不新增旧数据迁移 | 当前 v9 回归与默认前端构建；不把其旧菜单算入 v2 |

v2 应用没有 Subscription/Worktree business service 依赖。允许加载的保留 Runtime API 文件只是被显式绑定候选域的工厂，不启动旧全局路由/ORM。v9 仍可保留原功能，不构成把它们重新引入 v2。

## Tests

### 计数规则

**最终收集器：S4 58/58，28/28 测试文件覆盖，0 个未决门禁、0 个失败门禁。** 以下分组存在交叉覆盖、重跑与包含关系，禁止直接相加。最终只允许同一精确用例的有效重试覆盖其结果；原失败、退出码和来源范围均保留。没有一条命令覆盖并通过本轮全部 S4 文件的声明。S1.A 68/68、S2 112/112、S1.B 36/36、S3 81/81、v9 210/210 及相关额外回归 44/44 均由本轮真实记录核验；S1.B 和 v9 的完整运行与精确重试关系如下。

| 分组 | 已执行结果 | 证据日志文件名 / 范围 |
|---|---|---|
| Workspace/Git + 原子回执 | 10/10 | `s4-file-receipt-qualified.log`；1 项实际 mounted HTTP 交错，9 项实际服务/route-handler |
| Task/资源 handler | 4/4 | `s4-task-resource-handlers-final.log` |
| Task/ENV/Config 实际 HTTP | 1/1 | `s4-resource-http-final.log` |
| Runtime domain | 2/2 | `s4-runtime-domain-reopen-final.log`；owned-reopen |
| Runtime HTTP | 2/2 | `s4-runtime-http-logs-final.log`；owned-restart |
| 账户/2FA/reset HTTP | 5/5 | `s4-auth-final-http.log` |
| 应用启动与 HTTP 安全边界 | 4/4 | `s4-root-http-final.log`；1 项 app + 3 项 security，后续当前编译入口复核含相关启动覆盖，不能重复累计 |
| 当前编译入口 HTTP/CLI | 5/5 | `s4-current-build-http-cli-final.log` |
| 应用进程恢复 | 2/2 | `s4-entry-recovery-qualified.log`；实际新 controller/FD、未决状态拒绝 |
| 日志隐私 HTTP | 1/1 | `s4-log-http.log`；真实 pwd/跨页根路径投影与原字节 cursor |
| 备份 HTTP | 3/3 | `s4-backup-http-final.log` |
| 通知纯导入与实际 HTTP/Task/SIGKILL | 4/4 | `s4-notification-final-manual.log` |
| schema/WAL/terminal restore/架构组合 | 10/10 | `s4-schema-preflight-qualified.log`；包含旧 2 项 terminal、1 项 architecture |
| 反向 v9 schema gate | 1/1 | `s4-reverse-schema-identity-final.log`；不等同完整 v9 HTTP boot |
| 核心/Git 浏览器精确重跑 | 2/2 | `s4-browser-core-git-sealed-final-retry.log` |
| managed Node 浏览器精确重跑 | 1/1 | `s4-browser-managed-sealed-final-retry.log` |
| argv / 错误服务模式浏览器 | 2 个指定用例通过 | `s4-browser-sealed-final.log` 中原 5 项为 2 PASS/3 FAIL；后三项由精确重跑覆盖 |
| 生命周期浏览器 + 备份 HTTP 最终组合 | 最终 5/5，0 FAIL/0 CANCELLED/0 SKIP | `s4-lifecycle-backup-sealed-qualified.log`；2 项浏览器 + 3 项真实备份 HTTP，包含上列备份用例，不另加总 |
| i18n | 24/24 | `s4-i18n-final.log`；严格 checker 另为 PASS |
| v9 相关额外回归 | 44/44 | `s4-v9-relevant-extra-final.log`；包含上述 i18n，不额外重复累计 |

### Browser E2E

核心五项唯一浏览器用例已由原矩阵和精确重跑分别覆盖：4 项真实生产装配应用流程，1 项独立错误服务协议负例。实际 Chrome/Playwright，未拦截 business route 或伪造 Runtime/Sync/TaskRun 状态。

E2E01 包括新 LOCAL、编辑保存、实际 UI 安装/构建 managed Node、选择 Runtime、执行和日志/历史；E2E02/03 包括真实 Repo/GIT/Sync/Discovery、显式启用、真实 GIT_UPDATE 和 NO_CHANGE；E2E04 是独立会话真实 409 草稿保护；E2E05 最终实际证明归档只读/解归档、权限负例、真实备份 portable exchange/预览/PENDING，以及已知恢复/未知根替换拒绝；E2E06 由无 Subscription 的实际导航/流程、当前 route/module 负例和截图共同验证。最终生命周期两项与备份 HTTP 三项组合 5/5；它们复用同一 sealed artifact，不能与早期同名通过结果重复计数。

### Restart Recovery / 故障与初始失败

实际 S4 应用恢复包括新 controller 对队列/occurrence、Sync/Outbox、真实通知中途 SIGKILL 的接管、恢复拒绝与根替换。PID 或内存句柄不充当所有权；前一活 owner 的真实 FD 未释放时，不因逻辑时钟过期就接管。本轮 S3 全量回归包括原 14 个实际物理 SIGKILL checkpoint，14/14 通过，按各自持久证据由新 controller 恢复；S4 通知的实际请求中途 SIGKILL 单列，不混进这 14 个 checkpoint。最终收集器继续逐项核对，不将普通 throw、人工 marker 或逻辑状态测试算成 SIGKILL。

下列首次失败保留，而不是替换成一条全绿历史：

| 初始情况 | 已确认原因与处置 |
|---|---|
| Node 26 启动/鉴权环境 | 既有依赖不支持；改用实际 Node 22，无 shim，无把环境失败计为业务 PASS |
| LOCAL 当前构建能力探针失败 | A/B control 目录缺失；补齐真实私有控制域，重新执行真正备份恢复 |
| v2 import 触发 legacy Keyv | i18n/notify 导入链副作用；抽取纯 parser 与懒加载，模块边界及真实 HTTP 重新验证 |
| 未知 WAL schema 验证修改源 | 实际 P1，改用私有 FD 副本预检及取得 owner 后原代际复核，原始三哈希断言保留 |
| Runtime handler/HTTP 冷安装失败 | 首次真实七项操作后测试字段断言错误、后续下载 stall/curl28 等分别保留；最终 owned-reopen 明确标注；另有浏览器全新 Node 安装与 S1.B 独立冷恢复 |
| 首次 browser assets 在并行 build 中变化 | 统一构建并改用每用例不可变完整私有副本，不把空网络流量失败冒充功能测试 |
| Git 浏览器无自动运行 | 首轮遗漏启用默认 disabled 的 Discovery Task；增加真实 UI 启用步骤，业务规则未放宽 |
| Git 浏览器 Sync 等待超时 | 第二次实际 Sync 约 32.1 秒超过 30 秒测试等待；有界等待增至 90 秒，所有状态、来源、唯一运行和 NO_CHANGE 断言保留 |
| managed browser 编辑器 fill 一次失败 | 四项实际 provider 操作已成功；相同 sealed artifact 的精确重跑通过，并增加安全失败截图保留；不杜撰未确认根因 |
| 中文重新登录定位失败 | Antd 双字按钮可访问名称插入空格；调整定位，真实重新登录与原 ID/history 断言保留 |
| 早期 v9 i18n 40/41 | 新 v2 文本未接入全局严格检查；修复共享 namespace/ICU 与精确绑定识别，最终相关 44/44，未排除目录或改旧断言 |
| 生命周期 combined 中一项 cancelled | 测试在 UI refresh 的 GET 仍占真实 EX 锁时立即用领域服务读取，观察到 `WORKSPACE_BUSY`；仅将该验证读取改为最多 5 秒、25 ms 间隔且只重试精确 `WORKSPACE_BUSY`。所有源码字节、未知根身份/拒绝断言保持；最后完整组合重跑 5/5，0 cancelled，实际 BUSY 重试次数为 0，不声称最终重跑再次触发该竞争。原 cancellation 保留 |

### S1.A / S2 / S1.B / S3 / v9 回归

| 阶段 | 本轮真实历史与最终覆盖 | 日志 |
|---|---|---|
| S1.A | 最终 68/68，0 FAIL/0 SKIP | `s4-regression-s1a-final.log` |
| S2 | 最终 112/112，0 FAIL/0 SKIP | `s4-regression-s2-final.log` |
| S1.B | 初次 36 项为 35 PASS/1 FAIL；失败是官方 Python archive 下载 curl28 超时，约 929 秒只取得 2/23 MB，未进入备份恢复。随后独立 full 精确冷重试 1/1：真实 A 销毁且退出，独立 B 冷构建八个原 Task 均执行成功。合并为 36 项精确覆盖，不能宣称首次全量 36/36 | `s4-regression-s1b.log`、`s4-regression-s1b-full-retry.log` |
| S3 | 最终全量 81/81，0 FAIL/0 SKIP；保留更早 focused 失败日志，不用其部分结果替换全量 | `s4-regression-s3-final.log` |
| v9 | 初次 210 项为 209 PASS/1 FAIL；入口子进程依赖路径测试环境失败，随后真实入口两项精确重试 2/2。按同一失败用例覆盖合并，不能写成初次全量 210/210 | `s4-regression-v9.log`、`s4-v9-entrypoint-retry.log` |
| v9 相关额外回归 | 最终 44/44；phase10 entrypoint、auth、notifications/provider/branding、全部 i18n。其包含/重复关系由 collector 去重 | `s4-v9-relevant-extra-final.log` |

### Build

Backend TypeScript、backend build、v2 frontend build 和默认 v9 frontend build 已实际执行。当前编译 HTTP/CLI 5/5 对最终编译输出进行实际启动验证；代码格式化只接受 AST 等价证明，不据此免除实际入口检查。

默认 v9 构建明确 `env -u ZHIXU_FRONTEND_MODE npm run build:front`，退出 0，输出 `static/dist`。默认 `index.html` SHA-256 为 `a2e41728ecfe98a1fc5216f1da5586de7d5c57c3e03c0211d28981aa015fabd9`；构建前后 sealed v2 manifest 都为 `bd84f3e88849bc92da0d9884c912136f23077d5d35275fd02d54326baedf2458`。日志 `s4-v9-frontend-build-final.log` SHA-256 为 `11673480fd66f4741d671f9e6ce27ad7e73ad2a4a3537d0e9fa126a449e68c95`。

## Deferred S5 Qualification

本轮只交付 S4 内部产品整合。Linux、Container、AMD64、ARM64 的部署组合、不同文件系统/锁语义、完整浏览器矩阵、发行包/升级回滚、长期负载/容量、安全与生产发布资格留给独立 S5 审查。

Darwin arm64 上的真实 Chrome、Node 22 应用和受管 Python/Node 成功，不代表 Linux/容器或全部平台 PASS。Node 官方 HTTPS/SHA256 与 provider 的实际安装验证不等于额外未执行的签名验证。浏览器恢复预览/PENDING 不等于全部灾难恢复完成；后者由独立实际恢复与 S1.B 证据证明。

S4 结束后停止，等待人工审查；不自动进入 S5，不自动发布、部署或操作真实生产数据。

## Git

修改已有函数/类前执行 GitNexus upstream impact，并对 HIGH/CRITICAL 明确预警。新增独立应用、现有 shared/runtime/restore/Git helper、i18n 资源与 checker 的变更各自记录影响；无解析 caller 的 UNKNOWN/lower-bound 不当作零风险。

GitNexus 当前索引记录为 18,899 nodes / 62,473 edges / 697 flows。相对 `develop` 的代码最终比较实际退出 0，风险 CRITICAL，列出 129 个文件，其中包含用户保持 unstaged 的 `.gitignore`；源代码提交为 128 个文件。索引内影响为 2,740 symbols / 374 flows。分析器的动态分发、跨语言与流程探索预算存在已报告限制，未出现的边不作为无影响证明。

工具原有结果输出存在 1,000 条硬上限。为取得完整列表，使用未修改的 LocalBackend 和 8 个私有 `GIT_INDEX_FILE` 分区，核验精确 union 为全部 128 个源码文件、2,740 个符号和 374 条流程，`partial=false`、`truncated=false`，实际 Git index 未因此改变。代码提交前 staged 检查、提交后 compare/develop 与报告/机器证据提交前检查分别执行。这些是代码索引影响范围，**不是测试数，也不表示发布风险已经消除**。

| Git 操作 | 状态 |
|---|---|
| 本地 Commit | 源代码/测试：`3527f6601394e331ca77b5d604287672ae5fd009`；报告/机器证据：`SELF`，即包含本文件的本地提交 |
| 用户 `.gitignore` | 原样保留并排除提交 |
| Push | 未授权，不执行 |
| Tag | 未授权，不执行 |
| Release | 未授权，不执行 |
| Deploy | 未授权，不执行 |

## Final

```text
ZHI_XU_V2_S4_PRODUCT_INTEGRATION_PASS=YES
READY_FOR_S5_REVIEW=YES
S4_UNIQUE_TESTS=58
S4_LATEST_PASS=58
S4_LATEST_FAIL=0
S4_LATEST_CANCELLED=0
S4_LATEST_SKIP=0
S4_TEST_FILE_COVERAGE=28/28
S3_REAL_SIGKILL_GATES=14/14
PENDING_GATES=0
FAILED_GATES=0
FINAL_COMMIT=SELF
GITNEXUS_FINAL_COMPARE_AND_STAGED_REVIEW=COMPLETE
```

Remaining Blockers：无未决 S4 阻塞项。冻结 `POST /tasks` 的 `NONE` 幂等语义、owned-reopen 与冷安装范围、历史失败与重试均已明确披露，不擅自扩大保证。两项最终标志与机器收集器一致。已停止于 S4，等待人工审查，生产发布和跨平台资格由 S5 单独确认。
