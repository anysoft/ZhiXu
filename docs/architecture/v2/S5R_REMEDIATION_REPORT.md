# ZhiXu v2.0 — S5.R Remediation Report

## Baseline

本报告是 S5.R 的新记录；原 S5/S0～S4 记录未覆盖。最终发布判定以配套[机器证据](../../../tests/workspace-v2/s5r-validation-results.json) 的同一 RC15 证据和本报告 Final 为准。

- Entry HEAD：`5062a313dda9399605b9d8acf9853d066a07d2ab`；Branch：`codex/v2-s4-product-integration`。
- Previous RC10：`b814fb428b1c307645c6df438f2d0dc4eab1a2e3`，Tree：`cdf6ffb3b4b9d12e68f27f96b0983df13e957342`。
- Final code RC15：`58cfda832bf556a96e0ebc1b0722116d9c20fd4e`，Tree：`70a730f0599b201158bf3115badcde5cec132f7f`。报告提交属于后续元数据提交，不改变被测代码身份。
- 用户已有 `.gitignore` 修改按字节保留；45 个保护文件逐项 SHA256 一致，其中包括冻结合同、SQL、DTO、错误码、历史报告和验收证据。
- 本地修复提交依次为 `beb62a0`（HTTP/Task 停机）、`eb2028c`（可信离线输入及依赖修复）、`1aa1e6d`（独立构建标签）、`d0594e9`（原生构建暂存与崩溃 worker 策略）、`58cfda8`（非 root 原生工具及静态 TLS 构建）。完整 SHA 和文件清单见机器证据。

## B1 Security

安全判断分别覆盖 Application Release、Docker Base/OS、Managed Runtime Installed Volumes 和 Build/CI Toolchain；未批准任何风险豁免。扫描 exit0 只表示扫描命令完成。

- OpenSSH/Git：三个目标平台使用固定的 Git 2.50.2 安全回移构建及 OpenSSH 10.6p2，独立 OpenSSL 3.5.9 LTS、curl 8.23.0/MbedTLS 3.6.7 LTS 和 zlib 1.4。v2 消费者验证工具清单和二进制，拒绝回退宿主 Git/SSH。Darwin 封存 compiled App 上两 Node 各7项SSH与4项HTTPS，共22项真实传输/主机身份/凭证隔离/篡改用例完整通过；源码与许可证保留。
- SQLite：保留 `@whyour/sqlite3@1.1.2` Fork API，实际内嵌 Core 3.54.1。真实打开数据库的 Source ID 为 `2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`；使用 N-API 6，各平台从源码重编译并记录实际 `.node` SHA。没有用系统 SQLite 或 Node 内置 SQLite 冒充应用 Addon。
- Managed npm：11.21.2；tsx：4.23.15；esbuild：0.28.2，实际发布二进制由固定 Go 1.26.11 重编译，发布者明确为 ZhiXu，不冒称上游原始二进制。
- Managed Python：CPython 3.13.15 的受控源码构建，固定 pyenv revision `c293de3650a2d08ea36c5f6f0d55c5a3841b0c72`，私有静态 OpenSSL 3.5.9、zlib 1.4、SQLite 3.54.1，pip 26.3 同时用于基础安装、venv 和 ensurepip。Linux glibc 2.31 的 `_ssl/_hashlib` 探针使用有界 linker retention 修复，未伪造 configure 结果。来源/标准库适用性单独记录，不能由加密库升级推定整个 Python 无漏洞。
- pnpm：10.34.9。锁文件图、frozen install、必要生命周期、prune 后强制原生重建和两次独立构建均有记录；没有整体跳过生命周期来获取成功。
- 前端：真实构建图 1774 行，227 个发出的静态资源逐项匹配封存 A。若模块未发出，仅作为浏览器发行域可达性证据，不能关闭 Build/CI 或后端域风险。

最终扫描/处置：**B1=NO，Approved Waivers=[]**。以下为同一 RC15 的原始发现实例，不能相加成独立 CVE 数，也不能把工具 severity UNKNOWN 与处置 UNKNOWN_BLOCKED 混同。

| 发行域 | Critical | High | Medium | Low | severity UNKNOWN |
|---|---:|---:|---:|---:|---:|
| AMD64 正式镜像 | 0 | 169 | 531 | 889 | 25 |
| ARM64 正式镜像 | 0 | 169 | 526 | 888 | 25 |
| Darwin pruned Application | 0 | 0 | 15 | 0 | 0 |
| 完整 Source/Build/Dev 图 | 0 | 5 | 54 | 11 | 0 |

七个实际 Installed Runtime scope 分别为两种 Docker、两种 Native Linux，以及 Darwin 的 NPM/PNPM/Python 冷安装代表。自动 FS/SBOM 结果、实际 npm/tsx/esbuild/Go/pip 及 vendor 子集逐项分账；未将四个 Linux 前缀的结果扩成所有 Darwin 安装实例逐一已扫。Darwin 其余两个 NPM fixture 没有声称独立扫描或已证明字节等价。静态 C 库、CPython stdlib、原生宿主 libc/kernel 的自动扫描边界明确保留。

全部 3,392 条扫描发现均分到要求的五类：3,083 UNKNOWN_BLOCKED、191 NOT_APPLICABLE_WITH_EVIDENCE、112 NOT_REACHABLE_WITH_EVIDENCE、6 RESIDUAL_RISK_REQUIRES_APPROVAL；当前发现中没有伪造的 FIXED_AND_VERIFIED。另列六个已核实 Git backport 的修复控制证据。低等级未逐项审阅部分明确保留 UNKNOWN_BLOCKED。

余项包括系统 Git、部分 OS 解析器/库、Build/Dev 中 path-to-regexp/serialize-javascript/zod 的未关闭输入路径、共享 SDK 自带旧 npm 的独立风险账，以及实际 npm 闭包的 glob/minimatch 中等级和未被充分识别的 stdlib/C 组件。没有把受控 Git/OpenSSL/SQLite 修复当成系统对应包全部修复。

受控 Git 2.50.2 的认证源码归档及 RelNotes 对应六项修复；[维护者发布公告](https://github.blog/open-source/git/git-security-vulnerabilities-announced-7/)也明确包含该维护分支。部分 GHSA 元数据仍显示 all/none，作为来源同步差异记录，未改原始资料。镜像中实际系统 Git 仍为 `1:2.47.3-0+deb13u1`，[Debian 对递归克隆漏洞的记录](https://security-tracker.debian.org/tracker/CVE-2026-111760)仍列其易受影响；两个架构合计六条系统 Git HIGH 实例没有批准豁免。git-man 的实际 203 路径仅为文档/手册，按物理文件清单对其 18 条归因分别作 N/A，未扩成 Git 二进制 N/A。

两镜像默认合并文件系统及 image-config secret 扫描均 0 命中，工具内建排除保留，不声称所有删除层/归档已穷尽检查。Gitleaks 原始匹配另按位置/摘要审阅。SBOM 及原始扫描/失败以 SHA 索引保留私有原件；工具版本、时间、数据库、全部逐 finding 决策/来源/版本/消费者边界及固定修复控制嵌入机器证据；未提供全类 ignore 或默认 VEX 豁免。

## B2 Native AMD64 DR

离线输入与已安装 Runtime、Build、Workspace 源码和配置物化分域。通过受保护的独立 SHA256 Allowlist 批准精确发行清单；待导入包自身不能提供信任根。清单同时约束 Provider、发布者、URL、版本、OS/Arch、归档格式、摘要和签名状态。无可验证签名时如实保留 `SIGNATURE_NOT_AVAILABLE` / `SIGNATURE_NOT_VERIFIED`，不伪造官方签名。

`ONLINE_VERIFIED` 和 `OFFLINE_VERIFIED` 进入同一正式 Provider/安装/Build/Readiness 流程。无数据库影子表、手工 READY 或 Host Runtime Fallback。固定 npm/tsx 依赖闭包在实际拒绝出站网络下重建；不能支持的离线 PNPM 或任意 pip 闭包明确拒绝。原 ONLINE PNPM/pip 能力保留并单独验证。

最终包按平台独立记录为 Darwin ARM64 attempt10、Linux ARM64 attempt7、Linux AMD64 attempt5，其 manifest/独立 anchor/每个对象的 size/SHA/来源均由根审阅复核。旧包只保留为迭代历史，不混入最终资格。离线安全负例及 Runtime/生命周期新增测试以同一整组 99 例分别在 Node22/24 完整通过，包含篡改、平台/版本/依赖错配、不可信清单、路径/链接逃逸、截断、并发、中断和发布只读树保护。

本组灾备 Application Node24.22.3，Managed Node24.22.3 / Python3.13.15；基础/停机组 Application Node22.23.5 与24.22.3 各19+9例，性能组仅 Node22.23.5。Native AMD64 使用真实 `x86_64`、服务 UID10001、私有 mount/network namespace，无 QEMU。私有 mount namespace 内只读 bind 本轮 passwd/group 文件提供 UID10001 身份映射，host `/etc` inode/哈希不变；未使用 NSS wrapper 或 LD_PRELOAD 替代生产验证。

- A 独立进程执行 LOCAL/GIT × Python/JS/TS/Shell 原 8 个任务，全部一次 Attempt/exit0/cleanup SUCCESS；正式认证加密导出完成。
- A 退出并销毁 DATA/Runtime/Control 三根后，独立 PID B 才启动；无 A 进程、FD 或路径依赖。
- B Runtime Cache 初始 0 文件/0 bytes。恢复后 6 个受管 Python/JS/TS 任务的 readiness 为 `RESOURCE_UNAVAILABLE`，diagnostics 为 `RUNTIME_NOT_READY`，此时提交 FAILED 且 0 Attempt；Runtime 安装行 state 为 `MISSING`，两个 Shell 任务不受受管 Runtime 缺失阻断。随后 7 个真实 Provider/Runtime/Environment 操作成功，冷安装后执行原 Task IDs 1～8，新 Run IDs 与历史不同。
- 11 个历史 Runs/12 个 Attempts/日志哈希、Git Index、dirty/untracked/local commit 和源码按正式断言保留；恢复后再次备份成功。
- B 采用仅 loopback、无外部路由的真实隔离网络；没有依赖 GitHub/npm 出站下载。
- `AMD64_NATIVE_OFFLINE_DR=PASS`。本轮RC15的 `AMD64_NATIVE_ONLINE_DR_CURRENT_RC=NOT_RUN_CURRENT_RC`；`RC10_ONLINE_DR_HISTORY=BLOCKED_NETWORK` 保留原历史网络阻塞，本轮未把旧候选失败归为当前候选已执行，也未把离线成功改写成在线下载成功。
- S0 固定逻辑引用保全、恢复后未重建阻断 readiness、无 Host Fallback 和既有重建策略；独立 allowlist 与离线 acquisition 是本轮 S5.R 新增策略。依据原 S5 允许的正式验证缓存，本次通过 B 安装根/cache0、独立可信源码输入和正式冷安装/构建满足动态资格，冻结文件未修改。完整合同分析、A/B PID、根身份、Task/Run/Attempt、网络与原始回执 SHA 见机器证据。

## B3 Task Shutdown

正式策略见[停机策略](S5R_SHUTDOWN_POLICY.md)。QUEUED 关闭领取但保留原 Run ID/submission key，0 Attempt、无 cancel_requested，下一进程继续领取。RUNNING 先给 5 秒自然结束窗口：窗口内完成为 SUCCESS；截止后协调终止为 INTERRUPTED / EXECUTION_INTERRUPTED / SHUTDOWN，释放子进程和 FD/Lease 后才交还所有权。显式 USER_CANCEL 保持 CANCELLED，Task timeout 和真实控制器 SIGKILL 使用各自原有状态与恢复路径。

没有将断言扩成 `SUCCESS|CANCELLED|INTERRUPTED`。新增精确 QUEUED/GRACEFUL/TIMEOUT/CANCEL/SIGKILL/occurrence recovery 用例、真实跨进程队列和 Cron 恢复均记录各自唯一预期终态。HTTP 关闭先停止 admission/生产者，追踪已准入异步副作用及活跃 socket，排空或有界终止半包请求；不在异步写入仍活跃时提前关 SQLite。

RC15 完整 S2 同一次命令 **112/112 PASS**，exit0、fail/skip/cancel0；完整 S4 同一次命令 **58/58 PASS**，exit0、fail/skip/cancel0。S2 raw SHA 为 `5167318c0cd84672a10c46fa249d8d1a7299068f068d595ae79fc68bb8a49d88`；S4 为 `865f12960f4250693f665213769c15843d397c8fd2ea59a388bd829d4ddecfed`。原时限和断言未放宽。B3 正式关闭；重启/Cron/真实 SIGKILL 仍按各自精确状态验证。

## B4 WebKit

原 RC10 活跃 WebKit 停止超过 30 秒的历史证据完整保留；后续单次 83.687ms 诊断没有被当作修复证明。另可确定复现 RC10 的半 JSON/仍活跃 HTTP 所有权停机挂起 >30 秒；修复后相同受控请求约 5 秒收敛。此机制复现与原 WebKit 超时分别记账，不假定二者原始因果完全相同。

生产诊断采用单调时钟，记录 SIGTERM/admission/调度与 outbox/HTTP 请求和 socket/Runner/Lease/SQLite/进程退出，日志不含凭证或敏感请求体。实际没有的 SSE/WebSocket 不伪装为已测。每个浏览器场景均使用真实封存生产 HTTP；至少一组保持真实 Context 和请求活跃到 SIGTERM，未提前关闭浏览器规避问题。

最终 Application Node22.23.5 × Chromium/Firefox/WebKit 各完整 21/21，另 Application Node24.22.3 × WebKit 完整 21/21，共84个停机场景通过，其中72例在SIGTERM时保持Context存活，12例为Context先关闭的对照；每组七种场景各三个独立样本。真实引擎为 Chromium159.0.8154.6、Firefox159.0、WebKit27.2。

84 例原始单调时钟 shutdown 样本 p50=227.583479ms、经验 p95=5048.152815ms、最大5245.368885ms；p99=null。测量为 SIGTERM/stop 到子进程退出且 pipes 关闭，包含约5秒 transport deadline 的上传场景，不声称全部不超过5秒。各阶段事件原样解析保留；原进程与独立复起进程均 code0/signalnull，SQLITE_CLOSED 的连接/请求/handler 归零，BACKEND_OWNER_RELEASED 在进程退出之前。Workspace lease FD 没有独立阶段时间，未捏造该时间或 lease-state 字段。B4 依据已复现所有权挂起机制的修复和这些完整场景关闭，未倒填原 WebKit 超时的未知精确根因。

浏览器业务完整组为 7×3 引擎=21/21，严格 pageErrors0。私有夹具仅等待真实对话框动画完成、原有409冲突信息渲染完成并增加观测，使用正常 pointer；原98条业务断言源码逐项相同，证明 SHA `130ad702207e0805c7809e5c2a8b0fb2edb8747933e056bb6ff3c7bd997d74db`，manifest SHA `64aa8ef129b383011d0fa5c63cc83e01e5982f6fad27da1a12e76ae0b0e91a1a`。正式应用和候选测试源码未改；不虚称未修改夹具的原 WebKit 命令已 PASS。首4/7失败和后续观察失败仍保留，早期 Fetch API pageerror 没有被过滤或捏造确定根因。

另外三个独立 UI 补测各1/1，通过真正加密导出/导入/preview/confirm，观察自动恢复 COMPLETE，再以新的 CLI PID 重启到 COMPLETE 并执行原任务。它们与原7组只要求 PENDING 的断言分列；这些补测正常停止前会关闭 Context，Context存活时 SIGTERM 的证明来自上面72例子集，二者不混用。

## Platforms

各平台使用同一 RC15 源码。Native Linux 复用封存的 JS/前端输入并重建本平台原生 Addon/Git 工具；Docker 独立构建并按其实际清单和 OCI 身份验证。不能混用 Darwin/Linux 二进制，也不声称跨 OS 构建清单逐字节相同。原生 ARM64 为 Apple VZ 上真实 aarch64 Linux；原生 AMD64 为真实 x86_64；Docker 两种架构分别在对应原生宿主运行。模拟环境不计正式原生资格。

| 平台 | 最终实际资格 |
|---|---|
| Native AMD64 / Debian11 / x86_64 | 176/176：S1.B36、S381、Node22/24各19+9、coldNode1、Node22性能1、Node24完整8任务灾备1；另正式导入行政命令通过 |
| Native ARM64 / Ubuntu24.04 / aarch64 | 17组319/319：Node22/24各19、S2112、S458、core7×3、COMPLETE1×3、停机场景21×4、完整灾备1、Node22/24性能各1 |
| Docker AMD64 | 两Node各19+9，默认入口/重启、只读/nonroot/零cap、完整加密灾备和性能通过 |
| Docker ARM64 | 两Node各19+9，默认入口/重启、只读/nonroot/零cap、完整加密灾备和性能通过；另Root五资源组/八入口负例通过 |
| Darwin ARM64 | 两独立clean build、两Node各compiled19/停机与入口16/新增完整99，原v9/S1.A/HFS、真实Node/Python冷安装及ONLINE npm/PNPM/pip、升级回滚和容量补测通过 |

Native ARM 暂停前保留的 ordinary22/24、activeWebKit22/Firefox22 和灾备证据在 kernel6.8.0-147；恢复重启后的 S2/S4/其余 browser/perf 为6.8.0-149。各证据保留原 OS 字段，同一候选/后端/前端/目标发行字节，未声称同一 kernel。Native Linux 的 JS/前端为共享封存输入，目标原生依赖实际重编译；Docker 有其独立镜像身份。

## Regression

| 必需项 | 最终结果 | 资格范围 |
|---|---|---|
| S0 DDL | 86/86，exit0 | 58表/94FK/144guard，schema signature `f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c` |
| S0合同结构 | 3069当前检查通过 | 5项历史S0入场事实以明确45保护哈希证明分列；冻结validator未改 |
| S1.A | 68/68 | 原完整suite |
| S2 | 112/112 | NativeARM同一次完整命令 |
| S1.B | 36/36 | NativeAMD完整suite/真实Linux32MiB ENOSPC；Darwin原HFS用例另1/1 |
| S3 | 81/81 | NativeAMD独占窗口完整命令及严格namespace外层均0；14真实SIGKILL |
| S4 | 58/58 | NativeARM同一次完整命令，含原CLI重启、通知恢复及真实ManagedRuntime链 |
| relevant v9 | 210/210 +44/44 | 两原完整命令，各exit0 |
| 新增负例/生命周期/只读安全 | 99/99 × Node22/24 | 同一全部文件整组，不拼接 |
| 完整加密 A毁/B冷恢复 | 四Linux scope通过 | 原生AMD/ARM、DockerAMD/ARM，原8TaskIDs重新成功；ONLINE与OFFLINE分账 |
| 资源/入口 | 5组10故障断言、8入口负例通过 | 仅自有child/cgroup/tmpfs/network；不称全宿主资源耗尽；真实EDQUOT另为NativeARM OS_ONLY |
| 升级/回滚、发行完整性 | PASS | 同冻结Schema；测试后25,201封存项0差异及三归档SHA复核 |
| 安全 | NO | 七实际Runtime scope+两image+Application/Build/CI分账，剩余风险无豁免 |

容量补测独立一次新完整用例通过：1500×2050B文件、3 Workspace/3 Task/4 Run，每Run一次Attempt/exit0；同 Workspace Attempt互斥、不同 Workspace Attempt区间实际重叠；每份2097225B历史日志分3页，全部字节和原日志哈希一致。备份 operation.created_at 落实际RUNNING Attempt区间，正式snapshot校验1521文件，large目录1500文件。57个计时 call() 成功、0错误，鉴权和until轮询不纳入该分母。App+controller采样RSS峰436928512B、FD峰1024、临时logical峰3900B（250ms采样）；不含child CPU/RSS，不声称瞬时绝对峰或极限容量。

NativeARM最后独占性能两Node各8Run成功，FD30→30。queue经验p50/p95为Node22 313/692ms、Node24 330/762ms；lifetime为659/980ms、637/1056ms。样本各N8，p99=null、无预定义延迟SLO。只读采样期间WAL observed0，闭合数据库journal_mode=DELETE；绝对瞬时WAL峰值未知。真实本地Git Sync成功N6经验p50/p95=1041/1795ms、Outbox created→dispatched N6=66/114ms，均为数据库wall时间，不是公网延迟或单调阶段计时。Discovery缺少独立start/finish，记NOT_SEPARATELY_OBSERVED，不用poll总时长补填。

新增私有容量首轮因外部准备文件未发布inventory，正式HTTP正确返回WORKSPACE_VERSION_CONFLICT，尚未进入Task负载；新一轮先通过正式文件API发布准备状态，无直接数据库写入，再执行冻结脚本SHA `9846c916916f47df76c1246e18d2e417b4d5ed62dcac93e104d2fac4dd5cbad9`。资源夹具两次准备权限失败未启动应用，保留原FAIL，修正owned输入权限后五组从头真实执行通过。

历史失败和完整重试均保留。S4 两次 57/58 不相加，S2 旧 107 例中的部分通过不补成 112，旧候选通过也不计入 RC15。

暂停前的宿主 `ClamshellSleep` 与独立虚拟机时钟观测证实长时间停顿；该轮 S2/S4/ONLINE PNPM 受影响结果保留 FAIL，不延长原断言时限。恢复后启用有归属且有时限的防空闲休眠，使用新 clock observer 和独占资源窗口进行完整复验。防空闲休眠不能阻止主动合盖。

Root 旧 source-negative 命令缺少 compiled fixture 环境，产生 94 中 93 通过/1 loader 失败；已用相同全部文件与正确编译输入分别完整执行 99/99 × Node22/24。未执行的旧 Node24 计划标为 superseded，不冒称已执行或以必需 skip 充数。首次 Native AMD64 S3 内层 81/81、外层 mountinfo guard FAIL 原样保留；由于未存原两份 mountinfo 文本，不能精确归因某一 mount 行。独占窗口从头重跑 81/81 且同一严格外层 guard exit0 才计正式 PASS。

## Release Candidate

- Git SHA：`58cfda832bf556a96e0ebc1b0722116d9c20fd4e`；Tree：`70a730f0599b201158bf3115badcde5cec132f7f`。
- Source archive SHA256：`62f645a5f411715eaed90fe092f6e1ae7da6b65f19b8278a62728ab374e4df52`。
- Lockfile SHA256：`17a644568dcee8c69305b286f739a58f51718849ef718f4c4f291c03a8b64aef`。
- Backend manifest：`ee67403fd90d9dd4bf478f34c7eb8812e0b5c61b257edb0f3367b17bbbb77d48`。
- Frontend manifest：`486b58c36a885146cbc164e3e0c919d58dd190a610a61c818f58d329a1ffd4a2`。
- AMD64 OCI manifest：`sha256:12ec4578346c2874a83239e183ab7e7e507d42a4344a6d3145eed6759aeef679`；config：`sha256:694aac2803afff49f58e7b6e3a1d2168d4b033d9a223705ba0465a733e1d1a06`。
- ARM64 OCI manifest：`sha256:916d9d6f8cd615e85772b1cbdbad87c63086bbe7e133e2ac7f6f1964ff51ef38`；config：`sha256:25772d90674477261183f63728b906d0a8f18bc7c6d116a111f0368e2519ed35`。containerd store 的 inspect.Id 为 manifest descriptor，未误当 config。
- Darwin ARM64 的两次独立源码导出、frozen install、必要 lifecycle、prune 后强制原生编译均 exit0。Native Linux 使用共享封存 JS/前端与目标原生源码重建，记为 `PORTABLE_JS_WITH_TARGET_NATIVE_SOURCE_REBUILD`，不冒称 Linux 原生前端 clean build。主要发出代码/入口/辅助脚本/Git 输入哈希一致。完整封存 A/B 分别为 `9bc592ea5ce178856202c0dc868a357bd6f332b4ccf91bba6f9b31ebcd0c7b9a` / `744a7fd2c233e9e489b74f70036277f1e4412f7cdb99c273f628200d4996593b`；72 项差异归于 69 个 pnpm 绝对路径 shim、2 项依赖状态元数据、1 项构建日志。完整包 bit reproducible 为 **false**；未把规范化比较伪装成相同实际字节。
- 升级/回滚在实际 S4 基线→RC15→旧代码→升级前完整加密备份恢复→RC15 的四个独立进程中通过，保留 B 新写入状态和恢复后的任务成功。资格仅覆盖同一冻结 Schema，不声称 v9 自动迁移或任意未来版本降级。

清场 **PASS**：NativeAMD精确12根及全部namespace/进程清理；Supply范围14远端根、84容器/171卷及自有镜像/builder/cache清理；Root三次资源夹具65容器/79卷已按各自ledger独立复核0；NativeARM32个guest根完整stream封存后删除、63个host传输文件及所有observer/launcher清理。以上按owner分账，不将不同记录的累计数量相加为全局唯一数。

专用VZ实例已先正常停止，再精确删除，host父根按dev/ino验证后移除；两个旧Git builder域和guest SDK随整台本轮VM清理，caffeinate已按UID/start/argv核对终止。六个Darwin Runtime case完整私有归档48,310项逐byte/mode/link验证后，删除24个live Runtime/缓存子目录；旧S5.R构建缓存12目录已删。原始两AMD容器和本地Colima服务仍running且启动时间不变，没有global prune/kill，没有修改原有VM、真实生产数据或用户SSH配置。

只保留一处受控私有审计根中的源码/发行/OCI/Docker封存包、可信SDK/来源/制品输入、失败原件、完整opaque样例归档、SBOM/扫描和索引。旧S5证据与既有共享工具根未删除。公开JSON只有去敏命令模板、结构化观测和原件摘要/大小，原始私有运行日志、认证值、私有主机地址和密钥路径不入公开文件。

GitNexus 在现有索引重建后仍存在字段/名称回退与跨语言解析限制；没有把 0 affected 当作完整安全证明。提交前执行 staged detect_changes 及 develop compare，并结合静态调用关系、精确 staged 文件清单、45 个保护哈希和实际全回归审阅范围。

## Final

```text
S5R_BLOCKERS_CLOSED=NO
ZHI_XU_V2_S5_RELEASE_QUALIFICATION_PASS=NO
READY_FOR_RELEASE_APPROVAL=NO
```

| 原阻塞 | 当前状态 |
|---|---|
| B1 SECURITY | **未关闭**：UNKNOWN_BLOCKED与六条未批准残余风险仍存在，waivers=[] |
| B2 AMD64 NATIVE DISASTER | **PASS**：正式可信离线冷重建完整八任务；在线历史仍BLOCKED_NETWORK |
| B3 S4 FULL REGRESSION | **PASS**：同次58/58、exit0、无fail/skip/cancel |
| B4 ACTIVE WEBKIT SHUTDOWN | **PASS**：具体所有权机制修复、84停机场景（72例Context存活、12例已关闭对照）及独立重启证据 |

剩余发布阻塞是B1。需要针对保留的系统包、Build/CI及Runtime适用性完成后续安全修复/可靠关闭证据；如改变代码、依赖或发行内容，必须产生新候选并重新执行相应完整资格。本文没有替用户批准任何剩余风险；功能回归通过不能覆盖安全阻塞。

所有代码提交与报告均只在本地；没有 Push、Tag、Merge、Rebase、Release、Registry Publish、生产 Deploy 或生产实例修改。
