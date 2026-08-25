# Agent Evals

> Languages: **English** · [中文](README.zh-CN.md)

Golden-task regression harness for Director's public agent HTTP boundaries. When the agent
contracts (`packages/agent-engine/` and `packages/protocol/`), the gateway boundary
(`backend/gateway/`), or the skill docs change, these tasks verify that an agent driver can
still complete representative workflows end to end — including the failure taxonomy
(stale revision guards, strict field validation).

Vite config is `tools/vite.config.ts` (see [`tools/README.md`](../README.md)). The harness
passes `--config` when it spawns the UI.

## Run

```sh
npm run eval
```

The production reference case reuses the already-running Director, DSH, and Blender processes and never starts a
second browser or server:

```sh
npm run eval:reference
```

It sends one natural-language scene request through DSH, verifies that Director authoring and Blender refinement
share Stable IDs and revisions, then verifies clean, clay, mask, depth, and float-depth delivery. The runner creates
an isolated production scene, restores the previously active scene, and removes the temporary Director scene.

Requirements: a local machine with the repository dependencies installed and a Playwright
chromium download (`npx playwright install chromium` if missing). No extra npm packages.

## Isolation guarantees

The harness never talks to a developer's running stack. Every run:

- spawns its own gateway on port **8899** with `DIRECTOR_DATA_DIRECTORY=.runtime/evals/data`
  (wiped at run start; `.runtime/` is gitignored),
- spawns its own Vite UI on port **5199** pointed at that gateway via `VITE_STAGE_GATEWAY_URL`,
- opens a headless Chromium tab on the UI so workbench operations have a live executor,
- fails fast if either port is already in use, and
- tears the whole stack down (process groups included) when it exits.

## run.mjs

The eval entrypoint (`run.mjs`) logic:

1. Checks ports 8899 and 5199 are free (`assertPortFree`).
2. Wipes and creates `.runtime/evals/data`.
3. Spawns a gateway child process (`npm start` + env, waits for ready).
4. Spawns a Vite UI child process (`npx vite --config tools/vite.config.ts`, waits for ready).
5. Starts headless Chromium and navigates to `http://127.0.0.1:5199`.
6. Reads `tasks/*.json` in filename order, runs steps sequentially.
7. Each step POSTs JSON to `POST /api/tools/<step.tool>` and checks the response
   against expectations (`success`, `code`, `error_includes`, `result_paths`).
8. Summarizes pass/fail counts; exit code reflects the outcome.

## Task format

Each `tasks/*.json` file is one task, run sequentially with its own
`session_id` (`eval-<name>-<timestamp>`). Steps run in order and stop at the first failure.

Every step names one public tool in `tool`: `director_workbench`, `director_creative`,
`stage_video`, or `blender_native`. The task-schema test validates every
expected-success input against that tool's strict contract before an isolated browser run.

`result_paths` are dot-paths resolved against the whole JSON response body
(arrays index numerically, e.g. `result.issues.0`); a path passes when the resolved value is
neither `undefined` nor `null`. Steps with `expect.success: false` pass when the boundary
reports the expected failure, regardless of HTTP status. The runner is generic — add a task
by dropping a new JSON file into `tasks/`.

## Task inventory

| Path                                             | Purpose                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `tasks/01-blocking-and-revision-chain.json`      | Block out two primitives, place one relative to the other, verify revision chain increments                          |
| `tasks/02-catalog-and-camera.json`               | Discover a schema slice via `describe`, search the asset catalog, add an active camera, and capture a clean frame    |
| `tasks/03-guard-and-error-taxonomy.json`         | Verify failure semantics: stale revision guard, strict field validation rejection, and recovery to normal operations |
| `tasks/04-character-animation-and-ik.json`       | Create a grounded character and author pose controls, packaged motion, and IK atomically                             |
| `tasks/05-bounded-large-scene-observation.json`  | Add a multi-object block and verify bounded spatial and hierarchy observations                                       |
| `tasks/06-creative-workspaces-atomic-batch.json` | Exercise Canvas, Video Editor, and Gallery in one undoable Creative batch                                            |
| `tasks/07-video-and-native-capabilities.json`    | Verify Video provider discovery and Blender native-kernel status through public tools                                |
| `tasks/08-character-agent-possession.json`       | Place a catalog character, bind an Agent, drive it with motion/pose, verify the echoed binding, then unbind          |
