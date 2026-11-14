# ZhiXu v2.0 — S5 Release Qualification

本轮发布资格结论为 **NO**，未取得发布批准。此报告记录实际执行结果、测试工具修正、未闭合安全风险和现场清理。没有批准豁免任何必需门禁；没有 Push、Tag、Release、Registry Publish 或生产部署。

## Baseline

| 项目 | 实际身份 |
|---|---|
| Branch | `codex/v2-s4-product-integration` |
| Entry HEAD | `f765689d8db488fdf3cd8b4f6904263f6c87c478` |
| S4 code parent | `3527f6601394e331ca77b5d604287672ae5fd009`；确为 Entry HEAD 的直接父提交 |
| Qualification code HEAD / RC10 | `b814fb428b1c307645c6df438f2d0dc4eab1a2e3` |
| Qualification Git tree | `cdf6ffb3b4b9d12e68f27f96b0983df13e957342` |
| develop at entry | `f869cd1efb4b1aab360e0663109b132df0e3da61` |
| Source archive SHA256 | `8ab8e905bf1191fceed7e3b6cb8e4a2c30e084cd798d1da055b240edcb23676d` |
| package.json SHA256 | `0eb9210b840ed5ce81d6c3bbcc90dd0b45700f0b61eb6e3c41bb1bb056b00d35` |
| Lockfile SHA256 | `d2febfc813a23a25504eec5aead507da99546ea26303a0c37cdac4e3cb27d085` |
| 用户 `.gitignore` SHA256 | `78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893`；保持未提交修改 |

与本地 develop 的 merge-base 为 `f869cd1efb4b1aab360e0663109b132df0e3da61`，`develop...candidate` 左/右独有提交数为 `0 / 12`；未通过 Merge/Rebase 同步分支。

资格针对上述完整代码提交及封存产物。承载报告与机器证据的后续本地提交只增加验收记录；其完整 SHA 由最终交付消息及受控 `final-commit-receipt.json` 记录，避免在文件中伪造自引用提交哈希。37 个 S0 冻结文件及 4 份历史阶段机器记录均重新逐字节校验，无更改。

## Release Candidate

| 工件 / 身份 | SHA256 / digest |
|---|---|
| Darwin release composition | `7acc8fdbb8be030e91bd54af86cc5ffb69dfda33fd36da53a1180cabd6ababf1` |
| backend manifest | `c63a716bcf9b91ec5c4e308832195e5aeece29bf4f759c9d4de02df767661861` |
| frontend manifest | `e8b59a3f865778aac0b4c90701d71f14a5f4754ce325cfaa6df7865ffb8da47c` |
| helpers manifest | `eb348ab2e8bd605356855bdfd14585a21c063d1372fdc767d08efc2e451c6ac9` |
| entrypoints manifest | `443ec48c777b5e4bda3242f03c722d1d8add8435d5377ecf659c18d59624d9f8` |
| Darwin Native A 完整归档 | `e60e151edbd9676854b6010d7b5fbe26d8f9181288667eae4b69e05e8ac9cd22` |
| Darwin Native B 完整归档 | `f92119ad503ecfd294a08985c896eb861cf3cc935c02c1c65b60b0e3e7a00f5e` |
| arm64 OCI manifest | `sha256:20cd9e499c2b50c4a31299df86b59096b196ef740d6972e21206049c72fadbef` |
| arm64 image config | `sha256:1cb852f14fa765f75728de34afb0d4485327132cd4da33e94cb166656a52e8df` |
| amd64 OCI manifest | `sha256:860b531f7e2e264ba1371e9732ca8be3e8bf41a61c675d4d2617aabc70d0aef1` |
| amd64 image config | `sha256:49f676b6bc2cd19a99fc4b5692c88189010667d4a5248b23a1456d42980aba31` |

其它目标原生包与 OCI 导出归档的完整 SHA256、大小、平台和封存清单见机器证据 artifacts。

Schema signature 为 `f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c`；DDL SHA256 为 `ffa7b469ff5844fab2fc49b6046447b542f0cf6fc2a7a6dc50246ae47b501655`。58 tables、94 foreign keys、144 guards、35 explicit indexes（含自动索引共 91）。应用实际 sqlite3 addon 与 DDL 验证工具的 SQLite 版本分开记录。

镜像为本地测试构建，分别记录 OCI manifest、config、daemon image ID 和导出归档 SHA256；没有 Registry Publish，不能将本地 ID 宣称为已发布 registry digest。完整 SBOM 和原始扫描输出保存在受控证据包，机器记录提供别名与 SHA256。

## Build

Darwin ARM64 使用官方 Node `22.23.5`、pnpm `8.3.1`、两个独立 Git archive、独立 source/home/tmp、锁文件安装、正式 `build:v2` 等效脚本、production prune 与 rebuild；未使用开发 checkout 的 node_modules 或用户环境秘密。两次构建逐项校验 624 个后端文件、227 个前端文件、8 个 helper、4 个入口文件，全部字节相同。原生 sqlite3 在 prune 后及打包后都真实打开内存库、查询并关闭。

发行全量清单比较 25,021 个文件/目录/链接项，其中 20,947 个普通文件、953 个内部相对 symlink。完整发行包 **不是 bit-for-bit reproducible**：25 处差异分别为 23 个 PNPM bin wrapper 的独立 source 绝对路径、`.modules.yaml` 的 `prunedAt`、UMI 构建日志。所有编译文件及其余依赖字节一致；未忽略未知差异。原生 AMD64 双构建同样区分编译输出和完整包，详情见机器清单。bin wrapper 带有构建 source 路径，这也是未来独立可重定位封包需处理的局限；没有在已测包上事后归一化。归档重新读回比对完整清单；输入发行根未被封包器修改。

Darwin 与 Linux 前端有 67 个 gzip 文件仅 header 第 9 offset 的 OS byte 不同（Darwin `0x13`、Linux `0x03`），压缩 payload/trailer、解压内容及其余资源一致；不是笼统忽略跨平台差异。624 个后端文件完全相同。精确模块图与输出哈希证明 v2 没有自动引入旧全局 Layout/HTTP 依赖图；该结论不覆盖独立复制的 Monaco vendor 文件。

Darwin 产物采取内容封存、编译目录只读及测试前后清单检查；这是同用户可校验封存，不宣称抵御拥有者修改。Linux 部署另外使用 root 持有只读 App、非 root 进程和容器 read-only mount。

构建使用 `SOURCE_DATE_EPOCH=1794646336`（实际 RC10 commit 时间）。官方 Node22.23.5 工具归档附带 npm 10.9.9，Node24.22.3 工具归档附带 npm 11.19.1；正式依赖安装/构建仍使用 pnpm8.3.1，没有把未使用的 npm 版本当作构建器。Docker base index digest 固定，apt 解析包清单有实际记录，但没有冻结到 apt snapshot，也未宣称整个 OCI image 层两次可复现。

实际应用认证版本为 Node `22.23.5` / `24.22.3`。engines 为 `>=22.23.5 <23 || >=24.22.3 <25`；Node 26 未作为后端认证目标，未来 patch 也未自动取得本轮资格。

## Linux

| 目标 | 执行身份 | 最终事实 |
| --- | --- | --- |
| AMD64 Native | HOST_NATIVE_PRIVATE_MOUNT_NAMESPACE / x86_64 | Node22/24 各 19+perf1 PASS；完整 cold-B DR 两整组 FAIL / BLOCKED_NETWORK |
| ARM64 Native | VM_ARM64 / VZ / aarch64 | 19+19+perf1+DR1=40/40 PASS；A/B 原八任务与 cold0 验证 |
| AMD64 Docker | NATIVE_AMD64_ISA / Docker | 默认入口/重启、19+perf1、完整八任务 DR PASS |
| ARM64 Docker | VM_ARM64_DOCKER_NATIVE_ISA | 默认入口/重启、19+perf1+DR1 PASS |

AMD64 使用已授权的隔离 Debian 11 主机，真实 x86_64 / glibc 2.31；原生 addon 在该目标用精确 fork 源码重新编译，未把要求 GLIBC 2.33 的 Docker prebuilt 当作可用。原生应用运行在短命独立 mount namespace 中，只有该 namespace 的 `/tmp` 为 64 MiB tmpfs；宿主 mountinfo、原 `/tmp` identity 前后不变，进程实际 UID 10001 / capabilities 清空。它属于 host native，不是 Docker 或 QEMU。

ARM64 Native 使用新建 VZ VM，Ubuntu 24.04.5、kernel 6.8.0-147、glibc 2.39、4 CPU / 6 GiB / 32 GiB、无宿主共享目录、无 Rosetta / SSH agent forwarding。ARM64 Docker 运行于既有原生 ARM VZ VM 的隔离任务容器；不把容器与独立 Native VM 混为同一结果。未认证 musl/Alpine。AMD64 的 glibc 2.31 结论依赖该目标源码重编译的 addon；ARM64 包只在 glibc 2.39 实测，不能据 AMD64 推导 ARM64 更老 glibc 兼容。

Linux 实测覆盖锁/lease、controller/child 信号与 FD、原子发布、文件 ownership、main/WAL/SHM 预检、Git dirty/staged/untracked 保留和未知目录拒绝。逐项以对应实际用例为依据，不从 Darwin 单独外推 Linux 行为。

## Docker

| 架构 | 应用矩阵 | 真实完整 DR | 生产入口 |
| --- | --- | --- | --- |
| AMD64 | 19/19 + perf1/1 PASS | PASS | PASS |
| ARM64 | 19/19 + perf1/1 PASS | PASS 1/1 | PASS 两次 healthy、正常 stop、历史保留 |

自动 restart policy 来自 Compose 配置；普通资格以受控显式 stop/独立 restart 验证，没有将配置声明伪称自动重启故障演练。活动浏览器停止的未闭合观察另见 Risks。

正式入口为 `tini` → release-v2 entrypoint → 编译后 App；健康检查由 Docker Engine 实际达到 healthy，非仅调用一个函数。真实 HTTP 初始化、LOCAL Task/Run、独立重启及状态保存、SIGTERM 正常退出均分别记录。空根须显式初始化，不兼容根拒绝自动清理/迁移。

App 使用 UID/GID `10001:10001`、cap-drop ALL、no-new-privileges、read-only rootfs；`/data`、`/backup`、`/scratch` 为独立持久卷。`TMPDIR=/scratch/tmp` 需要数据库预检副本物理空间加至少 2 GiB 余量，不能用小 tmpfs 取代；`/tmp` 另配 64 MiB 可执行 tmpfs，供真实 tsx 正常运行。没有 privileged 产品容器；专用 BuildKit builder 属于测试构建工具边界。

| 默认入口负例 | 实际退出 | 整个父域保持原样 |
|---|---:|---|
| existing-v9 | 1 | True |
| unknown-nonempty | 1 | True |
| wrong-schema-signature | 1 | True |
| readonly-data | 1 | True |
| insufficient-permissions | 1 | True |
| root-symlink | 1 | True |
| root-ownership-mismatch | 1 | True |
| owner-marker-mismatch | 1 | True |

八例全部使用真正默认 Tini/UID10001 入口，没有人为调用一个 guard 代替启动。只读负例还在恢复 RW 后完成真实 Task；PENDING restore 所有者错误属于独立第八例。

任意脚本执行的信任边界是可信管理员管理的脚本。非 root 与 capabilities 限制不等于不可信多租户强隔离沙箱。镜像未因扫描程序 exit 0 获得安全 PASS。

## Managed Runtime

最终 S5 真实受管 Python `3.13.15`、Node `24.22.3`、npm `11.19.1`、tsx `4.20.6`；Shell 使用 `/bin/sh`。应用 Node 与受管 Node 为不同身份。历史源组件用例的旧版本 pin 另列为组件兼容性范围，不作为安全版本认证。

| 发行环境 | App Node | A / 独立 cold-B / 原八任务 |
| --- | --- | --- |
| AMD64 Docker | 22.23.5 | 整组 PASS，A 与 B 各八组合成功 |
| ARM64 Docker | 22.23.5 | 整组 PASS，A 与 B 各八组合成功 |
| ARM64 Native VM | 22.23.5 | 整组 PASS，A65366 / B84257、Bcache0 |
| AMD64 Native | 24.22.3 | BLOCKED_NETWORK：首轮 A 八组合成功并销毁；B 已恢复且 cold0，但新 provider8 GitHub GnuTLS(-54)/curl56失败。第二完整 fresh attempt 在 A provider1 同类 exit128，B未启动。 |

NativeAMD 没有完成 B 运行原八任务，不能用成功 A、DockerAMD 或 ARM 的结果代替该目标资格。两次失败均保留独立 root/key/cache、真实 operation stderr 与未到达阶段；不第三次无限外网重试。

实际八组合为 LOCAL/GIT × Python/JavaScript/TypeScript/Shell，通过真实 TaskService、Workspace lease、Runner、TaskRun、Attempt 和日志完成。B 的 runtime cache 开始为零，独立重建后执行原八个 Task ID；不使用 A 源码目录、存活进程/FD 或 host runtime fallback。正常构建缓存复用另有来源、哈希和复用范围，不能与冷 B 恢复混计。

## Browser

| 浏览器引擎 | 实际版本 | 原完整组 | 额外真实 UI→COMPLETE / 独立 PID 持久性 |
|---|---|---|---|
| webkit | 27.2 | 7/7 PASS | 1/1 PASS |
| chromium | 159.0.8154.6 | 7/7 PASS | 1/1 PASS |
| firefox | 159.0 | 7/7 PASS | 1/1 PASS |

原 Node40 + Browser21 = 61 项，另加三个新工具独立执行的完整恢复用例；新用例不反填旧 7 项的 PENDING 终点。均为真实 Linux native ARM 指令集上的引擎；浏览器 SDK 1.65.1 为工具，App 为真实 Node22.23.5。

三个补充用例共同使用运行前 SHA 封存的 private driver `adbcdf31fe4068777ca6fe6e32547c503d7e41b98e5572ffb663f74b8b26fcd4`：UI 加密导出/导入/预览/确认 → 真生产 CLI 同 PID 正常 close/launch → API 与 UI 显示 COMPLETE → 关闭浏览器 context → SIGTERM exit0 → 新独立 CLI PID 同根启动 → 同浏览器新 context 登录、确认 COMPLETE/原源码/Task/Run/Attempt/log、备份后 Run404 → 原 Task 从 UI 再执行 SUCCESS。最后关闭 context 再正常停止。

关闭 context 是该补充资格的明确前置条件。早期保持活动 WebKit context 的 SIGTERM 曾超过 30 秒而失败；另一次只发送一次 SIGTERM 的诊断中，CLI 在 83.687 ms 退出，context 在 83.766 ms 后才开始关闭，未复现旧阻塞，不能据此认定根因或宣布已修。原失败作为独立未闭合运行风险保留，不由三项新 PASS 覆盖。

使用生产 v2 前端、真实后端与 API、真实 Git 及受管运行环境；没有拦截 Workspace/Run/Sync/Discovery/Runtime/Backup API。既有三引擎各 7 项覆盖登录/退出与会话、LOCAL 编辑和 CAS409、GIT 同步/Discovery/事件执行、资源与 SET/UNSET/ATTACH/MASK、参数、双语及加密备份导出/导入/预览/确认 staging。该组恢复断言终点为 PENDING，不能作为浏览器观察到 durable COMPLETE 的证据；完整恢复由真实 Node/CLI 及独立 A→B 灾备另证。三引擎额外的真实 CLI 重启后 COMPLETE 补测结果单独列出，不回写或扩大原 7 项范围。

WebKit 早期两例真实 pointerdown/up 落点受到弹窗 opening scale 动画影响。修复仅等待真实动画和 transform 稳定，再使用普通 click；未 force-click、禁用动画、固定 sleep 或删除断言。旧失败与私有诊断分开保留，最终三引擎均重新整组执行。

## Security

RC10 安全发布门禁结论为 **NO**，`waivers=[]`。候选 `b814fb428b1c307645c6df438f2d0dc4eab1a2e3`，Tree `cdf6ffb3b4b9d12e68f27f96b0983df13e957342`，源码归档 SHA256 `8ab8e905bf1191fceed7e3b6cb8e4a2c30e084cd798d1da055b240edcb23676d`。

精确候选已重新执行源码、两个正式镜像、Darwin 产物和实际冷恢复运行卷扫描。Full pnpm audit 保留5 HIGH/0 CRITICAL；production 为0 HIGH/CRITICAL。正式 pruned Darwin 图408包，剩余 dev HIGH affected versions 未进入生产图；227个前端资产的准确模块归因排除了旧 axios/path-to-regexp 等。许可证仍有 tween-one1.2.7 一项 UNKNOWN。源码 Gitleaks212个 redacted findings 已按位置/hash 归类，未确认真实外部凭据；当前 tracked tree 扫描不覆盖历史或用户 DATA。

两个正式镜像各有 OS6 CRITICAL/342 HIGH、Node15 MEDIUM/0 HIGH/CRITICAL。MiniZip 和 kernel-header 相关命中仅作有实际 payload 证据的局部不适用分类；150项其余 nonheader OS HIGH 仍 UNKNOWN/BLOCKED。实际 Git SSH 客户端9.2p1+deb12u10仍受 host-key reexchange UAF 影响；host pinning、禁 Proxy/agent 和 -F 配置不足以证明该生命周期路径不可达。[Debian](https://security-tracker.debian.org/tracker/CVE-2026-60002)，[OpenSSH修复](https://www.openssh.org/releasenotes.html#10.4p1)。

App 实际加载的 SQLite core 为3.41.1，分别以 Darwin/Native 和两架构镜像真实 open/query/close 及 driver hash 确认。可信整 catalog 先验与固定/绑定参数 SQL 限制了已记录 arbitrary-SQL 及 FTS 消费者条件，但旧 core 未修，通用畸形数据库/parser 安全仍 UNKNOWN/BLOCKED。Node 内置3.54.1、Debian 系统3.40.1和 App addon3.41.1是独立组件。最小后续方案需保留 @whyour fork 生命周期/API/平台补丁，受控替换官方安全 core 并对所有目标强制 native 重编译，完整验证 WAL、FD、schema、备份与恢复。[SQLite公告](https://security-tracker.debian.org/tracker/CVE-2025-7458)。

运行卷是独立范围。最终 cold-B 实际16,265文件/568,709,280字节在扫描前后 hash 及 inode 不变。显式 installed-JavaScript cataloger 识别 npm11.19.1及 bundled 依赖后，Syft216组件的 SBOM 扫描新增 npm6 HIGH/12 MEDIUM/1 LOW、Go1 CRITICAL/25 HIGH/30 MEDIUM/3 LOW/2 UNKNOWN。npm 内 undici6.28.0 的 node-gyp 下载消费者、brace-expansion5.0.9 的 minimatch 消费者真实存在；tsx/esbuild0.25.12的实际 LinuxARM 二进制包含 Go1.23.12。Go critical 公告要求 TLS 恢复握手跨 CA 配置变更，未证明当前全部语义路径均满足或均不存在，保留 UNKNOWN/BLOCKED。应固定经实际 bundle 核验的 patched npm、tsx/esbuild/Go 工具链并重新冷构建/DR。[Go原始公告](https://pkg.go.dev/vuln/GO-2026-4337)。

CI pnpm8.3.1另有13 HIGH；archive/manifest 语义 UNKNOWN。8.6.8已有同 major 历史 tar 修复，当前8.3.1是声明而非不可修改 S0 合同；下一候选应固定维护中的兼容 manager 并验证 v6 锁格式。5 dev HIGH 中，path2已排除生产图，SerializeJavascript仅用于 cache/hash 无公告执行 sink，Vite 两个 launch-editor 公告要求 Windows；Zod build-input 语义仍 UNKNOWN。

镜像 secrets 另在两个已核验归档实际执行 Trivy secret+image-config secret：106内置规则、显式禁所有 path skip 及13全局 allow 规则，均 exit0/0发现。工具保留 lower-layer 已删除文件的匹配；规则局部 allow、普通 binary 及短文件限制仍存在，不能宣称所有 secret 不存在。源码 Gitleaks 与镜像 secrets 范围独立。

真实 compiled SMTP 在 Node22.23.5/24.22.3六例通过。独立 NativeARM 正式19+19+性能1+全8任务 A毁/B冷重建DR1共40/40通过，旧诊断未计入；4语言×LOCAL/GIT共8原 TaskID 均真实执行。功能通过不豁免安全门禁。性能为有界短样本、指定进程 scope，不主张生产 SLO/长期无泄漏；全发行包不宣称 bit-for-bit 重现。原始工具输出、版本、命令、退出码、时间与 SHA 保留私有，public 包只做已记录路径标准化与安全字段选择。

身份/授权验证覆盖 session 撤销、伪造 Bearer、Cookie-only、CSRF/Origin、跨 workspace 资源引用与下载/日志边界。public origin 必须是显式规范 http/https origin；wildcard bind 在写根目录前要求该配置，未信任代理头。具体动态结论限实际用例，不能由静态检查代替。

数据库 admission 顺序已修正为先验证可信冻结的完整 sqlite_schema catalog，再读取命名 metadata、执行完整性检查；未知对象（包括非规范 view/table）拒绝且原 main/WAL/SHM 与父目录 native identity 不变。该缓解不等于旧 SQLite core 已修补。v9 入口同样在应用写入与初始化之前做原库只读复制及可信 catalog 检查。

Undici 使用不自动重定向的实际请求路径，通知传输验证 307 不访问第二服务、响应容量与超时限制。真实 SMTP 补验证为编译 NotifyService → 受控 loopback SMTP，双应用 Node 共六例；没有使用真实外部邮箱配置或凭据。

## Reliability

AMD64 与修正 source-only 工具前提后的 ARM64 各完整 S3 81/81，其中各 14 个真实 SIGKILL checkpoint 有 killed signal / 不同恢复 PID / raw hash。初轮 ARM79/81 未到 FETCH/CHECKOUT，已实证是 frozen worker descendants() 所需 ps 缺失；只在独立 SOURCE_TOOL_ONLY 派生镜像添加 procps，624 后端/227 前端、Node binary 与 sqlite addon 字节/权限不变后，原完整 81 全新运行。生产镜像身份没有改变。S1.B 原完整36包含独立恢复阶段 SIGKILL；S5 通知发送中途 SIGKILL 另计。

S4 required CLI restart 用例在正常停机 active Run CANCELLED 后失败，后续该用例的 Cron/scheduler 断言未执行；其它已执行 scheduler/outbox 用例不能替代这一个必需完整回归门禁。

使用真实进程信号与独立恢复 controller，不将 throw 当作 SIGKILL。S3 的 14 个 checkpoint 与 S4 通知发送中途 SIGKILL 分开计数。恢复必须无 false SUCCESS、重复 Run、提前释放 writer lease、丢失唯一源码或遗留配置秘密；以实际断言/恢复 identity 为依据。

| 资源故障 | 资格结果 | 实际故障 / 恢复 |
|---|---|---|
| `S5-FAULT-ENOSPC` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-EMFILE` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-EACCES` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-EAGAIN` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-OFFLINE` | PASS | actual_fault_run_status=FAILED |
| `S5-FAULT-NETWORK-TIMEOUT` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-GIT-REMOTE-UNAVAILABLE` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-READONLY-FILESYSTEM` | PASS | actual_fault_run_status=FAILED；actual_recovery_run_status=SUCCESS |
| `S5-FAULT-BACKUP-SPACE` | PASS | actual_failed_backup_status=FAILED；public_error_code=BACKUP_OPERATION_FAILED |
| `S5-FAULT-BACKUP-SPACE-RW-RECOVERY` | PASS | actual_recovery_run_status=SUCCESS；actual_recovery_snapshot_status=SUCCESS |
| `S5-FAULT-RUNTIME-DOWNLOAD-INTERRUPTED` | PASS | actual_recovery_run_status=SUCCESS；actual_interrupted_operation_status=FAILED；state_while_interrupted=ERROR；actual_repair_status=SUCCESS；actual_repaired_runtime_state=READY；partial_archive_bytes_observed=4096；official_node_version=24.22.3 |

真实 Task 子进程的 RLIMIT_NOFILE32 触发 EMFILE，不代表主 App Node FD 已耗尽；pids64 cgroup 内最多 64 次有界创建后回收只属于测试的子进程。ENOSPC 限自有 32/64 MiB tmpfs；offline Git 是真实 Task 中 Git 命令，不扩称公共 Git URL 校验资格。下载中断为官方 Node 24.22.3 实际收到 4096 字节后断开该容器 bridge，验证 ERROR/非 READY，再重连 repair 至 READY。

独立真实配额测试在全新 Native ARM VM 的 128 MiB loop ext4 内设置 8 MiB project quota，UID10001 在写入 8,384,512 字节后得到 `errno=122 (EDQUOT)`，删文件后恢复写入成功；finally 验证 mount、loop association、镜像文件均消失。其范围是 Linux 文件系统资源故障，不宣称 App Task/Backup 已遇到 EDQUOT。首次因云镜像缺 quota 模块而 mount 失败，原始失败保留；仅在一次性 VM 加载与正在运行内核一致、经官方 apt 索引/归档 SHA 校验的 quota 模块后重新执行。

## Performance

ARM64 Docker 的有界 Shell workload 为 4 Workspace / 4 Task / 8 Run，102 个测量请求全部成功。以下为该次实际样本，不与其它环境作速度排名：

| 操作 | N | p50 ms | p95 ms | p99 |
|---|---:|---:|---:|---|
| workspace_create | 4 | 90.25 | 106.03 | null |
| file_create | 4 | 51.82 | 66.15 | null |
| task_create | 4 | 49.23 | 61.86 | null |
| file_read | 21 | 32.21 | 38.75 | null |
| file_save | 20 | 67.06 | 88.69 | null |
| file_tree | 20 | 31.26 | 37.31 | null |
| file_search | 20 | 29.85 | 35.48 | null |
| task_submission | 8 | 44.38 | 69.58 | null |
| backup_submission | 1 | 22.44 | 22.44 | null |
| backup_complete | 1 | 344.67 | 344.67 | null |

同次 App + test controller（不含 children）采样 peak RSS 250,028,032 B，CPU user/system 2,391,317/1,617,503 μs，FD before/after 27/30；磁盘 logical/allocated 1,619,729/1,777,664 B。这个短样本的 FD 增量不能证明长期泄漏或无泄漏。完整 DR 另有 10 个操作的真实 runtime provision、backup/export/import、whole-root restore、rebuild、A/B 执行时长、250 ms 目录使用量采样峰值与各自 controller CPU/RSS/FD，保留精确范围。

Darwin 功能启动观测（不是静默冷启动 benchmark）：Node22 cold/restart 各 N1 = 2867.405/2908.463 ms；Node24 = 3141.801/3871.062 ms。post-exit 已验证 DB 克隆的 Task 墙钟 N8：Node22 queue p50/p95=630/1130 ms、run lifetime=575/650 ms；Node24 queue=634/996 ms、run lifetime=555/645 ms。它们不是单调时钟内部 scheduler 分段精度。

另外独立 compiled REAL_HTTP/REAL_GIT probe：3 次 sync 的提交至观察终态为 initial 5052.27 / update 9384.62 / no-change 2800.76 ms，提交 API 为 93.07 / 88.98 / 86.42 ms；Discovery preview/apply API 为 773.08 / 732.22 ms。真实持久 outbox created→dispatched 为 initial 空计划 130 ms、remote-update 单任务计划 261 ms，不能混为同一负载。remote-update 提交至观察 dispatch 9642.37 ms、至观察 Task terminal 10730.04 ms，包含 50 ms polling/HTTP/调度开销。原三浏览器记录没有这些独立时刻；新 probe 不反填原 61 项。

独立真实 CLI 负载补测通过：257 文件树；4 Workspace、4 Task、8 次 Run，每次生成 20,001 行、实际日志文件各 1,180,050 B；4 个 Run 正在 RUNNING 时提交备份并成功，8 次执行全部 SUCCESS / 单 Attempt，独立新 PID 重启后历史及文件树保留。样本有界，没有以这组数据承诺生产规模或长时稳定性。

没有事先定义的延迟 SLO，不在事后创造阈值换取 PASS。N<100 时不提供有统计意义的 p99；未观测到 WAL 时记录 null 与原因，不记为零。CPU/RSS/FD/磁盘指标区分被测 App、其子进程、容器与 VM；受控协调采样不宣称整个物理开发机绝对空闲。短时有界负载不能证明长时无泄漏或生产容量。

## Upgrade / Rollback

实际候选 A 为存在的 S4 提交 `f765689d...` 独立重新构建的发行包（不是虚构旧已发布版本），B 为 RC10；A 的历史依赖只用于一次性 loopback 演练。四个不同真实 CLI controller 完成：A 初始化/Task/加密备份 → 停止 → B 启动验证原状态/执行原任务/编辑源码 → 停止 → A 代码回滚在 B 写入数据库上启动/保留新源码与历史/执行任务 → 完整备份恢复 → B 独立重启验证恢复状态并执行任务。整组 PASS。

明确区分：代码回滚保留 B 写入状态，不自动还原用户源码；整根备份恢复替换 inode、还原备份时用户源码/历史，并移除备份之后的 Run。未降低 Schema 版本。直接回滚结论仅限这两个实际共享冻结 S0 schema 的候选，未承诺未来任意 schema 可降级。

同 RC10 默认 v9 的独立源码生产构建与真实入口 HTTP 正向链已通过：fresh v9 初始化、登录、正常停止、独立新 PID 重启后保留 initialized 状态。该构建有真正的 v9 frontend，不能把仅带 dist-v2 的 v2 发行包说成也包含旧 UI。反向隔离由双 Node 的实际 v9 entry/direct app 拒绝 v2/unknown/corrupt 根，以及 v2 默认入口拒绝 genuine v9 证明；原父域身份/内容未变。

项目采用 fresh-v2。v9 与 v2 使用各自独立数据根和入口；不连接、迁移或清理真实 v9 用户数据。真实用户搬迁需要独立迁移项目设计与验收。

## Regression

| 最终 RC10 实际回归 | 结果 | 范围 / 限制 |
|---|---|---|
| S1.A | 68/68 PASS | Linux AMD64 完整新命令 |
| S2 | 112/112 PASS | Linux AMD64 完整新命令，原 provider 网络失败另留历史 |
| S1.B Darwin | 36/36 PASS | 包括真实受限 HFS 文件系统、完整 A→B 与恢复 SIGKILL |
| S1.B Linux AMD64 | 35/36，exit1 | 原 hdiutil/HFS 用例显式抛 `S1B_BOUNDED_VOLUME_IMPLEMENTATION_REQUIRED_ON_THIS_PLATFORM`，没有到达该用例的 ENOSPC；Linux 独立故障与发行灾备另列，不能声称此原 suite 全绿 |
| S3 AMD64 | 81/81 PASS | 包含 14 真实 SIGKILL / 独立恢复 |
| S3 ARM64 | 81/81 PASS | 初轮 79/81 原因是 source-only 工具镜像缺 ps；补 procps 后原完整 81 全新重跑，产品字节与生产镜像身份未变 |
| S4 原完整命令 | 57/58，exit1 | 唯一 Runtime provider 安装遇真实 GitHub GnuTLS(-110)，未进入该用例的后续 Python/Task 阶段 |
| S4 第二完整命令 | 57/58，exit1 | 该 Runtime 用例本次 PASS；CLI restart 用例实际 RUNNING→清洁 SIGTERM 协调 CANCELLED，而用例 poll/最终谓词排除 CANCELLED，后续 Cron/scheduler 断言未执行 |
| Related v9 | 210/210 PASS | 同 RC10 独立完整命令 |
| Additional v9/security | 44/44 PASS | 同 RC10 独立完整命令，包括实际默认 Nodemailer 对象拦截修正后的测试 |
| S0 DDL | 86/86 | 本轮实际内存库执行 |
| S0 structural | 3068 当前检查 | 另 5 条历史入场事实不计 PASS |

**S4 必需完整回归仍为 FAIL。** 两次不同的 57/58 不能拼成 58/58。`TaskExecutionService.close` 的逐 runner.cancel / await done 行为及状态映射在 S2、S4、RC10 相同；未证实是 S5 新增核心回归。S0 active 协调 cancel 的合法分支与 dead-owner/ghost 的 INTERRUPTED 恢复必须区分，且冻结合同没有把所有正常停机都明定为用户 cancel intent。不能在本轮擅自改冻结合同或只放宽终态。最小后续方案是明确正常停机策略，并分别确定性验证真 QUEUED 保持同 ID 与 active 协调停机，再形成一个完整新的验收结果。

构建与 typecheck 的具体命令/退出码列机器构建记录；Backend/Frontend v2 的独立生产双构建与 v9 的独立真实 production 构建不以历史 PASS 替代。

S0 当前重新执行 3,068 个结构检查与 86 个内存 DDL 用例。验证器保留的另 5 条 S0 入场事实明确标为 HISTORICAL，不计当前执行成功；没有改写历史 ddl-validation 或其它阶段 receipt。

Linux 原始 S1.B 包含一个 Darwin hdiutil/HFS 专用例，不能将其在 Linux 上的失败或未运行改名为通过。最终同一 RC10 的 Darwin 整组真实 36/36 通过；Linux 另有实际受限文件系统、完整原生/Docker 灾备和对应资源故障覆盖。每组执行环境与 scope 单独记录。

## Release Risks

| 级别 / 范围 | 未闭合事项 |
|---|---|
| Critical/High，真实依赖/协议消费者 | OpenSSH client host-key reexchange UAF；App 内嵌 SQLite3.41.1 通用 parser 风险尚未闭合 |
| High，OS | 两镜像各 150 条 nonheader OS HIGH 的消费者/触发面仍 UNKNOWN，未豁免 |
| High，构建链 | pnpm8.3.1 的 archive/manifest 风险、Zod builder 路径未完成安全闭合；dev HIGH 不在 pruned runtime 不等于构建链安全 |
| Critical/High，真实安装卷 | 实际 npm bundled 依赖 6 HIGH，以及 esbuild 所带 Go1.23.12 的 1 CRITICAL / 25 HIGH，语义可达性保留 UNKNOWN/BLOCKED |
| 未闭合运行观察 | 活动 WebKit context 下 SIGTERM 一次超过 30 秒，后续单次 83.687 ms 未复现；没有确定原因或已修证明 |
| Medium / Known limitations | tween-one1.2.7 精确许可证 UNKNOWN；完整发行包存在路径/日志/时间差异，bin wrapper 携带构建路径；原生 glibc 与容器/Node 的资格范围按具体目标限定 |

外部 provider/GitHub TLS/RPC 下载失败按真实操作阶段单列。若最终必需流程仍因网络无法完成，继续列 BLOCKED/FAILED；后续诊断或已通过的 A 阶段不能替代完整新组。

未批准任何 `WAIVED_WITH_RISK`。安全修复建议属于下一候选的待办，不能当成本轮已实施缓解。未验证的 OS/架构/Node patch、musl、广域网/大规模长时负载及未来 schema 降级不在认证范围。

## Candidate History

| 候选 | 实际停止/重建原因 | 最终 RC10 是否继承旧 PASS |
|---|---|---|
| RC1 `93059d16` | 更新 Undici 后旧 maxRedirections 参数不兼容，构建暴露 | 否 |
| RC2 `d8414bde` | 打包 contracts 测试 factory 缺 artifactRoot | 否 |
| RC3 `5974bf5b` | prune 后原生 addon 缺失，增加实际 rebuild/load gate | 否 |
| RC4 `4f06d7d1` | 私有构建调用了 pnpm8 不支持的 rebuild --prod | 否 |
| RC5 `60e2feb1` | CLI 测试使用 /logs 而冻结合同为 /log | 否 |
| RC6 `110a7dfc` | 性能工具 hash/tree/status 与实际合同失配；后续安全/catalog 修复形成新候选 | 否 |
| RC7 `594e84b0` | WebKit 两项弹窗动画落点失败 | 否 |
| RC8 `f6d40b4f` | 完整 DR 测试只接受200，实际异步202；私有完整诊断不计正式通过 | 否 |
| RC9 `6375ac01` | 旧通知测试替换 namespace，而生产实际调用 default 导出；新 test-only 提交修正绑定 | 否 |
| RC10 `b814fb42` | 全部正式结果绑定最终 SHA/产物；安全阻断保持 NO | 当前 |

另外保留：测试 PID1 缺 init、/tmp tmpfs 漏挂、只读 fixture 权限、NODE_PATH/Node24 TAP 解析、下载网络失败、旧 scratch 空间不足、归档 epoch 参数错误等工具/环境失败。没有将修正过私有测试输入的诊断结果计入冻结候选。旧 Docker 构建因候选替换取消，记录 SUPERSEDED_CANCEL 而非产品 FAIL。

## Deployment / Recovery Material

候选包含 `Dockerfile.v2`、`compose.v2.example.yaml`、release-v2 entrypoint/healthcheck、编译 Backend/Frontend/Helpers、lockfile、原生 addon、许可证及受控发行归档。当前安全资格 **未通过，不建议生产部署此候选**。

部署示例要求本地已构建精确镜像，设置 `ZHIXU_V2_IMAGE` 与精确的 `ZHIXU_V2_PUBLIC_ORIGIN`，使用独立新 named volumes。首次显式 `--initialize`，停止该实例后才正常 `up --pull never`；不得复用 v9 数据卷。compose 已给出 loopback 端口、UID、read-only、tmpfs、持久目录、CPU/内存/FD/pids、日志轮转及停止宽限配置。

需要物理临时空间容纳数据库只读副本并再留 2 GiB；32 GiB 为复制预算上限，不能当作足够的整机磁盘推荐。受管 Python 源码构建、Node 环境、完整备份和恢复候选同时占用额外空间，实际峰值另见性能记录。备份目录必须独立可写且空间充足；备份/加密导出完成和验证后才进行受控升级。恢复须观察 durable COMPLETE，之后重新认证/检查原 Task/历史/源码和受管 runtime；备份恢复与仅回滚程序分开执行。

Runtime provider 需要访问官方 Node/Python 与包源；Git 需要目标远端网络与明确凭据配置。本轮临时构建代理仅属于私有隔离工具环境，没有更改用户的外部服务或全局 Docker/SSH/TLS 设置。网络、provider、checksum、兼容性和应用错误分别记账，不用无限超时掩盖失败。

## Evidence / Cleanup

公开机器证据：`tests/workspace-v2/s5-validation-results.json`。原始命令、退出码、case IDs、预期/实际结果、环境/Node/browser/image/runtime identity、SIGKILL checkpoint/recovery、性能、初始失败/重试和门禁均按组关联最终候选。公开文件仅使用相对证据别名/摘要/哈希；私有机器地址、完整用户路径、认证材料、会话 token 和原始秘密内容不进入仓库。

受控私有索引关联实际保留文件和 SHA256；使用流式 SHA256 与归档内容读回验证。保留的封存发行包与审阅证据属于有意交付文件，和测试机运行残留分开记账。

现场清理已实际完成：按唯一 nonce、dev/inode、Docker label/exact ID 与进程身份核验后移除本轮拥有的 runner 目录、进程、容器、卷、镜像与 builder；原 AMD64 两容器和 Colima 用户容器保持原运行状态。新 VZ VM、其唯一 LIMA_HOME、确切新增缓存项与提取容器已删除。没有全局 prune/kill 或清理用户 DATA_DIR。逐项数量、例外保留的用户资源及清理证明 SHA256 见机器 cleanup。受控审阅材料已先完整搬离并逐 SHA/归档读回验证。保留 1 个无法证明归属的共享 moby/buildkit image：它没有本轮 owner label 或本轮 builder/container 引用，未猜测删除；另 8 个早于本轮创建的非 owned volume 保留。不能将 owned 清零扩称整个共享 daemon 回到唯一 image 初态。另有 7 个 Browser 本机场景及 5 个 Root 本机场景已先归档、逐 SHA/lsof/identity 核验后移除；共享 Node 工具和独立构建材料明确作为复核材料保留，不宣称全 /tmp 清空。

## Git

本轮共 10 个代码/测试本地提交，完整身份如下；承载此报告和机器记录的后续本地提交另在最终交付中给出。

| Commit | 内容 |
|---|---|
| `93059d163017fb6b5e9f8164ed586fea615cc6f7` | fix(v2): prepare isolated release candidate and security qualification |
| `d8414bde4da84dca51e8f09af6622365f676e161` | fix(v2): retain notification transport boundaries with patched Undici |
| `5974bf5b650d0e1a5b08aab05156e8ab50d66164` | test(v2): bind compiled qualification factories to packaged contracts |
| `4f06d7d101546d73d2b7a17ed9d2e96531f077df` | fix(v2): secure Node baseline and release startup admission |
| `60e2feb151918fd4980555b677ea3d7f21de2ff3` | fix(build): rebuild pruned dependencies with the pinned pnpm CLI |
| `110a7dfc9ef9182bd10fd6a1c32ca4f74ed4c6e2` | test: use frozen task run log route in release qualification |
| `594e84b07d7e123cb6262ac2d341ad5329afac6e` | fix(v2): validate database catalogs before reads and isolate release dependencies |
| `f6d40b4f62a89b200db695aa21ed415899a724d5` | test(v2): await actual dialog opening before browser pointer actions |
| `6375ac013d2db005a04b3d8dcb0a3cd6c639a049` | test(v2): accept asynchronous HTTP admission in disaster qualification |
| `b814fb428b1c307645c6df438f2d0dc4eab1a2e3` | test: intercept the active Nodemailer export in notification regression |

GitNexus 原始 compare against entry 输出 113 changed symbols / 25 affected / 54 files、CRITICAL；against develop 为 368 / 112 / 180、CRITICAL。两次 detect 的 partial/truncated 为 false，且这些输出无 NUL 字段。文件计数包含用户原有未提交 `.gitignore`；代码 diff 不将其归为本轮修改。源码/方法修改前已进行 impact、对高风险先告知，最终文档提交的 staged detect 另外记录。

索引本身报告流程探索预算截断；另一次 query 的 definition filePath 曾出现异常 NUL，未据其修改代码。不能把 detect 输出或缺失路径当作完整可靠调用图证明；实际静态源校验、hash 和回归另外提供。

最终文档提交前的 staged detect 为 2 files / 0 symbols、LOW，partial/truncated=false，符合实际暂存文件列表。最终 compare-develop 的两次独立读取却返回 375 / 392 个 changed symbols，出现 NUL 或损坏符号字段；这些精确数量不采信，原始输出与 SHA 留存。较早 113/368 是当时工具快照的观察值，也不作为完整图覆盖证明。该工具质量限制没有被当作源码变化或据此改代码；实际 Git 差异、工件全哈希与完整回归另证。

没有 Merge/Rebase 或切换覆盖分支，没有向项目远端 Push、创建正式 Tag、发布 Release/Registry image 或生产部署。受控 Git fixture 中用于产生提交/更新事件的本地 bare 仓库 push/tag 属于测试数据。用户 `.gitignore` 未修改、未暂存；S0 冻结工件与历史记录未改。

## Final

```text
ZHI_XU_V2_S5_RELEASE_QUALIFICATION_PASS=NO
READY_FOR_RELEASE_APPROVAL=NO
```

- `DEPENDENCY_AND_CONTAINER_SECURITY` — BLOCKED: SSH / bundled SQLite / unreviewed OS / builder chain / actual managed npm and esbuild-Go vulnerabilities unresolved
- `NATIVE_AMD64_COMPLETE_DISASTER` — BLOCKED: Two whole native Node24 A/B attempts failed at real official provider GitHub TLS/RPC; no completed B eight-task run
- `S4_COHERENT_FULL_REGRESSION` — FAIL: Two whole commands each57/58; normal-shutdown active CANCELLED vs test/contract precondition remains unresolved; never stitched into58
- `ACTIVE_BROWSER_GRACEFUL_SHUTDOWN` — BLOCKED: One active WebKit-context SIGTERM exceeded30s; single later83.687ms non-reproduction does not resolve original observation

S5 验收工作到此停止。需先处理阻断项，形成新的不可变候选并重新认证，再由人工决定发布；本轮没有授权或执行实际发布。
