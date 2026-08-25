---
title: Agent Workbench
description: 用 DeepSeek Harness 驱动导演台、画布、视频与 Blender。
---

Agent harness 是 DeepSeek Harness（`vendor/deepseek-harness`）。Director 不再内嵌自制会话循环。
导演台、画布、视频编辑与 Blender 工具在 `@director/dsh-plugin-workbench` 插件里。

Agent 工作区直接嵌入 DSH Web（默认 `http://127.0.0.1:3080`）。

1. 启动 Gateway：`npm run dev:gateway`（或 `npm run dev`）。
2. 生成 Director overlay 并启动固定版本的 DSH Web：`npm run dsh`
   （启动器固定 `@deepseek-ai/dsh@0.1.0-rc.6`）。必须从仓库根目录运行。
3. 打开 Director 的 Agent 工作区；只有 Director 插件健康契约通过后才会嵌入 DSH，
   DSH 启动期间页面会自动重试。

## Agent 循环由 DSH 自身提供

`npm run dsh` 以仓库根目录为工作目录启动官方发行版，DSH 会自行发现
`.dsh/skills/director-workbench` 技能（rank 100）。在嵌入的会话里直接使用 DSH 原生能力，
不要在树内重造：

- 用原生 `skill` 工具加载 Director 技能（`director-workbench`）。
- 用 `todo_write` 与 plan mode 做计划；用 `job_list` / `job_output` / `job_kill`
  跟踪长时生成任务。
- 用 `web_search` / `web_fetch` 检索；用 `bash`、`read`、`write`、`edit`、`glob`、`grep`
  或 Code Mode `tools.<name>({})` 操作代码库。
- 用 DSH 子代理与 workflow 分派任务；目标通过 `get_goal({})` 获取。

Director 只在这个循环之上贡献 overlay 插件工具（`director_workbench`、`director_creative`、
`stage_video`、`blender_native`、`director_model_routes`）。

## 启动器环境

启动器会在设置了 `STAGE_GATEWAY_URL`、`DIRECTOR_GATEWAY_TOKEN`、`DIRECTOR_TARGET_TOKEN`
时把它们透传给 DSH。无头 / 云端运行时设置 `DIRECTOR_DSH_NO_OPEN=1`（或 `CI=1`），
DSH Web 会以 `--no-open` 启动。`npm run dsh:prepare` 只写 overlay 不启动。

外部 coding agent 仍可通过 Director MCP（`npm run mcp`）调用同一套 `/api/tools/:name`。
`GET /api/agent/profiles` 仍用于重建与影片规划。
