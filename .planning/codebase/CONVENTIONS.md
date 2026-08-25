# Coding Conventions

**Analysis Date:** 2026-08-03

## Naming Patterns

**Files:**
- Use `camelCase.ts` for TypeScript modules and helpers, such as `packages/agent-engine/src/directorAuthoring.ts`, `server/workbenchAgentBoundary.ts`, and `src/comprehensive/editor/timeline/frameTime.ts`.
- Use `PascalCase.tsx` for React components, such as `src/comprehensive/editor/panels/ObjectTreePanel.tsx` and `src/comprehensive/editor/workspaces/VideoEditorWorkspace.tsx`.
- Keep frontend tests in `frontend/director/tests/` (mirroring `src/`) and gateway tests in `backend/gateway/tests/` (mirroring gateway source); name them `*.test.ts` or `*.test.tsx`. Shared npm packages under `packages/` keep tests in a sibling `tests/` directory. Reserve `*.integration.test.ts[x]` for tests that cross a substantial runtime boundary, as in `backend/gateway/tests/agentGatewayHttp.integration.test.ts` and `frontend/director/tests/comprehensive/editor/motion/CameraPilotController.integration.test.tsx`.
- Use `snake_case.py` for Python modules and `test_*.py` for Python tests, as in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py` and `pipelines/video-generation/worker/tests/test_worker_contract.py`.
- Use `index.ts` only for deliberate public barrels. Existing barrels are narrow domain boundaries such as `src/comprehensive/editor/timeline/index.ts`, `src/comprehensive/editor/interchange/index.ts`, and `src/comprehensive/editor/productionGraph/index.ts`.

**Functions:**
- Use `camelCase` for TypeScript functions, methods, callbacks, and hooks: `parseStageScene`, `createDefaultDirectorProject`, `handleAgentSessionRoute`, and `useDirectorStore`.
- Prefix constructors/factories with `create`, parsers with `parse` or `safeParse`, normalizers with `normalize`, and boolean queries with `is`, `has`, or `can`.
- Use `PascalCase` for React component functions, for example `ObjectTreePanel` and `ResearchPortal`.
- Use `snake_case` for Python functions and methods: `create_app`, `sha256_file`, `request_cancel`, and `test_http_v1_contract_and_idempotency`.
- Add return types to public boundaries and asynchronous TypeScript functions when the contract benefits from being explicit. Python production code uses annotations throughout; follow `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

**Variables:**
- Use `camelCase` for TypeScript local variables and properties: `parsedPayload`, `requestOrigin`, and `activeCameraId`.
- Use `SCREAMING_SNAKE_CASE` for module constants: `REVISION_A`, `TARGET`, and `HOST`.
- Preserve `snake_case` only at portable wire/tool boundaries where the schema is intentionally language-neutral, for example `expected_revision`, `idempotency_key`, and `coverage_shot_ids` in `packages/agent-engine/src/directorAuthoring.ts`.
- Use `snake_case` for Python locals and fields and a leading underscore for private state, such as `_jobs`, `_idempotency`, and `_consume` in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

**Types:**
- Use `PascalCase` for TypeScript interfaces, type aliases, classes, Zod-inferred domain types, and React prop types: `DirectorProject`, `AgentSessionRouteDependencies`, and `VideoGenerationClientError`.
- Use descriptive suffixes: `*Input`, `*Options`, `*State`, `*Actions`, `*Dependencies`, `*Schema`, `*Receipt`, and `*Error`.
- Use discriminated unions for domain variants and operation envelopes. The discriminator is commonly `kind`, `action`, or `op`; see `src/stage/sceneSchema.ts`, `src/shared/productionJobProtocol.ts`, and `packages/agent-engine/src/directorAuthoring.ts`.
- Use Python `PascalCase` classes and enums and annotate collection element types with modern syntax such as `list[JobOutput]` and `str | None`.

## Code Style

**Formatting:**
- Run Prettier 3 using `.prettierrc.json` for TypeScript, TSX, CSS, JSON, Markdown, and YAML.
- Use double quotes, semicolons, trailing commas, and a 120-column print width. The enforced settings live in `.prettierrc.json`; commands are `npm run format` and `npm run format:check` from `package.json`.
- Keep TypeScript strict and ESM-based. `tools/tsconfig.json` enables `strict`, `isolatedModules`, `noEmit`, bundler module resolution, and `react-jsx`.
- Run Ruff for Python formatting and linting. The LTX workspace and worker use a 120-character line length in `pipelines/video-generation/ltx-2/pyproject.toml` and `pipelines/video-generation/worker/pyproject.toml`.
- Prefer modern Python typing (`list[str]`, `Path`, `X | None`) and `pathlib.Path` operations, as demonstrated by `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

**Linting:**
- Run `npm run lint`. `tools/eslint.config.js` applies type-aware TypeScript ESLint, rejects empty blocks, and errors on floating promises.
- Treat React hook rule findings as warnings: `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` are configured in `tools/eslint.config.js`.
- Keep shared transport contracts runtime-neutral. `src/shared/creativeWorkspaceProtocol.ts` and `src/shared/videoGenerationProtocol.ts` must not import Node, React, Zustand, or editor runtime modules.
- Keep `server/**/*.ts` independent of browser globals and frontend/runtime packages. The restricted browser globals and imports are enforced by `tools/eslint.config.js`; `tools/scripts/checkServerImportBoundaries.ts` adds a repository-specific boundary check.
- In the LTX Python workspace, Ruff enables pycodestyle, Pyflakes, isort, naming, annotations, bugbear, pytest, simplification, pathlib, dead-code, and Pylint rule families in `pipelines/video-generation/ltx-2/pyproject.toml`.
- Do not use `print` in LTX production Python. Ruff rule `T20` is enabled; use the package logger or Python `logging`, as in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

## Import Organization

**Order:**
1. Import Node built-ins or third-party packages first, using `node:` prefixes for Node modules; see `server/agentGatewayHttp.integration.test.ts`.
2. Import shared/domain modules next, moving from broader dependencies toward the local feature.
3. Import same-directory implementation last.
4. Use `import type` for type-only dependencies. Combine value and type imports when they originate from the same module and remain readable.
5. In Python, order standard-library imports, third-party imports, then first-party/relative imports; Ruff isort enforces this in `pipelines/video-generation/ltx-2/pyproject.toml`.

**Path Aliases:**
- No TypeScript path aliases are configured in `tools/tsconfig.json`. Use repository-relative imports.
- Keep server-to-frontend imports limited to pure schemas and shared protocols, following `server/routes/agentSessionRoutes.ts`.
- LTX Python first-party modules are `ltx_core`, `ltx_pipelines`, and `ltx_trainer`, configured under Ruff isort in `pipelines/video-generation/ltx-2/pyproject.toml`.

## Error Handling

**Patterns:**
- Validate untrusted HTTP, persisted, MCP, and interchange data at boundaries with strict Zod schemas. Return a discriminated success/error result when callers need to display validation failures, as in `parseStageScene` in `src/stage/sceneSchema.ts`.
- Use `safeParse` for recoverable request validation and explicit HTTP status/code responses in route handlers. `server/routes/agentSessionRoutes.ts` consistently returns `{ error, code }` and stops processing after a failed boundary check.
- Use `.parse()` or throw `Error`/`TypeError` for programmer errors and invariant violations. Error text should identify the violated contract and relevant entity or field, as in `src/shared/productionArtifactProtocol.ts`.
- Define typed client errors when consumers need HTTP metadata. `VideoGenerationClientError` in `src/comprehensive/editor/api/videoGenerationClient.ts` carries status, code, and response body.
- Catch only errors that can be translated or recovered locally. Narrow with `instanceof`; rethrow unknown errors, as in `server/routes/agentSessionRoutes.ts`.
- Preserve error causes when translating Python exceptions (`raise ... from error`) and map domain failures to `HTTPException` at FastAPI boundaries, as in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
- Bound externally derived error content before persistence or display. The worker truncates inference messages; planner tests in `server/plannerFailure.test.ts` require redaction and fixed incident-facing messages.
- Use `AbortError`/`DOMException` for cancellable browser operations, as in `src/comprehensive/editor/video/directorVideoExport.ts`.

## Logging

**Framework:** Native `console`/injected logger in TypeScript scripts and server code; standard `logging` in Python.

**Patterns:**
- Keep reusable TypeScript logic quiet and return structured results. Log at process, CLI, gateway, or injected diagnostic boundaries.
- Use `console.error` for actionable CLI failures and exit non-zero, as in `scripts/run-local-asset-tests.mjs`.
- Inject logger callbacks into code that handles provider/model output so tests can verify redaction without intercepting global logging; see `server/plannerFailure.test.ts`.
- Never log raw credentials, model output, private paths, or unbounded payloads. Return fixed public errors and log only bounded, redacted diagnostics.
- In Python, create a module logger with `logging.getLogger(__name__)`; include contextual parameters rather than preformatted secret-bearing blobs, as in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.

## Comments

**When to Comment:**
- Comment non-obvious constraints, safety boundaries, compatibility behavior, or reasons for deviations. Examples include the Node local-storage shim in `tools/vitest.setup.ts` and corrupt-job isolation comments in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
- Avoid narrating straightforward control flow. Prefer descriptive names and explicit schemas.
- Keep lint suppressions narrow and explain the exact reason inline, as with `# noqa: BLE001` in `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
- Document repository-specific operational constraints in the nearest skill or package guidance; `.claude/skills/director-workbench/SKILL.md` defines the revision guard, idempotency, observe/mutate/verify loop, and delivery acceptance boundary.

**JSDoc/TSDoc:**
- Use short JSDoc comments for exported boundaries whose role is not obvious from the signature, such as `handleAgentSessionRoute` in `server/routes/agentSessionRoutes.ts`.
- Document portability or persistence semantics on public fields when misuse is likely, as in `ImportedAssetInput` in `src/comprehensive/editor/store/directorStore.ts`.
- Do not require documentation for every private helper or self-explanatory type.

## Function Design

**Size:** Keep pure transforms, validators, normalizers, and protocol helpers focused. Large orchestration functions exist at domain boundaries; split reusable policy and schema logic into adjacent modules before adding more branches.

**Parameters:**
- Use an options/dependencies object when a function has multiple collaborators or optional inputs. `AgentSessionRouteDependencies` in `server/routes/agentSessionRoutes.ts` makes route behavior injectable and testable.
- Use explicit domain objects instead of positional primitive lists. Reserve positional arguments for small, stable helpers.
- Accept dependencies such as `fetch`, storage, executors, and loggers through parameters when isolation matters; see `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`.
- Type all public Python parameters and return values. Use fixtures or typed helper factories in tests.

**Return Values:**
- Prefer structured objects over ambiguous tuples in TypeScript public APIs.
- Use discriminated results for expected validation failure (`{ success: true, ... } | { success: false, error }`) and exceptions for invariant violations.
- Preserve immutability for semantic batch operations: clone the source, apply all changes, and return the resulting project plus created/updated/deleted receipts. Tests in `packages/agent-engine/tests/directorAuthoring.test.ts` require atomic failure behavior.
- In Python, return Pydantic response models from FastAPI handlers and typed domain records from repositories.

## Module Design

**Exports:** Prefer named exports for domain functions, types, constants, and components. Default exports are used primarily for application entry components such as `src/comprehensive/App.tsx` and `src/research/ResearchPortal.tsx`.

**Barrel Files:** Use barrels only at stable feature boundaries. Keep implementation imports direct within a feature to avoid hidden dependencies and circular imports. Existing examples are `src/comprehensive/editor/interchange/index.ts`, `src/comprehensive/editor/timeline/index.ts`, and `src/comprehensive/editor/productionGraph/index.ts`.

**State and boundaries:**
- Keep portable schemas and wire protocols separate from React and Zustand. Boundary restrictions are encoded in `tools/eslint.config.js`.
- Keep browser state in focused Zustand stores and reset those stores explicitly in component tests; see `src/comprehensive/editor/store/directorStore.ts` and `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx`.
- Treat Director mutations as revision-guarded, idempotent intents and verify post-mutation state. The required architecture and acceptance loop is defined in `.claude/skills/director-workbench/SKILL.md`.

---

*Convention analysis: 2026-08-03*
