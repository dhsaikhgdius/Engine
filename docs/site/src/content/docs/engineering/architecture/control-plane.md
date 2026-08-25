---
title: Director control-plane architecture
---

## Scope and current status

Director separates interactive execution, durable orchestration, and GPU inference into three processes. This is a runtime boundary, not only a source-directory convention:

1. the **browser execution plane** owns the live editors, React state, WebGL rendering, exact-tab tool execution, and visual capture;
2. the **TypeScript control plane** owns authentication, runtime configuration, tool validation and scheduling, role orchestration, job manifests, and durable production records;
3. the **Python GPU worker** owns LTX-2.3 model residency, its single-device queue, inference, encoding, and worker-local artifacts.

The agent loop and its sessions are owned by DeepSeek Harness (`vendor/deepseek-harness`); the Director plugin in `packages/dsh-plugin-workbench/` registers the domain tools, and every agent surface (DSH plugin, MCP, CLI) reaches the Gateway through `POST /api/tools/:name`. The control plane also supports provider-neutral video jobs with ComfyUI and an HTTP LTX-2.3 provider. It does **not** yet upload conditioning media to a remote LTX worker or promote the worker's completed output into Director's persistent media library.

## Process topology

```text
┌──────────────────────────────── Browser execution plane ────────────────────────────────┐
│ React / R3F editor                                                                        │
│  ├─ Canvas, 3D Stage, Video Editor                                                        │
│  ├─ DirectorProject and Creative workspace runtime                                       │
│  ├─ exact-target director_workbench / director_creative execution                        │
│  └─ clean-frame and visual-evidence capture                                               │
└───────────────────────────────┬───────────────────────────────────────────────────────────┘
                                │ authenticated HTTP + WebSocket
                                │ target = tab + instance + scene + creative scope
┌───────────────────────────────▼───────────────────────────────────────────────────────────┐
│ TypeScript control plane (`backend/gateway/agent-gateway.ts`)                             │
│  ├─ gateway auth and target routing                                                       │
│  ├─ AgentProfileRegistry (public model/runtime profiles)                                  │
│  ├─ POST /api/tools/:name for the DSH plugin, MCP, and CLI                                │
│  ├─ agentToolScheduler + agentToolMemory (exclusive mutations, idempotent replay)         │
│  ├─ ProductionRunOrchestrator + hashed role artifacts                                     │
│  └─ VideoGenerationService + provider adapters                                            │
└──────────────────────┬─────────────────────────────────────────┬───────────────────────────┘
                       │ OpenAI-compatible Chat Completions      │ provider HTTP v1
                       ▼                                         ▼
             External/local model API               Python LTX-2.3 GPU worker
                                                     ├─ resident DistilledPipeline
                                                     ├─ durable single-consumer queue
                                                     └─ worker-local MP4 artifacts
```

The composition root is `backend/gateway/agent-gateway.ts`. It parses integration settings once through `backend/gateway/controlPlane/controlPlaneConfig.ts`, constructs registries and stores, and injects them into route modules. Provider secrets remain in the Gateway process and are not serialized into public capability responses.

## Browser execution plane

The browser is authoritative for operations that require the live editor or rendered pixels. In particular:

- `director_workbench` executes typed Stage/Director operations against the live `DirectorProject`;
- `director_creative` executes Canvas and Video operations against the scene-scoped Creative workspace;
- preview and clean-frame requests render the same browser scene the user sees, with capture policy deciding whether helpers are included;
- WebSocket responses carry the exact browser target that produced the result.

The target contract is defined by `directorAgentTargetWireSchema` in `packages/protocol/src/agentGatewayProtocol.ts`. A target binds a request to all of the following:

- browser capability token;
- client/tab ID;
- Director instance ID;
- scene ID;
- Creative workspace scope ID;
- contract version.

The gateway fails closed when that target disconnects or changes. It does not choose an arbitrary connected tab. The API Harness also checks the target returned by a tool before accepting its result.

Browser HTTP calls go through `frontend/director/src/comprehensive/editor/api/directorControlPlaneClient.ts`. The initial `/te-man/director/agent/bootstrap` call obtains the process-epoch gateway token. Normal requests send that credential through the shared authenticated fetch path; Server-Sent Events use a query token because `EventSource` cannot attach custom headers. Frontend modules do not read model or worker credentials.

The gateway still owns the compact `StageScene v5` compatibility state and its command engine. Full editor operations and Creative operations, however, are executed in the exact browser target rather than by duplicating the React editor model in Node.js.

## TypeScript control plane

### Configuration and exposure

`loadDirectorControlPlaneConfig` is the single parser for Agent API and video-provider settings. The gateway defaults to `127.0.0.1:8787` and rejects a non-loopback `STAGE_GATEWAY_HOST`. A network deployment therefore requires an authenticated reverse proxy; changing the host to `0.0.0.0` is intentionally not a supported shortcut.

Gateway authentication is implemented in `backend/gateway/gatewayAuth.ts`:

- `/health`, browser bootstrap, and the public preview are the narrow unauthenticated exceptions;
- other `/api/*` and Director management routes require the process-epoch token;
- allowed browser origins are explicit;
- an explicitly configured `DIRECTOR_GATEWAY_TOKEN` must be at least 24 characters.

### Durable state

| State                                                      | Current owner                                        | Durable location                                        |
| ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Agent sessions and events                                  | DeepSeek Harness (`vendor/deepseek-harness`)         | DSH-owned session storage, outside the Gateway          |
| Multi-Agent production runs and role artifacts             | `backend/gateway/multiAgent/multiAgentRunStore.ts`   | `data/multi-agent-runs/*.json`                          |
| Production manifest and per-scene DirectorProject records  | `backend/gateway/production/productionStateStore.ts` | `data/director-production-state.json`                   |
| Video request, resolved parameters, provider job, warnings | `backend/gateway/video/videoGenerationService.ts`    | `data/video-jobs/<job-id>/manifest.json`                |
| Captured conditioning frame and Stage snapshot             | `backend/gateway/video/videoGenerationService.ts`    | `data/video-jobs/<job-id>/reference.*` and `scene.json` |

JSON records are schema-validated and replaced through a temporary file plus rename. Per-run update locks serialize concurrent read-modify-write transforms. Agent event ordering and checkpoints are transactional in SQLite.

### Public gateway endpoints

All `/api/*` endpoints below require gateway authentication unless noted otherwise.

| Method and path                                                | Purpose                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`                                                  | Minimal unauthenticated gateway health                                               |
| `POST /te-man/director/agent/bootstrap`                        | Obtain the local process-epoch browser token                                         |
| `GET /api/control-plane/capabilities`                          | Sanitized Agent/video configuration summary; never includes secrets                  |
| `GET /api/agent/profiles`                                      | Public model/runtime profiles and capabilities                                       |
| `GET, POST /api/agent/runs`                                    | List or create durable Multi-Agent runs                                              |
| `GET /api/agent/runs/:id`                                      | Inspect run, node attempts, and artifacts                                            |
| `POST /api/agent/runs/:id/resume`                              | Resume non-succeeded nodes without repeating succeeded work                          |
| `POST /api/agent/runs/:id/cancel`                              | Abort the active session and wait for run shutdown                                   |
| `GET /api/video/providers`                                     | Live normalized provider capabilities                                                |
| `POST /api/tools/stage_video`                                  | `capabilities`, `prepare`, `render`, `submit`, `status`, or `cancel` video operation |

The structured tool endpoint family also contains `stage_read`, `director_workbench`, `director_creative`, and the remaining Stage tools. Their schemas remain the execution boundary; no agent surface sends arbitrary JavaScript or shell commands to the browser. Agent session endpoints are not part of the Gateway: sessions, events, and the conversation loop live in DeepSeek Harness.

## Agent runtime ownership

The agent runtime is DeepSeek Harness (`vendor/deepseek-harness`, DSH). DSH owns the tool loop,
sessions, todo state, subagents, and the workspace / web / job tools. Director's creative surface is
the Cordis plugin `packages/dsh-plugin-workbench/`, whose tool executions validate arguments with
Zod and dispatch to the Gateway's `POST /api/tools/:name`; MCP (`backend/gateway/mcp-server.ts`) and
the Stage CLI (`tools/scripts/stage-cli.mjs`) converge on the same route. The Gateway does not run a
second tool loop: it validates, schedules (`backend/gateway/agents/agentToolScheduler.ts`), applies
role policy (`backend/gateway/agents/filmRoleToolPolicy.ts`), and executes against the exact
browser target.

Profiles are Gateway-owned records from `backend/gateway/agents/agentProfileRegistry.ts`. A client
selects a public `profileId`, but cannot submit a base URL, model endpoint, or API key in a request.
Multiple hosted profiles are accepted through strict `DIRECTOR_AGENT_PROFILES_JSON`, and the
Agent workspace can persist additional providers to `agent-api-providers.json`. The public
profile endpoint exposes only label, runtime, model, endpoint host, capabilities, availability, and
whether a credential exists. Endpoint URLs on public profiles, secret values, and secret
environment-variable names remain server-side except the workspace settings list, which returns
base URLs so they can be edited.

Delegation belongs to DSH: its `subagent` and job tools create and track child sessions. Director
does not duplicate that lifecycle; a delegated child reaches Director state only through the same
typed tool HTTP as its parent.

## Multi-Agent production graph

The contracts are in `frontend/director/src/agent/multiAgentRunSchema.ts`; durable execution is split between `backend/gateway/multiAgent/multiAgentRunStore.ts` and `backend/gateway/multiAgent/productionRunOrchestrator.ts`.

The default role order is:

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

This is currently a **serial, topologically ordered DAG subset**. The second visual-critic node is
an explicit acceptance pass after repair. Nodes and artifact edges are durable, but there is no
general parallel branch/fan-in scheduler yet. Each node creates its own Agent Session with a
resolved, node-pinned Profile. A successful node emits a SHA-256-addressed artifact and records its
input/output artifact IDs. By default the next node receives up to the three most recent upstream
artifacts; a resumed node reuses its recorded inputs and Profile.

Run status is one of `queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`, or `interrupted`. Node status is one of `pending`, `running`, `succeeded`, `failed`, `cancelled`, or `stale`. Resume preserves succeeded nodes and their artifacts, resets every other node to pending, and is guarded against duplicate concurrent starts. Cancel aborts the active Agent session, marks unfinished nodes, releases event subscriptions, and waits for the background execution to finish before returning.

Artifacts currently have three kinds:

- `role-report` for normal role conclusions;
- `director-receipt` for verified Director mutations/evidence;
- `generation-receipt` for generation submission or result evidence.

The orchestrator always preserves the final role report, then inspects normalized `tool.completed`
events. It promotes an artifact to `generation-receipt` only when a successful `stage_video`
result contains a durable `job_id`, and to `director-receipt` only when a successful Workbench
result contains revision or delivery evidence. An assistant's text-only success claim remains a
`role-report`; it is never treated as rendered media or a verified mutation.

### Role policy

The API Harness enforces the following server-side policy in addition to each role's prompt:

| Role                                                   | Allowed structured tools                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `stage-director`, `cinematographer`, `repair-operator` | Stage/Workbench tools except `stage_video` and `director_creative`              |
| `generation-operator`                                  | `stage_video`, `stage_read`, and read-only Workbench operations                 |
| `editor`                                               | `director_creative` and `stage_read`                                            |
| `visual-critic`                                        | `stage_read` plus Workbench audit/capture/shot-package/delivery evidence        |
| Planning roles                                         | `stage_read`, read-only Workbench operations, and read-only Creative operations |

Read-only Workbench operations are `capabilities`, `observe`, `catalog`, `audit`, `diff`, `trace`, and `shot_ir`. Read-only Creative operations are `capabilities`, `observe`, `audit`, and `preview`.
The visual critic additionally receives `capture`, `shot_package`, and `deliver` so it can inspect
real helper-free pixels and hashes, while authoring operations remain rejected.

This exact tool filter is presently enforced by the native API adapter. Local Codex/Claude adapters share the structured Director tools and receive the assigned role, but should not yet be described as having the same adapter-level role-policy proof. Moving policy enforcement below every adapter, at the gateway tool boundary, remains a hardening task.

## Video generation and LTX-2.3

`packages/protocol/src/videoGenerationProtocol.ts` and `backend/gateway/video/providers/videoProvider.ts` define the provider-neutral contract. `backend/gateway/video/videoGenerationService.ts` owns Director job manifests; providers only translate normalized requests and job states.

For LTX-2.3, the flow is:

1. `prepare` validates the Stage scene, computes a scene digest, records scene structure and camera plan, and requests a browser capture when available;
2. the clean frame is written under the Director video-job directory;
3. LTX dimensions are aligned to multiples of 64 and frame count to `8k+1`; requested and resolved delivery values are both retained;
4. `submit` spawns `tools/scripts/ltx23-generate.py` against `vendor/ltx-2` through `backend/gateway/video/providers/ltx23SpawnProvider.ts`;
5. that process loads the official `DistilledPipeline` once, writes `output.mp4` next to the job manifest, and exits;
6. `status` and `cancel` reconcile the Director manifest with the child process (cancel kills the process group).

There is no resident FastAPI worker, HTTP job queue, or worker API key. Official source is the Git submodule `vendor/ltx-2`; weights stay outside Git.

## Environment variables

### TypeScript gateway and browser

| Variable                                   | Purpose                                                    | Default / constraint                       |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| `STAGE_GATEWAY_HOST`                       | Gateway bind host                                          | `127.0.0.1`; only loopback values accepted |
| `STAGE_GATEWAY_PORT`                       | Gateway HTTP port                                          | `8787`                                     |
| `DIRECTOR_GATEWAY_TOKEN`                   | Stable gateway credential instead of an ephemeral token    | Optional; at least 24 characters           |
| `DIRECTOR_ALLOWED_ORIGINS`                 | Additional comma-separated browser origins                 | Local Director origins are built in        |
| `STAGE_GATEWAY_URL`                        | API Harness callback origin for structured tools           | `http://127.0.0.1:8787`                    |
| `VITE_STAGE_GATEWAY_URL`                   | Browser control-plane origin                               | `http://127.0.0.1:8787`                    |
| `DIRECTOR_AGENT_API_BASE_URL`              | Server-owned OpenAI-compatible base URL                    | Required for the `api` profile             |
| `DIRECTOR_AGENT_API_KEY`                   | Bearer credential for that API                             | Optional for trusted local endpoints       |
| `DIRECTOR_AGENT_API_MODEL`                 | Model sent to Chat Completions                             | Required for the `api` profile             |
| `DIRECTOR_AGENT_API_LABEL`                 | Public profile label                                       | `OpenAI-compatible API`                    |
| `DIRECTOR_AGENT_API_MAX_TOOL_ROUNDS`       | Maximum tool-loop rounds                                   | `12`, clamped to `1..48`                   |
| `DIRECTOR_AGENT_PROFILES_JSON`             | Strict array of OpenAI, Anthropic, or compatible profiles  | Optional; maximum 64 profiles              |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`       | Native OpenAI credential and optional endpoint override    | Server-only                                |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Native Anthropic credential and optional endpoint override | Server-only                                |
| `DIRECTOR_VIDEO_PROVIDER`                  | Default video provider                                     | `ltx-2.3` or `comfyui`; otherwise inferred |
| `DIRECTOR_ACCEPT_LTX2_LICENSE`             | Must be `1` after reviewing the LTX-2 Community License    | Required to enable local LTX               |
| `DIRECTOR_LTX2_SOURCE_DIR`                 | Override the `vendor/ltx-2` checkout                       | Optional                                   |
| `DIRECTOR_LTX23_MODEL`                     | Model label stored in Director manifests                   | `ltx-2.3-22b`                              |
| `LTX23_DISTILLED_CHECKPOINT_PATH`          | Official distilled checkpoint                              | Required file                              |
| `LTX23_SPATIAL_UPSAMPLER_PATH`             | Official spatial upsampler                                 | Required file                              |
| `LTX23_GEMMA_ROOT`                         | Gemma encoder directory                                    | Required directory                         |
| `LTX23_DEVICE` / `LTX23_QUANTIZATION` / `LTX23_OFFLOAD` | Optional DistilledPipeline device policy      | Official defaults                          |
| `COMFYUI_URL`                              | ComfyUI HTTP origin                                        | Required for ComfyUI provider              |
| `COMFYUI_VIDEO_WORKFLOW_PATH`              | Workflow JSON inside the Director workspace                | Must not escape the workspace root         |

`DIRECTOR_AGENT_API_KEY` and gateway tokens never appear in `publicControlPlaneCapabilities` or public Agent profiles.

Installation: `DIRECTOR_ACCEPT_LTX2_LICENSE=1 npm run setup:ltx2`, then download the gated LTX-2.3 and Gemma weights listed in `vendor/ltx-2.lock.json`. Director imports the official LTX packages from `vendor/ltx-2` at spawn time; model weights remain outside the repository.

Official Hunyuan3D-2, TRELLIS, ARDY, and LTX-2 trees are Git submodules under `vendor/` with sibling `*.lock.json` pins. Initialize them with `npm run setup:hunyuan3d` (community-license acknowledgement required), `npm run setup:trellis`, `npm run setup:ardy`, and `npm run setup:ltx2`. Do not copy those sources into another directory.

## Extension rules

New Agent or video providers should preserve these boundaries:

1. add a provider behind the existing registry/interface rather than branching UI state;
2. keep endpoints and credentials in `controlPlaneConfig`, never in client-authored jobs;
3. validate external responses before persistence;
4. preserve exact browser targeting for any editor mutation;
5. emit normalized durable state and immutable artifact evidence;
6. make retries idempotent and cancellation observable;
7. report unsupported controls as warnings instead of silently dropping them;
8. do not claim remote media support until upload, digest verification, result promotion, and recovery are implemented end to end.
