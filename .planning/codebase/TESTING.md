# Testing Patterns

**Analysis Date:** 2026-08-03

## Test Framework

**Runner:**
- Vitest 4.1.2 for the TypeScript/React/server codebase.
- Config: `tools/vitest.config.ts`
- Default environment: `jsdom`, with globals enabled, thread pooling, one worker, and shared setup from `tools/vitest.setup.ts`.
- Individual server/process tests opt into Node with `// @vitest-environment node`, for example `server/agentGatewayHttp.integration.test.ts`.
- Pytest 8.x for the standalone resident video worker under `pipelines/video-generation/worker`.
- Python project config: `pipelines/video-generation/worker/pyproject.toml`; CI invocation is defined in `.github/workflows/ci.yml`.
- The vendored LTX workspace declares Pytest 9 in `pipelines/video-generation/ltx-2/pyproject.toml`, but no Python test files are present under `pipelines/video-generation/ltx-2` in this checkout.

**Assertion Library:**
- Vitest `expect`, including Jest-compatible DOM matchers loaded by `@testing-library/jest-dom` in `tools/vitest.setup.ts`.
- Native Python `assert` with Pytest fixtures and FastAPI/Starlette `TestClient`.

**Run Commands:**
```bash
npm test                         # Run the core Vitest suite
npm run test:core                # Run all Vitest tests once
npm run test:e2e                 # Playwright browser suite in tools/e2e/
npm run eval                     # Isolated agent golden tasks in tools/evals/
npm run test:agent               # Run frontend/director/tests/agent
npm run test:comprehensive       # Run frontend/director/tests/comprehensive
npm run test:assets              # Run local binary-asset acceptance tests
npm run test:all                 # Run core plus local asset tests
uv run --project pipelines/video-generation/worker --extra dev python -m pytest
                                    # Run worker contract tests
```

No watch-mode or coverage script is defined in `package.json`. For local watch development, invoke `npx vitest --config tools/vitest.config.ts` directly if needed; do not present it as a CI gate.

## Test File Organization

**Location:**
- Frontend tests live in `frontend/director/tests/`, mirroring `frontend/director/src/`. Gateway tests live in `backend/gateway/tests/`, mirroring gateway source. Examples: `frontend/director/tests/comprehensive/editor/panels/ObjectTreePanel.test.tsx` and `backend/gateway/tests/routes/stageRoutes.test.ts`.
- Shared npm packages under `packages/` keep tests in a sibling `tests/` directory (same layout as DeepSeek Harness), for example `packages/agent-engine/tests/directorAuthoring.test.ts`.
- Shared gateway fixtures live under `backend/gateway/tests/`, for example `backend/gateway/tests/createTestDirectorProject.ts`.
- Cross-process tests use explicit integration names, such as `backend/gateway/tests/agentGatewayHttp.integration.test.ts`.
- Python worker tests live separately under `pipelines/video-generation/worker/tests/`.
- Local binary-asset acceptance cases are gated by `packages/protocol/tests/localAssetTest.ts` and orchestrated by `tools/scripts/run-local-asset-tests.mjs`.
- Playwright specs live under `tools/e2e/` (`npm run test:e2e`); Vitest excludes that tree.
- Agent golden-task JSON and the isolated harness live under `tools/evals/` (`npm run eval`). The schema smoke test is `tools/evals/tasks.test.ts`.

**Naming:**
- Use `<module>.test.ts` for pure logic, schema, route, store, and server tests.
- Use `<Component>.test.tsx` for React behavior.
- Use `<subject>.integration.test.ts[x]` when starting a real process or crossing multiple major runtime layers.
- Use `test_<subject>.py` and flat `test_*` functions for Python.
- Give tests behavioral sentence names: state the trigger and observable contract, for example `"rejects a non-object tool envelope at the HTTP boundary"` in `server/routes/stageRoutes.test.ts`.

**Structure:**
```text
frontend/director/
├── src/agent/creativeWorkspaceAgentContract.ts
├── src/comprehensive/editor/panels/ObjectTreePanel.tsx
├── tests/agent/creativeWorkspaceAgentContract.test.ts
└── tests/comprehensive/editor/panels/ObjectTreePanel.test.tsx
backend/gateway/
├── routes/stageRoutes.ts
├── tests/routes/stageRoutes.test.ts
├── tests/createTestDirectorProject.ts
└── tests/agentGatewayHttp.integration.test.ts
packages/agent-engine/
├── src/
│   └── directorAuthoring.ts
└── tests/
    └── directorAuthoring.test.ts
packages/protocol/
└── tests/
    └── localAssetTest.ts
pipelines/video-generation/worker/
└── tests/
    └── test_worker_contract.py
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

function createDependencies(body: unknown) {
  const json = vi.fn();
  return {
    dependencies: {
      readBody: vi.fn().mockResolvedValue(body),
      json,
      // Inject only the collaborators needed by the public boundary.
    },
    json,
  };
}

describe("feature boundary", () => {
  beforeEach(() => {
    // Reset module/store state and mocks.
  });

  it("describes an observable behavior", async () => {
    const { dependencies, json } = createDependencies({ op: "example" });
    const handled = await publicBoundary(dependencies);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
  });
});
```

This mirrors the dependency-factory and public-boundary style in `server/routes/stageRoutes.test.ts`. `describe` is optional; focused component tests such as `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx` use flat `it` blocks when the filename already provides context.

**Patterns:**
- Arrange, act, and assert in visibly separated blocks without mandatory comments.
- Exercise public behavior. Route tests call route handlers, UI tests render components, schema tests call exported parsers, and semantic tests call exported batch operations.
- Verify both positive effects and safety properties: unchanged source objects, no forbidden calls, redacted output, bounded buffers, correct status codes, and atomic rollback.
- Prefer one test for one behavior, but group related assertions that prove the same contract.
- Use `beforeEach`/`afterEach` to reset shared Zustand state, module singletons, stubbed globals, and mocks. `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx` resets the store; `src/comprehensive/editor/assistant/agentGatewayClient.test.ts` clears the client and unstubs globals.
- Use `beforeAll`/`afterAll` for expensive process integration setup and guaranteed cleanup, as in `server/agentGatewayHttp.integration.test.ts`.
- Set explicit per-test or hook timeouts only for process/network-style integration cases.
- Test validation boundaries with both accepted and rejected values. Use Zod `safeParse` when the success bit is the contract and `.parse()`/public calls with `toThrow` when an exception is the contract.
- Test immutability and atomicity by cloning input before a failing operation and comparing afterward, as in `packages/agent-engine/tests/directorAuthoring.test.ts`.
- For Python, use flat functions, typed fixture parameters such as `tmp_path: Path`, `with TestClient(app)`, and deterministic fake executors in `pipelines/video-generation/worker/tests/test_worker_contract.py`.

## Mocking

**Framework:** Vitest `vi`; hand-written fakes and dependency injection in TypeScript and Python.

**Patterns:**
```typescript
const mockReadLocalModelFile = vi.fn();

vi.mock("../loaders/localModelImport", () => ({
  readLocalModelFile: (...args: unknown[]) => mockReadLocalModelFile(...args),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("handles a gateway response", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await publicClientCall();

  expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));
});
```

The module-delegating mock appears in `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx`; global fetch stubbing and cleanup appear in `src/comprehensive/editor/assistant/agentGatewayClient.test.ts`.

**What to Mock:**
- Mock network and provider calls with injected `fetchImpl` or `vi.stubGlobal("fetch", ...)`.
- Mock browser-only, WebGL, model-loader, file-picker, and media collaborators when testing surrounding UI behavior.
- Mock route dependencies with `vi.fn()` and pass them through a typed dependencies object; assert which collaborators were or were not called.
- Replace expensive model inference with a deterministic interface-compatible fake. `FakeExecutor` and `BlockingExecutor` in `pipelines/video-generation/worker/tests/test_worker_contract.py` test queueing, persistence, progress, and cancellation without loading LTX.
- Stub time, random IDs, browser globals, storage, observers, and process executables only when determinism or environment isolation requires it.
- Use small fake process scripts for true transport/error-boundary tests, as in `server/agentGatewayHttp.integration.test.ts`.

**What NOT to Mock:**
- Do not mock the pure function or schema under test; supply realistic domain objects and assert its output.
- Do not mock Zustand when the component contract includes store updates. Reset the real store and inspect `useDirectorStore.getState()`, following `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx`.
- Do not mock HTTP routing in worker contract tests. Build the real FastAPI app with an injected executor and call it through `TestClient`, as in `pipelines/video-generation/worker/tests/test_worker_contract.py`.
- Do not mock binary asset existence in local-asset acceptance tests. Gate them with `DIRECTOR_LOCAL_ASSET_TESTS` and require the real files through `scripts/run-local-asset-tests.mjs`.
- Do not assert private implementation steps when the same property can be observed through a public response, rendered accessibility tree, persisted receipt, or returned domain object.

## Fixtures and Factories

**Test Data:**
```typescript
/** Minimal valid project fixture that stays independent from Zustand and browser persistence. */
export function createTestDirectorProject(): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#182033",
      panoramaYaw: 0,
      panoramaRadius: 60,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.9,
      groundHeight: 0,
    },
    assets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };
}
```

This fixture is defined in `server/testing/createTestDirectorProject.ts`.

**Location:**
- Keep a factory local to a test file when only that suite uses it: `response()` and `bootstrapResponse()` in `src/comprehensive/editor/assistant/agentGatewayClient.test.ts`.
- Place reusable server fixtures under `server/testing/`.
- Reuse production default constructors when their defaults are part of the contract, such as `createDefaultDirectorProject()` in `packages/agent-engine/tests/directorAuthoring.test.ts`.
- Build request payloads with a valid baseline plus explicit overrides. The Python `request_payload(**overrides)` helper in `pipelines/video-generation/worker/tests/test_worker_contract.py` makes invalid-field tests concise.
- Use named constants for revisions, targets, tokens, dimensions, and fingerprints. This makes protocol intent visible and prevents accidental invalid fixtures.
- Prefer explicit helper functions over large global fixtures. For Python, use built-in Pytest fixtures such as `tmp_path` for filesystem isolation.

## Coverage

**Requirements:** No numerical line, branch, or function coverage threshold is configured in `tools/vitest.config.ts`, `package.json`, `.github/workflows/ci.yml`, or the Python project configuration.

CI enforces behavioral gates instead:
- Repository boundary checks: `npm run repo:check`
- ESLint and import-boundary checks: `npm run lint`
- Formatting: `npm run format:check`
- Type checking and production build: `npm run build`
- Core Vitest suite: `npm run test:core`
- Worker Pytest contract suite: command in `.github/workflows/ci.yml`
- Documentation build: `npm run docs:build`

Local binary-asset tests are excluded from core CI because source checkouts intentionally omit binary models and media. Run `npm run assets:verify` and `npm run test:assets` in an asset-complete checkout; the gate is implemented in `scripts/run-local-asset-tests.mjs`.

**View Coverage:**
```bash
# Not configured. Add @vitest/coverage-v8 and a deliberate threshold before
# treating coverage output as a repository quality gate.
```

## Test Types

**Unit Tests:**
- Pure math, timeline, schema, protocol, serialization, validation, immutable transformation, and safety-policy tests dominate the suite.
- Examples: `src/comprehensive/editor/timeline/timecode.test.ts`, `src/stage/sceneSchema.test.ts`, `src/shared/productionArtifactProtocol.test.ts`, and `src/agent/directorAudit.test.ts`.
- Assert exact domain values where stable; use `toMatchObject`/`objectContaining` for intentionally extensible envelopes.
- CSS contract tests read stylesheet text and assert required tokens/selectors in `src/comprehensive/styles/index.css.test.ts`. Use these only for static design-system invariants, not interactive rendering.

**Integration Tests:**
- Route integration tests invoke real route functions with injected dependencies, as in `server/routes/stageRoutes.test.ts`.
- HTTP/process integration tests spawn the real gateway on a reserved port and use real `fetch`, with fake upstream executables and strict cleanup in `server/agentGatewayHttp.integration.test.ts`.
- Worker contract tests construct the real FastAPI app, repository, queue, and HTTP surface with fake inference in `pipelines/video-generation/worker/tests/test_worker_contract.py`.
- Local asset acceptance tests parse real GLB/FBX/WebP/catalog files and are enabled only by `DIRECTOR_LOCAL_ASSET_TESTS=1`; see `packages/protocol/tests/localAssetTest.ts`.

**E2E Tests:**
- Playwright lives under `tools/e2e/` and is invoked with `npm run test:e2e`. Specs drive a real Chromium against a Vite UI (no gateway) for video-editor flows and 3D-stage pixel goldens.
- Agent HTTP goldens live under `tools/evals/` (`npm run eval`): an isolated gateway + Vite + headless workbench tab replays `tools/evals/tasks/*.json`.
- Neither suite is part of `npm test` or the current GitHub CI lane.
- React interaction coverage in the core suite still uses Testing Library in jsdom.
- For Director scene mutation acceptance, repository skill guidance in `.claude/skills/director-workbench/SKILL.md` requires live observe → mutate → observe → audit → visual verification; this operational verification is separate from the automated test runner.

## Common Patterns

**Async Testing:**
```typescript
it("updates UI state after user interaction", async () => {
  const user = userEvent.setup();
  render(<ObjectTreePanel />);

  await user.type(screen.getByLabelText("搜索场景内容"), "机位");

  expect(screen.getByRole("button", { name: "机位01" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "角色01" })).not.toBeInTheDocument();
});
```

Use `userEvent.setup()` and await user operations for normal interaction. Use `waitFor` for observable asynchronous completion and `act` for direct external store updates. Prefer role/name/label queries over `data-testid`; `src/comprehensive/editor/panels/ObjectTreePanel.test.tsx` demonstrates this accessibility-first style.

For promise contracts, use `await expect(promise).resolves...` or `.rejects...`, as in `src/comprehensive/editor/assistant/agentGatewayClient.test.ts`. For process integration, use readiness signals and bounded timeouts rather than arbitrary sleeps, following `server/agentGatewayHttp.integration.test.ts`.

**Error Testing:**
```typescript
const source = createDefaultDirectorProject();
const before = structuredClone(source);

expect(() =>
  applyDirectorAuthoringActions(source, [
    { action: "add_object", id: "temporary", name: "Temporary", kind: "prop", geometry_type: "box" },
    { action: "add_object", id: "char_default_a", name: "Conflict", kind: "character" },
  ]),
).toThrow(/already exists/);

expect(source).toEqual(before);
```

Test the public error plus its safety consequence: no mutation, no downstream call, stable HTTP code, redacted secrets, bounded output, or no orphaned persisted job. Existing examples include `packages/agent-engine/tests/directorAuthoring.test.ts`, `server/plannerFailure.test.ts`, `server/routes/stageRoutes.test.ts`, and `pipelines/video-generation/worker/tests/test_worker_contract.py`.

---

*Testing analysis: 2026-08-03*
