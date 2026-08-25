# Director workbench plugin for DeepSeek Harness

> Languages: **English** · [中文](README.zh-CN.md)

Director does not own an agent harness. The loop, sessions, workspace/web/job
tools, and prompt assembly come from the
[`vendor/deepseek-harness`](../../vendor/deepseek-harness) git submodule
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).

This package is the Director-specific Cordis plugin: Stage (`director_workbench`),
Canvas / Video Editor (`director_creative`), video generation (`stage_video`),
and native Blender (`blender_native`). Each tool POSTs to the running Gateway
`/api/tools/:name` surface.

The plugin also exposes `director_model_routes`, backed by DSH's own live LLM
registry. Subagents and workflows inherit the current route by default; when a
different capability is required, the Agent reads this catalog instead of
guessing provider or model ids. Visual QA is considered complete only when a
Director capture arrives as an image block.

## Load into DSH

```bash
npm run dsh
```

The launcher initializes the vendored submodule when needed, writes a thin overlay
under `vendor/deepseek-harness/.director/`, and launches the pinned official DSH
release on `http://127.0.0.1:3080`. The Gateway must
already be running (`npm run dev:gateway`) so the plugin can reach the live 3D
Stage, Canvas, and Video Editor. Use `npm run dsh:prepare` only when a generated
overlay is needed without launching the Web profile.

Environment:

| Variable                    | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `STAGE_GATEWAY_URL`         | Gateway origin, default `http://127.0.0.1:8787` |
| `DIRECTOR_GATEWAY_TOKEN`    | Browser token for authenticated tool routes     |
| `DIRECTOR_TARGET_TOKEN`     | Exact Director tab target                       |
| `DIRECTOR_AGENT_SESSION_ID` | Fallback session id for non-DSH plugin hosts    |

Generic coding, web, todo, subagent, job, skill, goal, and plan tools stay in DeepSeek Harness.
Do not add them here. Agents should load `.dsh/skills/director-workbench` with the DSH `skill`
tool, then call those Harness tools alongside Director domain tools.
