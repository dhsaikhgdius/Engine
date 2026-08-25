---
title: Agent Workbench
description: Drive Director Stage, Canvas, Video, and Blender through DeepSeek Harness.
---

The Agent harness is DeepSeek Harness (`vendor/deepseek-harness`). Director no longer hosts an
in-tree session loop. Stage, Canvas, Video Editor, and Blender tools are the
`@director/dsh-plugin-workbench` plugin.

The Agent workspace embeds DSH Web (default `http://127.0.0.1:3080`).

1. Start the Gateway: `npm run dev:gateway` (or `npm run dev`).
2. Prepare the Director overlay and launch the pinned DSH Web profile: `npm run dsh`.
3. Open the Agent workspace in Director. It embeds DSH only after the Director plugin health contract passes.

External coding agents can still use Director MCP (`npm run mcp`) against the same `/api/tools/:name`
surface. MCP does not include DSH `skill` / `todo_write` / `job_*` tools; those exist only in the
Harness process started by `npm run dsh`. `GET /api/agent/profiles` remains for reconstruction and film planning.
