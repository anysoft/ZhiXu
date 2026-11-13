# 前端信息架构、页面及交互改造

> 架构评审；未修改菜单、路由、组件或语言资源。基线 `develop@d527a46095e85b7fc61c83544cd847a6e3f237db`。以下“目标”是待实施合同；浏览器行为、可访问性、移动端及所有新流程均为 **UNVERIFIED**。

## 1. 当前真实入口与耦合

菜单由 [defaultProps.tsx](../../../src/layouts/defaultProps.tsx#L7)单独维护；[.umirc.ts](../../../.umirc.ts#L6)未配置显式 routes，页面由 `src/pages` 约定生成。菜单树不等于路由注册表：例如 `repository-workspace`、`scoped-env` 及 `setting/*` helper 文件均不在顶层菜单。当前 `src/.umi` 仍有已不存在的历史页面路径；它是生成缓存，不能用它证明当前源码存在 script/dependence/diff 页面，也不能改生成缓存代替改源码。`.umi-production` 静态快照可辅助核对约定路由，但本轮未重新构建，部署中的 route table 为 **UNVERIFIED**。

当前编辑器 [workspace.tsx:49](../../../src/pages/workspace.tsx#L49)从 `?id=` 读取 Worktree ID；第 122 行加载 `/worktrees`，第 118 行无条件读取 `/git/status`；第 438 行要求选择 `info.subscriptions` 才能 Sync/Discovery；第 483 行无条件读取 `info.repository.name`。所以“已有 `/workspace` 页面”不等于已有 LOCAL Workspace。

[Task 表单](../../../src/pages/tasks/index.tsx#L182)加载 Worktree、Python/Node environments，watch `worktree_id`，按 `/task-sources/:worktreeId/entries` 取脚本；[保存 payload](../../../src/pages/tasks/index.tsx#L256)写 `WORKTREE_ENTRYPOINT/worktree_id`。Runtime 默认编辑也分 Repository/Subscription 两层。Task 新建时 Trigger、ENV、Config、Hooks 是分别保存的资源，不能假设已有整合式创建向导。

[Repository 详情](../../../src/pages/repository-workspace.tsx#L183)混合 Config、Environment、bare storage 运维及 Worktree 创建；[ENV 控件](../../../src/components/scoped-environment.tsx#L230)以 `repository_id` 是否存在禁用 Profile 选择；[ConfigBindings](../../../src/components/config-bindings.tsx#L22)scope 只有 repository/task。上述读取和写入都需要重新定向 Workspace，不只是换菜单名称。

## 2. 冻结的顶层菜单

| 顺序 | 菜单         | 建议路由                            | 当前入口处置                                                                |
| ---- | ------------ | ----------------------------------- | --------------------------------------------------------------------------- |
| 1    | 仪表盘       | `/dashboard`                        | 保留 TaskRun 统计；新增 Workspace 类型/状态摘要，不把同步计作运行           |
| 2    | 任务管理     | `/tasks`                            | source selector 从 Worktree 改 Workspace；列表显示 Workspace/入口/Readiness |
| 3    | 运行记录     | `/runs`                             | 保留 TaskRun/Attempt/日志；Source Snapshot 展示 LOCAL/GIT                   |
| 4    | 脚本工作区   | `/workspaces`                       | 新统一列表与创建入口；Code Workspace 编辑器并入详情                         |
| 5    | Git 仓库管理 | `/repository`                       | 保留来源、Credentials、Remote Refs；移走运行默认配置和 Worktree 业务操作    |
| 6    | 运行环境     | `/runtime-python`（本期可保留 URL） | 当前页面已包含 Python/Node；业务文案统一，URL 改名非架构前置                |
| 7    | 环境变量     | `/env`                              | Global / Workspace Profiles / Task Overrides；LOCAL 可用                    |
| 8    | 配置资产     | `/config`                           | 全局资产库保留；bindings 在 Workspace/Task；usage 显示新 owner              |
| 9    | 通知管理     | `/notifications`                    | 保留 Channel/Delivery/TaskPolicy；同步事件另行设计，不能污染 Task 通知      |
| 10   | 系统设置     | `/setting`                          | 安全、应用、日志、Backup/Restore、语言、关于保留                            |

Subscription 顶层菜单及独立业务页面目标 **REMOVE**。`Code Workspace` 不再是单独业务入口；编辑器是 Workspace 的 Files tab。现有 `/log` 顶层入口并入“系统设置 → 日志”统一访问，保留日志功能、权限、retention 与下载，不直接删 API/用户日志。Backup/Restore 继续作为系统设置的重要 tab，不增加与本次目标冲突的顶层业务实体。

## 3. 全部当前页面文件与路由对应

本表覆盖当前 Git 跟踪的全部 `src/pages/**/*.tsx`。`*`、首页重定向另列。路径是当前约定生成结果或静态候选；标有 helper 的文件本意作为内嵌组件，直接访问行为本轮 **UNVERIFIED**。未来应将 helper 移到 features/components，避免被约定路由无意发布。不要为它们建立旧产品兼容路由。

| 当前文件                               | 当前路由/入口                                       | 目标对应                                                                                     | 文件动作                          |
| -------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/pages/404.tsx`                    | `*`                                                 | 未知路由反馈，增加 Workspace 深链边界                                                        | MINOR                             |
| `src/pages/dashboard/index.tsx`        | `/dashboard`，菜单                                  | 仪表盘；保留运行指标，按 Workspace 过滤可后续增强                                            | MINOR                             |
| `src/pages/tasks/index.tsx`            | `/tasks?task_id=`，菜单/Task 详情弹窗               | 同路由，Workspace→ 入口 →Runtime→Trigger 创建流程，显示继承来源                              | MAJOR                             |
| `src/pages/tasks/triggers.tsx`         | `/tasks/triggers`（helper）及 Task tab              | TaskTriggers feature；GIT_UPDATE 从 Workspace 约束                                           | MODERATE                          |
| `src/pages/runs/index.tsx`             | `/runs`，菜单                                       | TaskRun 历史；Workspace source、LOCAL 指纹/可选 Git commit                                   | MODERATE                          |
| `src/pages/subscription/index.tsx`     | `/subscription`，菜单                               | 移入 Git Workspace Sync Policy/Sync History                                                  | REMOVE                            |
| `src/pages/subscription/modal.tsx`     | `/subscription/modal`（helper）                     | Workspace 创建的 GIT source/ref 与 SyncPolicy 表单分开                                       | REMOVE；能力替代                  |
| `src/pages/subscription/discovery.tsx` | `/subscription/discovery`（helper）                 | Git Workspace Discovery tab，owner=workspace_id                                              | REMOVE；能力替代                  |
| `src/pages/subscription/logModal.tsx`  | `/subscription/logModal`（helper）                  | Workspace SyncRun log/detail 组件                                                            | REMOVE；能力替代                  |
| `src/pages/repository/index.tsx`       | `/repository`，菜单                                 | Git 仓库/凭证管理；进入 Repository source 详情                                               | MODERATE                          |
| `src/pages/repository-workspace.tsx`   | `/repository-workspace?id=<repositoryId>`           | Repository source 详情：Overview/Credentials/Remote Refs/Storage Diagnostics/关联 Workspaces | MAJOR                             |
| `src/pages/workspace.tsx`              | `/workspace?id=<worktreeId>`，菜单                  | `/workspaces/:id?tab=files`；拆共用 Editor 与 Git 扩展；不读取旧 ID 空间                     | MAJOR                             |
| `src/pages/scoped-env.tsx`             | `/scoped-env`，独立约定页面                         | `/env` 内唯一 Environment feature；owner Workspace                                           | MAJOR                             |
| `src/pages/env/index.tsx`              | `/env`，仅 re-export scoped-env                     | 环境变量 canonical 页面；移除重复业务入口                                                    | MINOR                             |
| `src/pages/config/index.tsx`           | `/config`，菜单                                     | 配置资产库；usage 改 Workspace/Task                                                          | MODERATE                          |
| `src/pages/runtime-python.tsx`         | `/runtime-python`，菜单                             | 运行环境；Python/Node 原有功能，引用 default owner 改 Workspace                              | MODERATE                          |
| `src/pages/notifications/index.tsx`    | `/notifications`，菜单；也嵌入 Settings             | 保留唯一通知业务页；Settings tab 改导航链接，避免双编辑器                                    | MINOR                             |
| `src/pages/log/index.tsx`              | `/log`，菜单                                        | 移入 Settings 日志 tab，普通日志能力保留                                                     | MINOR                             |
| `src/pages/setting/index.tsx`          | `/setting`，菜单                                    | System Settings 聚合；去 Subscription app scope，保留 Backup                                 | MODERATE                          |
| `src/pages/setting/about.tsx`          | `/setting/about`（helper）/关于 tab                 | SettingsAbout component，显示 v2 构建/资格来源                                               | MINOR                             |
| `src/pages/setting/appModal.tsx`       | `/setting/appModal`（helper）/应用弹窗              | SettingsApp component；Subscription scope 退出；新 Workspace Panel-only                      | MODERATE                          |
| `src/pages/setting/backup.tsx`         | `/setting/backup`（helper）/备份恢复 tab            | Workspace 资产分类、Local 必须备份、缺失代码阻断状态                                         | MODERATE                          |
| `src/pages/setting/clientIp.tsx`       | `/setting/clientIp`（helper）/客户端 IP tab         | SettingsClientIp component；功能保留                                                         | UNCHANGED（若移动文件则仅 MINOR） |
| `src/pages/setting/loginLog.tsx`       | `/setting/loginLog`（helper）/登录日志 tab          | SettingsLoginLog component；功能保留                                                         | UNCHANGED（若移动文件则仅 MINOR） |
| `src/pages/setting/other.tsx`          | `/setting/other`（helper）/其他设置 tab             | 语言/时区/主题/清理仍存在；新增 sync retention 后单独配置                                    | MINOR                             |
| `src/pages/setting/progress.tsx`       | `/setting/progress`（helper）/通用进度 hook         | 作为共享 hook 移出 pages，功能复用                                                           | MINOR                             |
| `src/pages/setting/security.tsx`       | `/setting/security`（helper）/安全 tab              | 保留认证/2FA/会话；不因 Workspace 添加绕过                                                   | UNCHANGED（若移动文件则仅 MINOR） |
| `src/pages/setting/systemLog.tsx`      | `/setting/systemLog`（helper）/系统日志 tab         | 与日志入口整合，保留日志内容和下载                                                           | MINOR                             |
| `src/pages/login/index.tsx`            | `/login`，hideInMenu                                | 登录页面，重定向目标可为 Workspace 深链                                                      | UNCHANGED                         |
| `src/pages/initialization/index.tsx`   | `/initialization`，hideInMenu                       | Fresh 安装；无需 Git 的 LOCAL 首次引导                                                       | MINOR                             |
| `src/pages/error/index.tsx`            | `/error`，hideInMenu                                | 系统不可用/恢复待完成；保留真实错误                                                          | MINOR                             |
| 无首页页面                             | `/` 由 layout 在认证后 `history.push('/dashboard')` | 保留 Dashboard 默认；有效深链不被覆盖                                                        | UNCHANGED                         |

`src/pages/crontab/index.less` 仅为样式文件，不是当前 TSX 页面，不能据此虚构 `/crontab` 运行路由。`defaultProps.tsx` 的 `/setting` component 字符串仍写 `@/pages/password/index`，但该文件不存在；真正渲染来源是约定 `setting/index.tsx`。下阶段清理菜单元数据与真实 routes 的一致性，不能把旧字符串当独立页面。

建议新增文件仅作实施清单：`src/pages/workspaces/index.tsx`（列表/创建）、`src/pages/workspaces/[id].tsx`（详情）；共用 `src/features/workspaces/WorkspaceFiles.tsx`、`WorkspaceOverview.tsx`、`WorkspaceCreate.tsx`、`WorkspaceSyncPolicy.tsx`、`WorkspaceSyncHistory.tsx`、`WorkspaceDiscovery.tsx` 及 Source/Runtime selector。动态页精确 Umi 命名需在契约阶段由 route-generation 检查确认；本轮不创建这些业务文件。

## 4. Workspace 创建与详情合同

### 4.1 统一列表

列：Name、Source Type LOCAL/GIT、Repository/Ref（仅 GIT）、Last Update、Task Count、Lifecycle/Sync Status、Actions。`Last Update` 展示内容变更时间，不能把 fetch 远端 refs 时间误当本地代码已更新；Git Sync History 单独展示最近成功同步。启用 Discovery 后对账失败不显示同步成功；若代码已 apply，展示 RECOVERY_REQUIRED/APPLIED_PENDING_RECONCILIATION、实际 commit 与恢复入口，并阻止新 Run/Save，恢复事务完成才显示 SUCCESS。LOCAL 详情显示代码修改 revision；GIT 显示固定 ref + resolved commit、dirty/conflict/ahead/behind。

创建入口首先选择 LOCAL/GIT。LOCAL 只要求 name；服务器分配受控目录，成功后直接进入 Files。GIT 要求 Repository、ref_type、ref_name；Branch 可选择 MANUAL/SCHEDULED 并配置 Cron 或 Interval；Tag/Commit 显示固定 SHA，不提供自动跟踪控件。自动任务发现默认为显式可选项，不创建即执行脚本；GitUpdate 需要单独 Task Trigger。

创建状态：CREATING→READY，失败为 ERROR/RECOVERY_REQUIRED，保留可诊断 ID；创建重试使用幂等请求，禁止误绑定已有其他 Workspace 目录。目录绝对路径不作为可编辑字段，不提供“选择宿主机路径”功能。

### 4.2 详情 tabs 与能力

| Tab          | LOCAL  | GIT      | 实施要求                                                                                        |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| Overview     | 是     | 是       | 名称/type/state/version/content revision、Task 引用、删除限制；GIT 额外来源/固定 SHA            |
| Files        | 是     | 是       | 创建文件/目录、编辑、rename/delete/search、hash CAS/冲突、未保存提醒、文件引用；无伪 Git 初始化 |
| Tasks        | 是     | 是       | 当前 Workspace Task 清单、创建 Task、Readiness/跳转；手动 Task 独立于发现                       |
| Environment  | 是     | 是       | Workspace Profile/default、有效来源/Task Override；Secret 脱敏，Local 可操作                    |
| Config       | 是     | 是       | Workspace bindings + Task override 引导；挂载预览不展示 Secret                                  |
| Git Status   | 否     | 是       | status/diff/stage/unstage/identity/commit/push；WRITE 凭证和 ref capability 控制                |
| Sync Policy  | 否     | 是       | Branch Cron/Interval/manual；Tag/Commit fixed；启禁仅影响同步                                   |
| Sync History | 否     | 是       | WorkspaceSyncRun 的 before/after/status/error/source/日志；不跳 TaskRun                         |
| Discovery    | 首期无 | 是，可选 | Preview/Apply、policy version、commit/revision、候选 diff、用户修改归属提示                     |

前端以服务端 capabilities 与 type 控制展示；后端同样做授权，隐藏按钮不能代替校验。LOCAL 页面不能无条件读取 Git info、`repository.name` 或调用 `/git/status`。在共同 Files 工具栏保留编辑能力，Git panel 仅 GIT 挂载。

### 4.3 文件冲突与运行中的编辑

[当前编辑器](../../../src/pages/workspace.tsx#L130)已有 `beforeunload`、页面切换/关闭标签草稿确认及 [hash 冲突处理](../../../src/pages/workspace.tsx#L192)，应复用。新 UI 保留文件的 saved/hash/content 三态；409 时保留草稿、展示“磁盘内容已变化”，允许重载或人工比较，禁止盲目重复保存覆盖。切换 Workspace 必须清空旧 owner 的 tree/tabs/selection；不允许只替换 ID 后沿用旧内容缓存。

执行期间采用已有保守租约策略：写入被拒绝时展示运行/同步占用状态及重试入口；不静默覆盖正在执行的代码。materialization journal 待恢复时读操作也被阻断，UI 显示恢复原因，不显示注入期间 Secret 文件。新的 content revision/任务引用提示来自服务端；不在浏览器推断一致性。

首期删除/rename 被 TaskSource 引用的入口或父目录时，显示影响任务并拒绝操作，提示先显式重绑或删除 Task；不无声改 TaskSource。其他辅助文件修改推进 content_revision 并使 readiness 需复核，外部脚本移除入口时 Source 缺失仍需阻断执行。Workspace 删除存在 Task/任意历史 Run/SyncRun/journal 引用时提示阻断，提供 archive/tombstone；物理 purge 待独立保全政策；浏览器不能传 `force=true` 绕过服务端保护。

## 5. Task 创建、运行及继承

目标步骤：`选择 Workspace → 选择入口 → 选择语言/Runtime → 配置 Trigger → 保存`。LOCAL 第一条 Task 路径不得出现“先添加 Repository/Subscription”步骤。

- Workspace selector 展示 name/type，过滤删除中/恢复待完成的对象；GET entries 使用 Workspace ID；语言、relative_entrypoint、cwd_mode、cwd_relative_path 均保留。
- Runtime 为 Workspace Default→Task Override；选择 managed Python/Node environment 后明确 READY build，否则给出可行动 readiness；无运行环境时不回退 Host。Shell 继续按受控执行器规则处理。
- Task payload 为 `source.type='WORKSPACE_ENTRYPOINT'` + `workspace_id`；编辑采用 expected_version。Workspace/type 变化前预览 ENV/Config/default/runtime/Trigger 影响，Workspace 删除后不自动绑定另一个相同名称资源。
- Trigger 默认为明确手动运行能力；Cron/Webhook 可配置，GIT_UPDATE 仅 GIT 并显式启用。Workspace Sync 完成不是“运行 Task”；UI 将 SyncRun ID 与 TaskRun ID 标识和详情分开。
- 当前 Trigger/Config/ENV/Hooks 分别保存。建议新建先以 disabled draft 保存 Task→ 配置子资源 →validate→ 显式 enable；任一步失败留在 draft 且显示未完成项，不把部分成功显示为整体已启用。完整原子创建复合 API 不是 LOCAL 首期前置。
- Task ENV selector 从 repository profiles 切为当前 Workspace profiles，LOCAL 不再 disabled；Task profile override 仅在同 Workspace profile 集中选择。有效变量预览显示 System/Global/Workspace/Task、SET/UNSET 和脱敏来源。
- Config tab 显示 Workspace inherited bindings 与 Task ATTACH/MASK；Hooks 仍归 Task，按 WORKSPACE_ROOT/TASK_CWD 求值；来源路径和 Secret 保持隔离。
- Clone 创建新手动 Task、保留 Workspace/相对入口和运行配置，不继承发现 owner、历史 Run、Webhook Secret。删除 Task 不删除脚本文件。

## 6. Git 仓库详情与 Subscription 能力接管

Git 仓库只保留 Repository/Credentials/Remote Refs，附 storage diagnostics（管理员）和“使用此来源的 Workspaces”。移走 Repository ENV Profiles、Config bindings、Runtime Default；用户需要按 Workspace 配置，不同 Branch Workspace 可以不同 Runtime。

原 Subscription 的名称、repo/branch、cron/interval、disabled、status、error、logs、discovery、profile、runtime default 分别落在 Workspace 标识、Git source、Sync Policy、Sync History、Discovery、Environment/Runtime。原编辑器的 Subscription dropdown 完全退出；每个 GIT Workspace 自带 Sync/Discovery，且同步不运行脚本。

同一 Repository/Branch 可创建多个 Workspace，各自独占目录和私有本地 branch；前端显示业务 ref 而非将内部 branch 名当产品资源。Push 显示远端目标 branch 与 WRITE 权限，不能默认将私有内部 branch 名推到远端。

## 7. 系统设置与非核心页面保留

[当前 settings items](../../../src/pages/setting/index.tsx#L293)包括 security、app、notification、syslog、login、client-ip、backup、other、about。目标逐项：安全保留；应用去 Subscription scope 并保持新 Workspace Panel-only；通知 tab 变为通知管理链接；syslog 与原顶层 `/log` 合为“日志”tab（系统日志、现存同步日志/历史只读、运维日志按域展示）；login/client-ip 保留；backup 明确 LOCAL 核心资产与恢复缺失代码错误；other 保留语言/主题/时区/清理；about 展示 v2 当前构建资格。不得为了 IA 改造删除用户日志或当前系统通知责任。

Login、Initialization、Error、404 不改业务模型；首次初始化成功后可引导创建 LOCAL 或 GIT Workspace。登录失效、恢复待完成、普通文件冲突要分别处理，不能将 409 一律重定向登录。

## 8. I18N 与共用组件改造

实际资源仅 [zh-CN.json](../../../src/locales/zh-CN.json)与 [en-US.json](../../../src/locales/en-US.json)，由 [i18n.ts:12](../../../src/utils/i18n.ts#L12)加载；语言控制在 `src/utils/language.ts`，格式化在 `src/utils/format.ts`，动态枚举/错误经 `translateEnum/translateError`。保留中文/英文同步、系统跟随、切换后即时生效与未知错误回退。

| 文件/区域                                                             | 当前关联                                              | 目标动作                                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/layouts/defaultProps.tsx`                                        | Subscription/Code Workspace/Logs 菜单与混合 name 来源 | MAJOR：统一 10 个目标菜单、次序、图标、真实 route；去 stale password component                                            |
| `src/layouts/index.tsx`                                               | 登录/初始化/错误/home 导航、菜单状态                  | MINOR：Workspace 深链/未保存阻断和 locale 刷新，认证责任保留                                                              |
| `src/utils/config.ts`                                                 | subscriptions AppScope 与中文旧菜单名                 | MODERATE：scope 收口；不因新增 source Type 开放 Git/文件 mutation 给 App token                                            |
| `src/utils/i18n.ts`、`language.ts`、`format.ts`                       | 通用语言/枚举/错误/时间格式                           | UNCHANGED 或 MINOR 注册 Workspace 新 domain；不新增另一套语言控制器                                                       |
| `src/locales/zh-CN.json`、`en-US.json`                                | 工作树、订阅、旧继承来源及错误码                      | MODERATE：新增 LOCAL/GIT、lifecycle、sync/ref/policy 状态、Workspace source/Config/ENV/default；淘汰无消费者旧 key 后再删 |
| `src/components/scoped-environment.tsx`、`repository-environment.tsx` | Task/Subscription 与 Repository profile               | MAJOR：Workspace profile 选择与 Task override，Local 可操作；Secret clear/replace 保留                                    |
| `src/components/config-bindings.tsx`                                  | repository/task union；继承 Repository                | MODERATE：workspace/task 与版本；继承 Workspace                                                                           |
| `src/components/task-resource-references.tsx`                         | kind worktree/repository/python/node                  | MODERATE：workspace 引用、仓库 Workspace 引用，删除阻断理由                                                               |
| `src/components/task-hooks.tsx`                                       | Task Hooks 的 cwd_base                                | MINOR：Workspace root 共用文案和预览                                                                                      |
| `src/components/observability/index.tsx`、`taskPolicy.tsx`            | TaskRun/source DTO 与通知                             | MODERATE：LOCAL/GIT 来源，不展示 SyncRun 为 TaskRun；通知规则保持                                                         |
| `src/utils/http.tsx`、`httpError.ts`、`authFailure.ts`                | API error/toast/鉴权                                  | MINOR：新 Workspace 错误码语义/保留草稿；不能泄漏 response SQL/绝对路径                                                   |
| `src/utils/presentation.ts`、`src/components/name.tsx`                | 字段/枚举/标签呈现                                    | MINOR：Workspace id/type/ref 友好显示；不用内部 branch/path 充当产品名称                                                  |

新增 key 最小集：`workspace.type.LOCAL/GIT`、Workspace lifecycle（含 CREATING/READY/ARCHIVED/RECOVERY_REQUIRED/DELETING）、SyncRun status、ref type、MANUAL/SCHEDULED、CRON/INTERVAL、TASK/WORKSPACE runtime origin、所有新 error_code，以及 APPLIED_PENDING_RECONCILIATION 同步阶段。中文不能只说“工作区”导致 Git Worktree 与业务 Workspace 混淆；产品中称“脚本工作区”，底层 Worktree 仅诊断使用。错误 toast、表格空态、进度、aria-label、弹窗确认、文件冲突说明必须两语言覆盖，不能只翻译菜单。

## 9. 前端与资格验收

| 验收范围       | 必须验证                                                                                                                         | 现有相关证据/入口的后续改造                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LOCAL 首次使用 | 空 volume，零 Repository/credential 创建 Workspace、网页建目录/脚本、保存、Task+Runtime+Trigger、运行/日志、重启再打开、备份恢复 | 新 LOCAL Browser 用例；当前无等价成功证据                                                                                                                                                              |
| GIT Workspace  | Branch/Tag/Commit、Cron/Interval、两 Workspace 同 ref 隔离、Dirty/分叉/执行锁、显式 GitUpdate、SyncRun history                   | `tests/phase11/git-pipeline.test.cjs`、`tests/phase12/git.test.cjs`、`diagnostics/phase12/browser-e2e.cjs`                                                                                             |
| Editor         | 文件/目录 CRUD/search、CAS 多 tab 冲突、未保存切换、二进制/大文件、symlink/hardlink、执行占用、恢复 fence                        | `tests/phase12/files.test.cjs`、`api.test.cjs`、`discovery.test.cjs`；Phase12 Browser 重跑                                                                                                             |
| Task/继承      | LOCAL/GIT 创建、clone、缺失 source/readiness、Workspace default 与 Task override、Config/ENV/Hooks、Run source snapshot          | `tests/phase9/*`、`tests/phase10/*` 及 Browser selector/payload 更新                                                                                                                                   |
| 通知           | 实际 LOCAL/GIT Task terminal event→outbox→delivery，失败不改 TaskRun，Secret 脱敏、Channel form                                  | Phase13 Browser + `tests/notifications/*`，不以旧 schema 的结果替代                                                                                                                                    |
| Backup/Restore | LOCAL 唯一源码可恢复、Workspace ID/root、Git repair、恢复时页面冻结、缺失代码阻断、加密导出导入                                  | Phase14 Browser/真实恢复，Settings Backup UI 与 API 错误一致                                                                                                                                           |
| IA/routes      | 菜单只出现冻结的 10 项；所有 helper 不作独立业务路由；深链、base URL、刷新、返回、404、登录跳转                                  | `.umirc.ts`/route generation/source file placement 与菜单同时检查；不编辑 `.umi` 代替源文件                                                                                                            |
| I18N/屏幕      | zh-CN/en-US/system-follow、未知码、不裸露 source enum/SQL/path；桌面/移动端；键盘/aria 和冲突弹窗                                | `tests/i18n/*`、现有 i18n Browser probes 扩展 Workspace 新场景                                                                                                                                         |
| CI/平台/容器   | TypeScript、前后端 build、Linux 原生锁/信号、ARM64/AMD64、非 root volume、重启与 restore                                         | [linux-ci](../../../.github/workflows/linux-ci.yml#L142) full browser job、[container qualification](../../../.github/workflows/container-qualification.yml#L17) 双架构 native matrix 重新取同源码证据 |

旧 Phase12/13/14/15/16A/16B 历史报告保持原样；它们能说明现有能力测试的意图，不能证明 v2 页面、LOCAL 源码资产或新容器已经通过。前端完成标准是两种来源同样可用且保留安全/恢复行为，不能只以菜单截图或 TypeScript 通过判定。
