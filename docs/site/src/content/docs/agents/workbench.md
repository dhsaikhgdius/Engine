---
title: Agent Workbench
description: Drive Director Stage, Canvas, Video, and Blender through DeepSeek Harness.
---

The Agent harness is DeepSeek Harness (`vendor/deepseek-harness`). Director no longer hosts an
in-tree session loop. Stage, Canvas, Video Editor, and Blender tools are the
`@director/dsh-plugin-workbench` plugin.

The Agent workspace embeds DSH Web (default `http://127.0.0.1:3080`).

1. Start the Gateway: `npm run dev:gateway` (or `npm run dev`).
2. Prepare the Director overlay and launch the pinned DSH Web profile: `npm run dsh`
   (the launcher pins `@deepseek-ai/dsh@0.1.0-rc.6`). Run it from the repository root.
3. Open the Agent workspace in Director. It embeds DSH only after the Director plugin health
   contract passes, and it keeps retrying automatically while DSH is starting.

## The agent loop is DSH's own

`npm run dsh` launches the official release with the repository root as the working directory,
so DSH discovers the `.dsh/skills/director-workbench` skill on its own (rank 100). Inside the
embedded session, use DSH's native capabilities directly — do not rebuild them in-tree:

- Load the Director skill with the native `skill` tool (`director-workbench`).
- Plan with `todo_write` and plan mode; keep long generation jobs observable with
  `job_list` / `job_output` / `job_kill`.
- Research with `web_search` / `web_fetch`; work the checkout with `bash`, `read`, `write`,
  `edit`, `glob`, `grep`, or Code Mode `tools.<name>({})`.
- Fan out with DSH subagents and workflows; goals stay available via `get_goal({})`.

Director contributes only the overlay plugin tools (`director_workbench`, `director_creative`,
`stage_video`, `blender_native`, `director_model_routes`) on top of that loop.

## Launcher environment

The launcher passes `STAGE_GATEWAY_URL`, `DIRECTOR_GATEWAY_TOKEN`, and `DIRECTOR_TARGET_TOKEN`
through to DSH when set. For headless or cloud runs, set `DIRECTOR_DSH_NO_OPEN=1` (or run with
`CI=1`) so DSH Web starts with `--no-open`. `npm run dsh:prepare` writes the overlay without
launching.

External coding agents can still use Director MCP (`npm run mcp`) against the same `/api/tools/:name`
surface. `GET /api/agent/profiles` remains for reconstruction and film planning.
