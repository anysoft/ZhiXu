# ZhiXu v2.0 — Release Scope Decision

本决定由本轮用户明确授权，定义 **Refactor Release Acceptance**。它改变发布验收范围，不修改冻结S0合同、历史测试结果或安全发现。

## Release Goal

交付功能正确、数据安全、可安装运行的v2架构候选，提交人工审批。复用代码和发行内容未变的RC15资格，不重复全矩阵认证。

## Supported Installation Mode

**Fresh-v2 Only**：新数据根、新配置、新Docker项目和专属新卷。v9自动数据库迁移、原地v9→v2 Schema升级均 **NOT_SUPPORTED**。保留v9现有运行和数据，不接管、清空或覆盖旧根。

## Functional Acceptance Criteria

- LOCAL/GIT Workspace统一；Task/Execution/Managed Runtime正常。
- 创建Workspace→编辑脚本→配置Runtime→创建Task→执行→查看日志可用。
- Repository→Git Workspace→Sync→Discovery/GitUpdate→TaskRun可用，v2不依赖Subscription。
- API与Web UI接线、Node22.23.5/24.22.3、已验证Linux/Docker双架构和浏览器业务范围有效。
- 发行身份、安装配置、数据目录、备份恢复及回退边界明确。

## Required Data Safety Criteria

冻结Schema/DTO/状态合同保持；源码保全、文件CAS、Git本地修改保留、Run一致性、正常停机/崩溃恢复、Backup/Restore和v9/v2根隔离继续作为硬门槛。既有证据如显示未修复的核心未授权访问/RCE、认证绕过、凭证泄漏、非预期文件破坏、可重复恢复丢失或Git/Runtime边界绕过，仍阻止受影响范围发布。

本轮核对的既有RC15证据未记录这类尚未修复的核心直接严重缺陷；这不是全量安全审计通过或无漏洞保证。

## Deferred Security Audit

`FULL_SECURITY_AUDIT=DEFERRED`。全量CVE/传递依赖/OS包修复、完整SBOM可达性、SDK清理、全部中低危关闭和供应链全面加固转独立专项；不要求全部扫描计数清零，也不以 `UNKNOWN_BLOCKED>0` 自动拒绝本次重构发布。逐依赖文件bit-for-bit可复现不属于本次门槛。

[S5历史报告](S5_RELEASE_QUALIFICATION_REPORT.md)、[S5.R报告](S5R_REMEDIATION_REPORT.md)及原机器证据保持原样，原B1=NO和三个历史NO不改写。延期不表示漏洞已修复，不是对任意直接严重缺陷的豁免。

## Known Risks / Release Limitations

- v2内部使用已验证受控Git；环境中的旧系统Git风险仍存在。可信Shell脚本可调用系统工具，并以平台账号访问已授予的文件/网络/卷；非root/零cap不等于恶意多租户强隔离沙箱。
- OS Expat/Python/SQLite等、构建依赖及SDK旧npm按原风险清单后续处理，不描述成新的功能失败。
- Offline Runtime Requires Trusted Artifacts：独立受保护信任锚和正确平台的完整制品包必需；导入清单不能自我授权。离线PNPM及未支持的非空pip依赖闭包不在当前承诺内。
- 支持范围是已有实测的平台和精确Node版本，不外推任意未来patch、其他libc、Windows或任意降级。
- RC15是代码候选号；包内SemVer仍为 `1.0.0-rc.6`。本轮不改版本、不重建、不新造v2.0.0产物。

## Approval Boundary

新结论单独记录在[发布准备报告](V2_RELEASE_READINESS.md)和[机器记录](../../../tests/workspace-v2/v2-release-readiness.json)。`READY_FOR_RELEASE_APPROVAL=YES`仅表示可提交审批，`RELEASE_APPROVAL_GRANTED=NO`。

本轮只允许文档/非破坏性范围说明、最小检查和本地提交；不Merge/Rebase/Push/Tag/GitHub Release/Docker Publish/生产Deploy。用户批准之前不执行发布。
