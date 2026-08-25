---
title: Agent-Native Architecture Assessment
description: Evaluate Director against the Builder.io agent-native architecture framework across five principles and stack dimensions.
---

This document evaluates Director against the framework in
[Builder.io: Agent-Native — The Next Architecture for Software](https://www.builder.io/blog/agent-native-architecture#where-agent-native-fits-in-the-software-stack).

Last verified: **2026-08-25**. Aligns with [Feature Status](/reference/feature-status/).

Related docs:

- [Agent-native Production](/concepts/agent-native-production/) — Director's own control loop and contracts
- [Control surfaces](/agents/control-surfaces/) — MCP, HTTP, CLI, and browser API convergence layer
- [Feature Status](/reference/feature-status/) — evidence chains and capability boundaries



## Overall verdict

Director **aligns with the agent-native definition in direction and core implementation**. Its control plane, protocol exposure, and evidence loop are materially stronger than typical "sidebar chat plus partial API" products. It has **not yet reached the article's ideal state**; the main gaps are UI/agent parity, a unified action registry, and team governance.

**Composite score: ~4/5** — design-first and substantially implemented for an agent-native product.

---



## Product stage classification


| Stage            | Article test                                 | Director today                                                        |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| **AI-enabled**   | Remove AI; product still basically works     | ✅ 3D / Canvas / Video editor works without AI                         |
| **AI-native**    | Remove AI; product value collapses           | ⚠️ No — AI is an enhancement layer, not the only entry point          |
| **Agent-native** | Can UI and agent operate the same workflows? | ✅ **Yes on core production paths**; edge capabilities still have gaps |


Director's docs explicitly position the product as **agent-native, not merely "controllable by an agent."**

Conclusion: Director is an **agent-native product architecture, not bolt-on AI**. It most closely matches the article's **Video** practice pattern — a full editor where agents manipulate the same composition model.

---



## Five architectural principles



### 1. Agent UI parity — partial ⚠️

**Aligned:**

- Core capabilities (scene authoring, cameras, characters, timeline, Canvas/Video, interchange export and import (`plan-import` / `import` with inline / media_id / workspace_path sources), collaboration reads/writes (comment resolve/reopen, version create/restore/delete), audit/deliver) are reachable through MCP / HTTP / CLI
- DOM-coordinate automation is not a supported authoring contract ([Feature Status](/reference/feature-status/))
- Agent results are inspectable in the UI (revision, diff, capture, receipts)

**Gaps:**

- Many UI operations still **mutate the Zustand store directly** (`frontend/director/src/comprehensive/editor/store/directorStore.ts`) while agents route through `directorWorkbenchExecutor` → `applyDirectorAuthoringActions`
- Viewport drag, pilot, and other interactive controls lack full semantic equivalents

**Rating: 3.5/5**

### 2. One shared action model — strong on agent side ✅, UI not fully unified ⚠️

**Aligned:**


| Layer               | Shared model                                                      | Path                                                                                                       |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workbench authoring | `directorAuthoringActionSchema` + `applyDirectorAuthoringActions` | `packages/agent-engine/src/directorAuthoring.ts`, `frontend/director/src/agent/directorWorkbenchExecutor.ts` |
| Workbench contract  | `directorWorkbenchOperationSchema` (Zod discriminated union)      | `packages/agent-engine/src/directorWorkbenchContract.ts`                                                   |
| Creative contract   | `creativeWorkspaceAgentRequestSchema` (transport-only)            | `packages/protocol/src/creativeWorkspaceProtocol.ts`                                                       |
| Stage white-box     | `stageCommandSchema` → `executeStageTool`                         | `packages/agent-engine/src/commandEngine.ts`, `packages/agent-engine/src/stageCommandSchema.ts`            |


All control surfaces converge on the same gateway execution and validation layer ([Control surfaces](/agents/control-surfaces/)). Audit suggested fixes reference the same `DirectorAuthoringAction[]` vocabulary across observe → author → audit → deliver.

**Shared action example:**

```json
{
  "op": "author",
  "expected_revision": "director-project-revision:v1:sha256:...",
  "idempotency_key": "shot-017-medium-framing-v1",
  "actions": [
    {
      "action": "update_camera",
      "camera_id": "cam-main",
      "patch": { "focal_length_mm": 50, "target_object_id": "hero" }
    }
  ]
}
```

**Gaps:**

- UI buttons and drags do not uniformly route through the `directorAuthoring` registry
- `stage_*` compatibility tools coexist with the full `director_workbench` model

**Rating: 4/5**

### 3. Shared state, data, and context — strong ✅

**Aligned:**


| State                  | Owner                          | Path                                                                       |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Live `DirectorProject` | Browser store                  | `frontend/director/src/comprehensive/editor/store/directorStore.ts`        |
| Agent observe/author   | Same store (browser execution) | `frontend/director/src/agent/directorWorkbenchExecutor.ts`, `frontend/director/src/agent/gatewayClient.ts` |
| Wire contract          | Shared Zod schema              | `packages/protocol/src/agentGatewayProtocol.ts`                            |
| Agent sessions/events  | SQLite WAL                     | `backend/gateway/agentSessionStore.ts`                                     |


- Selective `observe {"fields":[...]}` slices avoid stale full-project snapshots
- `expected_revision` / `snapshot_fingerprint` concurrency guards
- Exact target leases (token + client + instance + scene + scope), fail-closed, no silent tab/scene switching

**Rating: 4.5/5**

### 4. Protocol-ready by design — MCP strong ✅, A2A weak ⚠️

**Aligned:**


| Protocol      | Implementation                               | Path                                                                        |
| ------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| **MCP**       | stdio server, structured output              | `backend/gateway/mcp-server.ts`, `integrations/plugins/director-workbench/` |
| **HTTP**      | `POST /api/tools/{tool-name}`                | `backend/gateway/routes/stageRoutes.ts`                                     |
| **Tool manifest** | `GET /api/control-plane/tool-manifest` (generated from Zod schemas) | `backend/gateway/controlPlane/toolManifest.ts`                        |
| **WebSocket** | Browser target binding and command responses | `frontend/director/src/agent/gatewayClient.ts`, `backend/gateway/agent-gateway.ts` |
| **CLI**       | `npm run stage --`                           | [Control surfaces](/agents/control-surfaces/)                               |


MCP tools forward to the gateway without duplicating business logic. Distributable plugin includes `.mcp.json`, Skills, and Codex plugin manifest.

**Gaps:**

- No standard **A2A (agent-to-agent)** protocol
- Multi-agent orchestration is a fixed serial DAG, status **Experimental**

**Rating: 4/5**

### 5. Governed execution — gateway boundary gated ✅, UI gate still open ⚠️

**Aligned** (verified 2026-08-25):

- Production audit (spatial, grounding, graph issues) — `packages/agent-engine/src/directorAudit.ts`
- `deliver` machine acceptance boundary
- Revision / idempotency / exact target fail-closed (428 / 409)
- Agent event store, structured MCP receipts, credential redaction
- Shared film-role tool policy (e.g. visual-critic read-only) — `backend/gateway/agents/filmRoleToolPolicy.ts`, used by MCP (`DIRECTOR_FILM_ROLE`), the local Agent harness, and the hosted API adapter
- Raw HTTP `POST /api/tools/{tool-name}` (and therefore the CLI and DSH plugin) applies the same policy through `backend/gateway/agents/httpToolPolicy.ts`, rejecting before browser-target execution with the same structured 403 body as MCP
- Unified gateway audit trail: every `/api/tools/*` invocation is appended to `backend/gateway/agents/toolInvocationAuditStore.ts` tagged `source: ui | mcp | http | cli | dsh | unknown` (derived from the payload `session_id` prefix; the Stage CLI's `STAGE_AGENT_SESSION` defaults to `cli-default`), queryable via authorized `GET /api/agent/audit`

**Gaps:**

- Human UI actions have no equivalent permission gate, and UI-dispatched author actions are not yet written to the unified audit trail
- Collaboration production-room auth and internet deployment hardening remain **Limited**

**Rating: 4/5**

---



## Software stack dimensions

Against the article's [Where agent-native fits in the software stack](https://www.builder.io/blog/agent-native-architecture#where-agent-native-fits-in-the-software-stack) table:


| Dimension                 | Traditional SaaS           | Raw agent                | Agent-native target               | Director                                                                                                                     | Score |
| ------------------------- | -------------------------- | ------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Control**               | Vendor                     | User prompts             | Developer/team owns app           | Open source, local gateway, modifiable code                                                                                  | 5/5   |
| **Human UI quality**      | Strong                     | Weak/none                | Full product UI                   | Full Canvas / 3D / Video editor                                                                                              | 4.5/5 |
| **Agent access**          | Partial bolt-on            | Broad but unstructured   | Full access via app actions       | Strong on core paths; interchange export/import and collaboration reads/writes are JSON operations; OBJ/STL stay export-only with Limited format subsets | 4.5/5 |
| **Customizability**       | Settings/integrations      | One-off prompts          | Cloneable code/workflows          | Profiles, Skills, MCP plugin                                                                                                 | 4/5   |
| **Data ownership**        | Vendor DB                  | Depends on tools         | Your DB/schema                    | Local SQLite / JSON / browser media                                                                                          | 4.5/5 |
| **Runtime customization** | Vendor roadmap             | One-off chat             | SQL workspaces, runtime tools     | Skills/Profiles; no SQL-backed in-product workspace                                                                          | 3/5   |
| **Context awareness**     | UI state hidden from agent | Manual prompting         | Current view/selection/navigation | observe, capabilities, catalog, target lease                                                                                 | 4.5/5 |
| **Team readiness**        | Mature admin               | Hard to govern           | orgs/roles/audit                  | Yjs collaboration Limited; internet deployment incomplete                                                                    | 3/5   |
| **Observability**         | Product analytics          | Chat history             | traces/evals/audit/cost           | AgentEvent, trace, deliver receipts; no unified cost/latency dashboard                                                       | 4/5   |
| **Cost pattern**          | Per-seat + AI add-ons      | LLM + tool subscriptions | One key powers many owned apps    | Self-hosted + bring-your-own LLM key                                                                                         | —     |
| **Cloneability**          | Low                        | N/A                      | Clone, own, reshape               | Open repo, plugin validation script, bilingual docs                                                                          | 4/5   |


---



## Maturity layers (as they grow)


| Capability                      | Article expectation                          | Director                                                                             |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Workspace customization**     | SQL-backed AGENTS.md, skills, memory         | `.claude/skills/`, Profiles JSON; **no in-product SQL-backed workspace**             |
| **Runtime tools / automations** | Agent-created utilities, scheduled workflows | Fixed serial production graph (Experimental); no dynamic DAG / scheduled automations |
| **Progress & observability**    | Long-running progress, traces, evals, cost   | Agent workbench streaming, session events; no unified cost/latency dashboard         |
| **Team readiness**              | users/orgs/roles/audit                       | Collaboration Limited; multi-agent Experimental                                      |


---



## Practice pattern analogy

The article's **Video** example keeps timeline, preview, and export while agents manipulate the composition model directly.

Director matches closely:

- Humans use timeline, viewport, and Canvas node graph
- Agents use `director_workbench` / `director_creative` semantic operations on the same `DirectorProject`
- `audit` → `deliver` provides pixel-level acceptance closure

This is materially closer to an agent-native video template than "AI writes a video script."

---



## Component map

```text
Browser (gatewayClient.ts, directorStore)
    │ WebSocket + exact target
    ▼
agent-gateway.ts (composition root)
    ├─ stageRoutes.ts → commandEngine / browser workbench executor
    ├─ mcp-server.ts (stdio; filmRoleToolPolicy via DIRECTOR_FILM_ROLE)
    ├─ AgentHarness + agentAdapters (Codex/Claude; same policy)
    ├─ openAiCompatibleAdapter (same filmRoleToolPolicy)
    ├─ ProductionRunOrchestrator (multi-agent)
    └─ controlPlaneRoutes / video / dcc
```

---



## What is already aligned

1. **Single gateway execution layer** — MCP / HTTP / CLI / browser do not duplicate business logic
2. **Contract-first design** — Zod schemas span MCP input, HTTP, executor, and audit
3. **Evidence-driven loop** — observe → author → audit → deliver with revision-bound capture
4. **Fail-closed targeting** — no silent tab/scene switching
5. **Distributable agent assets** — plugin + skills + multi-provider workbench
6. **Cloneability** — open source, local data, validatable plugin (`npm run validate:agent-plugin`)



## Main gaps

1. **UI parity in progress** — interchange import, collaboration writes (resolve/reopen, version create/restore/delete), Gallery purge / media.relink, and Player/Pilot session ops are on the Agent JSON surface; Stage deletes and many one-shot transforms now go through `dispatchDirectorAuthoringActions` shared with Agent authoring. Remaining store mutators (camera panel, pose/IK, timeline, world, Canvas/Video) are still migrating in batches
2. **Incomplete governance surfaces** — MCP, local harness, and hosted adapter share `filmRoleToolPolicy`; raw HTTP and human UI still bypass film roles, and audit is not unified across entry points
3. **Protocol breadth** — MCP is strong and the tool manifest shipped; no standard A2A (spike conclusion: no-go / deferred, see roadmap M7); multi-agent is a custom serial graph
4. **Dual surface legacy** — `stage_`* compatibility layer vs full `director_workbench` model
5. **Runtime workspace** — no in-product SQL-backed AGENTS.md / LEARNINGS.md pattern described in the article

---



## Recommended improvements (by ROI)

See the full phased plan in [Agent-Native Optimization Roadmap](/engineering/agent_native_roadmap/).

1. **Keep routing UI mutators through shared authoring dispatch** — camera / pose / timeline / Canvas·Video still dual-write
2. **Apply the shared role policy to raw HTTP and UI, and unify the audit trail** — MCP / local / hosted already share `filmRoleToolPolicy.ts`
3. **Strengthen team/observability layers** — collaboration auth, agent trace/cost dashboard
4. **Cross-app orchestration** — the tool manifest shipped (`GET /api/control-plane/tool-manifest`); the A2A evaluation concluded no-go / deferred (see [roadmap M7](/engineering/agent_native_roadmap/)); the cross-app receipt handoff recipe remains

---



## References

- [Agent-Native: The Next Architecture for Software](https://www.builder.io/blog/agent-native-architecture) — Builder.io, Vishwas Gopinath, May 2026
- Director internal: [Agent-native Production](/concepts/agent-native-production/)
- Director internal: [Feature Status](/reference/feature-status/)

