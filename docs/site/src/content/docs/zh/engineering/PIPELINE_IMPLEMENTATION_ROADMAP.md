---
title: 管线实施路线图
description: ProductionGraph、持久化任务、artifact、互操作和运营能力的分阶段实施计划。
---

本路线图把[管线与系统设计](/zh/engineering/pipeline_system_design/)拆成可独立验收的
里程碑。每个阶段都要求 schema、迁移、失败恢复、测试、观测和用户/Agent 控制面保持一致。

## 交付规则

- additive 优先，不直接破坏现有 `DirectorProject`、`StageScene` 或 receipt；
- 每个新 ID 都必须能回到 source revision/fingerprint；
- 每个长任务都有 durable state、幂等 key、取消和 reconcile；
- adapter 必须报告 capability gap，不得静默丢字段；
- 先加入 fixture 和 acceptance test，再开放新的交付声明。

## Milestone 0：冻结基线

记录当前 schema、project revision、Stage adapter、Canvas/Video snapshot、provider 配置、
已有 receipt、资产目录和关键 E2E。输出基线 fingerprint、失败清单和迁移开关；验收标准是
旧测试在开启新 contract 前后保持一致。

## Milestone 1：ProductionGraph v1（只读）

### 新模块

增加 graph schema、identity resolver、projection reader、fingerprint、查询 API 和
只读 Agent/MCP 观察能力。首次实现不改变编辑器写路径。

### 最小 schema

```text
Production / Scene / CreativeScope
Asset / AssetVersion / Shot / Take / Coverage
Artifact / ArtifactVersion / ProductionJob / Review / Approval
```

每个实体需要 `id`、`kind`、`status`、`source_revision`、`created_at`、`updated_at`、
`schema_version` 和 provenance。关系需要来源、目标、类型和可选时间范围。

### Projection 规则

`DirectorProject`、Creative workspace、video manifest 和 DCC package 都只能投影到 graph；
graph 不能吞掉编辑器细节。无法映射的字段进入 warning/degradation，而不是被丢弃。

### 验收

旧项目可生成稳定 graph，重复读取 fingerprint 相同；跨 scene 查询可用；冲突和无法映射
字段可见；只读 graph 不改变编辑器行为。

## Milestone 2：增量持久化 graph ID

在现有实体中 additive 写入 graph ID，提供旧项目确定性回填、迁移 receipt、回滚开关和
双读校验。禁止用时间戳、文件路径或对象数组索引代替稳定 ID。验收包括新旧项目、复制、
导入、删除、恢复和重复迁移。

## Milestone 3：持久化 ProductionJob 状态机

### 共享契约

统一 job type、input/output fingerprint、attempt、provider receipt、warning、取消、
错误和 reconcile。gateway 保存制作意图；worker 保存执行 receipt。

### 状态

```text
queued → running → succeeded
                 ↘ failed
                 ↘ cancelled
                 ↘ outcome-unknown → reconcile
```

### 幂等性

同一个 key 只能重放相同 payload；不同 payload 必须失败。attempt 产生 immutable output
version，不能覆盖已 promotion 的结果。重启时未完成任务进入可重试或 outcome-unknown。

### 验收

覆盖提交、轮询、取消竞态、worker 重启、超时、重复提交、payload conflict、清理和权限。

## Milestone 4：不可变 ArtifactVersion 与 promotion

媒体、ShotIR、DCC package、PNG ZIP、MP4、proxy 和 waveform 都以 immutable version 存储。
promotion 是显式操作，绑定 graph node、输入 fingerprint、review/approval 和当前项目
revision。旧版本可比较、回退和复用，不能静默覆盖。

## Milestone 5：ImportPlan 与 ExportReceipt

### 导入

读取外部包后先生成 create/link/merge/replace plan，列出身份匹配、单位、坐标、时间基准、
能力差距和风险；明确 commit 前不能写入项目。

### 导出

先写 ExportManifest，固定 schema、hash、来源、目标能力和降级。完成后写 ExportReceipt，
记录写入的文件、artifact、warning、失败和实际 fingerprint。

### 首批适配器

Blender package、glTF/USD、Fountain、OTIO/OTIOZ、LTX/ShotIR 和 PNG/MP4 evidence package。

## Milestone 6：Blender return package

### 契约

Blender 只返回稳定 ID、新资产版本、约束的 transform/material/action/camera 变更和
preview/hash。不能回传任意脚本或直接覆盖源项目。

### 验收

生成可审查 diff，验证单位/轴/时间基准/许可，用户 approval 后原子 merge；冲突时保持
现有项目不变。

## Milestone 7：Unreal/OpenUSD package

使用 OpenUSD、CineCamera 和 Level Sequence 映射，而不是增加第二套 proprietary scene
format。Package 声明无法表达的 Director 语义，并提供 fixture round trip、hash 和 receipt。

## Milestone 8：fingerprint-bound approval

approval 绑定 project、creative snapshot、Shot Package、artifact 和 schema fingerprint。
任何 revision、素材或 provider 变化都会使 approval 失效，必须重新审查。

## Milestone 9：规模化与运营

- **媒体**：对象存储、proxy、波形、转码、保留和垃圾回收；
- **协作**：Yjs/awareness、评论、版本、结构 diff、offline/relink；
- **观测**：job latency、GPU、provider、reconcile、失败原因、审计和成本。

## 建议 PR 顺序

1. graph schema 与只读 projection；
2. graph ID additive migration；
3. ProductionJob receipt 与 worker adapter；
4. ArtifactVersion/promotion；
5. ImportPlan/ExportReceipt；
6. Blender return package；
7. OpenUSD/Unreal fixture；
8. fingerprint approval；
9. 媒体、协作和观测扩展。
