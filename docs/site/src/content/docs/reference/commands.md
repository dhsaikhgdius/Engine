---
title: Command Map
description: A compact map of Director workbench and Stage operations.
---

## Repository launch commands

| Command                     | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `npm run dev`               | Director UI and Gateway in watch mode                                |
| `npm run blender`      | Integrated Director plus the bound native Blender scene         |
| `npm run blender:test` | Run the native Blender smoke suite with the resolved executable |

Use `npm run dev` for browser-only staging. Use `npm run blender` when Director must provision
or edit native models, meshes, materials, UVs, modifiers, armatures, actions, or NLA in the bound
scene. These are two launch modes for the same product, not separate project formats.

## director_workbench operations

| Operation         | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `capabilities`    | List supported operations and authoring vocabulary         |
| `production`      | Observe or mutate the multi-scene production manifest      |
| `observe`         | Read selected compact project slices                       |
| `snapshot`        | Read the complete project when necessary                   |
| `inspect`         | Read exact fields for one entity                           |
| `author`          | Apply one atomic semantic action batch                     |
| `audit`           | Run structural, spatial, temporal, and camera-space checks |
| `correct`         | Apply validated fixes for an audit token                   |
| `diff`            | Compare turn-bound project changes                         |
| `trace`           | Inspect operation timing, status, and quality-gate results |
| `capture`         | Request a clean viewport or camera frame                   |
| `shot_ir`         | Evaluate a portable exact-frame scene/camera contract      |
| `shot_package`    | Capture a hashed multi-pass exact-frame evidence package   |
| `deliver`         | Audit and finalize clean visual evidence for acceptance    |
| `select`          | Change workbench selection                                 |
| `viewport`        | Change supported viewport UI state                         |
| `playback`        | Control timeline transport                                 |
| `patch`           | JSON Patch escape hatch for uncovered fields               |
| `replace_project` | Replace the complete validated project                     |
| `undo`            | Undo the latest tracked project mutation                   |

### Multi-scene production contract

Use `{"op":"production","command":{"action":"observe"}}` before a production mutation.
The response exposes the server-authoritative integer `production_revision`. Pass it back as
`expected_revision` and use one stable `idempotency_key` for byte-equivalent retries only.

Supported actions are `rename_production`, `create_scene`, `duplicate_scene`, `rename_scene`,
`activate_scene`, and `delete_scene`. `duplicate_scene` requires the source to be the scene
currently loaded in the bound browser and seeds an independent scoped `DirectorProject` for the
destination. New scene references and their validated project seed are committed in one atomic
server write; deleting a scene removes its document in that same write. Each scene document has
its own integer revision, distinct from `production_revision`.

An activating mutation returns `activation.status:"pending"`, `activation_id`, and the destination
scene. The browser loads the server document, rejects superseded switch requests, synchronizes the
Stage projection, waits for rendering, and emits a matching readiness acknowledgement. Observe
again only after the browser target rebinds; the new result includes `scene_document_revision`.
Deleting the last scene requires an explicit `replacement`.

`author.start_scene` resets or replaces content inside the currently loaded scene; it does not
create a production scene.

## Semantic author actions

| Action                                            | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `start_scene`                                     | Begin a new or replacement scene                                   |
| `set_scene`                                       | Patch global scene settings                                        |
| `upsert_asset` / `remove_assets`                  | Manage project assets                                              |
| `add_object` / `update_object` / `delete_objects` | Manage objects and characters                                      |
| `compose_blocking`                                | Compile semantic multi-character layouts and fitted camera framing |
| `place_relative` / `orient_toward`                | Place or aim existing objects using world/target/camera semantics  |
| `arrange_group` / `arrange_facing_pair`           | Build deterministic formations and reciprocal facing relationships |
| `add_camera` / `update_camera` / `delete_cameras` | Manage cameras                                                     |
| `set_animation`                                   | Replace the complete version 1 animation                           |
| `set_storyboard`                                  | Replace or remove storyboard data                                  |
| `set_active_camera`                               | Change the active shot camera                                      |

`set_scene` requires a non-empty `patch`. It does not create a new scene.

## Stage tool families

Use tool help or MCP capabilities for the exact current per-tool schemas. The families are:

- `stage_read` — observe, inspect, critique, state, and rendered review;
- `stage_scene` — reset, configure, validate, and production-level scene actions;
- `stage_object` — create, transform, place, group, animate, and remove;
- `stage_camera` — create, configure, aim, frame, and move;
- `stage_show` — tracks, actions, timeline, play, rehearse, and record;
- `stage_video` — prepare, render/submit, and status.

## Authoring invariants

- Give new entities explicit stable IDs.
- Use one `author` batch for one user intent.
- Prefer `compose_blocking` for supported multi-character layouts.
- Refine existing layouts with `place_relative`, `arrange_group`, `arrange_facing_pair`, and `orient_toward` instead of guessing coordinates.
- Omit centre distance/spacing for deterministic bounds-aware defaults, or use `clearance_m` for an edge gap. Do not combine it with `distance_m`/`spacing_m`.
- Treat primitive scale as metric size and primitive position as a floor pivot (bottom
  centre, not geometric centre). A 3 m wall on the ground is `position.y = 0` with
  `scale.y = 3`; `position.y = 1.5` floats it. A ceiling whose underside is at 3 m uses
  `position.y = 3`, not `3 + thickness/2`.
- Give a model asset its real-world size in metres (`realWorldSizeM`, largest bounding-box dimension). Without it the asset falls back to the legacy 2 m display normalization and audit reports `asset_missing_real_world_size`.
- Preserve locked objects.
- Use `deliver` and inspect its clean frame before claiming visual completion.

## Semantic spatial placement

Agent-authored placement is semantic rather than a blanket Y-coordinate exemption:

| Intent      | When to use                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `grounded`  | Floor contact                                                            |
| `supported` | Physical table, shelf, or platform contact                               |
| `attached`  | Wall, vehicle, rig side, or surface mount; requires anchored `parent_id` |
| `suspended` | Hanging object; requires a spatially overhead anchored `parent_id`       |
| `floating`  | Support-free airborne placement only when that is the requested visual   |

`parent_id` does not prove support for `supported` objects. Do not relabel content merely to
silence an audit. The live `capabilities.spatial_contract` exposes this decision tree.
Revision-bound `deliver`, not mutation success or a standalone audit, remains the acceptance
boundary. An elevated `auto`/intent-unknown object must be inspected and classified with a
semantic `author` action because `unsupported_object` deliberately has no automatic lowering
fix; use a narrow `correct.audit_issues` subset when the rest of the audit contains safe
deterministic fixes.

## director_creative requests

| Request         | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `capabilities`  | Discover operations, limits, guards, and quality profiles        |
| `observe`       | Read exact Canvas/Video IDs, media metadata, and fingerprint     |
| `execute`       | Apply one fingerprint-guarded, idempotent operation              |
| `execute_batch` | Apply 1–32 durable operations as one atomic undo unit            |
| `audit`         | Check Canvas graph, media, source ranges, overlaps, and coverage |
| `preview`       | Render a fingerprint-bound clean Canvas board or Video frame     |

Content operations cover Canvas nodes/edges, Video clips/tracks, seek, workspace switching, and
workspace undo/redo. `execute_batch` accepts only durable content mutations; created IDs can be
saved with `save_as` and referenced as `@alias` in later steps.
`preview` accepts `workspace:"auto"|"canvas"|"video"`, optional Video `time_sec`, and the latest
`expected_snapshot_fingerprint`; it returns PNG evidence without moving the playhead.
