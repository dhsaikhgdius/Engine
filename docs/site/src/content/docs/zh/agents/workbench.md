---
title: Agent Workbench
description: 用 DeepSeek Harness 驱动导演台、画布、视频与 Blender。
---

Agent harness 是 DeepSeek Harness（`vendor/deepseek-harness`）。Director 不再内嵌自制会话循环。
导演台、画布、视频编辑与 Blender 工具在 `@director/dsh-plugin-workbench` 插件里。

Agent 工作区直接嵌入 DSH Web（默认 `http://127.0.0.1:3080`）。

1. 启动 Gateway：`npm run dev:gateway`（或 `npm run dev`）。
2. 生成 Director overlay 并启动固定版本的 DSH Web：`npm run dsh`。
3. 打开 Director 的 Agent 工作区；只有 Director 插件健康契约通过后才会嵌入 DSH。

外部 coding agent 仍可通过 Director MCP（`npm run mcp`）调用同一套 `/api/tools/:name`。
MCP 不含 DSH 的 `skill` / `todo_write` / `job_*`；那些只存在于 `npm run dsh` 启动的 Harness 进程。
`GET /api/agent/profiles` 仍用于重建与影片规划。
