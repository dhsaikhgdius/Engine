# @director/agent-engine — Agent Engine

> Languages: **English** · [中文](README.zh-CN.md)

Director Agent engine. Contains workbench contracts, command execution, authoring actions, audit, automation, spatial authoring, storyboard, generation workbenches, and other core logic shared by frontend and backend.

**Package:** `@director/agent-engine` — `"main": "./src/index.ts"` — Depends: `zod`, `@director/protocol`, `@director/project-schema`, `@director/stage-protocol`, `@director/dcc-interchange`

The barrel `index.ts` exports only universal (Node + browser) safe files. Browser Zustand/DOM execution lives in `frontend/director/src/agent/`.

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export (universal-safe files only) |
| `agentIds.ts` | Agent identifiers: `DIRECTOR_AGENT_IDS` (codex, claude) and session provider IDs |
| `agentPlan.ts` | Agent plan: operation definitions, plan structure, Stage/Creative/Blender/Video tool execution routing |
| `agentPlanFold.ts` | Extracts the latest structured plan from session events (fold) |
| `agentSceneRunProjection.ts` | Pure replay projection of the latest Director/Blender 3D build loop: context, blockout, verification, and local repair |
| `agentRuntimeSchema.ts` | Agent runtime schema: profile IDs, runtime kinds, role-profile mapping |
| `agentSessionSchema.ts` | Agent session schema: session statuses, event types, capabilities, message schemas |
| `agentSessionProtocol.json` | Agent session protocol data: status and event type enumerations |
| `commandEngine.ts` | Stage command execution engine: `executeStageTool` core implementation (~976 lines) |
| `stageCommandSchema.ts` | Stage command Zod schemas: scene_state, create, update, delete, camera, etc. operations |
| `stageCommandPresentation.json` | Stage command help text template |
| `stageFeedback.ts` | Stage feedback: changed entities, scene hints, validation result schemas |
| `jsonPatch.ts` | JSON Patch (RFC 6902) implementation: add, remove, replace operations |
| `multiAgentRunSchema.ts` | Multi-agent run schema: production run IDs, statuses, role profile mapping |
| `videoModelContract.ts` | Video model input validation: parses `stage_video` operations and validates scene readiness |
| `directorWorkbenchContract.ts` | Director workbench contract: all operation schemas (observe, author, patch, generation, storyboard, etc.), ~865 lines |
| `directorWorkbenchDescribe.ts` | Progressive disclosure for workbench contract: returns JSON Schema for one operation or author action on demand |
| `directorWorkbenchObserve.ts` | Project-only observe payload used by the browser executor and gateway disconnected reads |
| `directorAuthoring.ts` | Authoring action definitions and execution: ~2943 lines covering all authoring ops (objects, cameras, lights, characters, animation, world) |
| `directorAudit.ts` | Project audit: checks structural integrity, reference consistency, spatial conflicts, generates fix suggestions |
| `directorAutomation.ts` | Automation library: macro definitions, parameterization, memory storage, import/export |
| `directorBlocking.ts` | Character blocking: compose character positions, facings, and pose presets |
| `directorProjectGraph.ts` | Project graph integrity checks: ID uniqueness, reference validation |
| `directorSpatialAuthoring.ts` | Spatial authoring: place_relative, arrange, align, distribute, and other spatial operations |
| `directorSpatialGeometry.ts` | Spatial geometry computation: character bounding boxes, planar footprint/support radius |
| `directorProceduralAuthoring.ts` | Procedural authoring: apply_procedural operation, expands procedural recipes into low-level authoring actions |
| `directorStageAdapter.ts` | Stage adapter: DirectorProject ↔ StageScene bidirectional conversion |
| `creativeWorkspaceAgentSchemas.ts` | Creative workspace Zod schemas and empty snapshot fixture (store-free) |
| `creativeWorkspaceAgentQuality.ts` | Creative workspace quality audit: board integrity, clip overlap, media reference checks |
| `characterMotionCatalog.ts` | Packaged Mixamo motion catalog for runtime, inspector, and Agent capabilities |
| `directorAgentAssetCatalog.ts` | Agent-facing packaged 3D asset catalog |
| `directorDefaultProject.ts` | Store-free default Director project factory |
| `creativeWorkspaceAgentCapabilities.json` | Creative workspace agent capability declaration data |
| `directorWorkbenchCapabilities.json` | Director workbench capability declaration data |

Browser workbench execution (`gatewayClient`, `directorWorkbenchExecutor`, capture/generation/storyboard handlers) lives in `frontend/director/src/agent/`. Those modules import this package; this package must not import the browser Zustand store.

## Build

Type-checked as part of the root `npm run build` as an npm workspace. The barrel export intentionally excludes browser-specific files, ensuring safe imports from Node.js targets (Gateway, MCP server).
