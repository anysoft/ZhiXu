# 技术决策批准状态与剩余验证

产品原则为 **PRODUCT_FROZEN**，不再开放 LOCAL/GIT、统一 Workspace、取消 Subscription 等产品选项。S0 已将九项技术建议收束为 [正式 ADR](S0_DECISION_RECORD.md) 和 [可实施合同](S0_TECHNICAL_CONTRACT.md)。**TECHNICAL_CONTRACT_READY_FOR_APPROVAL ≠ APPROVED**；S1 尚未请求或获得授权。

| ID  | 收束后的候选                                                                                                                              | 状态                                                            | 下一步                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D1  | Workspaces+GitWorkspaces 共享 PK；无独立 Worktrees 业务表；SQL+Service 类型/owner/READY guards                                            | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | 人工最终批准完整 DDL/DTO                                               |
| D2  | 同 Repo/ref 多 Workspace，共享 bare、独占 checkout/private branch/lease/执行配置                                                          | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S1/S3 并发与故障验证                                                   |
| D3  | MVP 排他执行；TaskRuns 唯一 queue；Task policy 与 wait_mode 分层；期限/cap/misfire/cancel/restart/source supersession 完整                | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S1 容量参数、S2 真实 queue/FD/child 资格；snapshot/overlay 另 ADR      |
| D4  | 单选同 Workspace Profile；System/Global/Profile/Task 合并；Task Runtime override；Workspace Config ATTACH→Task ATTACH/MASK；Hooks 仅 Task | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S2 跨 owner/秘密/版本/pin 验证                                         |
| D5  | 独立 fresh-v2 identity/signature；四类数据根启动；未知或损坏拒绝，不升级/清空                                                             | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S1 目标 SQLite/driver 能力与真实启动验证                               |
| D6  | 文件/Workspace/搜索/inventory/备份/临时磁盘/队列限额类型、单位、检查点冻结                                                                | 类型 TECHNICAL_CONTRACT_READY_FOR_APPROVAL；数字 DEFERRED_TO_S1 | Execution 合同候选默认须容量实测；不阻其他合同批准                     |
| D7  | WorkspaceDiscoverySuppressions；MANUAL/DISCOVERED/RETIRED/IGNORED 与 Cron owner 明确；用户修改保留                                        | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S3 扫描/用户并发/重现/忽略幂等验证                                     |
| D8  | archive/delete request/tombstone/reclaim/history/metadataGC 分离；历史 FK 不阻源码回收；保全 snapshot+hold                                | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S1 安全 owner/quarantine/备份 GC 竞态；历史永久保留只保留轻量 identity |
| D9  | A 原子对账；APPLIED/DiscoveryFAILED/EventNOT_COMMITTED 三事实；全 Workspace 恢复屏障、成功事务 outbox                                     | TECHNICAL_CONTRACT_READY_FOR_APPROVAL                           | S3 apply/DB/发现/dispatch 故障资格；未来 B 需 input proof 独立 ADR     |

仍需执行验证而非口头决定：目录/FD/flock/SIGKILL、真实 Git 与 Runtime、灾难恢复、浏览器、Linux/container、双架构与容量。S0 内存 DDL 通过不将这些项目标为 PASS。部署数值、未来 upload/ZIP、snapshot/overlay 和 B 局部放行不在本轮实施范围。

本次 D8 修改的是旧推荐：不再要求历史日志消失后才能释放源码目录；既有 CURRENT 源码事实原样保留，澄清/变更来源见 [Decision Record](S0_DECISION_RECORD.md)。
