---
title: MCP
description: 将任意支持 MCP 的 coding agent 接入 Director 的结构化制作工具。
---

仓库原生拥有这套 MCP 集成。项目配置通过 Node 的 `tsx/esm` loader 启动
`backend/gateway/mcp-server.ts`；Skill 指令存放在 `.claude/skills/` 目录中。
`integrations/plugins/director-workbench/` 只用于同一运行时的可选便携打包。

## 启动 gateway

```bash
npm run dev
```

项目 MCP 配置就绪后，重新加载 coding-agent 会话。

## 工具

| 工具                 | 用途                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `director_workbench` | 完整编辑器观察、创作、审计、捕获、Shot IR、多通道 Shot Package 和 UI 控制 |
| `director_creative`  | Canvas/Video 观察、原子编辑、审计和绑定指纹的 clean PNG 预览              |
| `director_dcc`       | DCC/引擎交接：提供方发现、Blender `.blend` 往返、Unreal/Unity/Godot 无头发送与受保护回传、引擎场景导入 |
| `stage_read`         | 紧凑观察、检查、批评、完整状态和相机捕获                                  |
| `stage_scene`        | 重置、场景设置、校验和场景级 mutation                                     |
| `stage_object`       | 创建、变换、放置、父子绑定、动画和移除白模对象                            |
| `stage_camera`       | 创建、取景、瞄准、移动和配置相机                                          |
| `stage_show`         | 时间线、轨道、动作、播放和录制控制                                        |
| `stage_video`        | 白模到视频任务的准备、提交和检查                                          |

`stage_*` 是紧凑的 `StageScene` 协议。新工作应使用 `director_workbench`。尤其
`kind:"cube"` 只对 `stage_object` 有效。公开的 `director_workbench` `author` 批次应实例化
catalog / `project_assets` 网格（`asset_id`）；独特建筑用 `blender_native`，独特生成网格用
`generated_3d`。该 Agent 线路会拒绝 Stage `geometry_type` 简单几何体。见[快速上手](/zh/getting-started/quick-start/)和
[端到端可验证镜头](/zh/tutorials/verified-shot/)。

## 可移植插件

可分发插件位于：

```text
integrations/plugins/director-workbench/
```

使用以下命令重新构建并校验：

```bash
npm run build:mcp-plugin
npm run validate:agent-plugin
```

`director-workbench` Skill 教授基于证据的 Workbench delivery 与独立的 Creative 循环，而不是把成功写入当作视觉证明。仓库根目录的 `AGENTS.md` 是权威指令入口；主流 coding agent 的项目发现已预配置：

| Agent           | MCP 配置                 | 指令 / Skill 入口                        |
| --------------- | ------------------------ | ---------------------------------------- |
| Codex           | `.codex/config.toml`     | `AGENTS.md`                              |
| Claude Code     | `.mcp.json`              | `CLAUDE.md` + `.claude/skills/`          |
| Cursor          | `.cursor/mcp.json`       | `.cursor/rules/director-workbench.mdc`   |

权威 Skill 源在 `.claude/skills/director-workbench`。仓库内适配只覆盖 Cursor、Codex 和 Claude Code；`npm run sync:skills` 会从 `tools/scripts/agent-integrations.mjs` 生成这些文件。`npm run repo:check` 会校验它们启动的都是同一个 MCP server。其他 MCP 客户端可以复制 `.mcp.json`。用 `npm run dev` 启动应用，重新加载 coding-agent 会话以发现 MCP，然后让它使用 `director-workbench`。

## 会话身份

stdio server 会自动创建 ref session。若 host 每次调用都会重启 MCP 进程，请设置稳定值：

```bash
export DIRECTOR_MCP_SESSION_ID=my-director-session
```

ref alias 只在该 session 作用域内有效。闲置 session 会过期，gateway 也会限制保存数量，避免无限增长。

## 原子批次

Stage 工具接受单个操作或有序 `ops` 批次。创建操作可以声明 `ref`；同一 session 后续操作可以使用别名。

```json
{
  "ops": [
    { "op": "create", "ref": "hero", "kind": "cube", "position": [0, 0, 0] },
    { "op": "transform", "object_id": "hero", "scale": [2, 0.5, 2] },
    { "op": "place", "object_id": "hero", "on": "ground" }
  ]
}
```

这段 `kind:"cube"` 批次是紧凑 `stage_*` 输入,不要粘贴进 `director_workbench` 的 `author`。

批次失败时，原始场景保持不变。

## 响应 envelope

MCP 工具通过 `structuredContent` 返回机器可读字段，例如：

- `ok`
- `result`
- `error`
- `changed`
- `scene_hint`
- `context`
- `available_refs`
- `ui_events`
- `target`

对于不消费结构化内容的客户端，文本内容会镜像同一个 envelope。

`target` 标识本次响应使用的精确浏览器客户端、项目实例、场景、creative scope 和契约版本。将完整描述视为一份 lease。
bundled MCP server 会在观察后保留不透明 token，并在后续 Workbench 或 Creative 操作中复用。如果目标消失，调用会 fail closed，
客户端必须重新观察；它不会把写入重定向到另一个可见 tab。

## 低 token 观察

优先使用：

```json
{ "op": "observe" }
```

然后检查单个实体：

```json
{ "op": "inspect", "entity": "object", "id": "hero-id" }
```

只有确实需要时才请求完整场景或项目快照。

最终捕获后如果需要可移植的精确帧交接，使用只读的 `shot_ir`：

```json
{ "op": "shot_ir", "take_id": "take-main", "coverage_shot_id": "coverage-close", "frame": 48 }
```

该操作通过 MCP、HTTP 和浏览器 workbench transport 返回同一份求值契约，并包含稳定的修订指纹。只需要相机时也可以传 `camera_id`。
mutation Workbench 调用应携带最近返回的 `project_revision` 作为 `expected_revision`，并设置稳定的 `idempotency_key`，以拒绝过期写入和重复重试。
`capture`、`shot_package` 和 `deliver` 要求该修订号，以确保证据对应同一场景版本。

调用 `capture` 时必须显式提供 `camera_id` 与非负整数 `frame`，可用 `render_pass`、`width`、`height` 选择一张 PNG；或使用 `shot_package` 和 `render_passes` 获取带 hash 的 clean/depth/normal/object-ID 包。
Agent-wire 栅格请求上限为 2,073,600 像素，避免异常图片溢出响应通道。最终验收优先使用 `deliver`，它会把审计、无辅助线 clean capture、Shot IR
和带 hash 的 package 合并为一个机器可读收据。

## Canvas 与 Video Editor

先调用 `director_creative {"op":"capabilities"}`，再调用 `{"op":"observe"}`。mutation 必须携带返回的
`snapshot_fingerprint` 和 `idempotency_key`。一个用户意图优先使用 `execute_batch`；新建 ID 可以通过 `save_as` 保存，再用 `@alias` 引用。
步骤失败时会恢复整个工作区和选择状态。

mutation 后再次观察并执行：

```json
{ "op": "audit", "scope": "all", "quality_profile": "production" }
```

审计是结构性的，并会明确要求视觉 Canvas/Video 预览。针对 mutation 后的指纹请求证据：

```json
{
  "op": "preview",
  "workspace": "video",
  "time_sec": 2.5,
  "expected_snapshot_fingerprint": "<最新 snapshot_fingerprint>"
}
```

响应附带无辅助线 PNG，不会移动时间线播放头。并发修改返回 `stale_snapshot`；应重新观察，而不是接受或重新标记旧像素。

## 超时恢复

超时的 mutation 返回 `outcome_unknown`，不代表 `target_unavailable`。观察精确目标并检查效果。如果 mutation 不存在且原始前置条件仍成立，
只用同一个 `idempotency_key` 重发字节完全相同的请求。payload、revision 或 fingerprint 改变后必须使用新 key。读取/证据超时返回 `command_timeout` 并会取消；
恢复可见目标并刷新保护条件后再重试。
