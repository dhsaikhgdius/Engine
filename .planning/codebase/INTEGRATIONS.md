# External Integrations

**Analysis Date:** 2026-08-03

## APIs & External Services

**Agent and model providers:**

- OpenAI API - Hosted Agent profile using the OpenAI-compatible Chat Completions wire format.
  - SDK/Client: Native Fetch adapter in `packages/model-provider/src/runtime/openAiChatDriver.ts`; default endpoint configured in `backend/gateway/controlPlane/controlPlaneConfig.ts`.
  - Auth: `OPENAI_API_KEY`; optional endpoint override `OPENAI_BASE_URL`.
- Anthropic Messages API - Hosted Agent profile with tools, vision content, usage accounting, and bounded retries.
  - SDK/Client: Native Fetch adapter in `packages/model-provider/src/runtime/anthropicMessagesDriver.ts`.
  - Auth: `ANTHROPIC_API_KEY`; optional endpoint override `ANTHROPIC_BASE_URL`.
- OpenAI-compatible APIs - Generic hosted model endpoints, including local or third-party servers exposing `/chat/completions`.
  - SDK/Client: `packages/model-provider/src/runtime/openAiChatDriver.ts` and hosted profile routing in `backend/gateway/agents/agentProfileRegistry.ts`.
  - Auth: Profile-defined `apiKeyEnv`, defaulting to `DIRECTOR_AGENT_API_KEY`; legacy config uses `DIRECTOR_AGENT_API_BASE_URL`, `DIRECTOR_AGENT_API_MODEL`, and `DIRECTOR_AGENT_API_LABEL`.
- Local Agent CLIs - Codex and Claude subprocess adapters integrated with the Director session harness.
  - SDK/Client: JSON-RPC/process adapters in `server/agentAdapters.ts` and `server/jsonRpcProcess.ts`.
  - Auth: Owned by each installed CLI; executable names can be overridden with `CODEX_CLI_COMMAND` and `CLAUDE_CLI_COMMAND`.

**Agent control protocols:**

- Model Context Protocol - Exposes Director Stage, Workbench, Canvas/Video, generation, DCC, and production-evidence tools over stdio.
  - SDK/Client: `@modelcontextprotocol/sdk` in `server/mcp-server.ts`; client configuration in `.mcp.json`.
  - Auth: MCP inherits or bootstraps `DIRECTOR_GATEWAY_TOKEN`, then sends `X-Director-Browser-Token` to the loopback gateway.
- Director HTTP API - Local control plane for Agent sessions, tools, productions, scenes, DCC, generation jobs, artifacts, and previews.
  - SDK/Client: Node HTTP server in `server/agent-gateway.ts`; route modules in `server/routes/`; browser and CLI clients in `src/agent/gatewayClient.ts` and `scripts/stage-cli.mjs`.
  - Auth: Process-epoch or configured `DIRECTOR_GATEWAY_TOKEN`; workspace operations additionally bind exact target tokens and revision/fingerprint guards.
- Director WebSocket protocol - Browser registration, Workbench/creative commands, collaboration updates, and PTY terminal streams.
  - SDK/Client: `ws` server in `server/agent-gateway.ts`; browser clients in `src/agent/gatewayClient.ts`, `src/agent/useTerminalSession.ts`, and `src/comprehensive/editor/collaboration/directorCollaborationGatewayTransport.ts`.
  - Auth: Gateway token passed through the authenticated WebSocket URL/query contract, with Origin allowlisting in `server/gatewayAuth.ts`.

**Video generation:**

- Director LTX-2.3 worker - Separate resident Python service for source-backed distilled audio-video generation.
  - SDK/Client: Fetch provider in `server/video/providers/ltx23HttpProvider.ts`; FastAPI service in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
  - Auth: Control plane sends `DIRECTOR_LTX23_API_KEY`; worker validates it against `LTX23_WORKER_API_KEY` as a Bearer token.
- ComfyUI - Optional workflow-based video generation provider.
  - SDK/Client: Native Fetch in `server/video/providers/comfyUiVideoProvider.ts` and reference upload/workflow templating in `server/video/createVideoGenerationService.ts`.
  - Auth: No credential mechanism is implemented by the adapter; endpoint comes from `COMFYUI_URL`, and the API-format workflow path comes from `COMFYUI_VIDEO_WORKFLOW_PATH`.
- Official Lightricks LTX-2 source - Pinned source checkout used by the resident worker and Python packages.
  - SDK/Client: Git/source bootstrap in `scripts/bootstrap-ltx2-source.mjs`, `scripts/ltx2-source.mjs`, and runtime activation in `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`.
  - Auth: Normal Git transport if needed; license acceptance is explicit through `DIRECTOR_ACCEPT_LTX2_LICENSE=1`. Runtime model files are local paths rather than remote API calls.

**Model training and media captioning:**

- Hugging Face Hub - Optional model repository creation/upload for trained LoRAs and immutable asset bundle downloads.
  - SDK/Client: `huggingface-hub` in `pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/hf_hub_utils.py`; checksum-pinned HTTP asset installer in `scripts/director-assets.mjs`.
  - Auth: Hugging Face SDK standard token resolution for trainer uploads; asset manifests can declare a token environment variable for gated/private repositories in `scripts/director-assets.mjs`.
- Google Gemini Developer API / Vertex AI - Optional image/video captioning through Gemini Flash.
  - SDK/Client: `google-genai` in `pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/captioning.py`.
  - Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`; otherwise Google Application Default Credentials with optional `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.
- Local vLLM - Optional OpenAI-compatible Qwen3-Omni media captioning server.
  - SDK/Client: `openai` Python client in `pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/captioning.py`; launch helper in `pipelines/video-generation/ltx-2/packages/ltx-trainer/scripts/serve_captioner.py`.
  - Auth: Captioner `api_key` argument; default local service uses a placeholder accepted by unauthenticated vLLM. Default endpoint is loopback port 8001.
- Weights & Biases - Optional training metrics and validation media tracking.
  - SDK/Client: `wandb` in `pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/trainer.py` and `validation_runner.py`.
  - Auth: Standard W&B SDK environment/login resolution; enabled and scoped through trainer YAML/Pydantic configuration in `pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/config.py`.

**Assets and DCC:**

- Hugging Face asset datasets/models - Version-pinned redistribution channel for cleared runtime assets.
  - SDK/Client: Direct HTTPS downloads with SHA-256, size, path, license, and immutable revision checks in `scripts/director-assets.mjs`.
  - Auth: Manifest-declared environment variable for gated/private repositories; current repository expects the release manifest at `assets/manifest.lock.json`, while `assets/manifest.example.json` is the checked-in template.
- Adobe Mixamo - User-operated character/animation download scripts; downloaded exports remain user-provided local assets.
  - SDK/Client: Playwright and direct HTTP utility scripts in `scripts/mixamo-downloader/`.
  - Auth: `MIXAMO_TOKEN` or an operator-supplied token file/browser session; token files are not repository configuration.
- Flick asset catalog - Checked-in catalog metadata references Flick source and CDN URLs for stage props.
  - SDK/Client: Catalog schema and URL construction in `packages/agent-engine/src/directorAgentAssetCatalog.ts`; local mirrored catalog under `public/flick-stage-props/`.
  - Auth: Not detected. The repository treats the current mirror as local-only until redistribution rights are documented (`README.md`).
- Blender - Local DCC subprocess and file-package integration for Director-to-Blender export and validated GLB return.
  - SDK/Client: Process bridge in `server/dcc/blenderBridge.ts`, return validation in `server/dcc/blenderReturnImport.ts`, and Blender Python exporter in `integrations/blender/director_return_export.py`.
  - Auth: None; local executable can be selected with `DIRECTOR_BLENDER_BIN`.



## Data Storage

**Databases:**

- SQLite via Node 22 built-in `node:sqlite`.
  - Connection: Local file `data/director-agent-sessions.sqlite` by default; base directory is overridden with `DIRECTOR_DATA_DIRECTORY`.
  - Client: `DatabaseSync` with WAL, foreign keys, and busy timeout in `server/agentSessionStore.ts`.
  - Stores: Agent sessions, events, checkpoints, queued messages, plans, and canonical hosted-model conversation state.

**File Storage:**

- Local filesystem is the primary durable store; no managed object store is used by the Director control plane.
- Gateway project and production state default under `data/`, including `data/stage-scene.json`, `data/director-workbench.json`, `data/director-production-state.json`, and preview/schema artifacts (`server/agent-gateway.ts`).
- Production runs are JSON files managed by `server/multiAgent/multiAgentRunStore.ts`.
- Durable production jobs and artifacts are file-backed through `server/jobs/productionJobStore.ts` and `server/artifacts/productionArtifactStore.ts`.
- Video job manifests, captured conditioning images, and provider outputs are managed under the configured data directory by `server/video/videoGenerationService.ts`.
- LTX worker receipts and MP4 artifacts default to `data/ltx23-worker/jobs/`, configurable with `LTX23_OUTPUT_DIR` (`pipelines/video-generation/worker/src/director_ltx23_worker/app.py`).
- Browser editor/project state and preferences use scoped `localStorage` in `src/comprehensive/editor/store/directorStore.ts`, `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`, and related UI modules; camera thumbnails use `sessionStorage`.
- Large media bytes are kept in browser media/artifact storage rather than embedded in scene JSON, as specified in `README.md`.

**Caching:**

- No Redis or external cache was detected.
- In-memory maps hold active browser clients, target leases, WebSocket collaboration rooms, ComfyUI job mappings, and worker queues (`server/agent-gateway.ts`, `server/collaborationWebSocketHub.ts`, `server/video/providers/comfyUiVideoProvider.ts`, `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`).
- Browser `localStorage` provides durable workspace snapshots and idempotency records (`src/agent/directorWorkbenchIdempotencyLedger.ts`, `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`).
- Model and package caches follow standard Hugging Face locations, optionally controlled by `HF_HOME` in `pipelines/video-generation/ltx-2/packages/ltx-trainer/scripts/serve_captioner.py`.



## Authentication & Identity

**Auth Provider:**

- Custom local capability-token authentication; no external user identity provider, OAuth login, or account database was detected.
  - Implementation: `server/gatewayAuth.ts` generates or validates a minimum-24-character `DIRECTOR_GATEWAY_TOKEN`, uses timing-safe comparison, allowlists browser Origins, and protects `/api/` plus production/scene/Agent routes.
  - Bootstrap: Allowlisted browser Origins can request the process token; no-Origin clients must already possess it unless `DIRECTOR_ALLOW_ANON_BOOTSTRAP=1`.
  - Preview access: A separate process-epoch, read-only `preview_token` authorizes only `GET /api/preview`.
  - Workspace identity: Browser target tokens identify an exact client/instance/scene/scope lease; mutation guards and idempotency keys are separate from gateway authentication (`server/mcp-server.ts`, `server/workbenchAgentBoundary.ts`).
  - Provider credentials: OpenAI, Anthropic, compatible API, LTX worker, Gemini, W&B, and Hugging Face credentials remain server/process-side and are not exposed in public capability payloads (`server/controlPlane/controlPlaneConfig.ts`).



## Monitoring & Observability

**Error Tracking:**

- No Sentry, Datadog, OpenTelemetry collector, or managed error-tracking integration was detected.
- W&B is available only for LTX training experiments, not application error tracking (`pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/trainer.py`).

**Logs:**

- Node gateway and scripts use process stdout/stderr and structured route/tool responses (`server/agent-gateway.ts`, `scripts/`).
- Agent events, model usage, plans, approvals, and checkpoints are persisted in SQLite (`server/agentSessionStore.ts`).
- Production artifacts, immutable version receipts, SHA-256 hashes, audit results, and promotion records are persisted by `server/artifacts/productionArtifactStore.ts`.
- Python worker uses standard `logging` and stores bounded job error details plus durable JSON receipts (`pipelines/video-generation/worker/src/director_ltx23_worker/app.py`).
- LTX trainer uses its package logger plus optional W&B metrics/media (`pipelines/video-generation/ltx-2/packages/ltx-trainer/src/ltx_trainer/__init__.py`, `trainer.py`).



## CI/CD & Deployment

**Hosting:**

- Primary application target is local loopback: Director UI on port 5175, gateway on port 8787, docs on port 4321, and optional LTX worker on port 8790 (`README.md`, `tools/vite.config.ts`, `docs/site/astro.config.mjs`, `backend/inference/video-generation/worker/src/director_ltx23_worker/executor.py`).
- Vite creates a static browser build; Astro creates a static documentation build (`package.json`, `docs-site/package.json`).
- The gateway refuses non-loopback binds and directs remote operators to place a real authenticated reverse proxy in front (`server/controlPlane/controlPlaneConfig.ts`).
- No Docker, Kubernetes, serverless, or named cloud-host deployment configuration was detected.

**CI Pipeline:**

- GitHub Actions workflow at `.github/workflows/ci.yml`.
- Node 22 job runs npm clean installs, repository boundary checks, ESLint, Prettier verification, TypeScript/Vite/MCP build, Vitest, and Astro docs build.
- Python 3.12 job installs uv, syncs the locked worker with dev dependencies, and runs pytest.
- Asset tests requiring licensed/local runtime assets are intentionally separate from default CI (`package.json`, `README.md`).



## Environment Configuration

**Required env vars:**

- None for the basic local UI/gateway path; defaults are loopback and a random process token (`server/controlPlane/controlPlaneConfig.ts`, `server/gatewayAuth.ts`).
- Hosted Agents: `DIRECTOR_AGENT_PROFILES_JSON` plus the profile-selected API-key variable; common keys are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DIRECTOR_AGENT_API_KEY`.
- Legacy compatible Agent: `DIRECTOR_AGENT_API_BASE_URL`, `DIRECTOR_AGENT_API_MODEL`, and optional `DIRECTOR_AGENT_API_KEY`.
- Gateway/MCP/CLI: optional `STAGE_GATEWAY_HOST`, `STAGE_GATEWAY_PORT`, `STAGE_GATEWAY_URL`, `DIRECTOR_GATEWAY_TOKEN`, `DIRECTOR_ALLOWED_ORIGINS`, `DIRECTOR_MCP_SESSION_ID`, `STAGE_AGENT_SESSION`, and `DIRECTOR_TARGET_TOKEN`.
- LTX control plane: `DIRECTOR_LTX23_URL` and optional `DIRECTOR_LTX23_API_KEY`; worker execution requires valid `LTX23_DISTILLED_CHECKPOINT_PATH`, `LTX23_SPATIAL_UPSAMPLER_PATH`, `LTX23_GEMMA_ROOT`, `LTX2_SOURCE_ROOT`, and `LTX2_SOURCE_COMMIT` (`pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`).
- ComfyUI: `COMFYUI_URL` and `COMFYUI_VIDEO_WORKFLOW_PATH`.
- Captioning: `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or Google ADC plus optional `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`.
- LTX source bootstrap: `DIRECTOR_ACCEPT_LTX2_LICENSE=1`; optional `DIRECTOR_LTX2_SOURCE_DIR`.

**Secrets location:**

- Secrets are supplied through process environment or external CLI/SDK credential stores; no `.env` files were detected.
- Hosted model profile JSON stores the name of an environment variable (`apiKeyEnv`), not the credential value, in `server/controlPlane/controlPlaneConfig.ts`.
- The gateway generates an ephemeral process token when `DIRECTOR_GATEWAY_TOKEN` is absent and passes it only to child processes/authorized clients (`server/agent-gateway.ts`, `server/gatewayAuth.ts`).
- Checked-in `.mcp.json` contains only the loopback gateway URL and no secret.



## Webhooks & Callbacks

**Incoming:**

- No third-party webhook endpoints were detected.
- Incoming integration surfaces are synchronous/local HTTP routes and WebSocket messages: Director API routes in `server/routes/`, MCP stdio in `server/mcp-server.ts`, and the LTX worker REST API in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
- Browser callbacks are correlation-ID-based WebSocket responses managed inside `server/agent-gateway.ts`; they are not externally registered webhooks.

**Outgoing:**

- No outgoing webhook delivery system was detected.
- Outbound interactions are direct request/response calls to hosted model APIs, the LTX worker, ComfyUI, Hugging Face, Gemini/Vertex AI, local vLLM, and local Agent/DCC subprocesses.
- Video-provider status is polled through provider APIs (`server/video/providers/ltx23HttpProvider.ts`, `server/video/providers/comfyUiVideoProvider.ts`) rather than delivered by callbacks.

---

*Integration audit: 2026-08-03*