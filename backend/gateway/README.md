# Gateway Control Plane

> Languages: **English** · [中文](README.zh-CN.md)

The TypeScript Gateway control plane for Director (WorldEngine). It provides project & scene management, media generation & transcoding, a collaboration WebSocket hub, HTTP API routes, and structured tool interfaces for DeepSeek Harness and MCP clients. Agent sessions live in the `vendor/deepseek-harness` submodule.

- **Runtime**: `tsx` (TypeScript execute), Node.js HTTP server (Hono-free, raw `node:http`), `ws` WebSocket, `Yjs` CRDT + `y-protocols/awareness`, `Zod` schema validation, `node-pty` terminal
- **Start**:
  - `npm run dev:gateway` — Gateway dev server on port 8787
  - `npm run mcp` — Standalone MCP server (stdio transport)
  - `npm run dev` — Gateway + Vite UI together

---

## Top-level files

### Core implementation

| Path                           | Purpose                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-gateway.ts`             | Main gateway entry: creates the HTTP server, WebSocket upgrade, Agent plan/execution orchestration, Stage capture & workbench routing                                             |
| `bootstrap.ts`                 | Gateway bootstrap assembly: instantiates all services (Auth, Agent harness, Collaboration, DCC, Film, Generation, Transcode, etc.) and injects into HTTP routes                   |
| `mcp-server.ts`                | MCP server entry: registers three tool sets (`director_workbench`, `director_creative`, `director_dcc`), communicates via stdio with MCP clients, proxies to the Gateway via HTTP |
| `agentPlanStore.ts`            | Short-lived assistant plan cache for plan/apply                                                                                                                                   |
| `agentNaiveBoundary.ts`        | Agent operation boundary: classifies mutation vs read-only operations, generates idempotency keys, manages session target binding, applies observed guards                        |
| `agentPlanDelivery.ts`         | Automatic delivery: converts `author` operation results into `deliver` render operations with quality profiles and render passes                                                  |
| `agentPlanSchema.json`         | JSON Schema for Agent plans: defines `summary`, `suggested_next`, `operations` array structure for CLI structured output                                                          |
| `gatewayAuth.ts`               | Gateway authentication: token generation, browser origin allowlist, request authorization, preview URL signing                                                                    |
| `gatewaySchemas.ts`            | Gateway Zod schemas: `assistantPlanRequest`, `assistantApplyRequest`, `terminalMessage` (hello, term.open, term.input, term.resize), etc.                                         |
| `collaborationWebSocketHub.ts` | Collaboration WebSocket hub: Yjs document + Awareness room management, multi-client real-time sync (max 256 rooms, 64 peers per room)                                             |
| `terminalSessionManager.ts`    | Terminal session manager: creates PTY terminals for Codex/Claude CLIs via node-pty, WebSocket transport for I/O                                                                   |
| `jsonRpcProcess.ts`            | JSON-RPC child process wrapper: spawns child processes, sends requests/receives responses via stdout line protocol, supports notifications & stderr listening                     |
| `plannerDraft.ts`              | Plan draft decoding: decodes Claude transport envelopes, extracts `operations` arrays, generates retry hints on validation failure                                                |
| `plannerFailure.ts`            | Planner failure handling: sanitizes stderr summaries (redacts keys/credentials), generates user-friendly error messages, internal diagnostic logging                              |
| `atomicJsonFile.ts`            | Atomic JSON file write: writes to a temp file then renames, guaranteeing atomicity                                                                                                |
| `boundedTextBuffer.ts`         | Bounded text buffer: retains newest bytes, truncates with marker on overflow, used for safe process output truncation                                                             |
| `browserClientDiscovery.ts`    | Browser client discovery: tries multiple browser tabs by priority for requests, supports exact leases and fallback discovery                                                      |
| `browserCommandTimeout.ts`     | Browser command timeout: distinguishes mutation (outcome unknown, must observe) from read-only (safe to retry) timeout errors                                                     |
| `capturePayload.ts`            | Capture payload parsing: parses base64 data URLs (PNG/JPEG/WebP), validates MIME type and size cap (12 MB)                                                                        |
| `mcpToolResponse.ts`           | MCP tool response builder: standardizes `ok`, `code`, `result`, `error`, `suggested_next` fields, with UI events and scene hints                                                  |
| `processTermination.ts`        | Process termination utilities: cross-platform process tree signaling (POSIX process groups, Windows taskkill), graceful termination                                               |
| `refSessions.ts`               | Reference session registry: in-memory session-scoped key-value reference store with TTL expiry and capacity cap                                                                   |
| `workbenchClientRouting.ts`    | Workbench client routing: ranks browser clients by workspace (stage/canvas/video) and capture readiness                                                                           |
| `tsconfig.json`                | Thin `extends` of `tools/tsconfig.json` so the IDE type-checks this tree                                                                                                          |

### Test files

Tests live in `tests/`, mirroring gateway source.

| Path                                          | Purpose                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tests/agentNaiveBoundary.test.ts`            | Agent operation boundary tests                                                           |
| `tests/agentPlanApply.integration.test.ts`    | Agent plan apply integration tests                                                       |
| `tests/agentPlanDelivery.test.ts`             | Automatic delivery logic tests                                                           |
| `tests/agentGatewayHttp.integration.test.ts`  | Gateway HTTP integration tests                                                           |
| `tests/atomicJsonFile.test.ts`                | Atomic file write tests                                                                  |
| `tests/boundedTextBuffer.test.ts`             | Bounded text buffer tests                                                                |
| `tests/browserClientDiscovery.test.ts`        | Browser client discovery tests                                                           |
| `tests/capturePayload.test.ts`                | Capture payload parsing tests                                                            |
| `tests/collaborationWebSocketHub.test.ts`     | Collaboration WebSocket hub tests                                                        |
| `tests/gatewayAuth.test.ts`                   | Gateway auth tests                                                                       |
| `tests/gatewaySchemas.test.ts`                | Gateway schema tests                                                                     |
| `tests/jsonRpcProcess.test.ts`                | JSON-RPC process tests                                                                   |
| `tests/mcpFilmRolePolicy.integration.test.ts` | MCP film role policy integration tests                                                   |
| `tests/mcpToolResponse.test.ts`               | MCP tool response tests                                                                  |
| `tests/plannerDraft.test.ts`                  | Planner draft decoding tests                                                             |
| `tests/plannerFailure.test.ts`                | Planner failure handling tests                                                           |
| `tests/refSessions.test.ts`                   | Reference session registry tests                                                         |
| `tests/serverImportBoundary.test.ts`          | Server import boundary check: ensures server code doesn't import browser runtime modules |
| `tests/stageCli.test.ts`                      | Stage CLI integration tests: smoke-tests the gateway via `stage-cli.mjs`                 |
| `tests/terminalSessionManager.test.ts`        | Terminal session manager tests                                                           |
| `tests/workbenchClientRouting.test.ts`        | Workbench client routing tests                                                           |

---

## Subdirectories

| Directory          | Purpose                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/`          | Agent runtime components: agent profiles, API provider store, tool registry/schemas, tool memory, scheduler, result projection, role policies. The agent loop itself lives in DeepSeek Harness (`vendor/deepseek-harness`) with the Director plugin in `packages/dsh-plugin-workbench/` |
| `artifacts/`       | Artifact versioning & approval: production artifact version management, approval workflow, promotion pointers                                                                                                                                                                           |
| `controlPlane/`    | Control plane configuration: unified env var parsing, Zod schemas, hosted agent defaults                                                                                                                                                                                                |
| `dcc/`             | DCC integration: Blender bridge, scene import/export, Blender native session, glTF preparation                                                                                                                                                                                          |
| `episode/`         | Episode packaging: bundles storyboard videos, action tracks, captions into deliverable episode artifacts                                                                                                                                                                                |
| `film/`            | Film pipeline: planning agents, render coordination, audio mixing, timeline export, structured LLM calls                                                                                                                                                                                |
| `generation/`      | Generation runtime: ComfyUI image/video generation, 3D generation (Infinigen, etc.), workflow storage, startup reconciliation                                                                                                                                                           |
| `jobs/`            | Production job store: job records, state transitions, idempotency keys, Canvas placeholders                                                                                                                                                                                             |
| `media/`           | Media transcoding: ffmpeg-based transcode executor, input staging, shared upload endpoint with transcription                                                                                                                                                                            |
| `motion/`          | Motion generation: NVIDIA ARDY text-to-motion generation bridge (local or SSH)                                                                                                                                                                                                          |
| `multiAgent/`      | Multi-agent orchestration: production run orchestrator (executes film graph by role sequence), run storage                                                                                                                                                                              |
| `production/`      | Production state: scene project state management, idempotent mutation coordinator                                                                                                                                                                                                       |
| `promptExpansion/` | Prompt expansion: uses film LLM to rewrite generation prompts, includes image/video prompt expanders and asset size estimation                                                                                                                                                          |
| `reconstruction/`  | Scene reconstruction: 3D scene reconstruction from capture images (Python worker), reference scene analysis                                                                                                                                                                             |
| `routes/`          | HTTP routes: route handlers per feature domain (Stage, Assistant, Generation, DCC, Film, Production, etc.)                                                                                                                                                                              |
| `testing/`         | Test utilities: minimal `DirectorProject` fixture factory                                                                                                                                                                                                                               |
| `transcription/`   | Media transcription: audio/video transcription executor, input staging, chunking                                                                                                                                                                                                        |
| `video/`           | Video generation: multi-provider (ComfyUI, LTX 0.9.2.3, Minimax H3) video generation service                                                                                                                                                                                            |

---

### `agents/` File listing

| Path                                  | Purpose                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/agentProfileRegistry.ts`      | Agent profile registry: resolves local and hosted agent capabilities, drivers, model configs                                                                                       |
| `agents/agentApiModels.ts`            | API provider model discovery: fetches and validates the model list of a user-configured provider                                                                                   |
| `agents/agentApiProviderStore.ts`     | API provider store: persists user-configured hosted model providers (endpoint, driver, models)                                                                                     |
| `agents/agentToolRegistry.ts`         | Tool registry: canonical compact wire schemas, definitions, timeouts, read/write modes for Director tools                                                                          |
| `agents/agentToolMemory.ts`           | Tool memory: idempotency replay and duplicate-call detection keyed by `idempotency_key`                                                                                            |
| `agents/agentToolOutcomes.ts`         | Tool outcome classification: classifies tool results as `completed`/`failed`/`timed_out`/`stale_revision`/`outcome_unknown`                                                        |
| `agents/agentToolResultProjection.ts` | Tool result projection re-export: canonical implementation lives in `packages/dsh-plugin-workbench/src/toolResultProjection.ts`, wired into both the DSH plugin and the MCP server |
| `agents/agentToolScheduler.ts`        | Tool scheduler: ordered call windows, read parallelism, process-wide exact-target write barriers                                                                                   |
| `agents/localAgentCliAvailability.ts` | Local CLI availability: probes Codex/Claude CLI presence at gateway start                                                                                                          |
| `agents/modelProviderIntegration.ts`  | Model provider integration: registers built-in `@director/model-provider` factories for the gateway                                                                                |
| `agents/filmRoleToolPolicy.ts`        | Film role tool policy: restricts available tools and operations by `FilmRoleId` (read-only vs write)                                                                               |

### `artifacts/` File listing

| Path                                   | Purpose                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `artifacts/productionArtifactStore.ts` | Artifact store: version management, approval workflow, promotion pointers with SHA-256 fingerprints |

### `controlPlane/` File listing

| Path                                    | Purpose                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `controlPlane/controlPlaneConfig.ts`    | Control plane config: env var parsing, Zod validation, agent defaults, ComfyUI node definitions |
| `controlPlane/hostedAgentDefaults.json` | Hosted agent default configuration JSON                                                         |

### `dcc/` File listing

| Path                          | Purpose                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `dcc/blenderBridge.ts`        | Blender bridge: spawns Blender to execute scene package imports, returns previews and reports                      |
| `dcc/blenderSceneImport.ts`   | Blender scene import: exports Director scene graph as GLB/glTF packages for Blender                                |
| `dcc/blenderReturnImport.ts`  | Blender return import: parses Blender-exported result packages, registers assets back into Director                |
| `dcc/dccExchangePackage.ts`   | DCC exchange package: portable exchange format across DCC tools, with asset manifests, previews, SHA-256 integrity |
| `dcc/dccProviderRegistry.ts`  | DCC provider registry: manages configured DCC tool descriptors, status, availability                               |
| `dcc/gltfPrepare.ts`          | glTF preparation: preprocesses glTF files for Blender import (texture copying, path correction)                    |
| `dcc/blenderNativeSession.ts` | Blender native session: HTTP client wrapper for Blender service (command batches, scene snapshots, jobs)           |
| `dcc/blenderNativeTool.ts`    | Blender native tool: MCP tool definition exposing Blender read/write operations                                    |

### `episode/` File listing

| Path                                | Purpose                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `episode/episodePackageExecutor.ts` | Episode package executor: bundles MP4, action tracks, captions into integrity-checked episode artifacts |

### `film/` File listing

| Path                               | Purpose                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `film/createFilmPipeline.ts`       | Film pipeline assembly: assembles LLM drivers, audio, rendering, media generators from control plane config |
| `film/filmPipelineOrchestrator.ts` | Pipeline orchestrator: coordinates the full film storyboard planning, rendering, audio generation flow      |
| `film/filmPlanningAgents.ts`       | Film planning agents: uses LLM for storyboard planning, shot design, scene description                      |
| `film/filmRenderCoordinator.ts`    | Render coordinator: manages shot render task dispatch, audio mix hooks                                      |
| `film/filmRunStore.ts`             | Film run store: persists film pipeline run records and state                                                |
| `film/filmAudioPipeline.ts`        | Audio pipeline: TTS (OpenAI Speech) and audio mixing                                                        |
| `film/filmStageAnchors.ts`         | Stage anchor resolver: resolves Stage references in film storyboards to actual scene anchors                |
| `film/filmTimelineExport.ts`       | Timeline export: exports film timelines using ffmpeg/ffprobe                                                |
| `film/filmMediaProviders.ts`       | Media providers: hosted image/video API generators                                                          |
| `film/filmFfmpeg.ts`               | ffmpeg utilities: shared ffmpeg/ffprobe binary path management                                              |
| `film/structuredCall.ts`           | Structured LLM call: LLM call wrapper with JSON Schema constraints                                          |

### `generation/` File listing

| Path                                         | Purpose                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `generation/createComfyGenerationRuntime.ts` | ComfyUI runtime assembly: creates executor, node pool, workflow store                    |
| `generation/createGenerated3DRuntime.ts`     | 3D generation runtime assembly: creates 3D executor, provider registry, promotion store  |
| `generation/comfyGenerationExecutor.ts`      | ComfyUI executor: submits prompts to ComfyUI, polls results, downloads outputs           |
| `generation/comfyNodePool.ts`                | ComfyUI node pool: manages workflow node definitions and availability                    |
| `generation/comfyWorkflow.ts`                | ComfyUI workflow: workflow JSON template loading and parameter substitution              |
| `generation/comfyWorkflowStore.ts`           | Workflow store: manages configured ComfyUI workflow definitions                          |
| `generation/generated3dExecutor.ts`          | 3D generation executor: submits 3D generation tasks, polls, manages lifecycle            |
| `generation/generated3dProviders.ts`         | 3D provider registry: manages multiple 3D generation providers (e.g., Infinigen)         |
| `generation/generated3dNormalizer.ts`        | 3D result normalizer: normalizes outputs from different providers into a standard format |
| `generation/generated3dPromotionStore.ts`    | 3D promotion store: manages the promotion flow from generated assets to project assets   |
| `generation/generated3dSourceStore.ts`       | 3D source store: manages source files for generated 3D assets                            |
| `generation/infinigenGenerated3dProvider.ts` | Infinigen 3D provider: integrates Infinigen procedural 3D world generation               |
| `generation/startupReconciliation.ts`        | Startup reconciliation: recovers unfinished job states after gateway restart             |

### `jobs/` File listing

| Path                                | Purpose                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `jobs/productionJobStore.ts`        | Job store: production job CRUD, state transitions, idempotency keys, fingerprints, Canvas placeholder rendering |
| `jobs/canvasPlaceholderArtifact.ts` | Canvas placeholder: generates placeholder PNGs for jobs without output yet                                      |

### `media/` File listing

| Path                                   | Purpose                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `media/createMediaTranscodeRuntime.ts` | Transcode runtime assembly: creates input staging and ffmpeg executor                    |
| `media/mediaTranscodeExecutor.ts`      | Transcode executor: executes ffmpeg transcoding tasks                                    |
| `media/mediaTranscodeInputStore.ts`    | Transcode input staging: content-addressed media file staging, shared with transcription |
| `media/mediaProcessRunner.ts`          | Media process runner: spawns ffmpeg/ffprobe child processes, manages timeouts and output |

### `motion/` File listing

| Path                          | Purpose                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `motion/ardyMotionService.ts` | ARDY motion service: gateway bridge for NVIDIA ARDY text-to-motion generation (local or remote Python script) |

### `multiAgent/` File listing

| Path                                      | Purpose                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiAgent/productionRunOrchestrator.ts` | Production run orchestrator: executes multi-agent production pipeline in film role sequence (showrunner → screenwriter → … → generation-operator) |
| `multiAgent/multiAgentRunStore.ts`        | Multi-agent run store: persists production run records                                                                                            |

### `production/` File listing

| Path                                          | Purpose                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `production/productionStateStore.ts`          | Production state store: atomic read/write of scene project state, revision management        |
| `production/productionMutationCoordinator.ts` | Mutation coordinator: idempotent mutation execution, conflict detection, revision validation |

### `promptExpansion/` File listing

| Path                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `promptExpansion/createPromptExpanders.ts` | Prompt expander assembly: reuses film LLM to create image/video prompt expanders     |
| `promptExpansion/imagePromptExpander.ts`   | Image prompt expander: expands short prompts into generator-optimized versions       |
| `promptExpansion/videoPromptExpander.ts`   | Video prompt expander: expands short prompts into video-generator-optimized versions |
| `promptExpansion/assetSizeEstimator.ts`    | Asset size estimator: estimates file sizes for generated assets                      |

### `reconstruction/` File listing

| Path                                                   | Purpose                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `reconstruction/createCaptureReconstructionRuntime.ts` | Reconstruction runtime assembly: creates scene reconstruction executor, shares media transcode input staging |
| `reconstruction/captureReconstructionExecutor.ts`      | Reconstruction executor: executes Python 3D reconstruction worker                                            |
| `reconstruction/captureReconstructionPlan.ts`          | Reconstruction plan: parses and validates reconstruction plan parameters                                     |
| `reconstruction/referenceSceneAnalyzer.ts`             | Reference scene analyzer: analyzes reference images to extract scene parameters                              |

### `routes/` File listing

| Path                                    | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `routes/assistantRoutes.ts`             | Assistant routes: `POST /api/assistant/plan` and `/api/assistant/apply`     |
| `routes/stageRoutes.ts`                 | Stage routes: core Workbench tool execution, capture, project operations    |
| `routes/agentSessionRoutes.ts`          | Agent session routes: session management, bootstrap, health checks          |
| `routes/controlPlaneRoutes.ts`          | Control plane routes: config queries, agent configuration, capabilities     |
| `routes/generationRoutes.ts`            | Generation routes: ComfyUI image/video generation task submission and query |
| `routes/generated3dRoutes.ts`           | 3D generation routes: 3D generation task submission, query, promotion       |
| `routes/generatedAssetRoutes.ts`        | Generated asset routes: management and query of generated assets            |
| `routes/productionRoutes.ts`            | Production routes: project scene state, mutation submission                 |
| `routes/productionJobRoutes.ts`         | Production job routes: job status query, management                         |
| `routes/productionArtifactRoutes.ts`    | Artifact routes: artifact versioning, approval, promotion                   |
| `routes/filmPipelineRoutes.ts`          | Film pipeline routes: film storyboard planning, rendering, run management   |
| `routes/multiAgentRunRoutes.ts`         | Multi-agent run routes: production run creation, query, status              |
| `routes/dccRoutes.ts`                   | DCC routes: Blender import/export, DCC exchange packages, provider status   |
| `routes/blenderLiveRoutes.ts`           | Blender routes: Blender scene snapshots, command batches                    |
| `routes/mediaTranscriptionRoutes.ts`    | Transcription routes: media transcription task submission and query         |
| `routes/referenceSceneRoutes.ts`        | Reference scene routes: reference image analysis                            |
| `routes/captureReconstructionRoutes.ts` | Reconstruction routes: scene reconstruction task submission and query       |
| `routes/assetSizeRoutes.ts`             | Asset size routes: asset size estimation                                    |
| `routes/motionGenerationRoutes.ts`      | Motion generation routes: ARDY motion generation task submission and query  |

### `tests/` fixtures

Gateway tests live under `tests/` grouped by domain (`agents/`, `routes/`, `dcc/`, `core/`, `workbench/`, `mcp/`, `planner/`, `cli/`, …), mirroring gateway source. Shared helpers sit in `tests/fixtures/`.

| Path                                          | Purpose                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/createTestDirectorProject.ts` | Test project factory: creates minimal valid `DirectorProject` fixture, independent of browser persistence |

### `transcription/` File listing

| Path                                               | Purpose                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `transcription/createMediaTranscriptionRuntime.ts` | Transcription runtime assembly: creates input staging and transcription executor          |
| `transcription/mediaTranscriptionExecutor.ts`      | Transcription executor: executes media transcription tasks                                |
| `transcription/mediaTranscriptionInputStore.ts`    | Transcription input staging: content-addressed media file staging                         |
| `transcription/mediaTranscriptionChunker.ts`       | Transcription chunker: chunks long audio/video to fit transcription model context windows |

### `video/` File listing

| Path                                      | Purpose                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `video/createVideoGenerationService.ts`   | Video generation service assembly: creates multi-provider video generation service from control plane config             |
| `video/videoGenerationService.ts`         | Video generation service: unified video generation interface, routes to specific providers                               |
| `video/providers/videoProvider.ts`        | Video provider interface: defines `VideoProvider` abstraction and `VideoGenerationRequest`/`VideoGenerationResult` types |
| `video/providers/comfyUiVideoProvider.ts` | ComfyUI video provider: generates video via ComfyUI workflows                                                            |
| `video/providers/ltx23SpawnProvider.ts`   | LTX-2.3 provider: Gateway spawns official DistilledPipeline                                                              |
| `video/providers/minimaxH3Provider.ts`    | Minimax H3 provider: calls Minimax H3 video generation via HTTP API                                                      |

---

## Run & test

| Command                                                                | Description                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run dev:gateway`                                                  | Start gateway dev server on port 8787                                                                         |
| `npm run mcp`                                                          | Start standalone MCP server (stdio transport)                                                                 |
| `npm run stage -- director_workbench '{"op":"observe"}'`               | Stage CLI smoke test: sends an observe request to the gateway via `stage-cli.mjs` (`npm run stage -- --help`) |
| `npm test`                                                             | Run the full vitest test suite (`tools/vitest.config.ts`)                                                     |
| `npx vitest run --config tools/vitest.config.ts backend/gateway/tests` | Run gateway tests only                                                                                        |

### Environment variables

Key environment variables are parsed through `controlPlane/controlPlaneConfig.ts`, primarily:

| Variable                       | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `STAGE_GATEWAY_PORT`           | Gateway port (default 8787)                                                    |
| `STAGE_GATEWAY_URL`            | URL for MCP server to connect to the gateway (default `http://127.0.0.1:8787`) |
| `DIRECTOR_GATEWAY_TOKEN`       | Gateway authentication token (min 24 characters)                               |
| `DIRECTOR_AGENT_API_BASE_URL`  | Hosted Agent API base URL                                                      |
| `DIRECTOR_AGENT_API_KEY`       | Hosted Agent API key                                                           |
| `DIRECTOR_AGENT_API_MODEL`     | Hosted Agent model name                                                        |
| `DIRECTOR_AGENT_PROFILES_JSON` | Custom Agent profiles JSON                                                     |
| `DIRECTOR_FILM_ROLE`           | MCP client role (e.g. `stage-director`, `cinematographer`)                     |
| `DIRECTOR_MCP_SESSION_ID`      | MCP session ID                                                                 |

See `controlPlane/controlPlaneConfig.ts` for the complete configuration catalog.
