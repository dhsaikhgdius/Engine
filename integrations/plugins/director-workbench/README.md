# Director Workbench — Portable Agent/MCP Plugin

> Languages: **English** · [中文](README.zh-CN.md)

`integrations/plugins/director-workbench/` is the portable Agent/MCP plugin,
built from the same workbench contracts. It gives coding agents structured
control over the 3D Stage, Canvas production DAG, and Video Editor timelines.

## File-level inventory

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex CLI plugin manifest: name `director-workbench` v0.1.0, declares capabilities (Interactive, Write), default prompts, points to skills dir and MCP server config. |
| `.mcp.json` | MCP server config: defines `director-workbench` server, launched via `node ./mcp/server.mjs`, env `STAGE_GATEWAY_URL=http://127.0.0.1:8787`. |
| `mcp/server.mjs` | **Generated** build artifact (~97k lines): single-file bundled MCP server with all dependencies (ajv, etc.) inlined. Built by `npm run build:mcp-plugin`. **Do not hand-edit.** |
| `skills/director-workbench/SKILL.md` | Main skill instructions (138 lines): default working loop (discover → observe → atomic mutate → observe → audit → preview/deliver), 3D Stage operation rules (author/execute/execute_batch), large scene handling, concurrency limits, idempotent recovery rules. |
| `skills/director-workbench/agents/openai.yaml` | OpenAI Agent config: declares MCP tool dependency `director-workbench` (stdio transport), allows implicit invocation. |
| `skills/director-workbench/references/operations.md` | Operation examples reference (652 lines): shortest usable request shapes and explanations for observe, describe, catalog, author, capture, audit, execute_batch, deliver, shot_package, and more. |

## Skill structure

```
skills/director-workbench/
├── SKILL.md                  # Main instructions
├── agents/
│   └── openai.yaml           # OpenAI Agent integration config
└── references/
    └── operations.md          # Operation reference
```

The canonical skill source lives at `.claude/skills/director-workbench/`.
The copy under this directory is synced by `npm run sync:skills`.
**Edit the canonical source, not the copy here.**

## MCP server

`mcp/server.mjs` is a build artifact: `npm run build:mcp-plugin` bundles the
MCP server and all its dependencies into a single self-contained file. This
file **should not be hand-edited** — all changes should be made in source and
rebuilt.

The MCP server connects to `STAGE_GATEWAY_URL` (default `http://127.0.0.1:8787`) on
startup, exposing three tool sets:

- `director_workbench` — Stage, generation, jobs
- `director_creative` — Canvas, Video, Gallery, interchange, collaboration
- `director_dcc` — Blender/DCC handoff

## Run

```bash
npm run build:mcp-plugin      # Build portable MCP plugin
npm run sync:skills           # Sync skills from canonical source
npm run validate:agent-plugin # Validate agent plugin integration
```