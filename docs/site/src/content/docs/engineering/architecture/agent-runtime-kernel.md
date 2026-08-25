---
title: Agent runtime kernel
---

## Status

Implemented. Director owns one Agent runtime kernel in the TypeScript Gateway. Provider bridges may translate external protocols, but they do not own separate session state, queues, or Director tool policy.

## Runtime flow

```text
AgentSessionStore
  → shared session projection
  → durable inbox
  → AgentHarness owned run
  → provider bridge
  → canonical tool registry and execution pipeline
  → process-wide exact-target scheduler
  → Director project or Blender native scene
```

The durable event stream is the lifecycle source of truth. `agent_sessions` is a materialized projection updated in the same transaction as each event. The browser applies the same reducer from `@director/agent-engine/session-projection`; it does not maintain a second lifecycle state machine.

## Invariants

1. A retained session keeps its complete ordered event stream. Session-level retention may remove an expired session and its owned rows, but individual event appends never trim earlier events.
2. Queue payload changes and `queue.updated` events commit together. Work left running by a stopped Gateway is returned to the queue on startup and the open turn becomes interrupted.
3. One session owns at most one active turn. `whenIdle()` includes owned turns and scheduled inbox drains.
4. Shutdown first stops Provider work, records any remaining turn as interrupted, waits for quiescence, flushes buffered deltas, and only then closes SQLite.
5. Codex dynamic tools and hosted model tools use the same registry, role policy, timeout policy, target check, revision memory, result projection, spill storage, and outcome normalization. Inside the Gateway process they invoke `handleStageRoute` directly; MCP, CLI, and `blender_native` still use `POST /api/tools/*`.
6. Explicit read-only tool windows may run with bounded concurrency and return results to the model in original call order. Workbench and Creative calls bound to the same exact Director target share a process-wide reader/writer queue across sessions and providers; mutations are exclusive, and queued cancellations are removed before browser dispatch. Blender keeps its own revisioned transaction boundary.
7. Domain tools advertise one compact operation envelope to every model provider. Exact fields are progressively disclosed through `describe` and `capabilities`, while the Gateway continues to validate every execution against the complete strict schema. Large operation unions therefore do not consume the model context on every tool round.
8. Provider drivers normalize prompt usage into disjoint uncached-input, cache-read, and cache-write buckets. Every model round appends its own usage event, so cache hit rate, cumulative billing input, and latest context occupancy are derived without Provider-specific guessing in the browser.
9. `@director/model-provider/runtime` owns the OpenAI-compatible and Anthropic wire implementations. Provider facades and the Gateway use those same Drivers; the legacy Gateway module paths are compatibility exports, not a second protocol stack. All production Driver construction passes through `createModelDriver`. Built-in model metadata, endpoints, credential environment variables, and factories come from one `builtinProviders` profile table.
10. Hosted Agent capabilities resolve in one order: conservative protocol defaults, exact built-in model metadata when known, then explicit user overrides. The browser re-exports the same `@director/agent-engine/runtime-schema` contract used by the Gateway.

## Main modules

| Module                                                | Responsibility                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/agent-engine/src/agentSessionProjection.ts` | Shared event-to-session reducer                                   |
| `packages/model-provider/src/runtime/`                | Canonical Provider wire, streaming, retry, cache, and usage logic |
| `packages/model-provider/src/builtinProviders.ts`     | Built-in model descriptors, endpoints, credentials, and factories |
| `packages/agent-engine/src/agentRuntimeSchema.ts`     | Shared Agent profile and model capability wire contract           |
| `backend/gateway/agentSessionStore.ts`                | SQLite event log, projections, inbox, recovery, batched appends   |
| `backend/gateway/agentHarness.ts`                     | Run ownership, queue scheduling, cancellation, quiescent shutdown |
| `backend/gateway/agents/agentToolRegistry.ts`         | Canonical compact wire schemas, definitions, timeouts, modes      |
| `backend/gateway/agents/workspace/`                   | Workspace tools plus sandboxed foreground Bash                    |
| `backend/gateway/agents/web/`                         | Hosted `web_search` / `web_fetch` (DSH seam, DeepSeek official + Exa + HTTP) |
| `backend/gateway/agents/agentPluginSettingsStore.ts`  | Plugins page: search provider/key, agent-loop concurrency         |
| `backend/gateway/agents/agentToolPipeline.ts`         | Policy, target routing, execution, bounded model result           |
| `backend/gateway/agents/localDirectorToolDispatch.ts` | In-process Stage-route dispatch for Hosted and Codex              |
| `backend/gateway/agents/agentToolScheduler.ts`        | Ordered call windows and process-wide exact-target barriers       |
| `backend/gateway/agentAdapters.ts`                    | Codex and Claude protocol translation                             |

Claude still communicates through the portable MCP process because its CLI owns that transport. They share the same Gateway contracts and role policy; Provider-specific message formatting remains at the bridge boundary.

## Workspace Bash boundary

Hosted Bash is not the node-pty terminal used to embed external coding CLIs. Each call starts one fresh, non-interactive foreground process and returns stdout, stderr, exit code, deadline, truncation, and sandbox-denial facts. A non-zero process exit is a completed tool call, not a Gateway transport failure.

The Gateway selects macOS Seatbelt or Linux Bubblewrap at runtime. If neither is available, the capability reports unavailable and refuses execution rather than silently running an unconfined shell. Writes are limited to the Director workspace and temporary directories; a filtered environment keeps Gateway credentials out of the child. Background jobs and permission elevation remain separate future capabilities.

## Remaining boundary

An Agent checkpoint currently stores the Director project snapshot. Blender native revisions are recorded in events but are not yet restored atomically with that project snapshot. A future unified checkpoint must bind the Director project revision to a Blender scene revision or native savepoint; until then, restore responses must continue to identify the Director-only scope.
