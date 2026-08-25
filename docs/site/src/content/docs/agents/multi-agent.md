---
title: Multi-Agent Production
description: Route film roles to model Profiles and run Director's durable serial production graph.
---

Director can run local coding Agents and hosted model APIs through one durable session harness. A
**Profile** is server-owned model/runtime configuration; a **film role** determines the operating
instructions and, through shared `filmRoleToolPolicy.ts`, the allowed Director tools on MCP, the
local Agent harness, and the hosted API adapter. Raw HTTP and human UI actions are not gated by
that policy.

This implementation is a fixed, durable **serial production graph**. It is not a dynamic DAG and
does not currently schedule nodes in parallel or let a model rewrite the graph while it runs.

## Configure hosted Profiles

Set `DIRECTOR_AGENT_PROFILES_JSON` before starting the gateway. The value is a strict JSON array;
unknown properties, duplicate or reserved IDs, invalid URLs, and invalid credential environment
variable names fail startup.

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'
export DIRECTOR_AGENT_PROFILES_JSON='[
  {
    "id":"openai-director",
    "label":"OpenAI Director",
    "driver":"openai",
    "model":"your-openai-model-id"
  },
  {
    "id":"claude-camera",
    "label":"Claude Camera",
    "driver":"anthropic",
    "model":"your-anthropic-model-id"
  },
  {
    "id":"openai-critic",
    "label":"OpenAI Visual Critic",
    "driver":"openai",
    "model":"your-vision-model-id"
  }
]'
```

Supported hosted drivers are `openai`, `anthropic`, and `openai-compatible`. OpenAI and Anthropic
use their native wire protocols. An OpenAI-compatible Profile must set `baseUrl`; it may omit a
credential only when the endpoint itself is loopback. Secrets remain in the gateway and are not
returned by discovery, events, or durable conversation files.

Local Profiles are registered automatically when their CLI is available:

| Profile ID     | Provider | Runtime               |
| -------------- | -------- | --------------------- |
| `codex-local`  | `codex`  | Codex app server      |
| `claude-local` | `claude` | Claude streaming JSON |
| `api-default`  | `api`    | Legacy compatible API |

Discover only public metadata with `GET /api/agent/profiles`. The response includes availability,
model, endpoint host, and capability flags, but never API keys or their environment-variable names.

## Route roles to Profiles

Server defaults are a strict, partial role map:

```bash
export DIRECTOR_AGENT_ROLE_PROFILES_JSON='{
  "stage-director":"openai-director",
  "cinematographer":"claude-camera",
  "visual-critic":"openai-critic",
  "repair-operator":"openai-director"
}'
```

The Profile for each node is resolved once, in this order:

1. `profileByRole[role]` in the production-run request;
2. the same role in `DIRECTOR_AGENT_ROLE_PROFILES_JSON`;
3. the run's `profileId` fallback, which defaults to `api-default`.

The resolved Profile ID is copied into the durable node. Resume therefore cannot silently move a
completed or pending node to a newly configured model.

A run has one `provider`. Every selected Profile must belong to that provider. Multiple hosted
OpenAI, Anthropic, and compatible Profiles can be mixed because all use provider `api`; a single run
cannot mix `codex-local` and API Profiles. Before creation, Director also requires tool support from
every Profile and both vision and tool support from a `visual-critic` Profile.

## Default production graph

When `roles` is omitted, Director creates these nodes in order:

```text
showrunner
  → screenwriter
  → continuity-supervisor
  → shot-planner
  → stage-director
  → cinematographer
  → visual-critic
  → repair-operator
  → visual-critic
  → generation-operator
  → editor
```

The second Critic pass evaluates the repair result. A request may supply a shorter ordered `roles`
array, but execution remains serial. Each node receives explicitly assigned input artifacts or, when
none are assigned, at most the three most recent upstream artifacts.

Every node creates a durable Agent session. Its final text and bounded structured tool receipts
become an immutable, SHA-256-addressed artifact. Director labels an artifact as a
`director-receipt` or `generation-receipt` only when a completed tool result contains the expected
revision, package, or generation job evidence; prose alone remains a `role-report`.

## Role guardrails

MCP, the local Agent harness, and the hosted API adapter share these tool policies in
`backend/gateway/agents/filmRoleToolPolicy.ts`:

| Role group                                       | Allowed work                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Showrunner, writer, continuity, shot planner     | Stage reads plus read-only Workbench and creative operations                         |
| Stage director, cinematographer, repair operator | Stage and Workbench authoring; no `stage_video` or creative edits                    |
| Visual critic                                    | Stage reads, Blender inspect, Workbench capture/shot_ir, and read-only creative |
| Generation operator                              | `stage_video`, Canvas pipeline configure/start/cancel, and otherwise read-only       |
| Editor                                           | Creative workspace operations and Stage reads                                        |

Tool input is still validated by the same runtime schemas used by HTTP and MCP. A role policy is an
additional restriction, not a replacement for target, revision, idempotency, asset, or quality
guards.

## Exact target binding

Every run is pinned to the complete target returned by a current Workbench observation:

```json
{
  "token": "opaque-target-token",
  "client_id": "browser-client-id",
  "instance_id": "project-instance-id",
  "scene_id": "scene-id",
  "creative_scope_id": "scope-id",
  "contract_version": 2
}
```

The gateway checks all fields, not just the token. If that tab disconnects, reloads into another
instance, changes scene/scope, or returns a mismatched response, the operation fails closed. Director
does not fall back to another visible tab. Observe again and create a new run when the intended target
has materially changed.

## Durability and recovery

Runs are atomically stored under `data/multi-agent-runs/`; Agent sessions and events are stored in
`data/director-agent-sessions.sqlite` using SQLite WAL mode.

- `POST /api/agent/runs` returns `202` after the durable run is created and schedules execution.
- Poll `GET /api/agent/runs/{id}` for node status, artifacts, and errors.
- `POST /api/agent/runs/{id}/cancel` interrupts the active session and marks running and pending
  nodes cancelled.
- `POST /api/agent/runs/{id}/resume` preserves successful nodes and resets every other node to
  pending. It reuses the pinned Profile IDs and target.

If a node fails, later nodes do not run. Before resume, reconnect the exact target and resolve the
reported provider, approval, capability, or tool error. Do not edit run JSON by hand.

## Current limits

- The production graph is a serial ordered list, not a dependency-aware or model-authored DAG.
- There is no parallel node scheduling, speculative branch, automatic re-planning, or quorum vote.
- The current Workbench panel exposes a focused Stage subset; the complete default graph is available
  through the HTTP run API.
- Provider availability and capability declarations are checked before creation, but a remote model
  or browser target can still fail during execution.
- A successful receipt proves a tool result, not aesthetic quality. The visual Critic must inspect
  clean image evidence before generation or editorial approval is trusted.

See [HTTP API](/reference/http-api/) for bootstrap, authenticated requests, and runnable examples.
