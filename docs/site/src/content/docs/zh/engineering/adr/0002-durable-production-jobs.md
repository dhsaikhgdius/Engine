---
title: ADR 0002：统一持久化 ProductionJob 状态机
description: 为生成、转码、代理、DCC 和其他重型任务建立统一的可恢复状态机。
---

- **状态：** Accepted（核验于 2026-08-25）
- **证据：** `ProductionJobStore`（`backend/gateway/jobs/productionJobStore.ts`）与
  `packages/protocol/src/productionJobProtocol.ts` 中的 `transitionProductionJob` 状态机
  （状态 `queued` / `running` / `succeeded` / `failed` / `cancelled` / `outcome_unknown` /
  `reconciling`；kind 覆盖 canvas、图像/视频/3D/音频生成、media proxy / transcribe /
  transcode、场景重建、DCC export/import 与 episode package）。
  `backend/gateway/tests/jobs/productionJobStore.test.ts` 覆盖非法迁移拒绝、精确幂等去重与
  changed-reuse 拒绝、重启恢复到 `outcome_unknown`，以及重试前 reconciliation 并保留历史 attempt。

## 背景

图像、视频、音频、代理生成、转码和 DCC 工作目前拥有不同的生命周期。进程重启、
网络超时或 worker 退出时，系统可能既无法安全重试，也无法判断结果是否已经产生。

## 决策

统一使用持久化 `ProductionJob`：

```text
queued → running → succeeded
                 ↘ failed
                 ↘ cancelled
                 ↘ outcome-unknown → reconcile
```

任务包含稳定 job ID、类型、输入 fingerprint、幂等 key、attempt 列表、状态时间线、
取消请求、错误、警告、输出 artifact version 和 reconciliation 信息。每次重试创建
新的 attempt，不能覆盖已 promotion 的结果。

## 后果

### 正面

- 所有重型任务都有统一查询、取消、重试和恢复语义；
- 进程重启后可以把未完成任务标为可重试或 outcome-unknown；
- UI、Agent、gateway 和 worker 可以共享 receipt 语言。

### 成本

- 需要稳定的存储、清理策略和后台 reconciliation；
- provider 的特有状态必须映射到通用状态并保留原始 receipt；
- 并发与资源配额必须按 job type 管理。

## 拒绝的替代方案

- 让每个 provider 自己维护状态机；
- 只在内存中保存 job；
- 通过“再次提交”解决所有超时，而不先检查结果。

## 安全

Job receipt 不保存 provider secret。输入和输出只保存受权限保护的引用；跨用户读取、
取消和 artifact 下载都必须经过 project scope 与 capability 检查。

## 验收

需要覆盖幂等重放、payload 冲突、重启恢复、取消竞态、重复输出、outcome-unknown
reconcile、artifact promotion 和权限边界。
