---
title: 架构决策记录
description: 影响多个 Director 工作区或外部契约的架构决策。
---

ADR 记录会影响多个 Director workspace 或外部契约的决定。状态为 **Proposed** 的
记录是可评审方向，不代表已经上线。

| ADR                                                                                 | 状态                                       | 决策                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| [ADR 0001：ProductionGraph](/zh/engineering/adr/0001-production-graph/)             | Accepted                                   | 在现有编辑器模型之上增加身份与 lineage graph。  |
| [ADR 0002：持久化 ProductionJob](/zh/engineering/adr/0002-durable-production-jobs/) | Accepted（2026-08-25）                     | 为外部任务和重型任务使用统一的持久化状态机。    |
| [ADR 0003：导入、导出与回执](/zh/engineering/adr/0003-import-export-receipts/)      | 对已交付 adapter 为 Accepted（2026-08-25） | 将互操作拆成可审查的 plan/manifest 和写入回执。 |
| [ADR 0004：A2A gateway spike](/zh/engineering/adr/0004-a2a-gateway-spike/)          | Rejected                                   | 不上线 live A2A runtime；仅提供指向 MCP 与 HTTP tool manifest 的 discovery-only agent card。 |
| [ADR 0005：Verified shot 北极星](/zh/engineering/adr/0005-verified-shot-north-star/) | Accepted（2026-08-27）                    | 采纳产品宪法：一条 verified-shot 生产线、理念三问、core/adapter/experiment 分层，研究输入归档而非路线图。 |

## ADR 生命周期

`Proposed → Accepted → Superseded` 或 `Rejected`。

在 ADR 变为 Accepted 前，需要补齐：

- owner 与实施里程碑；
- 最终 schema 名称和版本策略；
- 迁移与兼容方案；
- 安全与失败分析；
- fixture 和验收测试计划。
