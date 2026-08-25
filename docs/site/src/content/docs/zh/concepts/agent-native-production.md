---
title: Agent-native 制片
description: 让普通 Agent 能安全创作、验证和修复 Director 项目的契约。
---

Director 的目标是 **Agent-native**，而不只是“能被 Agent 控制”。差别在于每次操作都有
完整契约：Agent 能发现词汇、定位精确项目、执行有边界的修改、验证状态与像素，并在冲突
后恢复，而不依赖屏幕坐标点击。

本页解释这套模型。页面中的各个术语——observe、author、audit、deliver、精确目标、守卫、
幂等键——在[术语表](/zh/concepts/glossary/)中逐一定义。

## 标准控制循环

```text
capabilities/catalog
  → 观察 target + revision
  → 检查精确实体
  → 原子提交一个意图
  → 再次 observe/diff
  → audit/correct
  → deliver
  → 检查 clean 像素与回执
```

每一步解决不同风险：`capabilities` 防止虚构操作，`catalog` 防止虚构资产 ID，target
租约防止写错标签页，revision guard 防止陈旧覆盖，幂等键防止重复副作用，`audit` 捕获
确定性问题，`deliver` 则把干净渲染帧绑定到已验收版本。

## 一个项目，四个语义控制面

| 控制面               | 负责内容                           | 适用任务                                             |
| -------------------- | ---------------------------------- | ---------------------------------------------------- |
| `director_workbench` | 完整 DirectorProject 与 Stage 证据 | 场景、对象、人物、相机、时间线、coverage、审计与交付 |
| `director_creative`  | Canvas 与 Video 工作区             | 节点、边、媒体片段、轨道、预览、撤销/重做            |
| `stage_video`        | 生成任务                           | prepare、submit/render、轮询、取消                   |
| `director_dcc`       | DCC 交接                           | 能力发现、Blender 导出与状态                         |

`stage_*` 仍作为紧凑兼容层保留。新的自动化除非明确需要 compact Stage 协议，否则优先
使用 `director_workbench`。

## 精确 target 租约

可写浏览器目标是一个元组，不只是 URL：

```text
token + client_id + instance_id + scene_id + creative_scope_id + contract_version
```

Agent 从当前观察或 bootstrap 响应取得它，并在本轮一直携带。Director 不会静默回退到
另一个标签页、场景或 creative scope。目标消失时必须显式重新绑定。

## Guard 与幂等

Stage 修改使用 `expected_revision`；Canvas/Video 修改使用
`expected_snapshot_fingerprint`。不匹配说明目标已被别人改变。此时重新观察，计算尚未完成
的意图，并用新的幂等键提交新请求。

若结果为 `outcome_unknown`，不要立刻换 key 重试。先 observe 或 diff；确认副作用不存在后，
才使用原 key 重放字节等价请求。

naive caller 可以在公开 Workbench/Creative 调用中省略 target lease、guard 与 request key。
Director 会发现一个可响应的精确目标，执行所需的只读 preflight，注入缺失的 guard/key，并
返回 `agent_boundary` 回执。浏览器执行边界仍是严格的：未守卫的项目/Production/Storyboard
写入和未带 key 的 durable job submission 会被拒绝。

原生 Blender `apply` 也遵循同一套 naive-caller 原则，但不依赖浏览器 lease。Gateway 会先
快照 Blender，并注入缺失的 scene epoch、revision 和 intent ID。原生请求派发后若结果
不确定，响应会携带完整 `retry_ticket.input`；必须原样重放该对象，让 Blender 返回原事务，
而不是再次创作。

## 原子意图

一个用户意图应对应一个 `author` batch。一次批次可以同时上架资产、创建对象、设置动作并
建立相机；任一 action 校验失败，都不应留下部分提交。

只有语义 action 无法表达时才使用 JSON Patch。语义操作会保护落地、真实资产身份、锁定
对象以及相机/人物关系等不变量。

## 证据层级

| 证据             | 能证明                     | 不能证明                              |
| ---------------- | -------------------------- | ------------------------------------- |
| mutation 回执    | 操作已提交                 | 镜头视觉正确                          |
| 新 revision/diff | 目标字段已变化             | 画面可用                              |
| `audit`          | 确定性约束通过             | 像素质量                              |
| clean capture    | 相机实际渲染结果           | 未绑定 fingerprint 时不保证是最新版本 |
| `deliver`        | 审计与捕获属于同一验收版本 | 未经人类/Critic 检查的创意质量        |

视频生成交付至少要求 `ready:true`、`status:"delivered"`、`capture_verified:true`、
通过的 audit、正确 revision/package fingerprint，并人工或视觉 Critic 检查 clean PNG。
`audit.ready` 本身不等于完成。

## Agent 绝不能猜测的内容

- 资产 ID、文件 URL、动作 clip ID、相机 ID 或对象 ID；
- 已有相对布局语义操作时的世界坐标；
- 仅凭 `parent_id` 推断支撑关系；
- 超时 mutation 是否已提交；
- 未检查返回 artifact 就声称画面干净；
- 没有真实 job/artifact 回执就声称 provider 已生成结果。

具体接口见[资产发现](/zh/agents/assets/)、[Agent 工作台](/zh/agents/workbench/)和
[Gateway HTTP API](/zh/reference/http-api/)。
