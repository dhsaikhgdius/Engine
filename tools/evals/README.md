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

Run the engine-result gate separately when a real Godot 4 editor is available:

```sh
npm run eval:godot-result
```

This launches a runnable 3D room in Godot, captures the engine viewport, and
compares a downsampled image against `fixtures/godot-room-reference.ppm`. The
gate requires both runtime markers and a visual score of at least 82. Temporary
project files are deleted; the frame and JSON report remain under
`.runtime/evals/godot-result/` for review. Set `DIRECTOR_GODOT_BIN` when Godot
is not installed in a standard location.

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
   against expectations (`success`, `code`, `error_includes`, `result_paths`, `result_equals`).
8. Summarizes pass/fail counts; exit code reflects the outcome.

## Task format

Each `tasks/*.json` file is one task, run sequentially with its own
`session_id` (`eval-<name>-<timestamp>`). Steps run in order and stop at the first failure.

Every step names one public tool in `tool`: `director_workbench`, `director_creative`,
`stage_video`, `blender_native`, `director_dcc`, or `director_game`. The task-schema test validates every
expected-success input against that tool's strict contract before an isolated browser run.
Game-slice tasks (`12`–`24`) cover plan/bind/playtest, export→`director_dcc` routing, unbound rejection,
host-free playtest without an inline `trace`, the harness-vs-codegen honesty contract
(Stage as the default runtime; `export_slice` refusing engine code generation), all five genre
demo recipes (fps, racing, rpg, exploration, fighting) replayed verbatim from
`packages/protocol/src/gameDemoRecipes.ts`, the racing/fps full loops ending in the
`export_slice` refusal, and the live Stage playtest path (see "Live vs host-free playtest").
The harness-vs-codegen comparison is documented in
`docs/site/src/content/docs/research/game-harness-vs-codegen.md`.

`result_paths` are dot-paths resolved against the whole JSON response body
(arrays index numerically, e.g. `result.issues.0`); a path passes when the resolved value is
neither `undefined` nor `null`. `result_equals` maps the same dot-paths to exact expected JSON
values (deep equality) for assertions where existence is not enough — e.g. `runtime.default`
must be `"stage"`, not merely present, and a playtest trace source must equal `"live_stage"`,
because a host-free fallback would still resolve the path. Steps with `expect.success: false` pass when the boundary
reports the expected failure, regardless of HTTP status. The runner is generic — add a task
by dropping a new JSON file into `tasks/`.

A step may impersonate a specific agent session with `session_id` (e.g. the possessing
session of a character binding) to exercise possession scoping. Steps marked
`gateway_fills_target: true` deliberately omit their character target so the gateway
possession preflight fills it before validation; the task-schema test asserts those inputs
really are incomplete.

A step waiting on asynchronous readiness may declare `retry: { attempts, delay_ms }` (delay
defaults to 2000 ms): the step re-runs until its full expectations pass or the attempts are
exhausted. Task `18` uses this on its live playtest step because the headless tab's Player
Mode needs a moment to become live after `player enter`.

## Live vs host-free playtest

`director_game {op:"playtest"}` without an inline `trace` prefers the live Stage path: the
Gateway dispatches the tape to a connected workbench tab, the live PlayerController replays
it frame by frame, and the receipt comes back stamped `trace.source: "live_stage"` (also
persisted as `evaluation.trace_source`). When no tab answers — or the tab cannot run the
tape, e.g. the bound player `object_id` does not exist in the Stage project — the Gateway
falls back to the kinematic runner and the receipt honestly reports `"host_free"`. Inline
traces always evaluate as `"inline"`; the machine restamps them so live provenance cannot be
forged over the public boundary.

In this harness, a headless workbench tab is always connected, so which path a task
exercises is decided by its bindings:

- Tasks `12`–`17` bind role ids to object ids that exist only in the slice document, so the
  live tab rejects the tape and the Gateway falls back — they are host-free goldens (tasks
  `12` and `13` additionally supply inline traces, which evaluate as `"inline"`).
- Task `18` authors real Stage objects first and binds the slice to them, so the tape must
  replay on the live player session. Its `result_equals` assertions require
  `"live_stage"` provenance and a playable receipt: if the harness were forced to
  host-free (including a timed-out live dispatch, which falls back with honest `"host_free"`
  provenance), the task fails. It warms the session with a public
  `player {"action":"enter"}` first so cold Player Mode startup never eats the live
  dispatch budget, and exits Player Mode when done.

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
| `tasks/08-character-agent-possession.json`       | Bind an Agent to a character, drive it from the possessing session (with target fill-in), verify possession rejects out-of-scope author/player/pilot writes, then unbind |
| `tasks/09-dcc-discover-and-handoff.json`         | Verify the DCC provider catalog, Blender handoff readiness, and the unknown-provider failure taxonomy                |
| `tasks/10-transcription-contract.json`           | Verify transcription capabilities/list and the get/read failure taxonomy for unknown inputs                          |
| `tasks/11-workbench-observe-author-smoke.json`   | Smoke the core loop: capabilities, bounded observation, author a camera, inspect it, and undo                        |
| `tasks/12-game-slice-plan-and-playtest.json`     | Plan a typed game slice, bind Stage objects, and playtest it with a scripted input tape                              |
| `tasks/13-game-slice-export-routes-dcc.json`     | Export a playable slice through DCC discover/status/send_to_engine routes                                            |
| `tasks/13-whitebox-blockout-workflow.json`       | White-box blockout workflow golden                                                                                   |
| `tasks/14-game-slice-unbound-playtest-rejects.json` | Verify playtest rejects until the player role is bound to a Stage object                                          |
| `tasks/14-world-systems-observation.json`        | Author Living World weather/wind plus one effect, then verify the `world` observation projection                     |
| `tasks/15-game-slice-hostfree-playtest-no-trace.json` | Host-free playtest scoring without an explicit trace                                                            |
| `tasks/16-game-demo-fps-recipe-hostfree.json`    | Replay the fps demo recipe: discover via capabilities/describe, plan, bind hinted roles, host-free playtest to playable |
| `tasks/16-game-harness-vs-codegen-honesty.json`  | Harness-vs-codegen honesty: capabilities report `runtime.default = "stage"`, and `export_slice` rejects codegen both before (`game_export_not_playable`) and after (`game_export_via_dcc`) a playable receipt |
| `tasks/16-game-slice-racing-full-loop.json`      | Full racing loop with no inline trace: plan → bind → playtest → evaluate, then `export_slice` refuses codegen and routes to `director_dcc` |
| `tasks/17-game-demo-racing-recipe-hostfree.json` | Replay the racing demo recipe with enter/exit vehicle verbs to a literally playable receipt                          |
| `tasks/17-game-slice-fps-full-loop.json`         | Full fps loop with no inline trace: sprint/fire/reload scored host-free, then `export_slice` refuses codegen and routes to `director_dcc` |
| `tasks/18-game-demo-rpg-recipe-hostfree.json`    | Replay the rpg demo recipe with interact plus attack verbs to a literally playable receipt                            |
| `tasks/18-game-slice-live-stage-playtest.json`   | Live Stage playtest: author real actors, bind, replay the tape on the connected tab, require `live_stage` provenance  |
| `tasks/19-game-demo-exploration-recipe-hostfree.json` | Replay the exploration demo recipe (walk, hop, interact with the stele) to a literally playable receipt          |
| `tasks/20-game-demo-fighting-recipe-hostfree.json` | Replay the fighting demo recipe with attack plus dash verbs to a literally playable receipt                         |
