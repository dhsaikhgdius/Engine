# Codebase Structure

**Analysis Date:** 2026-08-03

## Directory Layout

```text
WorldEngine/
├── src/                                  # Browser application and shared domain code
│   ├── main.tsx                          # Vite/React browser entry
│   ├── comprehensive/                    # Complete Director editor
│   │   ├── App.tsx                       # Workspace router and application shell
│   │   ├── app/                          # Layout and theme infrastructure
│   │   ├── editor/                       # Editor features and browser runtime
│   │   │   ├── api/                      # Typed gateway/control-plane clients
│   │   │   ├── assistant/                # In-app Agent workbench and plan/apply bridges
│   │   │   ├── canvas/                   # React Three Fiber viewport and controls
│   │   │   ├── collaboration/            # Yjs presence, reviews, and versions
│   │   │   ├── gateway/                  # Exact browser-target registry
│   │   │   ├── interchange/              # OTIO, Fountain, glTF, and USD subsets
│   │   │   ├── io/                       # Import/export, host, and capture bridges
│   │   │   ├── loaders/                  # Asset, panorama, and humanoid loaders
│   │   │   ├── media/                    # Media probing and IndexedDB persistence
│   │   │   ├── modelLibrary/             # Asset catalogs and library behavior
│   │   │   ├── motion/                   # Camera and motion controls
│   │   │   ├── panels/                   # Scene, asset, character, camera inspectors
│   │   │   ├── performance/              # Adaptive render profiles and metrics
│   │   │   ├── player/                   # Character exploration/player runtime
│   │   │   ├── presets/                  # Reusable pose and scene presets
│   │   │   ├── production/               # Production scene client and UI
│   │   │   ├── productionGraph/          # Production graph schema and integrity
│   │   │   ├── render/                   # Capture visibility, optics, render passes
│   │   │   ├── runtime/                  # Three.js character and animation runtime
│   │   │   ├── schema/                   # DirectorProject types and Zod schemas
│   │   │   ├── session/                  # Active scene/session runtime
│   │   │   ├── shot/                     # Shot IR, package, trajectory, capture
│   │   │   ├── store/                    # Zustand Director state and selectors
│   │   │   ├── storyboard/               # Storyboard domain and panel
│   │   │   ├── timeline/                 # Frame-native timeline and timecode
│   │   │   ├── trajectory/               # Procedural paths and viewport overlays
│   │   │   ├── video/                    # Deterministic video export/recording
│   │   │   └── workspaces/                # Canvas, Stage, and Video workspaces
│   │   ├── i18n/                         # Chinese/English UI strings
│   │   └── styles/                       # Editor and component CSS
│   ├── agent/                            # Agent contracts, authoring, audit, execution
│   ├── stage/                            # Compact StageScene schema and domain
│   └── shared/                           # Pure browser/server transport contracts
├── server/                               # Node TypeScript control plane
│   ├── agent-gateway.ts                  # HTTP/WebSocket composition root
│   ├── mcp-server.ts                     # Native MCP stdio server
│   ├── agents/                           # Profiles, adapters, and model drivers
│   │   └── modelDrivers/                 # Native/OpenAI-compatible HTTP drivers
│   ├── artifacts/                        # Durable production artifact storage
│   ├── controlPlane/                     # Server-owned configuration
│   ├── dcc/                              # Blender and glTF handoff
│   ├── jobs/                             # Durable production job storage
│   ├── multiAgent/                       # Production DAG orchestration and runs
│   ├── production/                       # Manifest/scene persistence and coordination
│   ├── routes/                           # Feature-specific HTTP route handlers
│   ├── testing/                          # Shared server test builders
│   └── video/                            # Generation service and provider adapters
│       └── providers/                    # LTX-2.3, ComfyUI, provider interface
├── pipelines/                            # Isolated heavyweight production pipelines
│   └── video-generation/
│       ├── worker/                       # Director FastAPI LTX-2.3 worker
│       │   ├── src/director_ltx23_worker/
│       │   └── tests/
│       └── ltx-2/                        # Pinned upstream Python/CUDA source
│           └── packages/
│               ├── ltx-core/
│               ├── ltx-kernels/
│               ├── ltx-pipelines/
│               └── ltx-trainer/
├── scripts/                              # CLI, checks, asset and worker utilities
├── plugins/
│   └── director-workbench/               # Portable MCP plugin distribution
├── .claude/skills/
│   └── director-workbench/               # Native Agent workflow instructions
├── docs-site/                            # Astro Starlight documentation project
│   └── src/content/docs/                 # English, Chinese, and engineering docs
├── tools/                                # Tooling configs, scripts, Playwright, evals
├── assets/                               # Asset schema and immutable manifest metadata
├── public/                               # Tracked catalogs/notices and restored assets
├── data/                                 # Ignored runtime state; tracked schemas only
├── vendor/                               # Vendored third-party source
└── package.json                          # Root scripts and JavaScript dependencies
```

## Directory Purposes

**`src/comprehensive/`:**
- Purpose: Own the complete browser Director product.
- Contains: React UI, R3F viewport, editor runtime, schemas, stores, media, interchange, collaboration, and three workspaces.
- Key files: `src/comprehensive/App.tsx`, `src/comprehensive/app/layout/DirectorDeskShell.tsx`, `src/comprehensive/editor/workspaces/StageWorkspace.tsx`

**`src/comprehensive/editor/schema/`:**
- Purpose: Define the authoritative versioned `DirectorProject` and pure scene-domain structures.
- Contains: TypeScript models, Zod schemas, migration helpers, camera geometry, animation, production, catalogs, revisions, and viewport configuration.
- Key files: `src/comprehensive/editor/schema/directorProject.ts`, `src/comprehensive/editor/schema/directorProjectSchema.ts`, `src/comprehensive/editor/schema/directorProjectRevision.ts`

**`src/comprehensive/editor/store/`:**
- Purpose: Own mutable browser Stage state and derived selectors.
- Contains: Zustand store, project/UI actions, undo batching, persistence, imports, and selectors.
- Key files: `src/comprehensive/editor/store/directorStore.ts`, `src/comprehensive/editor/store/directorSelectors.ts`

**`src/comprehensive/editor/workspaces/`:**
- Purpose: Compose each top-level creative mode and own Canvas/Video workspace state.
- Contains: Stage shell, spatial Canvas, timeline editor, media browser, workspace store, and transport controls.
- Key files: `src/comprehensive/editor/workspaces/StageWorkspace.tsx`, `src/comprehensive/editor/workspaces/CanvasWorkspace.tsx`, `src/comprehensive/editor/workspaces/VideoEditorWorkspace.tsx`, `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`

**`src/comprehensive/editor/canvas/`:**
- Purpose: Render and navigate the 3D Stage.
- Contains: R3F scene roots, viewport layouts, toolbar, overlays, camera properties, keyboard controls, bounds, and capture-facing helpers.
- Key files: `src/comprehensive/editor/canvas/DirectorCanvas.tsx`, `src/comprehensive/editor/canvas/SceneRoot.tsx`, `src/comprehensive/editor/canvas/ViewportToolbar.tsx`

**`src/comprehensive/editor/runtime/`:**
- Purpose: Evaluate and render characters, assets, rigs, animation, and high-frequency interactions.
- Contains: Mixamo/UE4/mannequin runtimes, glTF loading, IK, character models, and frame-coalesced interaction.
- Key files: `src/comprehensive/editor/runtime/CharacterModel.tsx`, `src/comprehensive/editor/runtime/gltfLoader.ts`, `src/comprehensive/editor/runtime/useRafCoalescedTransformInteraction.ts`

**`src/comprehensive/editor/api/`:**
- Purpose: Provide the only frontend transport boundary to control-plane HTTP services.
- Contains: Production, video generation, DCC return, and general control-plane clients.
- Key files: `src/comprehensive/editor/api/directorControlPlaneClient.ts`, `src/comprehensive/editor/api/videoGenerationClient.ts`, `src/comprehensive/editor/api/dccReturnClient.ts`

**`src/agent/`:**
- Purpose: Browser-only Codex/Claude PTY terminal UI.
- Contains: xterm panel, session hook, terminal theme/CSS, and the gateway-bridge persistence test.
- Key files: `src/agent/TerminalAssistantPanel.tsx`, `src/agent/useTerminalSession.ts`

**`packages/stage-protocol/`:**
- Purpose: Hold the compact `StageScene` model independently of React and editor stores.
- Contains: Scene types, Zod parsing, default scene, and prop catalog.
- Key files: `packages/stage-protocol/src/types.ts`, `packages/stage-protocol/src/sceneSchema.ts`, `packages/stage-protocol/src/defaultScene.ts`

**`src/shared/`:**
- Purpose: Share pure wire protocols between browser, gateway, MCP server, and tests.
- Contains: Agent gateway, Creative workspace, collaboration, video generation, production job, and artifact contracts.
- Key files: `src/shared/agentGatewayProtocol.ts`, `src/shared/creativeWorkspaceProtocol.ts`, `src/shared/videoGenerationProtocol.ts`, `src/shared/productionArtifactProtocol.ts`

**`server/`:**
- Purpose: Own authenticated control, durable state, provider routing, orchestration, and external integration.
- Contains: Gateway/MCP entry points, route handlers, Agent harness, sessions, terminal process management, browser routing, collaboration, DCC, jobs, artifacts, and video services.
- Key files: `server/agent-gateway.ts`, `server/mcp-server.ts`, `server/agentHarness.ts`, `server/gatewayAuth.ts`

**`server/routes/`:**
- Purpose: Split HTTP handling by control-plane feature while keeping service composition in the gateway.
- Contains: Stage tools, productions, sessions, assistant, DCC, multi-Agent runs, jobs, artifacts, and control-plane routes.
- Key files: `server/routes/stageRoutes.ts`, `server/routes/productionRoutes.ts`, `server/routes/controlPlaneRoutes.ts`, `server/routes/agentSessionRoutes.ts`

**`server/agents/`:**
- Purpose: Resolve Profiles and normalize model-provider protocols.
- Contains: Profile registry and film-role tool policy. Canonical model drivers live in `@director/model-provider`.
- Key files: `server/agents/agentProfileRegistry.ts`, `packages/model-provider/src/runtime/modelDriver.ts`

**`server/production/`:**
- Purpose: Maintain production manifests and independently revisioned scene documents.
- Contains: Validated atomic persistence and serialized mutation coordination.
- Key files: `server/production/productionStateStore.ts`, `server/production/productionMutationCoordinator.ts`

**`server/multiAgent/`:**
- Purpose: Run and persist the production role graph.
- Contains: Durable run store and serial orchestrator.
- Key files: `server/multiAgent/multiAgentRunStore.ts`, `server/multiAgent/productionRunOrchestrator.ts`

**`server/video/`:**
- Purpose: Convert Director shot intent into durable provider-neutral generation jobs.
- Contains: Generation service, provider factory, LTX-2.3 HTTP adapter, ComfyUI adapter, and provider interface.
- Key files: `server/video/videoGenerationService.ts`, `server/video/createVideoGenerationService.ts`, `server/video/providers/videoProvider.ts`

**`pipelines/video-generation/worker/`:**
- Purpose: Run Director's isolated Python inference API.
- Contains: FastAPI application, strict Pydantic models, resident executor, persisted job receipts, and worker contract tests.
- Key files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/models.py`

**`pipelines/video-generation/ltx-2/`:**
- Purpose: Supply pinned upstream LTX implementation and training/inference packages.
- Contains: `ltx-core`, CUDA kernels, inference pipelines, trainer, lockfile, and upstream documentation.
- Key files: `pipelines/video-generation/ltx-2/pyproject.toml`, `pipelines/video-generation/ltx-2/uv.lock`, `pipelines/video-generation/ltx-2/packages/ltx-pipelines/src/ltx_pipelines/__init__.py`

**`scripts/`:**
- Purpose: Provide repeatable repository checks, CLI access, asset restoration, and worker bootstrap.
- Contains: Stage CLI, server boundary checker, build-budget checker, open-source checks, LTX source bootstrap, asset manager, and asset packaging scripts.
- Key files: `scripts/stage-cli.mjs`, `scripts/checkServerImportBoundaries.ts`, `scripts/director-assets.mjs`, `scripts/bootstrap-ltx2-source.mjs`

**`tools/`:**
- Purpose: Hold repository tooling configs (Vite, Vitest, ESLint, TypeScript, PostCSS/Tailwind) plus scripts, Playwright, and evals so the repository root stays limited to npm workspace files.
- Contains: `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `tsconfig.json`, PostCSS/Tailwind, `scripts/`, `e2e/`, `evals/`.
- Key files: `tools/README.md`, `tools/vite.config.ts`, `tools/vitest.config.ts`, `tools/eslint.config.js`, `tools/tsconfig.json`

**`plugins/director-workbench/`:**
- Purpose: Package the native MCP server and skill for portable installation.
- Contains: Generated ESM MCP bundle, `.mcp.json`, plugin metadata, skill instructions, and operation references.
- Key files: `plugins/director-workbench/mcp/server.mjs`, `plugins/director-workbench/.codex-plugin/plugin.json`, `plugins/director-workbench/skills/director-workbench/SKILL.md`

**`docs-site/`:**
- Purpose: Build public bilingual operator and engineering documentation.
- Contains: Astro Starlight config, English and Chinese content, ADRs, reference docs, and its own package lock.
- Key files: `docs-site/astro.config.mjs`, `docs-site/src/content/docs/architecture/index.md`, `docs-site/src/content/docs/reference/repository-structure.md`

**`assets/`, `public/`, and `data/`:**
- Purpose: Separate reproducible metadata, public runtime files, and mutable local state.
- Contains: `assets/manifest.schema.json`, tracked catalogs and licenses under `public/`, and ignored gateway artifacts under `data/`.
- Key files: `assets/manifest.schema.json`, `assets/manifest.lock.json`, `public/director-characters/catalog.json`

## Key File Locations

**Entry Points:**
- `src/main.tsx`: Browser application bootstrap.
- `src/comprehensive/App.tsx`: Director workspace selection and shell.
- `server/agent-gateway.ts`: Node HTTP/WebSocket control-plane entry.
- `server/mcp-server.ts`: Native MCP stdio entry.
- `scripts/stage-cli.mjs`: Command-line gateway client.
- `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`: Python worker application.

**Configuration:**
- `package.json`: Root commands, runtime dependencies, and build/test entry points.
- `tools/vite.config.ts`: Browser development/build settings (`npm run dev:ui` / `npm run build` pass `--config`).
- `tools/vitest.config.ts`: TypeScript test runner (`npm test` passes `--config`).
- `tools/eslint.config.js`: Static analysis and boundary-facing lint policy (`npm run lint` passes `--config`).
- `tools/tsconfig.json`: Strict ES2023 TypeScript and bundler module resolution. Thin `extends` files live in `frontend/director/`, `backend/gateway/`, and `packages/` for the IDE.
- `tools/postcss.config.js` / `tools/tailwind.config.js`: Director UI CSS pipeline (Vite `css.postcss` points at `tools/`).
- `tools/e2e/playwright.config.ts`: Playwright end-to-end suite (`npm run test:e2e` passes `--config`).
- `server/controlPlane/controlPlaneConfig.ts`: Parsed server, Agent, profile, data, and provider configuration.
- `pipelines/video-generation/worker/pyproject.toml`: Python worker package and dependency configuration.
- `pipelines/video-generation/ltx-2/pyproject.toml`: Pinned upstream workspace configuration.
- `docs-site/astro.config.mjs`: Documentation site configuration.

**Core Logic:**
- `src/comprehensive/editor/store/directorStore.ts`: Complete editor state and user mutations.
- `src/comprehensive/editor/schema/directorProject.ts`: Authoritative editor model.
- `src/agent/directorWorkbenchExecutor.ts`: Agent-native complete-project execution.
- `packages/agent-engine/src/directorAuthoring.ts`: Semantic authoring action implementation.
- `packages/agent-engine/src/directorAudit.ts`: Deterministic production-quality checks.
- `packages/agent-engine/src/commandEngine.ts`: Compact Stage command semantics.
- `src/agent/gatewayClient.ts`: Browser synchronization and exact-target execution.
- `server/agentHarness.ts`: Provider-neutral Agent loop.
- `server/production/productionStateStore.ts`: Durable production/scene records.
- `server/multiAgent/productionRunOrchestrator.ts`: Production DAG execution.
- `server/video/videoGenerationService.ts`: Provider-neutral video jobs.

**Testing:**
- `frontend/director/tests/**/*.test.ts(x)`: Browser/domain unit and component tests, mirroring `src/`.
- `backend/gateway/tests/**/*.test.ts`: Control-plane unit, route, and integration tests, mirroring gateway source.
- `server/*.integration.test.ts`: Gateway/MCP integration tests.
- `pipelines/video-generation/worker/tests/test_worker_contract.py`: Python worker API contract tests.
- `pipelines/video-generation/ltx-2/packages/*/tests/`: Upstream Python package tests.

**Documentation:**
- `README.md`: Product overview, setup, high-level architecture, and verification commands.
- `docs-site/src/content/docs/architecture/`: Public architectural guides.
- `docs-site/src/content/docs/engineering/`: Detailed implementation records and ADRs.
- `.claude/skills/director-workbench/SKILL.md`: Agent operating contract.

## Naming Conventions

**Files:**
- React components use PascalCase `.tsx`: `src/comprehensive/editor/panels/CameraPanel.tsx`.
- TypeScript domain modules use lower camelCase `.ts`: `src/agent/directorWorkbenchExecutor.ts`.
- Frontend tests live in `frontend/director/tests/` and gateway tests in `backend/gateway/tests/`, named `*.test.ts` or `*.test.tsx`. Shared packages keep tests in `packages/<name>/tests/`.
- Integration tests append `.integration.test.ts`: `server/mcpWorkbenchBoundary.integration.test.ts`.
- Python modules use snake_case: `pipelines/video-generation/worker/tests/test_worker_contract.py`.
- Generated portable output uses explicit distribution paths: `plugins/director-workbench/mcp/server.mjs`.
- Documentation pages use kebab-case: `docs-site/src/content/docs/architecture/control-plane.md`.

**Directories:**
- TypeScript feature directories use lower camelCase where a compound name is needed: `src/comprehensive/editor/modelLibrary/`, `server/multiAgent/`.
- Broad architectural directories use lowercase nouns: `src/agent/`, `src/stage/`, `server/routes/`, `server/video/`.
- Python package directories use snake_case: `pipelines/video-generation/worker/src/director_ltx23_worker/`.
- Product/package directories may use kebab-case: `plugins/director-workbench/`, `pipelines/video-generation/`, `packages/ltx-pipelines/`.

**Types and Contracts:**
- Domain types/interfaces use PascalCase: `DirectorProject`, `StageScene`, `ProductionRecord`.
- Zod values end in `Schema` or `schema`: `directorProjectSchema`, `toolEnvelopeSchema`.
- Store hooks start with `use` and end with `Store`: `useDirectorStore`, `useDirectorCreativeWorkspaceStore`.
- Gateway wire fields use snake_case where they form external JSON contracts; browser-internal TypeScript state uses camelCase.

## Where to Add New Code

**New Browser Editor Feature:**
- Primary code: `src/comprehensive/editor/<feature>/`
- Workspace composition: `src/comprehensive/editor/workspaces/`
- Shared editor model changes: `src/comprehensive/editor/schema/`
- State/actions: `src/comprehensive/editor/store/directorStore.ts` or `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`
- Tests: Co-locate as `*.test.ts` or `*.test.tsx` beside the implementation.

**New React Panel or Viewport Component:**
- Inspector/panel implementation: `src/comprehensive/editor/panels/`
- R3F viewport implementation: `src/comprehensive/editor/canvas/`
- Character/render runtime: `src/comprehensive/editor/runtime/`
- Tests: Same directory and basename with `.test.tsx`.

**New Workbench Operation:**
- Wire schema: `packages/agent-engine/src/directorWorkbenchContract.ts`
- Semantic implementation: `src/agent/directorWorkbenchExecutor.ts` or `packages/agent-engine/src/directorAuthoring.ts`
- Browser dispatch: `src/agent/gatewayClient.ts` only when transport behavior changes.
- Server transport: `server/routes/stageRoutes.ts` only when the existing generic Workbench path is insufficient.
- MCP description/schema exposure: `server/mcp-server.ts`
- Tests: `src/agent/*.test.ts`, `server/routes/stageRoutes.test.ts`, and MCP boundary tests as applicable.
- Distribution: Rebuild `plugins/director-workbench/mcp/server.mjs`; do not hand-edit it.

**New Compact Stage Operation:**
- Operation schema: `packages/agent-engine/src/stageCommandSchema.ts`
- Execution: `packages/agent-engine/src/commandEngine.ts`
- Scene model/validation: `packages/stage-protocol/src/types.ts` and `packages/stage-protocol/src/sceneSchema.ts`
- Tests: Co-located under `packages/agent-engine/` or `packages/stage-protocol/`.

**New Browser/Server Protocol:**
- Shared schema: `src/shared/`
- Frontend API client: `src/comprehensive/editor/api/`
- Server route: `server/routes/`
- Route wiring and services: `server/agent-gateway.ts`
- Rule: Keep `src/shared/` free of React, DOM, Zustand, Node, and filesystem APIs.

**New Control-Plane Feature:**
- Domain/service: Create a focused directory under `server/`.
- HTTP boundary: `server/routes/<feature>Routes.ts`
- Gateway composition: `server/agent-gateway.ts`
- Durable state: Follow stores in `server/production/`, `server/jobs/`, or `server/artifacts/`.
- Tests: Co-locate unit/route tests under `server/`; use `.integration.test.ts` for process-boundary coverage.

**New Agent Provider:**
- Profile/config parsing: `server/controlPlane/controlPlaneConfig.ts`
- Adapter registration: `server/agents/agentAdapterRegistry.ts`
- Protocol driver: `packages/model-provider/src/runtime/`
- Shared orchestration: Reuse the DeepSeek Harness session runtime; do not introduce provider-specific scene state.
- Tests: `packages/model-provider/tests/runtime/modelDrivers.test.ts`.

**New Video Generation Provider:**
- Provider contract: `server/video/providers/videoProvider.ts`
- Provider implementation: `server/video/providers/<providerName>Provider.ts`
- Factory selection: `server/video/createVideoGenerationService.ts`
- Provider-neutral job behavior: `server/video/videoGenerationService.ts`
- Shared wire model: `src/shared/videoGenerationProtocol.ts`
- Tests: Co-locate provider and service tests under `server/video/`.

**New Python Model Worker:**
- Worker package: `pipelines/<stage>/worker/src/<package>/`
- API contracts: `models.py`
- Queue/application: `app.py`
- Model lifecycle: `executor.py`
- Contract tests: `pipelines/<stage>/worker/tests/`
- Node adapter: Add a provider under `server/<feature>/providers/`; keep model weights out of `server/`.

**Utilities:**
- Shared transport helpers: `src/shared/`
- Pure compact Stage helpers: `src/stage/`
- Browser-only helpers: The relevant feature directory under `src/comprehensive/editor/`.
- Node-only helpers: The relevant feature directory under `server/`.
- Repository automation: `scripts/`.

**Documentation:**
- Public English guide: `docs-site/src/content/docs/<section>/`
- Chinese counterpart: `docs-site/src/content/docs/zh/<section>/`
- Engineering record/ADR: `docs-site/src/content/docs/engineering/`
- Agent operational rule: `.claude/skills/director-workbench/` and the portable mirror under `plugins/director-workbench/skills/director-workbench/`.

## Special Directories

**`data/`:**
- Purpose: Gateway runtime state including production documents, sessions, jobs, run artifacts, captures, and receipts.
- Generated: Yes, except intentional schemas.
- Committed: No by default.

**`dist/` and `docs-site/dist/`:**
- Purpose: Browser and documentation build outputs.
- Generated: Yes.
- Committed: No.

**`plugins/director-workbench/mcp/`:**
- Purpose: Portable bundled MCP runtime built from `server/mcp-server.ts`.
- Generated: Yes.
- Committed: Yes as plugin distribution output; regenerate through `npm run build:mcp-plugin`.

**`public/`:**
- Purpose: Serve tracked catalogs/license metadata and locally restored runtime assets.
- Generated: Mixed; catalogs/notices are source artifacts, restored binary assets are external runtime data.
- Committed: Only cleared catalogs, notices, and intended source assets.

**`assets/`:**
- Purpose: Define the asset manifest, lock, checksums, schema, and licensing boundary.
- Generated: No for schema/manifest metadata.
- Committed: Yes.

**`pipelines/video-generation/ltx-2/`:**
- Purpose: Provide the pinned upstream LTX source tree with its own packages and lockfile.
- Generated: No; vendored/pinned upstream source.
- Committed: Yes according to the repository's upstream lock strategy.

**`vendor/`:**
- Purpose: Hold explicitly vendored third-party source.
- Generated: No.
- Committed: Yes with associated notices and licensing records.

**`.planning/codebase/`:**
- Purpose: Store GSD codebase maps consumed by planning and execution workflows.
- Generated: Yes, by codebase mapping.
- Committed: Project workflow dependent.

---

*Structure analysis: 2026-08-03*
