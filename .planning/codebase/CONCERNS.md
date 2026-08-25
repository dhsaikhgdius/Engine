# Codebase Concerns

**Analysis Date:** 2026-08-03

## Tech Debt

**Monolithic Director state store:**
- Issue: `src/comprehensive/editor/store/directorStore.ts` combines project migration, persistence, asset catalog behavior, scene mutations, camera operations, clipboard logic, undo, and UI state in one file exceeding 3,000 lines.
- Files: `src/comprehensive/editor/store/directorStore.ts`
- Impact: Changes have a broad regression surface, reviewers must understand unrelated concerns, and ownership boundaries are difficult to enforce.
- Fix approach: Split pure project transforms, persistence, migrations, selection/UI state, and history into independent modules while retaining `useDirectorStore` as a small composition boundary; move behavior behind tested pure functions before changing runtime behavior.

**Monolithic gateway composition root and request router:**
- Issue: `server/agent-gateway.ts` owns HTTP routing, WebSocket routing, planner process execution, browser-target leasing, persistence, CORS, terminal sessions, video generation, DCC, collaboration, and service construction in one module of roughly 1,600 lines.
- Files: `server/agent-gateway.ts`, `server/routes/stageRoutes.ts`, `server/routes/assistantRoutes.ts`
- Impact: Process lifecycle and security policy are coupled to feature routing, making safe changes and isolated tests harder.
- Fix approach: Keep `server/agent-gateway.ts` as a composition root; extract planner process management, WebSocket connection handling, snapshot persistence, and HTTP middleware into focused services with explicit dependencies.

**Generated MCP bundle is committed:**
- Issue: The deployable MCP entry is a generated esbuild bundle and must stay synchronized manually with its TypeScript source.
- Files: `server/mcp-server.ts`, `plugins/director-workbench/mcp/server.mjs`, `package.json`, `scripts/check-native-agent-integration.mjs`
- Impact: Source and shipped plugin can drift, diffs in the generated bundle are difficult to review, and ordinary source changes produce a very large secondary diff.
- Fix approach: Continue treating `server/mcp-server.ts` as the source of truth, add a CI step that rebuilds and fails on a dirty `plugins/director-workbench/mcp/server.mjs`, and document generated-file ownership beside the build script.

**Duplicated test configuration:**
- Issue: Vitest settings are present in both the `test` block of `tools/vite.config.ts` and a separate `tools/vitest.config.ts`.
- Files: `tools/vite.config.ts`, `tools/vitest.config.ts`
- Impact: A setting changed in only one location can make local, IDE, and CI test behavior disagree.
- Fix approach: Define the Vitest configuration once or import a shared test configuration object from one small module.

**Mixed persistence strategies:**
- Issue: Production jobs, production state, conversations, and artifacts use temporary-file plus rename, while Stage and Workbench snapshots are written directly to their destination.
- Files: `server/jobs/productionJobStore.ts`, `server/production/productionStateStore.ts`, `server/agents/openAiCompatibleAdapter.ts`, `server/artifacts/productionArtifactStore.ts`, `server/agent-gateway.ts`
- Impact: Durability guarantees vary by feature even though all files represent operator-authored state.
- Fix approach: Introduce one atomic JSON persistence helper and use it for `stage-scene.json`, `director-workbench.json`, and generated schema files as well as existing durable stores.

## Known Bugs

**Active worker cancellation does not cancel inference:**
- Symptoms: Deleting a running job only sets `cancel_requested`; the blocking model call continues until generation returns, after which the output is deleted and the job becomes cancelled.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`
- Trigger: Send `DELETE /v1/jobs/{job_id}` after `WorkerRuntime._consume()` has entered `executor.generate()`.
- Workaround: Wait for the active generation to finish; cancellation prevents delivery but does not reclaim GPU time. Add a cooperative cancellation token checked between inference stages, or isolate each job in a killable worker process.

**Corrupt Stage snapshots silently reset to the default scene:**
- Symptoms: Any read, JSON parse, or schema failure while loading `stage-scene.json` is converted into `createDefaultScene()` without preserving or surfacing the damaged snapshot.
- Files: `server/agent-gateway.ts`, `src/stage/defaultScene.ts`, `src/stage/sceneSchema.ts`
- Trigger: Interrupt a direct `writeFile()` to `stage-scene.json`, truncate the file, or persist schema-invalid JSON.
- Workaround: Restore the file from source control or an external backup. Use atomic replacement, quarantine invalid snapshots, and log a bounded recovery error instead of silently presenting a new scene.

**Browser persistence failures are invisible:**
- Symptoms: Storage quota and private-mode failures are caught without surfacing an error; the current tab keeps working but changes may disappear after reload.
- Files: `src/comprehensive/editor/store/directorStore.ts`, `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`
- Trigger: Exceed `localStorage` quota with a large project/workspace or use a browser mode that rejects writes.
- Workaround: Export the project manually. Track persistence health in store state and show a durable warning with an export action when writes fail.

## Security Considerations

**Worker can be exposed without authentication:**
- Risk: `LTX23_HOST` accepts arbitrary bind addresses while `LTX23_WORKER_API_KEY` is optional. Binding to `0.0.0.0` without a key exposes job submission, status, cancellation, generated artifacts, and expensive GPU execution.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`
- Current mitigation: The default host is `127.0.0.1`; bearer authentication is enforced when a key is configured, and input files are restricted to allowed roots.
- Recommendations: Refuse non-loopback `LTX23_HOST` unless a sufficiently strong API key is configured; use constant-time token comparison; document TLS/reverse-proxy requirements for remote access.

**Generic gateway failures return internal error text:**
- Risk: The top-level HTTP catch serializes `error.message` directly, which can disclose local paths, provider details, or subprocess diagnostics to any authenticated caller.
- Files: `server/agent-gateway.ts`, `server/plannerFailure.ts`
- Current mitigation: The gateway is forced to loopback and requires a process-epoch token; planner-specific failures have dedicated redaction.
- Recommendations: Apply the bounded redaction strategy from `server/plannerFailure.ts` to all public errors, return stable public error codes, and keep detailed diagnostics server-side.

**Bearer capabilities appear in query strings:**
- Risk: Gateway and preview tokens accepted as `browser_token` and `preview_token` query parameters can be retained in browser history, copied URLs, proxy logs, or screenshots.
- Files: `server/gatewayAuth.ts`, `server/agent-gateway.ts`, `server/agentGatewayHttp.integration.test.ts`
- Current mitigation: Preview uses a separate read-only process-epoch secret, responses are `no-store`, and the master token is normally sent in a header.
- Recommendations: Keep query-token support limited to the preview use case, set a strict referrer policy, avoid rendering tokenized URLs in persistent UI, and remove master-token query support when client compatibility allows.

**Local terminal is a high-impact capability:**
- Risk: An authenticated WebSocket can open Codex or Claude in a PTY with the gateway process environment and repository working directory, then send arbitrary terminal input.
- Files: `server/terminalSessionManager.ts`, `server/agent-gateway.ts`, `server/gatewayAuth.ts`
- Current mitigation: The gateway binds only to loopback, checks both origin and a random process-epoch token, limits WebSocket clients, and only permits predefined agent commands.
- Recommendations: Preserve loopback-only binding as a hard invariant, strip unrelated secrets from the PTY environment, add explicit PTY concurrency limits, and audit terminal-open events.

## Performance Bottlenecks

**Whole-project clone and equality checks on ordinary mutations:**
- Problem: Outside an explicit undo batch, each Director mutation clones persisted state and compares full snapshots via `JSON.stringify`; up to 80 complete snapshots are retained.
- Files: `src/comprehensive/editor/store/directorStore.ts`
- Cause: `commitMutation()`, `cloneJsonValue()`, `isSameDirectorState()`, and the undo stack all operate on complete `DirectorState` values.
- Improvement path: Use structural sharing and mutation-specific patches/inverses for history; compare project revisions or changed slices rather than serializing the entire project.

**Whole-workspace serialization on every store notification:**
- Problem: Every creative workspace update serializes all board nodes, edges, sections, tracks, and clips before the 600 ms persistence debounce can coalesce writes.
- Files: `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`
- Cause: `schedulePersistedState()` calls `serializeDirectorCreativeWorkspacePersistedState()` synchronously for every subscription notification.
- Improvement path: Mark persistence dirty cheaply, serialize only when the debounce fires, and skip transient fields through slice-specific subscriptions.

**Media hashing duplicates full blobs in memory:**
- Problem: Media import hashing materializes an entire `Blob` into an `ArrayBuffer` before computing SHA-256; the fallback also iterates the full copy on the main thread.
- Files: `src/comprehensive/editor/media/persistentCreativeMediaStore.ts`
- Cause: `hashCreativeMediaBlob()` calls `blob.arrayBuffer()` and Web Crypto has no streaming digest in this implementation.
- Improvement path: Hash large media in a worker, use chunked hashing where supported, and enforce an import-size policy tied to available storage.

**Worker persistence rewrites receipts on every progress callback:**
- Problem: Every progress update rewrites a formatted `job.json`, adding synchronous filesystem work to the inference callback path.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`
- Cause: `JobRepository.update_progress()` calls `_persist()` for each callback.
- Improvement path: Throttle durable progress updates, persist terminal transitions immediately, and publish high-frequency progress in memory.

**Startup scales linearly with all historical records:**
- Problem: Worker jobs, production jobs, and production artifacts are fully enumerated, parsed, and indexed into memory on startup.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `server/jobs/productionJobStore.ts`, `server/artifacts/productionArtifactStore.ts`
- Cause: These filesystem stores have no pagination index or retention policy and rebuild in-memory maps from every record.
- Improvement path: Add bounded retention/archival, maintain compact indexes, and lazily load record bodies.

## Fragile Areas

**Cross-process browser target leasing:**
- Files: `server/agent-gateway.ts`, `server/workbenchClientRouting.ts`, `server/routes/stageRoutes.ts`, `server/mcp-server.ts`, `src/shared/agentGatewayProtocol.ts`
- Why fragile: Correctness depends on a coordinated tuple of target token, client, instance, scene, creative scope, contract version, revision/fingerprint, and idempotency key across HTTP, WebSocket, MCP, and browser state.
- Safe modification: Preserve exact-target checks at every response boundary, keep lease changes atomic with browser registration, and test disconnect, rebind, stale revision, timeout, and outcome-unknown paths.
- Test coverage: Strong route and integration coverage exists, but end-to-end behavior still depends on a live browser renderer and process timing not represented by unit mocks.

**Director project schema and migrations:**
- Files: `src/comprehensive/editor/schema/directorProject.ts`, `src/comprehensive/editor/schema/directorProjectSchema.ts`, `src/comprehensive/editor/schema/directorProduction.ts`, `src/comprehensive/editor/store/directorStore.ts`, `src/comprehensive/editor/productionGraph/productionGraphMigration.ts`
- Why fragile: The same project spans persisted browser state, gateway snapshots, production scenes, collaboration state, interchange formats, and backward-compatible migrations.
- Safe modification: Add fields through schema defaults and explicit migrations, validate at all ingress boundaries, and retain fixtures for each persisted version.
- Test coverage: Migration tests are extensive, but corruption recovery currently falls back silently in some storage paths.

**Video generation contract across TypeScript and Python:**
- Files: `src/shared/videoGenerationProtocol.ts`, `src/agent/videoModelContract.ts`, `server/video/providers/ltx23HttpProvider.ts`, `pipelines/video-generation/worker/src/director_ltx23_worker/models.py`
- Why fragile: Dimensions, frame rules, job states, idempotency, conditioning paths, and artifact metadata are duplicated across languages without generated types.
- Safe modification: Version the wire schema, add shared JSON contract fixtures consumed by both Vitest and pytest, and change provider and worker in the same patch.
- Test coverage: Both sides have contract tests, but root CI does not launch a real LTX pipeline or validate generated video.

**Pinned LTX-2 submodule and runtime bootstrap:**
- Files: `.gitmodules`, `pipelines/video-generation/upstream.lock.json`, `scripts/bootstrap-ltx2-source.mjs`, `scripts/ltx2-source.mjs`, `scripts/run-ltx23-source-worker.mjs`
- Why fragile: Successful runtime requires submodule availability, exact origin/commit/license hash, explicit license acceptance, uv, CUDA-compatible dependencies, model checkpoints, and a detached checkout.
- Safe modification: Update the lock, submodule commit, license receipt, and worker compatibility tests together; never edit the pinned submodule as ordinary application source.
- Test coverage: CI tests the lightweight worker contract but does not bootstrap the submodule or execute model inference.

## Scaling Limits

**Append-only job and artifact data:**
- Current capacity: The worker queue is bounded to 1–256 pending jobs, but completed job directories, production job records, immutable artifact versions, approvals, and promotions have no retention bound.
- Limit: Disk usage and startup indexing time grow for the lifetime of the installation.
- Scaling path: Add operator-configurable retention, archive/export workflows, referentially safe garbage collection, and storage health metrics.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `server/jobs/productionJobStore.ts`, `server/artifacts/productionArtifactStore.ts`

**Single resident inference consumer:**
- Current capacity: One `WorkerRuntime` queue consumer executes one LTX generation at a time.
- Limit: Long generations block all later jobs; active cancellation does not release the slot.
- Scaling path: Expose queue position and ETA, implement cooperative cancellation, and add a supervised multi-worker scheduler only when GPU memory isolation is defined.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`

**Single-process local control plane:**
- Current capacity: One Node process owns mutable scene state, browser connections, WebSocket collaboration rooms, planners, PTYs, and orchestration.
- Limit: A process crash interrupts all active work, and CPU-heavy serialization or large messages delay unrelated features on the event loop.
- Scaling path: Keep the local single-operator model explicit; move CPU-heavy or failure-prone tasks to workers and ensure every authored state path is atomically recoverable.
- Files: `server/agent-gateway.ts`, `server/collaborationWebSocketHub.ts`, `server/terminalSessionManager.ts`

## Dependencies at Risk

**Native `node-pty` installation:**
- Risk: The root install script tolerates a failed native build, so `npm install` can succeed while the terminal feature remains unusable; CI uses `npm ci --ignore-scripts` and therefore never builds it.
- Impact: Terminal sessions may fail only at runtime on unsupported or incompletely configured developer machines.
- Migration plan: Detect availability at gateway startup and advertise terminal capability honestly; add a platform matrix smoke test or make terminal support an explicit optional package.
- Files: `package.json`, `.github/workflows/ci.yml`, `server/terminalSessionManager.ts`

**CUDA/Python runtime is outside the main CI gate:**
- Risk: The pinned LTX packages include platform-specific CUDA kernels and large model dependencies, while root CI only runs worker contract tests with a fake executor.
- Impact: Dependency, driver, import, and model API incompatibilities can reach runtime without repository CI detecting them.
- Migration plan: Add a scheduled Linux/CUDA smoke workflow in an appropriate runner environment; at minimum bootstrap the pinned source and import the production pipeline in CPU-safe validation.
- Files: `.github/workflows/ci.yml`, `pipelines/video-generation/ltx-2/packages/ltx-kernels/setup.py`, `pipelines/video-generation/worker/tests/test_worker_contract.py`

**Broad semver ranges in the worker package:**
- Risk: `fastapi`, `pydantic`, and `uvicorn` are specified by broad compatible ranges in the worker project, and the worker has no committed lockfile of its own.
- Impact: Installing the worker independently can resolve versions different from CI or from the pinned LTX workspace.
- Migration plan: Publish a tested lock/constraints file for standalone worker deployment or require execution through the frozen pinned-source launcher.
- Files: `pipelines/video-generation/worker/pyproject.toml`, `scripts/run-ltx23-source-worker.mjs`

## Missing Critical Features

**No retention or storage management UI:**
- Problem: Operators cannot inspect aggregate storage, archive old jobs, or safely remove unreferenced generated media and immutable evidence.
- Blocks: Long-running installations cannot maintain predictable disk usage without manual filesystem intervention.
- Files: `server/jobs/productionJobStore.ts`, `server/artifacts/productionArtifactStore.ts`, `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`

**No actionable persistence-health state:**
- Problem: Browser persistence errors are intentionally swallowed to preserve editor usability but are not exposed to the operator.
- Blocks: The UI cannot distinguish a safely saved project from a tab-only project at risk of loss.
- Files: `src/comprehensive/editor/store/directorStore.ts`, `src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`, `src/comprehensive/editor/media/persistentCreativeMediaStore.ts`

## Test Coverage Gaps

**Real LTX inference path:**
- What's not tested: Loading the pinned official source, checkpoint compatibility, quantization/offload combinations, CUDA execution, audio/video decode, and cooperative runtime behavior.
- Files: `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`, `pipelines/video-generation/ltx-2/packages/ltx-pipelines/src/ltx_pipelines/distilled.py`, `.github/workflows/ci.yml`
- Risk: The fake worker executor can pass while production inference fails during import, model loading, or generation.
- Priority: High

**Running-job cancellation:**
- What's not tested: Cancelling after inference starts, ensuring prompt resource release, and behavior when cancellation races completion.
- Files: `pipelines/video-generation/worker/tests/test_worker_contract.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/app.py`
- Risk: Users believe cancellation reclaimed GPU capacity when it only suppresses the output.
- Priority: High

**Snapshot crash recovery:**
- What's not tested: Process interruption during Stage/Workbench direct writes and user-visible recovery from truncated snapshots.
- Files: `server/agent-gateway.ts`, `server/production/productionStateStore.test.ts`
- Risk: Authored state can silently revert to defaults after a crash.
- Priority: High

**Coverage thresholds:**
- What's not tested: No line, branch, or function coverage minimum is configured for the TypeScript application or Python worker.
- Files: `tools/vite.config.ts`, `tools/vitest.config.ts`, `.github/workflows/ci.yml`, `backend/inference/video-generation/worker/pyproject.toml`
- Risk: The large test suite can continue passing while newly added branches remain untested.
- Priority: Medium

**Independent worker deployment security:**
- What's not tested: Refusal of non-loopback/no-key configurations, weak API keys, or remote exposure policy.
- Files: `pipelines/video-generation/worker/tests/test_worker_contract.py`, `pipelines/video-generation/worker/src/director_ltx23_worker/executor.py`
- Risk: A deployment configuration can expose unauthenticated GPU execution and artifacts.
- Priority: High

---

*Concerns audit: 2026-08-03*
