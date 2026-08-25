---
title: 管线与系统设计
description: 了解 Director 如何把身份、时间、相机、媒体、证据和恢复从 brief 传递到最终交付。
---

Director 是一个制作系统，包含三个编辑视图：

- **Canvas**：发展提示词、参考、变体和生成血缘；
- **3D Stage**：负责度量 blocking、表演、相机、镜头和预演；
- **Video Editor**：负责画面/音频组装和剪辑时间。

只有当这些视图保持相同的制作身份，并能产出可检查、可恢复的交付 artifact 时，管线才算完整。

## 管线概览

```text
Brief / Fountain / references
          │
          v
Canvas 开发 ── 生成任务 ──> 不可变媒体版本
          │                         │
          ├──── 选定的参考 ─────────┘
          v
Stage blocking → 角色表演 → 相机 coverage
          │
          v
审计 → clean frame → Shot IR → 带 hash 的 Shot Package
          │                          │
          │                          ├─ Blender / Unreal / USD
          │                          └─ 视频生成 provider
          v
生成画面与音频回到媒体库
          │
          v
Video 剪辑 → OTIO/OTIOZ → 审阅/版本批准 → 归档
```

## 真相来源

Director 有意使用多套模型；每套模型只负责一个领域，适配器把它们投影到外部格式，而不是制造彼此竞争的编辑器。

| 关注点                   | 真相来源              | 重要投影                                      |
| ------------------------ | --------------------- | --------------------------------------------- |
| Stage、相机、角色、表演  | `DirectorProject v1`  | StageScene v5、Shot IR、DCC package、glTF/USD |
| Canvas 图与 Video 时间线 | Creative workspace v2 | Agent snapshot、OTIO/OTIOZ、预览/导出         |
| 媒体字节与派生物         | 持久化媒体 store      | object URL、代理、波形、缩略图                |
| 多场景项目与剪辑         | Production record     | scene tab 与项目总览                          |
| 协作与审阅               | Yjs document          | presence、评论、版本、结构 diff               |
| 外部执行                 | Production job        | provider 请求、进度、错误、artifact           |

大媒体字节永远不应放进场景或协作 JSON。这些文档只保存稳定 ID、元数据、hash 和安全引用，实际字节由媒体或 artifact store 管理。

## 已实现

- 带 hash 修订号的校验 `DirectorProject` 状态；
- 带 snapshot fingerprint 和原子 Agent 编辑的场景级 Canvas/Video 状态；
- 有理帧率、整数帧、SMPTE 起始 timecode 与 drop-frame；
- 目录化 Mixamo 角色、骨骼运动、语义姿势控制与 IK；
- 可复用表演 take 与独立相机 coverage；
- 无辅助线 clean、depth、normal、object-ID 和 mask 捕获；
- Shot IR、相机轨迹、AI 控制 sidecar、artifact hash 和 package fingerprint；
- Fountain、OTIO/OTIOZ、glTF、USD 和 USDZ 适配器及 fixtures；
- 持久化媒体、波形、代理、显式离线引用与 relink；
- Yjs 同步、presence、锚定审阅评论、命名版本、比较和恢复；
- 校验后的 Blender 导出、可选 clay preview，以及受限、先审阅再应用的稳定 ID mesh/变换回传。

## 尚未完整的部分

### 跨工作区身份

Canvas、Stage、Video、生成任务和 DCC package 都有稳定本地 ID，但还没有共享单一的项目级血缘图。
下一份主要契约应是 `ProductionGraph`：负责稳定的资产、剧本节拍、镜头、artifact、使用关系和审阅身份，同时让各编辑器继续管理自己的详细状态。

### 持久化任务

图像和视频任务已经可检查，但图像、视频、音频、代理/转码和 DCC 工作应共享一个持久状态机：

```text
queued → running → succeeded
                 ↘ failed
                 ↘ cancelled
                 ↘ outcome-unknown → reconcile
```

重试会创建 attempt 和不可变输出版本，不得重复图节点或静默覆盖已提升的结果。

### DCC 往返

Blender mesh replacement 与对象/相机变换已可通过带 hash 的稳定 ID package、可审阅 ImportPlan、
revision guard 和幂等 author batch 回传。剩余 DCC 工作是更广语义：Blender 游离对象创建、相机光学和灯光、
armature pose 烘焙、交互式 add-on，以及绑定 fingerprint 的明确人工审批。Unreal 应使用 OpenUSD 加
CineCamera/Level Sequence 映射，而不是另一套专有场景格式。

## 管线关卡

### 1. Intake

创建制作、场景、creative scope、timebase 和稳定故事身份。导入必须先校验，并声明是 create、link、merge 还是 replace。

### 2. 资产规范化

对源文件 hash 和 probe，记录来源/许可证，创建运行时代理和解码派生物，验证度量边界与角色 rig，并保留明确的离线状态。

### 3. Canvas 开发

为每个任务冻结 provider、模型、配置和输入 hash。生成输出是不可变版本，可比较、提升或复用。

### 4. Stage 与 coverage

制作米制 blocking、角色表演、物理相机、有理帧时间线、可复用 take 和独立相机 coverage。

### 5. 镜头验收

审计精确修订号，捕获无辅助线证据，输出 Shot IR 与带 hash 的控制包。下游 provider 消费该包，不再抓取编辑器 UI。

### 6. DCC 或生成

通过能力检查的适配器转换已验收 package。不支持的控制项应生成降级报告，不能静默丢失。

### 7. 剪辑与审阅

以新媒体版本返回输出，保留源/派生的 timebase 区别，使用匹配的预览/导出语义剪辑，并把评论/批准绑定到精确修订和 artifact 指纹。

### 8. 交换与归档

先导出 manifest，再导出字节。每个适配器发布支持和降级语义；往返必须由 fixture 测试。

## 核心不变量

每个边界都要声明：

1. 稳定身份和源修订/指纹；
2. 米制、手性、上轴和相机前向轴；
3. 有理帧率、整数帧、起始 timecode 和 drop-frame 模式；
4. 显示/数据色彩空间与辅助线可见性；
5. 源/派生物与 provider 血缘；
6. create/link/merge/replace 行为；
7. 失败、重试和 reconciliation 行为。

Schema 有效只是第一道关。Director 还会独立检查图完整性、制作就绪、渲染证据和最终视觉质量。

## Agent 原生操作

朴素 Agent 使用语义 ID 和结果，而不是 DOM 坐标或原始骨骼四元数：

```text
capabilities/catalog
  → 观察精确目标与保护条件
  → 执行一个原子意图
  → observe/diff
  → audit
  → preview 或 deliver
  → 检查像素与 artifact
```

`director_workbench` 负责 Stage，`director_creative` 负责 Canvas/Video，`stage_video` 负责生成任务，`director_dcc` 负责 DCC 交接。

## 推荐实现顺序

1. 增加 `ProductionGraph v1` 和可选 graph ID，不替换现有 store；
2. 为生成、转码/代理和 DCC 执行增加统一持久任务 store；
3. 创建不可变 `ArtifactVersion` 记录，以及明确的 promote/use 操作；
4. 在适配器之间统一 `ImportPlan`/`ImportReceipt` 和 `ExportManifest`/`ExportReceipt`；
5. 增加 Blender 回写 package 和可审阅的原子 merge；
6. 增加基于 OpenUSD 的 Unreal 导出与 camera/sequence fixtures；
7. 将审阅批准绑定到项目、creative 和 Shot Package 指纹；
8. 把重媒体任务移到可取消 worker 或 gateway job。

完整工程契约、迁移计划、失败表、验收矩阵和源码映射维护在 `docs/site/src/content/docs/engineering/PIPELINE_SYSTEM_DESIGN.md`。
