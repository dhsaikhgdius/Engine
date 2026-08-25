<!-- refreshed: 2026-08-03 -->
# Architecture

**Analysis Date:** 2026-08-03

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser execution plane                                                     │
├───────────────────────┬────────────────────────┬─────────────────────────────┤
│ Canvas workspace      │ 3D Stage workspace     │ Video Editor workspace      │
│ `src/comprehensive/`  │ `src/comprehensive/`  │ `src/comprehensive/`        │
└───────────┬───────────┴────────────┬───────────┴──────────────┬──────────────┘
            │ Zustand stores, validated projects, rendered evidence
            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser Agent UI and shared contracts                                       │
│ `src/agent/` (PTY terminal), `@director/agent-engine`, `@director/stage-protocol` │
└──────────────────────────────┬───────────────────────────────────────────────┘
            authenticated HTTP / WebSocket + exact browser target
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ TypeScript control plane                                                    │
│ `server/agent-gateway.ts`, `server/routes/`, `server/agents/`                │
├───────────────────────┬────────────────────────┬─────────────────────────────┤
│ MCP stdio proxy       │ Durable production     │ Provider-neutral Agents     │
│ `server/mcp-server.ts`│ `server/production/`   │ `server/agentHarness.ts`    │
└───────────┬───────────┴────────────┬───────────┴──────────────┬──────────────┘
            │                        │                          │
            ▼                        ▼                          ▼
┌─────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐
│ Runtime persistence │  │ Python inference plane │  │ External model APIs    │
│ `data/`             │  │ `pipelines/*/worker`  │  │ via `server/agents/`   │
└─────────────────────┘  └────────────┬───────────┘  └────────────────────────┘
                                     ▼
                         LTX-2.3 model + generated artifacts
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Browser bootstrap | Chooses the research portal or Director application, initializes theme, then loads the Agent gateway bridge after first paint | `src/main.tsx` |
| Director application | Selects Canvas, Stage, or Video workspaces and scopes creative state to the active production scene | `src/comprehensive/App.tsx` |
| Stage editor state | Owns the editable `DirectorProject`, UI state, selection, undo, import, cameras, characters, and scene mutations | `src/comprehensive/editor/store/directorStore.ts` |
| Creative workspace state | Owns Canvas graph, Video timeline, snapshot history, and scene-scoped persistence | `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts` |
| Browser gateway bridge | Registers the exact browser target, synchronizes projects, executes Workbench/Creative requests, and returns captures | `src/agent/gatewayClient.ts` |
| Workbench executor | Applies revision-guarded semantic authoring, audit, correction, inspection, capture, and delivery to `DirectorProject` | `src/agent/directorWorkbenchExecutor.ts` |
| Compact Stage engine | Validates and atomically executes portable `StageScene` operations | `packages/agent-engine/src/commandEngine.ts` |
| Director/Stage adapter | Converts between complete `DirectorProject` and compact `StageScene` representations | `packages/agent-engine/src/directorStageAdapter.ts` |
| Shared wire contracts | Keeps browser/server/MCP payload schemas independent of React, DOM, and Node runtimes | `src/shared/creativeWorkspaceProtocol.ts` |
| Gateway composition root | Creates HTTP/WebSocket services, stores, provider registries, production orchestration, DCC, and video services | `server/agent-gateway.ts` |
| Stage transport routes | Validates tool envelopes and routes compact Stage locally or Workbench/Creative operations to the exact browser | `server/routes/stageRoutes.ts` |
| MCP adapter | Publishes semantic tools over stdio and forwards authenticated requests to the gateway | `server/mcp-server.ts` |
| Production state store | Persists one revisioned production manifest plus independently revisioned scene projects atomically | `server/production/productionStateStore.ts` |
| Agent harness | Normalizes provider sessions, tool execution, policy, and durable provider-neutral events | `server/agentHarness.ts` |
| Multi-Agent orchestrator | Runs the serial production role graph and stores hash-addressed artifacts | `server/multiAgent/productionRunOrchestrator.ts` |
| Video service | Prepares durable provider-neutral jobs and delegates execution to LTX-2.3 or ComfyUI providers | `server/video/videoGenerationService.ts` |
| Python worker | Exposes idempotent FastAPI jobs, serial GPU execution, recovery receipts, and generated MP4 artifacts | `pipelines/video-generation/worker/src/director_ltx23_worker/app.py` |

## Pattern Overview

**Overall:** Three-plane, contract-first architecture with an authoritative live browser renderer, a Node control plane, and isolated Python inference workers.

**Key Characteristics:**
- Browser rendering and browser-owned mutable editor state stay in `src/comprehensive/`; the server never imports React, Zustand stores, WebGL, or browser globals.
- Pure Zod contracts in `src/shared/`, `src/stage/`, and selected schema modules are shared across browser, gateway, and MCP boundaries.
- Exact-target tokens bind commands to one tab, instance, scene, creative scope, and contract version; project revisions and snapshot fingerprints provide optimistic concurrency.
- Mutations are intent-atomic and idempotency guarded. Workbench uses project revisions; Creative batches use snapshot fingerprints; production uses integer manifest and scene revisions.
- Durable orchestration and manifests live in `server/`; heavyweight model weights and GPU queues live only in `pipelines/*/worker`.
- Visual acceptance is evidence based: a successful mutation is followed by fresh observation, audit, capture/preview, and revision-bound delivery receipts.

## Layers

**Presentation and Rendering:**
- Purpose: Provide the Director desk, 3D viewport, Canvas board, Video Editor, panels, capture, and local interaction.
- Location: `src/comprehensive/`
- Contains: React components, React Three Fiber scenes, runtime loaders, panels, workspace shells, styles, and capture bridges.
- Depends on: `src/comprehensive/editor/store/`, `src/comprehensive/editor/schema/`, `src/shared/`, Three.js, React Three Fiber, and browser APIs.
- Used by: Human operators and the browser Agent bridge.

**Browser Domain and State:**
- Purpose: Represent complete projects and creative workspaces, validate graph integrity, perform semantic mutations, and persist browser state.
- Location: `src/comprehensive/editor/`
- Contains: `DirectorProject` schemas, Zustand stores, selectors, media persistence, collaboration, production, timeline, storyboard, and interchange.
- Depends on: Zod schemas, browser storage, pure geometry/evaluation helpers, and rendered scene runtime.
- Used by: UI workspaces and `src/agent/gatewayClient.ts`.

**Agent Domain and Portable Stage:**
- Purpose: Define tool contracts, semantic authoring, deterministic audits, Workbench execution, compact Stage operations, and model adapters.
- Location: `src/agent/` and `src/stage/`
- Contains: Workbench schemas/executor, Stage command parser/engine, revision and idempotency logic, audit, authoring, Shot IR, and feedback.
- Depends on: Pure project schemas in `src/comprehensive/editor/schema/` and transport contracts in `src/shared/`.
- Used by: Browser gateway execution, server route validation, MCP registration, and tests.

**Transport Contracts:**
- Purpose: Provide one validated wire vocabulary without importing browser or server runtime code.
- Location: `src/shared/`
- Contains: Agent gateway, creative workspace, collaboration, production artifact/job, and video-generation protocols.
- Depends on: Zod only plus pure TypeScript types.
- Used by: `src/agent/gatewayClient.ts`, `server/routes/`, `server/mcp-server.ts`, and frontend API clients.

**TypeScript Control Plane:**
- Purpose: Authenticate local clients, route exact-target commands, persist production/session/job state, orchestrate Agents, and integrate external providers.
- Location: `server/`
- Contains: HTTP/WebSocket composition, route modules, stores, Agent adapters, role profiles, DCC bridge, collaboration hub, and video providers.
- Depends on: Node APIs, `src/shared/`, pure Agent/Stage schemas, and selected `DirectorProject` schemas.
- Used by: Browser clients, MCP/CLI clients, hosted model APIs, and Python workers.

**Inference Plane:**
- Purpose: Keep GPU model loading and generation outside the browser and Node event loop.
- Location: `pipelines/video-generation/worker/`
- Contains: FastAPI app, Pydantic contracts, durable job repository, serial execution queue, and LTX executor.
- Depends on: The pinned upstream source at `pipelines/video-generation/ltx-2/`.
- Used by: `server/video/providers/ltx23HttpProvider.ts`.

**Documentation and Distribution:**
- Purpose: Publish operator and engineering guidance and package the MCP surface.
- Location: `docs-site/` and `plugins/director-workbench/`
- Contains: Astro Starlight docs, portable skill metadata, MCP configuration, and the generated MCP bundle.
- Depends on: Native sources in `server/mcp-server.ts` and `.claude/skills/director-workbench/`.
- Used by: Operators, coding Agents, and portable plugin installations.

## Data Flow

### Primary Workbench Request Path

1. An MCP client invokes `director_workbench`; the stdio adapter authenticates and POSTs a tool envelope to the gateway (`server/mcp-server.ts:126`).
2. The Stage route validates the tool, payload, target token, and mutation boundary before dispatch (`server/routes/stageRoutes.ts:194`).
3. The gateway resolves one exact WebSocket browser registration and sends the request to that target (`server/agent-gateway.ts:111`).
4. The browser verifies the target tuple and executes the semantic operation against its live Zustand store (`src/agent/gatewayClient.ts:120`, `src/agent/directorWorkbenchExecutor.ts:211`).
5. Workbench execution validates the project, graph, revision guard, and idempotency record; authoring changes become one undoable intent (`src/agent/directorWorkbenchExecutor.ts`).
6. The browser returns structured result, project, Stage projection, and optional capture; the gateway persists and broadcasts validated state (`server/routes/stageRoutes.ts`).
7. MCP converts the gateway result into structured tool output; delivery evidence remains bound to the observed project revision (`server/mcpToolResponse.ts`).

### Human Editor Flow

1. `src/main.tsx` lazy-loads `src/comprehensive/App.tsx`.
2. `src/comprehensive/App.tsx` selects Canvas, Stage, or Video from the URL/store and lazy-loads the corresponding workspace.
3. UI actions mutate `src/comprehensive/editor/store/directorStore.ts` or `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`.
4. Store subscribers persist debounced browser snapshots; `src/agent/gatewayClient.ts` synchronizes validated project updates with compatible peers and production scene records.
5. React Three Fiber renders the project; capture bridges return helper-free pixels for audit/delivery.

### Compact Stage Flow

1. A `stage_*` request reaches `server/routes/stageRoutes.ts`.
2. The shared parser and `executeStageTool` run in `packages/agent-engine/src/commandEngine.ts`.
3. An ordered batch applies to a cloned `StageScene`; any invalid operation returns failure without committing partial state.
4. The gateway persists `data/stage-scene.json`, broadcasts the validated scene, and returns compact feedback.
5. `packages/agent-engine/src/directorStageAdapter.ts` projects compatible compact changes into the complete browser project where needed.

### Video Generation Flow

1. `stage_video` validates a `StageScene`, active camera, Shot IR, and conditioning package in `server/video/videoGenerationService.ts`.
2. `server/jobs/productionJobStore.ts` records the Director-side durable job and provider-neutral intent.
3. `server/video/providers/ltx23HttpProvider.ts` submits an idempotent HTTP request to the Python worker.
4. `pipelines/video-generation/worker/src/director_ltx23_worker/app.py` writes a job receipt before queueing, then invokes `executor.py` on a single GPU worker.
5. Worker progress and artifact hashes are polled back into the control-plane manifest; generated bytes remain in worker artifact storage.

### Multi-Agent Production Flow

1. Control-plane routes create a durable run in `server/multiAgent/multiAgentRunStore.ts`.
2. `server/multiAgent/productionRunOrchestrator.ts` executes the serial role DAG using profiles from `server/agents/agentProfileRegistry.ts`.
3. `server/agentHarness.ts` normalizes OpenAI, Anthropic, or OpenAI-compatible model streams and enforces per-role tool policy.
4. Each successful node emits a hash-addressed artifact; resume retains succeeded nodes and pinned profiles.

**State Management:**
- `DirectorProject` state and Stage UI state are held in a Zustand store at `src/comprehensive/editor/store/directorStore.ts`.
- Canvas/Video state is held separately in `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`.
- Browser project snapshots use local storage; media bytes use IndexedDB through `src/comprehensive/editor/media/persistentCreativeMediaStore.ts`.
- Server state uses JSON manifests, atomic temporary-file replacement, SQLite Agent sessions, and directory-backed run/job artifacts under ignored `data/`.
- Python jobs use in-memory indexing plus atomically replaced `job.json` receipts and artifact files.

## Key Abstractions

**DirectorProject:**
- Purpose: Complete editable scene, asset, object, camera, storyboard, timeline, and production model.
- Examples: `src/comprehensive/editor/schema/directorProject.ts`, `src/comprehensive/editor/schema/directorProjectSchema.ts`
- Pattern: Versioned document plus Zod boundary validation and separate graph-integrity checks.

**StageScene:**
- Purpose: Compact portable white-box scene for legacy and low-level Agent operations.
- Examples: `packages/stage-protocol/src/types.ts`, `packages/stage-protocol/src/sceneSchema.ts`, `packages/agent-engine/src/commandEngine.ts`
- Pattern: Versioned command document with clone-then-commit atomic batches.

**DirectorCreativeWorkspace:**
- Purpose: Scene-scoped Canvas graph and Video timeline sharing a media library.
- Examples: `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`, `src/shared/creativeWorkspaceProtocol.ts`
- Pattern: Fingerprinted observable snapshot with transactional operation batches.

**Exact Browser Target:**
- Purpose: Prevent commands or captures from drifting to another tab, scene, or workspace.
- Examples: `src/shared/agentGatewayProtocol.ts`, `src/comprehensive/editor/gateway/browserTargetRegistry.ts`, `server/workbenchClientRouting.ts`
- Pattern: Opaque process-epoch capability over a tuple of client, instance, scene, creative scope, and contract version.

**Revision and Idempotency Guard:**
- Purpose: Prevent stale overwrites and duplicate side effects.
- Examples: `src/comprehensive/editor/schema/directorProjectRevision.ts`, `src/agent/directorWorkbenchIdempotencyLedger.ts`, `server/workbenchAgentBoundary.ts`
- Pattern: Optimistic concurrency plus stable exact-retry keys.

**Provider Adapter and Model Driver:**
- Purpose: Normalize model APIs into shared Agent sessions and events.
- Examples: `packages/model-provider/src/runtime/modelDriver.ts`, `packages/model-provider/src/runtime/anthropicMessagesDriver.ts`
- Pattern: Registry-selected adapter/driver behind provider-neutral domain contracts.

**Durable Store:**
- Purpose: Serialize revisioned or resumable state outside process memory.
- Examples: `server/agentSessionStore.ts`, `server/production/productionStateStore.ts`, `server/multiAgent/multiAgentRunStore.ts`, `server/jobs/productionJobStore.ts`
- Pattern: Boundary validation, clone-before-return, serialized writes, and atomic replacement.

## Entry Points

**Browser Application:**
- Location: `src/main.tsx`
- Triggers: Vite serves the root page.
- Responsibilities: Select research or Director UI, mount React, and initialize the gateway bridge.

**Director Workspace Shell:**
- Location: `src/comprehensive/App.tsx`
- Triggers: Browser bootstrap imports the main application.
- Responsibilities: Select and lazy-load Canvas, Stage, or Video workspaces and initialize scene-scoped state.

**Gateway Server:**
- Location: `server/agent-gateway.ts`
- Triggers: `npm run gateway` or `npm run dev`.
- Responsibilities: Compose HTTP/WebSocket routes, authentication, stores, providers, orchestration, captures, and persistence.

**Native MCP Server:**
- Location: `server/mcp-server.ts`
- Triggers: `npm run mcp` or portable plugin startup.
- Responsibilities: Register Director tools, maintain session target binding, and proxy calls to the gateway.

**CLI:**
- Location: `scripts/stage-cli.mjs`
- Triggers: `npm run stage -- <tool> '<json>'`.
- Responsibilities: Acquire target guards when needed and call gateway tools from a terminal.

**Python LTX Worker:**
- Location: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`
- Triggers: `npm run worker:ltx23`.
- Responsibilities: Start FastAPI, restore receipts, load the resident executor, and process queued generation jobs.

**Documentation Site:**
- Location: `docs-site/astro.config.mjs`
- Triggers: `npm run docs:dev` or `npm run docs:build`.
- Responsibilities: Build bilingual Starlight operator and engineering documentation.

## Architectural Constraints

- **Threading:** Browser UI and Node gateway use event loops; the Python worker protects its repository with `threading.RLock` and serializes GPU jobs through one asynchronous queue.
- **Global state:** Gateway process resources are intentionally composed once in `server/agent-gateway.ts`; browser socket, target, revision, and save queues are module-scoped in `src/agent/gatewayClient.ts`.
- **Circular imports:** Server imports are mechanically restricted by `scripts/checkServerImportBoundaries.ts`; `server/**` may consume pure schemas but not editor runtime modules.
- **Rendering authority:** Clean capture and WebGL-dependent operations must execute in the bound browser target, not in the Node process.
- **Model isolation:** The Node control plane never loads model weights; Python workers own GPU lifecycle and artifacts.
- **Concurrency:** Workbench project revisions, Creative snapshot fingerprints, production revisions, scene-document revisions, and idempotency keys are mandatory at mutation boundaries.
- **Persistence:** Large media and generated assets are referenced by stable IDs and stored outside project JSON.
- **Deployment:** The gateway is loopback-oriented and single-operator; browser and MCP clients use process-epoch capabilities.

## Anti-Patterns

### Importing Browser Runtime Into the Server

**What happens:** A `server/**` module imports React, Zustand stores, R3F components, browser storage, or DOM globals.
**Why it's wrong:** It couples the control plane to WebGL/browser execution and can break Node startup or bundle pure contracts into the server.
**Do this instead:** Move transport schemas to `src/shared/`, pure project logic to schema/domain modules, and invoke browser behavior over `src/shared/agentGatewayProtocol.ts`; enforce with `scripts/checkServerImportBoundaries.ts`.

### Treating Command Acknowledgement as Completion

**What happens:** A caller assumes a successful mutation proves the requested scene or visual result.
**Why it's wrong:** The result may be stale, structurally valid but visually wrong, or applied to state that changed before capture.
**Do this instead:** Follow observe → guarded mutation → fresh observe → audit → preview/deliver using `src/agent/directorWorkbenchExecutor.ts` and revision-bound evidence.

### Mutating Without Exact Concurrency Guards

**What happens:** A Workbench, Creative, or production mutation is issued without the latest revision/fingerprint and a stable exact-retry key.
**Why it's wrong:** Concurrent human or Agent edits can be overwritten, and timeout retries can duplicate side effects.
**Do this instead:** Use project revisions in `src/comprehensive/editor/schema/directorProjectRevision.ts`, creative fingerprints in `src/shared/creativeWorkspaceProtocol.ts`, and production integer revisions in `server/production/productionStateStore.ts`.

### Creating Parallel Scene Models

**What happens:** Provider-specific Agent output or UI projections become independently editable scene state.
**Why it's wrong:** Competing authorities drift and bypass shared validation, graph integrity, undo, and persistence.
**Do this instead:** Keep `DirectorProject` authoritative, treat `StageScene` and Agent snapshots as validated projections, and convert through `src/agent/directorStageAdapter.ts`.

## Error Handling

**Strategy:** Validate at every untrusted boundary, return structured error codes and recovery guidance, and fail closed on stale targets, malformed documents, conflicts, or unknown mutation outcomes.

**Patterns:**
- Zod `safeParse` converts external JSON into explicit success/error branches in `src/shared/`, `src/agent/`, and `server/routes/`.
- Domain stores throw typed errors with HTTP status and stable codes, such as `ProductionStateStoreError` in `server/production/productionStateStore.ts`.
- Browser command timeouts distinguish cancelled reads from mutation `outcome_unknown` in `server/browserCommandTimeout.ts`.
- Atomic batches clone state before execution and commit only after all operations validate in `packages/agent-engine/src/commandEngine.ts`.
- Python worker failures become persisted `JobError` records and interrupted jobs become retriable after restart in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

## Cross-Cutting Concerns

**Logging:** Node services emit operational diagnostics from the gateway and provider modules; Python uses the standard `logging` package in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`. Durable receipts carry the state needed for recovery rather than relying only on logs.
**Validation:** Zod guards TypeScript wire/document boundaries; Pydantic guards Python worker requests and responses; semantic graph checks run separately from shape validation.
**Authentication:** `server/gatewayAuth.ts` creates process-epoch capabilities, restricts origins/loopback access, and keeps hosted-provider and worker credentials server-side.

---

*Architecture analysis: 2026-08-03*
