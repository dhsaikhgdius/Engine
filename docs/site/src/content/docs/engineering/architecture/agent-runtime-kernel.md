---
title: Agent runtime kernel
---

## Status

Superseded by the DeepSeek Harness cutover (2026-08-17). Director no longer hosts an in-tree
Agent run loop. Agent sessions, the tool loop, prompt assembly, session persistence, and the
generic workspace (`read` / `write` / `edit` / `glob` / `grep` / `bash` / `todo_write`), web
(`web_search` / `web_fetch`), job, and subagent tools all come from the official DeepSeek Harness
submodule (`vendor/deepseek-harness`), launched with `npm run dsh` on `http://127.0.0.1:3080`.

Director-specific Stage, Canvas, Video Editor, and Blender tools are contributed to DSH by the
Cordis plugin in `packages/dsh-plugin-workbench`. Each plugin tool POSTs to the running Gateway's
`POST /api/tools/:name` surface. MCP clients (`backend/gateway/mcp-server.ts`) and the Stage CLI
(`tools/scripts/stage-cli.mjs`) call that same HTTP surface. Do not re-add an in-tree tool loop,
session store fork, or hosted copies of DSH workspace/web/job tools.

## Runtime flow

```text
DeepSeek Harness session (vendor/deepseek-harness, npm run dsh)
  → @director/dsh-plugin-workbench tool call
  → Gateway POST /api/tools/*  (routes/stageRoutes.ts)
  → process-wide exact-target scheduler
  → Director project or Blender native scene
```

MCP and CLI clients skip the harness and enter directly at `POST /api/tools/*`.

## What the Gateway still owns

1. **Tool HTTP surface and exact-target scheduling.** `routes/stageRoutes.ts` plus
   `agents/agentToolScheduler.ts`: explicitly read-only calls may run with bounded concurrency
   and return in original call order; calls bound to the same exact Director target share a
   process-wide reader/writer queue across sessions and clients; mutations are exclusive, and
   queued cancellations are removed before browser dispatch. Blender keeps its own revisioned
   transaction boundary.
2. **Compact operation envelopes.** Domain tools advertise one compact envelope per tool
   (`agents/agentToolRegistry.ts`, re-exported from the DSH plugin). Exact fields are disclosed
   on demand through `describe` and `capabilities`, while the Gateway validates every execution
   against the complete strict schema. Large operation unions therefore do not consume model
   context on every tool round.
3. **Film role tool policy.** `agents/filmRoleToolPolicy.ts` restricts which tools and operations
   a `FilmRoleId` can see and call; MCP and the DSH plugin apply the same policy.
4. **Model-facing result projection.** `agents/agentToolResultProjection.ts` summarizes oversized
   tool results (heavy collections above 48 items, or envelopes above the 12,288-byte budget)
   into counts, bounded id samples, and a retrieval hint. The MCP response builder
   (`mcpToolResponse.ts`) and the DSH plugin consume it; raw HTTP/CLI responses stay complete.
   Capture bytes never ride in serialized model JSON — images travel as MCP image blocks.
5. **Revision memory for stateless clients.** `agents/agentToolMemory.ts` lets the MCP server
   inject the last observed workbench revision into guarded writes and retry once on a stale
   revision.
6. **Model provider configuration for structured LLM calls.** `agents/agentProfileRegistry.ts`,
   `agents/agentApiProviderStore.ts`, `agents/agentApiModels.ts`, and
   `agents/modelProviderIntegration.ts` resolve hosted API profiles for the film pipeline and
   multi-agent production runs, backed by the wire drivers in `packages/model-provider`. These
   serve structured film-pipeline calls, not a conversation loop.

## Main modules

| Module                                                | Responsibility                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `vendor/deepseek-harness`                             | Agent loop, sessions, workspace/web/job/subagent tools (submodule) |
| `packages/dsh-plugin-workbench/`                      | Director Stage / Canvas / Video / Blender tools as a DSH plugin    |
| `backend/gateway/routes/stageRoutes.ts`               | Tool HTTP surface, target discovery, capture, guarded writes       |
| `backend/gateway/agents/agentToolScheduler.ts`        | Ordered call windows and process-wide exact-target barriers        |
| `backend/gateway/agents/agentToolRegistry.ts`         | Compact wire schemas and timeouts, re-exported from the DSH plugin |
| `backend/gateway/agents/agentToolResultProjection.ts` | Counts + id-sample summaries for oversized model-facing results    |
| `backend/gateway/agents/filmRoleToolPolicy.ts`        | FilmRole tool and operation policy                                 |
| `backend/gateway/mcp-server.ts` / `mcpToolResponse.ts`| MCP stdio surface with projection and capture-byte stripping       |
| `packages/model-provider/src/runtime/`                | Provider wire, streaming, retry, and usage for structured calls    |

Removed at the cutover — do not document or re-create them: the in-tree `AgentHarness` run loop
(`backend/gateway/agentHarness.ts`), `agentSessionStore.ts`, `agentAdapters.ts`, the hosted
workspace tool copies (`backend/gateway/agents/workspace/`), the hosted `web_search` / `web_fetch`
copies (`backend/gateway/agents/web/`), `agents/agentToolPipeline.ts`,
`agents/localDirectorToolDispatch.ts`, `agents/agentPluginSettingsStore.ts`, and the hosted
session history, replay, and surface-meter modules.
