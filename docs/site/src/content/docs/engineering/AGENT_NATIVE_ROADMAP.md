---
title: Agent-Native Optimization Roadmap
description: Phased plan to improve UI/agent parity, unified action model, governance, and team readiness based on the architecture assessment.
---

This roadmap turns gaps from the
[Agent-Native Architecture Assessment](/research/agent-native-architecture-assessment/)
into shippable milestones. The goal is to move Director from "agent-native on core paths" to
"full parity plus unified governance" without replacing Stage, Canvas, Video, or Agent stores in
one migration.

Drafted: **2026-08-02**. Last verified: **2026-08-25**.

## Completed foundation — naive caller boundary

The shared public boundary is implemented for the current mutation surfaces. A caller may submit
the semantic intent without first managing a browser lease, revision/fingerprint, or retry key.
Director discovers one exact target, performs the required read-only preflight, injects missing
guards/keys, and returns a structured `agent_boundary` receipt. Browser execution remains strict,
and exact retries are either replayed, rejected as changed-key reuse, or rejected as stale.

Covered surfaces: Workbench project mutations and evidence, Production CRUD, Creative edits,
Canvas pipeline start, collaboration comments, durable generation/transcription/3D submit and
retry, generated-3D promotion, Storyboard capture/export, and Blender native apply. This closes
the transport-safety foundation; the remaining milestones concern UI/action parity, governance,
collaboration breadth, and observability rather than naive-call correctness.

Blender `apply` snapshots and injects a missing native epoch, revision, and intent ID. If its
post-dispatch outcome is unknown, the Gateway returns the complete bound input as the exact retry ticket.

Related docs:

- [Agent-native Production](/concepts/agent-native-production/) — control loop and contracts
- [Feature Status](/reference/feature-status/) — current capability boundaries
- [Pipeline implementation roadmap](/engineering/pipeline_implementation_roadmap/) — data model and ProductionGraph evolution (runs in parallel; coordinate at M6)

---

## North star

By the end of **Milestone 4**, Director should:

1. Expose a **semantic action for every documented UI mutation**; agents and UI share one executor.
2. Automate **Interchange / Collaboration / Media** without human-only panels.
3. Apply the **same role and audit policy** across MCP, HTTP, CLI, and hosted API.
4. Keep Structured Agent control **Implemented** in Feature Status, with parity tests covering main workspaces.

Target: raise the self-assessment score from **4/5 → 4.5/5**.

---

## Delivery rules

1. **Contract before UI** — new actions land in Zod schemas and tests before React changes.
2. **Do not weaken revision guards** — after UI convergence, `expected_revision` / `snapshot_fingerprint` behavior must not regress.
3. **Every user-facing mutation needs an agent recovery test** — same rule as the [Pipeline roadmap](/engineering/pipeline_implementation_roadmap/).
4. **Human-only capabilities stay explicit** — update `capabilities`, Skills, and Feature Status until JSON surfaces ship.
5. **Milestones merge independently** — each milestone leaves the product releasable.
6. **`stage_*` only shrinks** — new automation uses `director_workbench` / `director_creative`; legacy `stage_*` is maintained, not extended.

---

## Phase overview

| Phase  | Theme                      | Status          | Main outputs                                                                                                 | Depends on              |
| ------ | -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- |
| **M0** | Baseline & metrics         | Planned         | UI/agent parity inventory, parity harness                                                                    | —                       |
| **M1** | Shared action registry     | Planned         | High-traffic UI paths via `applyDirectorAuthoringActions`                                                    | M0                      |
| **M2** | Remove human-only surfaces | **Implemented** | Interchange export + import (plan-import/import) and collaboration reads/writes (resolve, version create/restore, …) are JSON operations | M1 (partially parallel) |
| **M3** | Unified gateway governance | **Implemented** | Shared `filmRoleToolPolicy` on MCP / local / hosted / raw HTTP+CLI; source-tagged `/api/tools/*` audit trail | M1                      |
| **M4** | In-product workspace       | Planned         | SQL-backed instructions / skills / memory                                                                    | M3                      |
| **M5** | Observability              | Planned         | Traces, cost, long-running progress                                                                          | M3                      |
| **M6** | Team readiness             | Planned         | Collaboration auth, multi-agent enhancements                                                                 | M3, M5                  |
| **M7** | Ecosystem protocols        | **Partial**     | Tool manifest shipped (`GET /api/control-plane/tool-manifest`); A2A spike concluded no-go / deferred         | M2, M3                  |

```mermaid
flowchart LR
  M0[M0 Baseline] --> M1[M1 Action Registry]
  M1 --> M2[M2 JSON Surfaces]
  M1 --> M3[M3 Governance]
  M3 --> M4[M4 Workspace]
  M3 --> M5[M5 Observability]
  M3 --> M6[M6 Team Ready]
  M2 --> M7[M7 Ecosystem]
  M3 --> M7
```

---

## Milestone 0 — Baseline & metrics

**Goal:** make parity work measurable and regression-testable.

### Work

- Audit all `directorStore` mutation entry points; produce a **UI mutation inventory**.
- Map against `directorAuthoringActionSchema`; label **parity gaps** (high / medium / low).
- Add a **parity harness** test suite:
  - given authoring actions → UI executor and agent executor produce the same revision;
  - failures emit diffs, not only boolean assertions.
- Add **Agent UI parity coverage** to Feature Status (percentage + link to inventory).
- Document `stage_*` → `director_workbench` **migration map** (op mapping, deprecation timeline).

### Acceptance

- Inventory covers top 20 mutation paths across Stage, Canvas, and Video.
- Parity harness passes for the current `directorAuthoring` action set.
- No runtime behavior changes.

### Suggested PR order

1. Inventory doc + optional generator (`tools/scripts/auditUiMutations.ts`)
2. Parity harness framework + 5 seed cases
3. Feature Status and assessment cross-links

---

## Milestone 1 — Shared action registry

**Goal:** UI and agents share one mutation path; eliminate dual writes.

### Work

#### 1.1 UI dispatch layer

- Add `dispatchDirectorAuthoringActions(actions, context)` — thin UI wrapper that:
  - fills `expected_revision` / `idempotency_key`;
  - hooks unified error toasts and undo;
  - calls `applyDirectorAuthoringActions` internally.
- Same pattern for Canvas/Video via `creativeWorkspaceAgentContract`.

#### 1.2 Migrate UI mutations in batches

| Batch  | Scope                   | Typical actions                                   |
| ------ | ----------------------- | ------------------------------------------------- |
| **1a** | Object CRUD, transforms | `create_object`, `update_object`, `delete_object` |
| **1b** | Cameras and shots       | `create_camera`, `update_camera`, `frame_camera`  |
| **1c** | Characters and motion   | `assign_motion`, `update_character_pose`          |
| **1d** | Timeline / coverage     | `create_coverage`, `assign_take`                  |
| **1e** | Canvas nodes / edges    | creative `author` batches                         |
| **1f** | Video tracks / clips    | creative `author` batches                         |

#### 1.3 Semantic equivalents for interactive controls

- **Viewport drag** → debounced `update_object` author batches.
- **Camera pilot** → `update_camera` stream or new `pilot_camera` action (schema extension).
- Operations that cannot be semanticized stay human-only and appear in capabilities exclusions.

#### 1.4 Converge `stage_*`

- Mark `stage_*` as **legacy compact surface** in MCP, docs, and Skills.
- All new automation examples use `director_workbench`.
- Do not delete `stage_*`; freeze op expansion.

### Acceptance

- Parity harness covers batches **1a–1d** with matching revisions on UI and agent paths.
- No new high-priority "UI-only, no agent twin" gaps.
- Existing MCP / HTTP / CLI integration tests pass.

### Risks

| Risk                            | Mitigation                                     |
| ------------------------------- | ---------------------------------------------- |
| UI perf regression per revision | Local batching; debounced author for drags     |
| Undo/redo vs author batches     | Wire existing undo in M1; unify receipts in M4 |

---

## Milestone 2 — Remove human-only surfaces

**Status: Implemented** (verified 2026-08-25).

**Goal:** Interchange, Collaboration, and Media are reachable through JSON operations with plan/receipt.

### Shipped

`director_creative` exposes:

| Surface                     | Actions                                                                                                                                                                                                | Evidence                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interchange export          | `capabilities`, `plan-export`, `export`                                                                                                                                                                | `packages/protocol/src/creativeWorkspaceProtocol.ts`, Creative Agent tests, [Interchange](/pipelines/interchange/)                                                |
| Interchange import          | `plan-import` (`inline` / `media_id` / `workspace_path` sources), `import` (guard-fingerprint recheck + atomic commit + receipt)                                                                       | same protocol, `frontend/director/src/agent/creativeWorkspaceSemanticOperations.ts`, `frontend/director/tests/agent/creativeWorkspaceSemanticOperations.import.test.ts` |
| Collaboration reads/writes  | `observe`, `list-comments`, `add-comment`, `resolve-comment`, `reopen-comment`, `update-comment`, `delete-comment`, `list-versions`, `compare`, `create-version`, `restore-version`, `delete-version` | same protocol + semantic-operation tests (`creativeWorkspaceSemanticOperations.test.ts`)                                                                          |
| Gallery / media mutations   | `gallery.media.*`, `media.proxy.attach`, and related execute ops                                                                                                                                       | Feature Status Gallery **Implemented**; persistent media **Limited**                                                                                              |

The Skill already lists JSON `plan-import` / `import` as the preferred import path; the human
Interchange menu file picker remains available.

### Retained boundaries

- OBJ/STL stay export-only; the Feature Status **Limited** Fountain / OTIO / glTF / USD subset boundaries are unchanged.
- `workspace_path` sources require a trusted host resolver; a plain browser target rejects them explicitly and points at `inline` or `media_id`.
- Large media bytes still never enter Yjs.

---

## Milestone 3 — Unified gateway governance

**Status: Implemented** (verified 2026-08-25). Optional UI permission gating and confirmation boundaries continue as follow-ups.

**Goal:** every control surface obeys the same permission and audit policy.

### Shipped

Role policy lives in `backend/gateway/agents/filmRoleToolPolicy.ts` (not a separate `gatewayToolPolicy.ts`). MCP, the local Agent harness, the hosted API adapter, and the raw gateway HTTP tool boundary share it:

| Surface        | Binding                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP            | `DIRECTOR_FILM_ROLE` in `backend/gateway/mcp-server.ts`                                                                                                                                                                        |
| Local harness  | `agentAdapters.ts` prompt + `filmRoleToolPolicyRejection` before tool dispatch                                                                                                                                                 |
| Hosted adapter | `openAiCompatibleAdapter.ts` visibility + rejection                                                                                                                                                                            |
| Raw HTTP / CLI | `backend/gateway/agents/httpToolPolicy.ts` on every `/api/tools/*` route (`DIRECTOR_FILM_ROLE` + `DIRECTOR_PLAN_MODE`, same 403 rejection body as MCP; covers the Stage CLI and the DSH plugin, which POST to the same routes) |

#### 3.1 Raw HTTP and CLI permissions (shipped)

- `filmRoleToolPolicy` now gates raw `POST /api/tools/{tool-name}` (and therefore the CLI and DSH plugin) through the shared `httpToolPolicyRejection` helper, before any browser-target execution.
- An unknown `DIRECTOR_FILM_ROLE` fails closed with the same structured rejection.

#### 3.2 Unified audit trail (shipped)

- Every `/api/tools/*` invocation is appended to a gateway-local audit log (`backend/gateway/agents/toolInvocationAuditStore.ts`, JSONL under the control-plane data directory), tagged `source: ui | mcp | http | cli | dsh | unknown` derived from the payload `session_id` prefix.
- Structured fields: `tool`, `operation`, `revision_before`, `revision_after`, `idempotency_key`, `role`, `session_id`, `outcome`, `http_status`, redacted error code/message.
- `GET /api/agent/audit` (gateway-authorized) lists records with `session_id` / `source` / `tool` filters and an `after` cursor.

### Remaining

#### 3.1b Optional UI permission gating

- Optional: read-only mode and role-gated UI disable from the same policy source. UI-dispatched author actions are not yet written to the unified audit trail.

#### 3.3 Confirmation boundaries

- Define destructive/publish actions (`deliver`, `export`, `version_restore`, etc.).
- Agent path: harness approval or explicit `confirm_token`.
- UI path: existing modals; shared `confirm_token` generation.

### Acceptance

- Denied MCP ops are also denied on raw HTTP/CLI for the same role — done (`backend/gateway/tests/routes/httpToolPolicyRoutes.test.ts`).
- Audit log reconstructs a tool chain across HTTP/CLI/MCP/DSH entry points via `GET /api/agent/audit` — done (`backend/gateway/tests/routes/agentAuditRoutes.test.ts`). UI-dispatched author actions remain out of scope until UI gating lands.
- Governance tests cover HTTP bypass cases — done; UI bypass cases remain with 3.1b.

---

## Milestone 4 — In-product agent workspace

**Goal:** team instructions, skills, and memory live in SQLite and are editable in-app.

### Work

- Add `agent_workspace` tables (org / user scope):
  - `instructions` (AGENTS.md equivalent)
  - `learnings` (LEARNINGS.md equivalent)
  - `skill_refs`
  - `memory_entries` (structured KV with TTL)
- Workbench harness merges: repo Skills → DB workspace → session override.
- UI: **Settings → Agent Workspace** editor with version history.
- Migrate or merge with `DIRECTOR_AGENT_PROFILES_JSON`.

### Acceptance

- DB instruction edits appear in new sessions without repo changes.
- Export/import workspace bundle (JSON) for clone workflows.
- Redaction matches existing harness rules.

---

## Milestone 5 — Observability

**Goal:** supervise and measure long-running, multi-step agent work.

### Work

- **Trace view**: per-session tool chain, revision changes, capture thumbnails.
- **Cost / latency**: aggregate tokens, wall time, retries from provider adapters.
- **Progress API**: unified schema for video jobs, multi-agent runs, DCC exports.
- **Eval hooks**: optional rubric scores after deliver, stored as session artifacts.

### Acceptance

- Workbench UI or `/agent/traces` shows the latest production run.
- Feature Status Observability moves from Partial → Implemented.

---

## Milestone 6 — Team readiness

**Goal:** multi-user collaboration and multi-agent orchestration reach hosted trial quality.

### Work

- Collaboration: **room auth**, invite tokens, server snapshot policy.
- Multi-agent: configurable graph beyond fixed serial DAG; safe parallel critic + operator.
- Deployment: internet-facing hardening checklist (auth, rate limits, CORS, secret rotation).
- Lightweight org model: users, roles, shared workspace (SQLite-first).

### Acceptance

- Two humans plus an agent editing one scene produces predictable, auditable conflicts.
- Multi-agent runs resume from checkpoints (extend existing Experimental path).
- Deployment doc lists minimum production configuration.

### Coordination with Pipeline roadmap

- ProductionGraph v1 (Pipeline M1) supplies cross-workspace identity — multi-agent here should consume graph IDs, not ad hoc strings.

---

## Milestone 7 — Ecosystem protocols

**Status: Partial** (verified 2026-08-25).

**Goal:** interoperate with other agent-native apps.

### Shipped

- **Tool manifest export**: `GET /api/control-plane/tool-manifest` generates a machine-readable
  tool catalog from the same Zod schemas that validate execution (`director_workbench`,
  `director_creative`, `director_dcc`, `blender_native`, `stage_video`, `director_production`,
  `director_film`), each entry carrying its description, JSON Schema input contract, and operation
  names; frozen `stage_*` compatibility tools are marked `legacy: true`. It shares the same
  authentication and no-secrets exposure policy as `/api/control-plane/capabilities`.
  Evidence: `backend/gateway/controlPlane/toolManifest.ts` + `controlPlaneRoutes.test.ts`.

### A2A spike conclusion: no-go / deferred

Wrapping the gateway as an A2A agent card is currently a **no-go**: MCP plus the HTTP tool
manifest already cover the discovery needs of cross-app orchestration, while A2A would introduce
a second session and identity model with no current consumer asking for it. Revisit after M3
unified governance lands and a real external A2A consumer appears. No new protocol is implemented.

### Remaining

- **Cross-app recipe**: document receipt handoff (e.g. Director deliver → external video post).

### Acceptance

- `GET /api/control-plane/tool-manifest` returns a machine-readable tool catalog. ✅
- A2A spike produces a written conclusion; implementation is optional. ✅ (no-go / deferred, above)

---

## Suggested timeline (indicative)

At **~2 weeks per milestone** (adjust for capacity):

| Period      | Milestone                                |
| ----------- | ---------------------------------------- |
| Weeks 1–2   | M0 Baseline                              |
| Weeks 3–6   | M1 Shared actions (6 PR batches)         |
| Weeks 5–8   | M2 JSON surfaces (parallel with late M1) |
| Weeks 7–8   | M3 Governance                            |
| Weeks 9–10  | M4 Workspace                             |
| Weeks 11–12 | M5 Observability                         |
| Weeks 13–16 | M6 Team readiness                        |
| Weeks 17–18 | M7 Ecosystem                             |

**Critical path:** M0 → M1 → M3. M2 can parallel late M1; M4–M7 depend on M3.

---

## Out of scope

- Replacing Zustand with a remote CRDT primary store
- Full SaaS multi-tenant billing
- Complete A2A implementation (spike only unless M7 go)
- Removing `stage_*` tools (freeze expansion only)
- Finishing LTX / UE pipelines (see [Pipeline roadmap](/engineering/pipeline_implementation_roadmap/))

---

## Success metrics

| Metric                          | Today (2026-08-25)                                          | After remaining M3         | After M4 |
| ------------------------------- | ----------------------------------------------------------- | -------------------------- | -------- |
| Parity coverage (top mutations) | ~60%                                                        | ≥85%                       | ≥95%     |
| Documented human-only classes   | 0 (M2 shipped; retained boundaries in M2, OBJ/STL export-only) | 0                          | 0        |
| Consistent gateway policy       | Yes (MCP / local / hosted / raw HTTP+CLI; UI dispatch still ungated) | Yes, including optional UI gating | Yes      |
| In-product workspace            | No                                                          | No                         | Yes      |
| Agent-native self-score         | 4.1                                                         | 4.2                        | 4.5      |

---

## Immediate next steps

1. M3 follow-ups: optional role-gated UI disable (3.1b) and confirmation boundaries (3.3); the HTTP/CLI policy gate and unified audit trail shipped 2026-08-25
2. Remaining M7: document the cross-app receipt handoff recipe
3. Keep [Feature Status](/reference/feature-status/) and the [architecture assessment](/research/agent-native-architecture-assessment/) in the same change when those land
