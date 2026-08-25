---
title: Director Agent-native 操作指南
description: Provider 无关的 Agent 操作闭环、精确目标绑定、幂等重试和证据交付。
---

这份指南描述 coding Agent 如何安全地操作 Director。核心要求是：先发现、再绑定精确
目标、执行一个原子意图、观察变化、审计并交付证据。Agent 不应通过猜测 ID、坐标点击
或盲目重试来推进工作。

## 基本体地面枢轴

Box、sphere 等基本体的 `position` 是**底部中心（floor pivot）**，不是几何中心。不要把半高加到 `position.y` 上。

- 3 米高的墙立在地面：`position.y = 0`，`scale.y = 3`。写成 `position.y = 1.5` 会把墙抬离地面 1.5 米。
- 天花板底面贴在 3 米：`position.y = 3`，不是 `3 + 厚度/2`。
- 窗台高 0.8 米、窗扇高 2.2 米：`position.y = 0.8`，不是 `0.8 + 1.1`。

落地物体用 `placement_mode:"grounded"`，`position.y` 取 `scene.groundHeight`（默认 0）。

## 一个闭环

```text
discover capabilities/catalog
  → observe exact target and guard
  → execute one atomic intent
  → observe / diff
  → audit
  → preview or deliver
  → inspect pixels and artifacts
```

## 启动与发现

启动后先确认 gateway、provider、browser target 和协议版本：

```text
bootstrap
  → capabilities
  → catalog / inspect
  → observe
  → author or execute_batch
```

不要凭记忆构造对象 ID、资产 URL、骨骼名称或 camera ID。catalog 返回的 asset 对象应
原样传给 author；动作、角色和 provider 能力也必须先从 catalog/capabilities 获取。

## 精确目标绑定

每个写请求绑定 tab、Director instance、scene、creative scope、project revision 或
snapshot fingerprint。任何绑定变化都应返回 `target_unavailable`、`stale_project_revision`
或 `stale_snapshot`，而不是把写入重定向到当前可见的其他页面。

精确绑定还包括：

- protocol version 和目标 capability；
- 当前用户、workspace、project 和 scene scope；
- mutation 的 idempotency key；
- 请求对应的 revision/fingerprint guard。

## Workbench：3D Stage、相机、角色和镜头

`director_workbench` 面向完整的 DirectorProject：场景、资产、角色、相机、take、
coverage、时间线、审计和 clean capture。一个 author batch 应表达一个完整意图，例如
“添加角色、绑定动作、放置相机并创建 shot”，而不是把半个意图分成多个无关请求。

常用顺序：

1. observe 当前 project revision 和 scene；
2. catalog 资产、动作、相机或 shot preset；
3. 用语义 ID 生成一个原子 author batch；
4. 重新 observe/diff；
5. audit grounding、overlap、framing、timeline 和 helper visibility；
6. 请求 preview、clean frame 或 Shot Package。

### 面向朴素 Agent 的放置语义

Agent 应使用 `placement`、`floor_offset`、`visual_bounds`、`anchor` 和 `look_at` 等
语义，而不是猜测模型 origin。角色先按可见 bounds 落地，再应用用户要求的世界坐标；
相机以目标主体和景别计算 framing。任何自动修正都要写入 diff 并可撤销。

## Canvas 与 Video Editor

`director_creative` 面向 scene-scoped Canvas/Video 状态。它们使用
`snapshot_fingerprint` 而不是 Stage 的 project revision：

```text
capabilities
  → observe(target + snapshot_fingerprint)
  → execute_batch
  → observe
  → audit
  → preview
```

Canvas 负责 prompt、reference、variant、lineage 和 media node；Video Editor 负责 picture、
audio、transition、timeline、IN/OUT 和 editorial version。preview 必须绑定最终 fingerprint，
不能移动用户 playhead 或接受旧像素。

对于项目写入、Production mutation、Generated 3D 晋升、Storyboard 捕获/导出、Creative
编辑、Canvas pipeline 启动、协作评论以及 durable job submit/retry，naive caller 只需表达
意图。公开边界会锁定一个精确浏览器目标，按需观察并注入 revision/fingerprint，缺少 key
时生成唯一 retry key，并在 `agent_boundary` 中返回。浏览器执行边界仍会拒绝未守卫或未带
key 的写入。

`blender_native apply` 不依赖浏览器 target lease。naive caller 可以省略
`expectedSceneEpoch`、`expectedRevision` 和 `intentId`，Gateway 会在提交前快照原生场景并补齐
三者。如果派发后返回 `outcome_unknown`，必须原样重发完整的 `result.retry_ticket.input`；其中
保留了原 intent ID，可让 Blender 对同一事务进行恢复或精确回放。

## 幂等规则

- 同一个 idempotency key 只能重放字节完全相同的 payload；
- payload 改变必须使用新 key；
- 已成功 replay 的 mutation 不能再次产生对象或 job；
- `outcome_unknown` 时先 observe/diff，再决定是否用原 key 重试；
- revision/fingerprint 变化后必须重新 observe，并以新 guard 和新意图提交。

## 结构化恢复

| 状态                     | 正确操作                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| `target_unavailable`     | 重新绑定同一个 tab/project/scene，不要切换目标写入。                |
| `stale_project_revision` | observe 最新 project，合并意图，使用新 revision。                   |
| `stale_snapshot`         | observe 最新 Canvas/Video fingerprint，再请求 preview 或 mutation。 |
| `outcome_unknown`        | 停止重试，检查 diff、receipt 和 artifact；只有确认未生效才 replay。 |
| validation/audit failure | 修复具体建议，再以新原子意图提交。                                  |
| provider timeout         | 查询 durable job；不要通过新 job 盲目复制输出。                     |

失败批次必须原子回滚；部分成功只能由 receipt 明确表达，不能凭 UI 状态猜测。

## 完成检查表

- [ ] 使用 capabilities/catalog，而不是猜测 schema 或 ID；
- [ ] 请求绑定精确 target 与最新 revision/fingerprint；
- [ ] mutation 是一个可撤销、可重试的原子意图；
- [ ] 已 observe/diff 并运行结构或质量 audit；
- [ ] 交付包含 helper-free visual evidence、artifact hash 和匹配 receipt；
- [ ] 已记录 warning、degradation、license 和 recovery 状态；
- [ ] 未把 `success: true` 当成视觉完成的证明。
