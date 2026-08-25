---
title: Agent runtime kernel
---

## Status

Superseded by the DeepSeek Harness integration. Director no longer owns an in-house Agent runtime kernel: the tool loop, session store, prompt assembly, and the workspace / web / job tools come from `vendor/deepseek-harness` (DSH). Director's creative surface is the Cordis plugin `packages/dsh-plugin-workbench/`, which registers the Director tools and system guidance into DSH. The earlier in-house modules this page used to describe (`AgentSessionStore`, `AgentHarness`, `agentToolPipeline`, provider adapters) have been removed from the Gateway.

## Runtime flow

```text
DSH session (vendor/deepseek-harness, loop + session + prompts)
  → Cordis plugin packages/dsh-plugin-workbench (director_workbench / director_creative /
    stage_video / blender_native / director_model_routes)
  → POST /api/tools/:name on the Gateway
  → handleStageRoute (backend/gateway/routes/stageRoutes.ts)
  → scheduler window / revision guard / role policy
  → Director project (browser Stage) or Blender native scene
```

Coding agents (Cursor, Claude Code, Codex) reach the same Gateway contracts through `backend/gateway/mcp-server.ts`, which exposes `director_workbench`, `director_creative`, and `director_dcc` over MCP. Both surfaces validate against the same strict schemas and share the same tool-result projection.

## Invariants

1. The Gateway is stateless with respect to the agent loop. Session history, turn ownership, queueing, and compaction belong to DSH; Director never re-implements them.
2. Every mutation validates `expected_revision` against the live project and returns the new revision. Stale-revision rejections carry the current revision so the caller can re-observe and retry.
3. Explicit read-only tool windows may run with bounded concurrency and return results in original call order. Calls bound to the same exact Director target share a process-wide reader/writer queue across sessions and surfaces (`agents/agentToolScheduler.ts`); mutations are exclusive. Blender keeps its own revisioned transaction boundary.
4. Domain tools advertise one compact operation envelope to every model surface. Exact fields are progressively disclosed through `describe` and `capabilities` (`agents/agentToolRegistry.ts`), while the Gateway continues to validate every execution against the complete strict schema.
5. Oversized tool results are summarized before they reach the model. The canonical projection lives in `packages/dsh-plugin-workbench/src/toolResultProjection.ts` and is wired into both the DSH plugin result path and `createMcpToolResponse`; encoded media payloads are stripped from text/JSON and delivered once through the attachment channel.
6. Mutations carry `idempotency_key`; replays are answered from tool memory (`agents/agentToolMemory.ts`) instead of re-executing.
7. Public authoring calls that set Stage `geometry_type` are rejected. Missing architecture is modeled with `blender_native` (`create_blockout` / `create_opening`) or generated with `generated_3d`; white-box is a clay look, not stacked Stage boxes.

## Main modules

| Module                                                      | Responsibility                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `vendor/deepseek-harness`                                   | Tool loop, session store, prompt assembly, workspace/web/job tools  |
| `packages/dsh-plugin-workbench/src/register.ts`             | Director tool registration and `DIRECTOR_AGENT_GUIDANCE`            |
| `packages/dsh-plugin-workbench/src/catalog.ts`              | Model-facing tool schemas projected from `packages/protocol` Zod    |
| `packages/dsh-plugin-workbench/src/toolResultProjection.ts` | Canonical oversized-result summarization and media stripping        |
| `backend/gateway/routes/stageRoutes.ts`                     | `POST /api/tools/:name` execution for every surface                 |
| `backend/gateway/agents/agentToolRegistry.ts`               | Canonical compact wire schemas, definitions, timeouts, modes        |
| `backend/gateway/agents/agentToolScheduler.ts`              | Ordered call windows and process-wide exact-target barriers         |
| `backend/gateway/agents/agentToolMemory.ts`                 | Idempotency replay keyed by `idempotency_key`                       |
| `backend/gateway/agents/agentToolOutcomes.ts`               | Outcome normalization (`completed` / `failed` / `stale_revision` …) |
| `backend/gateway/agents/filmRoleToolPolicy.ts`              | Role-scoped tool and operation restrictions                         |
| `backend/gateway/mcp-server.ts`                             | MCP surface for coding agents (Cursor / Claude Code / Codex)        |

`npm run dsh` prepares the Director workbench overlay and launches the pinned DSH Web profile on `:3080`. `npm run mcp` starts the MCP server for coding agents against the Gateway on `:8787`.

## Remaining boundary

Director project revisions and Blender native scene revisions are separate transaction boundaries. A Blender edit session is fenced by its own snapshot fingerprint and revision chain; there is no atomic checkpoint that binds a Director project revision to a Blender scene revision. Until such a unified checkpoint exists, restore responses must continue to identify the Director-only scope.
