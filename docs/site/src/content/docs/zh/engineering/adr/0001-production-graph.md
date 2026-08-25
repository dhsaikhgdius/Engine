---
title: ADR 0001：项目级 ProductionGraph
description: 在现有编辑器模型之上增加稳定的制作身份与 lineage graph。
---

**状态：** Accepted。只读投影与 `director_workbench` observe 字段 `production_graph` 已落地；编辑器模型仍是详细状态的权威来源。

## 背景

Canvas、Stage、Video、生成任务和 DCC 目前各自拥有稳定的局部 ID，但没有一个跨
workspace 的制作级 lineage 模型。只靠文件路径、时间戳或 prompt 无法可靠地表达
同一资产、镜头和交付物之间的关系。

## 决策

增加一个持久化的 `ProductionGraph v1`，作为跨编辑器的身份与 lineage 层。它不替代
现有编辑器的详细状态，而是通过明确的 projection 与各 workspace 连接。

图节点至少包括：

- production、scene、creative scope、screenplay beat；
- asset、asset version、shot、take 和 coverage；
- artifact、artifact version、generation job；
- review、approval 和 external package。

每个节点都需要稳定 ID、状态、来源 revision/fingerprint、时间戳、owner 和
schema version。边关系应表达 `contains`、`uses`、`derived_from`、`renders`、
`references`、`promoted_to` 与 `reviewed_by` 等语义。

## 初始实体

`ProductionGraph` 首版只读投影现有项目，不强迫编辑器立刻迁移全部状态。随后以
additive 方式写入 graph ID，并为旧项目提供确定性回填和兼容读取。

## 后果

### 正面

- 跨 Canvas、Stage、Video、生成和 DCC 追踪同一个制作身份；
- 生成版本、审批和交付包可以绑定精确来源；
- 迁移可以分阶段进行，不破坏现有编辑器 schema。

### 成本

- 需要处理旧项目回填、冲突和多 workspace 的事务边界；
- projection 与 graph 的不一致必须可检测、可修复；
- 每个外部适配器都要声明其 graph 语义损失。

## 拒绝的替代方案

- 让 Canvas 成为所有状态的唯一编辑器：它不了解 Stage 的空间和相机细节；
- 让每个 workspace 自己复制 lineage：会重新产生分裂身份；
- 使用文件路径代替 ID：无法表达版本、复用和移动后的同一性。

## 兼容性

Graph 是 additive 层。现有 `DirectorProject v1`、`StageScene v5`、Creative
workspace v2 和已有 job receipt 继续有效；适配器负责生成或读取 graph projection。

## 验收

首版需要完成只读构建、稳定 fingerprint、旧项目回填、跨 workspace 查询、冲突报告和
不改变现有编辑器行为的 fixture 测试。
