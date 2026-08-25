---
title: Director 管线与系统设计
description: 从 brief 到交付的身份、时间、相机、媒体、证据、恢复和互操作契约。
---

## 1. 目的

Director 是一个制作系统，而不是三个互相独立的工具：Canvas 负责开发和生成 lineage，
3D Stage 负责 metre-scale blocking、表演、相机与 previs，Video Editor 负责 picture/audio
assembly 与 editorial timing。三者必须保留同一套制作身份，并输出可检查、可恢复的 artifact。

## 2. 当前状态概览

| 能力                                               | 状态            |
| -------------------------------------------------- | --------------- |
| DirectorProject v1、StageScene v5 adapter          | 已实现          |
| Canvas/Video snapshot、原子 Agent edit、audit      | 已实现          |
| 物理相机、filmback、DOF、clean capture             | 已实现/部分实现 |
| Performance Take、Coverage Shot、ShotIR            | 已实现/部分实现 |
| PNG frame package、artifact hash、Blender 单向导出 | 部分实现        |
| ProductionGraph、统一 durable job、ArtifactVersion | 提案/分阶段实施 |
| Blender 双向回传、Unreal/OpenUSD、完整媒体容器     | 提案或部分实现  |

## 3. 系统原则

### 3.1 每种关注点只有一个 source of truth

| 关注点                         | source of truth         | 重要 projection                              |
| ------------------------------ | ----------------------- | -------------------------------------------- |
| Stage、相机、角色、表演        | `DirectorProject v1`    | StageScene v5、ShotIR、DCC package、glTF/USD |
| Canvas graph 与 Video timeline | Creative workspace v2   | Agent snapshot、OTIO/OTIOZ、preview/export   |
| 媒体二进制                     | persistent media store  | object URL、proxy、waveform、thumbnail       |
| 多 scene 制作身份              | ProductionGraph（目标） | scene tab、artifact、review                  |
| 协作与评论                     | Yjs document            | presence、comment、version、diff             |
| 外部执行                       | ProductionJob           | provider request、progress、error、artifact  |

Adapter 可以投影状态，不能把投影格式变成第二套 editor model。

### 3.2 状态不是证据

有效的 JSON、`success: true` 或 job `ready: true` 只证明结构状态。交付还需要 mutation
diff、audit、精确 camera/frame、clean capture、artifact hash 和 receipt。结构、变化、质量
和视觉证据必须分开记录。

### 3.3 元数据可携带，二进制由外部存储拥有

Project 和 collaboration JSON 保存稳定 ID、元数据、hash、版本和安全引用；大媒体、模型、
代理和输出文件由 media/artifact store 管理。不能把可执行 provider payload、超大二进制或
未审计的外部 URL 直接塞进 scene state。

### 3.4 显式约定

每条边界都要写明 metre scale、handedness、up axis、camera forward axis、rational frame
rate、integer frame、start timecode、drop-frame、color space、helper visibility、lineage、
create/link/merge/replace 和 failure/retry/reconcile。

## 4. 当前模型拓扑

```text
DirectorProject v1
  ├─ scenes / assets / characters / cameras
  ├─ performance takes / coverage shots / timeline
  ├─ creative workspace snapshot
  ├─ media references / generation jobs
  └─ revision + audit/evidence metadata

StageScene v5 ← validated adapter → DirectorProject v1
Canvas/Video v2 ← snapshot adapter → Production record / artifact graph
```

旧 Stage operation 仍可使用 compact protocol；新 Agent integration 优先使用
`director_workbench` 和 `director_creative`。

## 5. 端到端制作管线

```text
Brief / Fountain / references
          │
          v
Canvas development ── generation jobs ──> immutable media versions
          │                                      │
          ├──────── selected references ─────────┘
          v
Stage blocking → character performance → camera coverage
          │
          v
Audit → clean frame → Shot IR → hashed Shot Package
          │                          │
          │                          ├─ Blender / Unreal / USD
          │                          └─ video-generation provider
          v
Generated plates and audio return to the media library
          │
          v
Video editorial → OTIO/OTIOZ → review/version approval → archive
```

### Gate 0：intake 与项目身份

创建 production、scene、creative scope、timebase 和 story identity。导入必须声明是
create、link、merge 还是 replace，并生成输入 hash、来源和计划。

### Gate 1：资产导入与规范化

probe/hash 来源、记录 provenance/license、生成 runtime proxy 和 derivative、验证 metre bounds、
角色 rig、纹理预算和 offline state。未审计 URL 不进入可交付目录。

### Gate 2：Canvas 开发与生成 lineage

每个 generation job 固定 provider、model、configuration、prompt 和输入 hash。输出成为
immutable media version，可以 compare、promote、reuse，但不能覆盖原版本。

### Gate 3：Stage blocking、表演与 coverage

使用 metre-scale blocking、角色动作、物理相机、rational timeline、PerformanceTake 和
独立 CoverageShot。相同表演可以被多台相机复用；每个 shot 保存 lens、sensor、focus、frame
range 和来源 revision。

### Gate 4：shot acceptance 与 control package

对准确 revision 运行结构/语义/空间/时间/相机 audit，生成 helper-free clean frame、ShotIR、
camera plot、pass、AI control sidecar、artifact hash 和 package fingerprint。

### Gate 5：DCC 或生成渲染

能力检查后通过 adapter 消费 package。支持、近似、降级和拒绝都要进入 degradation report；
unsupported control 不能静默消失。

### Gate 6：媒体回流与剪辑

输出作为新 media version 回到 library，保留 source/project timebase、preview/export 语义、
proxy/waveform、offline/relink 和 provider receipt。Video Editor 使用 OTIO/OTIOZ 或等价的
有版本 editorial representation。

### Gate 7：协作、审查与审批

协作状态使用 Yjs/awareness，评论锚定 exact revision/asset/artifact。审批前比较版本、
结构 diff、视觉证据和来源；任何输入 fingerprint 变化都会使旧审批失效。

### Gate 8：互操作与归档

先导出 manifest，后写入二进制。每个 adapter 发布 supported/degraded semantics、输入 hash、
输出 hash、receipt 和保留策略。归档包必须可在没有运行时 UI 的情况下解释来源和版本。

## 6. 身份与 lineage 设计

目标中的 `ProductionGraph` 横跨 production、scene、beat、asset、asset version、shot、take、
coverage、artifact、job、review 和 approval。它只保存跨 workspace 的身份与关系，详细
空间、骨骼、剪辑状态仍由各 editor 持有。

稳定身份不能由数组索引、文件路径、时间戳或 prompt 文本生成。每个实体至少有 ID、kind、
schema version、source revision、created/updated time、owner 和 provenance；每条关系有 type、
source、target、可选 frame range 和 evidence。

## 7. Adapter 与边界架构

Adapter 输入有版本、scope、revision/fingerprint 和 capability request；输出有 manifest、
degradation、warning、artifact hash 和 receipt。浏览器、Node gateway、Python worker、DCC
和 provider 之间禁止隐式共享可变状态。

## 8. Agent-native 执行模型

```text
capabilities/catalog
  → observe exact target and guard
  → execute one atomic intent
  → observe / diff
  → audit
  → preview or deliver
  → inspect pixels and artifacts
```

Workbench 操作 Stage，Creative 操作 Canvas/Video，`stage_video` 操作生成任务，DCC adapter
操作互操作。所有写请求需要语义 ID、revision/fingerprint guard、idempotency key 和清晰
receipt。`outcome_unknown` 必须先 reconcile，不能盲目复制。

## 9. DCC 演进

### 已实现：Blender Bridge v1

当前是 Director → Blender 的单向、带 hash 的 package。它固定单位、轴、frame、camera、
asset provenance 和 helper policy；Blender 手工修改不会自动回写。

### 下一步：双向 DCC v2

return package 只能携带稳定 ID、受限 transform/material/action/camera 变化和新 asset version。
回传先生成 reviewable diff，经过 approval 后原子 merge；冲突或未识别 ID 保持项目不变。

### Unreal

使用 OpenUSD、CineCamera 和 Level Sequence 映射；adapter 必须说明 Director 语义与 Unreal
能力之间的损失，并提供 fixture round trip。

## 10. 生成 provider 架构

provider 只消费 provider-neutral ShotIR 和 immutable input version。配置、模型、prompt、seed、
输入 hash、尺寸、帧数、audio、enhancement、环境和 provider receipt 都要进入 job。LTX worker
的尺寸是 64 倍数、帧数为 `8k+1`；ComfyUI 是可选 adapter，不能绕过控制面。

## 11. 失败与恢复契约

| 失败                          | 恢复                                                  |
| ----------------------------- | ----------------------------------------------------- |
| stale revision/fingerprint    | 重新 observe、合并意图、使用新 guard 和新 key         |
| target unavailable            | 重新绑定原 tab/project/scene，禁止重定向写入          |
| outcome unknown               | 查询 receipt、diff 和 artifact；确认未生效后才 replay |
| provider timeout              | 查询同一 durable job，不能新建重复 job                |
| worker restart                | 标为 retriable 或 outcome-unknown，不报告成功         |
| adapter degradation           | 显示具体字段和替代语义，要求审查或拒绝                |
| import/export partial failure | 保持源项目不变，凭 receipt 重试或回滚                 |
| approval fingerprint changed  | 使审批失效，重新比较并审批                            |

## 12. 优先实施计划

- **P0**：ProductionGraph 只读与 additive ID、统一 ProductionJob、ArtifactVersion、ShotIR、
  stale-write protection；
- **P1**：ImportPlan/ExportReceipt、Blender return package、OpenUSD/Unreal fixture、fingerprint approval；
- **P2**：媒体 scale、proxy/transcode、协作、review、relink 和观测；
- **P3**：跨 provider 优化、自动 coverage、资源调度和成本控制。

## 13. 迁移策略

先保留旧 schema 和 adapter，加入双读、shadow projection、fingerprint 比较、feature flag 和
迁移 receipt。每次迁移都能回滚；只有新路径通过 fixture、E2E、失败恢复和视觉证据后，才将
默认流量切换过去。

## 14. 验收矩阵

| 维度     | 必须证明                                                  |
| -------- | --------------------------------------------------------- |
| Schema   | 版本、身份、单位、时间和兼容性明确                        |
| State    | UI、Agent、adapter 读到同一 source of truth               |
| Mutation | 原子、可撤销、revision guard、幂等                        |
| Quality  | 结构、语义、空间、时间和相机 audit                        |
| Visual   | exact frame、clean capture、pass 和像素检查               |
| Delivery | manifest、artifact hash、receipt、provenance、license     |
| Recovery | timeout、restart、cancel、conflict、reconcile 和 rollback |

## 15. 必须记录的架构决策

优先记录 ProductionGraph identity、ProductionJob 状态机、ArtifactVersion/promotion、
ImportPlan/ExportReceipt、Blender return package、OpenUSD 映射、媒体 ownership、collaboration
和 fingerprint-bound approval。每项都要关联 ADR、schema、迁移、fixture 和 acceptance test。

## 16. 源码地图

实现位置、测试、worker、MCP、插件和公共文档的最新对应关系见[仓库结构](/zh/reference/repository-structure/)。
详细英文契约见[English pipeline and system design](/engineering/pipeline_system_design/)。
