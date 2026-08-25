# Director agent guide

Director (repository name WorldEngine) is an agent-native 3D film production workbench: a human
directs scenes visually in the browser while coding agents inspect and change the same project
through typed MCP, HTTP, and CLI surfaces. This file is the canonical instruction entry point for
every coding agent; per-agent rule files only point back here.

## Repository map

| Path                             | Responsibility                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/director/`             | React Director product and browser workspaces                                                                                                  |
| `backend/gateway/`               | TypeScript Gateway, jobs, media, collaboration, and tool HTTP for DSH / MCP                                                                    |
| `packages/`                      | Shared npm workspaces: protocol, agent-engine, dsh-plugin-workbench, project-schema, stage-protocol, dcc-*, model-provider, di, scene-pipeline |
| `packages/dsh-plugin-workbench/` | Director Stage / Canvas / Video / Blender tools as a DeepSeek Harness plugin                                                                   |
| `vendor/`                        | Official third-party Git submodules: DeepSeek Harness, LTX-2, Hunyuan3D-2, TRELLIS, ARDY. Do not fork them in-tree.             |
| `integrations/`                  | Blender live kernel, `.blend` interchange, portable Agent plugin                                                                               |
| `assets/`                        | Asset catalogs, manifests, provenance, and license metadata                                                                                    |
| `docs/site/`                     | Product and engineering documentation site                                                                                                     |
| `tools/scripts/`                 | Repository automation, local launchers, checks, reproducible tools                                                                             |
| `tools/`                         | Vite, Vitest, ESLint, TypeScript, and PostCSS/Tailwind configs                                                                                 |
| `tools/e2e/`                     | Playwright end-to-end tests (`npm run test:e2e`)                                                                                               |
| `tools/evals/`                   | Agent golden-task evals (`npm run eval`)                                                                                                       |

Generated scenes, build trees, and local checkpoints live under the ignored `.runtime/` directory.

The Agent harness is DeepSeek Harness (`vendor/deepseek-harness`). Director-specific
Stage, Canvas, Video Editor, and Blender operations live in
`packages/dsh-plugin-workbench`. Do not add another in-tree tool loop, session
store fork, or focused copy of DSH workspace/web/job tools.

## Commands

- `npm run dev` — gateway (`:8787`) plus Vite UI (`:5175`) together; `npm run dev:ui` / `npm run dev:gateway` individually.
- `npm test` — full vitest suite; scope with `npx vitest run --config tools/vitest.config.ts <path>`.
- `npm run test:e2e` — Playwright end-to-end tests.
- `npm run lint` — ESLint plus server import-boundary check. `npm run format:check` for Prettier.
- `npm run build` — typecheck, Vite build, chunk budget, and the portable MCP plugin.
- `npm run repo:check` — open-source boundary plus native agent integration checks (CI runs this).
- `npm run --silent stage -- director_workbench '{"op":"observe"}'` — gateway smoke test through the Stage CLI. Prefer MCP `director_workbench` when that server is connected; `npm run --silent stage -- --help` lists tools. Legacy `stage_*` names are HTTP-compatible only. `npm run stage --` prints an npm banner that breaks `JSON.parse`; use `--silent` or `node tools/scripts/stage-cli.mjs`.
- `npm run eval` — agent golden-task evals against an isolated gateway + headless workbench tab (see `tools/evals/README.md`).
- `npm run dsh` — prepare the Director workbench overlay and launch the pinned DeepSeek Harness Web profile on `:3080`.

Tooling configs live in `[tools/](tools/README.md)` (`vite.config.ts`, `vitest.config.ts`,
`eslint.config.js`, `tsconfig.json`, PostCSS/Tailwind). `package.json` stays at the repository
root. Prefer `npm run …` scripts; they pass `--config` / `-p` explicitly.

## Browser test lifecycle

- Reuse an existing suitable browser tab for UI inspection and testing. Do not create another
  browser instance when the current tab can run the required checks.
- Never launch Chrome or Chromium directly from a shell command. Do not use fixed remote-debugging
  ports, and do not run browser processes in the background or detached from their owning task.
- When a new browser is unavoidable, use Playwright and close every context and browser in a
  `finally` block so cleanup also runs after failures or interruption.
- Before ending the task, verify that every browser page and process created by the task has exited.
  Preserve the user's pre-existing browser tabs and unrelated browser processes.

## Director workbench skill

To control the live Director workbench (3D Stage, Canvas production DAG, Video Editor, Gallery,
generation and transcription jobs), read and follow
`[.claude/skills/director-workbench/SKILL.md](.claude/skills/director-workbench/SKILL.md)`.
The MCP server exposes `director_workbench` (Stage, generation, jobs), `director_creative`
(Canvas, Video, Gallery, interchange, collaboration), and `director_dcc` (Blender/DCC handoff).
Follow the invariant loop: capabilities/catalog → observe the exact target → one atomic intent →
observe/diff → audit → preview or deliver. Never automate the UI by screen coordinates when a
semantic operation exists.

## Conventions

- TypeScript is strict; validate untrusted data with Zod at system boundaries.
- Frontend tests live in `frontend/director/tests/` (mirroring `src/`). Gateway tests live in
  `backend/gateway/tests/` grouped by domain (mirroring gateway source; shared fixtures in
  `tests/fixtures/`). Shared npm packages under `packages/`
  keep tests in a sibling `tests/` directory (same layout as DeepSeek Harness). Vitest (jsdom)
  runs both.
- Stage scenes instance catalog meshes, Blender-authored geometry, or promoted generated-3D
  assets. White-box is a clay look, not a stack of Stage boxes. Public
  `director_workbench` author calls that set `geometry_type` are rejected; model missing
  architecture with `blender_native` or generate with `generated_3d`.
- UI copy is written in Simplified Chinese as the source language; add English translations to
  `frontend/director/src/comprehensive/i18n/en-US.json`.
- The workbench skill lives in `.claude/skills/director-workbench/`. `npm run sync:skills` generates
  the DSH-discoverable `.dsh/skills/director-workbench/` copy and the portable plugin copy. Project
  adapters exist only for Cursor (`.cursor/`), Codex (`.codex/`), and Claude Code (`.claude/`,
  `CLAUDE.md`, `.mcp.json`). Edit `AGENTS.md` and the canonical skill, then run `npm run sync:skills`.
- Generated adapters and skill copies must all launch the same MCP server; `npm run repo:check`
  verifies this (see `tools/scripts/agent-integrations.mjs`).

## MCP configuration per agent

These paths are generated from `tools/scripts/agent-integrations.mjs`. The Director MCP server
starts with `node --import tsx/esm backend/gateway/mcp-server.ts`
(`STAGE_GATEWAY_URL=http://127.0.0.1:8787`; manual run: `npm run mcp`).

| Agent       | Instructions                           | MCP configuration    |
| ----------- | -------------------------------------- | -------------------- |
| Claude Code | `CLAUDE.md` → this file                | `.mcp.json`          |
| Codex CLI   | `AGENTS.md` (this file)                | `.codex/config.toml` |
| Cursor      | `.cursor/rules/director-workbench.mdc` | `.cursor/mcp.json`   |

Start the app with `npm run dev`, reload the agent session so it discovers the MCP server, then
ask it to use the Director workbench.
