---
name: director-workbench
description: Control the live Director 3D workbench, Canvas production DAG, Video Editor, Gallery, cameras, characters, animation, storyboard, generation jobs, and media through Director's structured tools.
---

# Director Workbench

Use `director_workbench` for the 3D Stage and `director_creative` for Canvas, Video Editor, Gallery, collaboration, and generation pipelines.

## Canonical source order

Four channels teach the same contract. They repeat key lessons on purpose — each channel reaches an agent population the others cannot — but they are ranked, and only one of them is vocabulary:

1. **`capabilities` / `describe`** — the only canonical vocabulary for operations, parameters, enums, and defaults. When any other channel disagrees with a live `describe` result, `describe` wins.
2. **This skill and the DSH system guidance** (`DIRECTOR_AGENT_GUIDANCE` in `packages/dsh-plugin-workbench/src/register.ts`) — principles, working order, and pointers. Parameter spellings quoted here are convenience copies, never the source of truth; verify a failing or disputed field against `describe` before concluding the contract changed.
3. **Tool descriptions** — short routing envelopes that pick the right tool and name its entry operations. They never grow into a parameter reference.
4. **Rejection messages** — each rejection carries the corrective call for that exact failure (the `geometry_type` rejection points at `create_blockout`, a stale revision returns the current revision). They are teaching moments, not a fifth vocabulary.

Recommend an operation or parameter as currently available only when it appears in `capabilities` or `describe`; otherwise label it a product proposal. Do not add a fifth teaching channel for discoverability. `npm run repo:check` mechanically verifies that documentation only references `backend/gateway/**` paths that exist and never resurrects removed gateway modules or capability promises that are not wired.

## Default working loop

1. Read the user's requested outcome.
2. Call `observe` or a catalog only when current IDs or available assets are unknown. For a large scene, use `query_objects` when only a name, kind, camera frustum, or local area matters, hierarchy mode for parent-child structure, or `since_revision` for persisted changes only. Treat `result.counts` as authoritative and copy requested totals verbatim; do not recompute them from other arrays or feedback.
3. Call `describe` when an operation's exact parameters are unknown: `{"op":"describe","target":"capture"}` or `{"op":"describe","target":"author.add_object"}` returns that slice's JSON Schema and needs no browser tab. Common author fields (`actions`, `object_id`, `patch`) and Blender `operations` are already on the compact tool schema; do not discover required fields by sending a failing mutation.
4. Apply one complete intent with `author`, `execute`, or `execute_batch`.
5. White-box is a clay look (metric, untextured, readable silhouettes), not a modeling method. Instance catalog meshes, Blender-authored geometry, or promoted generated-3D assets. Do not assemble a location from Stage boxes. Materials and textures are not completion criteria; a stack of primitives is not a finished white-box either.
6. Check the entities, spatial relationships, or frame that actually changed once.
7. If that check exposes a real issue, repair only the failed objects or region instead of rebuilding unrelated work.
8. Report the result and any real tool error in plain language, including validation failures that were corrected on a later retry. Never claim there were no errors when a tool call failed during the turn.

Do not add review passes, acceptance gates, or recovery branches unless the user asks for them or a tool returns an error that requires them.

## DeepSeek Harness tools

Director does not own the agent loop. This process is DeepSeek Harness. Load project skills and use Harness tools directly; do not rebuild them, and do not wrap Director tools in `code`.

- Call `skill` to catalog then load `director-workbench` before Stage, Canvas, or Blender work. Project skills live at `<git-root>/.dsh/skills`.
- `todo_write` tracks multi-step productions. Do not mark a creative todo complete until the typed mutation receipt and any requested audit or capture succeeded.
- Goals: `get_goal({})` / `set_goal`. Omitting the argument is not lossless JSON.
- Plan mode is for large scenes. A plan is not mutation evidence.
- `job_list`, `job_output`, `job_kill` are Harness background jobs (bash, subagent). Do not busy-poll; keep working, then `job_output`. Set `wait: true` only when blocked. Director video/image jobs are different: poll `stage_video` `status` or `director_creative` pipeline `get`.
- `web_search` / `web_fetch` research references; then Director `catalog` for asset ids. Never guess ids. If search reports a missing credential, do not repeat the same call.
- `bash`, `read`, `write`, `edit`, `glob`, `grep` are repository files only. Never mutate the 3D scene through the shell.
- Subagents inherit this provider/model when those fields are omitted. Call `director_model_routes` only to copy an exact registered pair. Children must not `start_scene`, `replace_project`, or edit objects they did not create. Use unique id prefixes for parallel sessions.
- DSH workflows are not the Canvas production DAG. Canvas pipelines use `director_creative`.
- Code Mode: `await tools.director_workbench({...})`, `await tools.blender_native({...})`, `await tools.director_model_routes({})`. Zero-argument tools need `{}`.
- Oversized `observe` / catalog results arrive summarized (`counts`, id samples, `retrieval_hint`). Use `fields`, `inspect`, or `query_objects` instead of asking for the full dump.

## 3D Stage

- Prefer one `author` request containing all actions for a single intent.
- Deletion actions are `delete_objects` with `object_ids`, `delete_lights` with `light_ids`, and `delete_cameras` with `camera_ids`. `remove_object` / `delete_object` with `id` are accepted as `delete_objects`. Catalog Stage instances (trees, props) are not Blender datablocks: clearing Blender does not delete them. `start_scene` clears objects and cameras but keeps lights; delete unwanted lights explicitly.
- Use catalog results for packaged assets, characters, and motions; do not guess IDs.
- Use `compose_blocking`, `place_relative`, `arrange_group`, and `orient_toward` for spatial work. When the request is framing vocabulary ("low wide right profile of the hero") rather than layout, use `frame_shot` instead of sending raw camera transforms.
- Use `query_objects` for bounded read-only context: `name_pattern` / `kind` to find objects by name or type, or `spatial` for a local area. A camera query is `{"spatial":{"mode":"frustum","camera_id":"..."}}`, not a nested `frustum` object. Set `max_results` from 1 to 200 when the user requests a bound; the default is 50. Do not invent `max_objects` or `limit`. `name_pattern` and `kind` are top-level fields.
- `inspect` needs `entity` plus `id` from observe/query_objects (`entity:"camera"` for cameras). `diff` needs exactly one of `since_turn` or `since_audit` from a previous result; do not call `{"op":"diff"}` alone. Kernel ownership (Stage vs Blender datablock, accepted vs rejected patch fields) is decided by the `kernel_ownership` field on object/light/camera inspect results — trust that field over prose; `describe target:"inspect"` returns its schema.
- Respect locked objects unless the user explicitly asks to change them.
- At the public Agent boundary, callers may state only the mutation intent. Director binds the exact browser target, observes and injects a missing project revision, and returns the generated retry key in `agent_boundary`.
- Use `capture` when the user asks for an image, `audit` when they ask for diagnostics, and `deliver` or `shot_package` when they ask for an export package.
- `audit.ready` means zero error-severity structural issues (graph, scale, spatial layout, timeline, storyboard, camera framing). It does not judge visual quality, photorealism, or whether geometry is recognizable. Outdoor scenes often produce spatial warnings such as large ground planes and canopy overlap. Do not claim a scene looks finished from audit alone; use `capture` or `author.evidence` when appearance matters.

### Large scenes

- An unscoped `observe` still returns the complete project on the HTTP/CLI executor. Model-facing MCP and DeepSeek Harness surfaces summarize oversized results and keep `project_revision`, counts, and the current selection. Use `fields`, `inspect`, or `query_objects` (`name_pattern`, `kind`, or `spatial`) when you need a bounded set of object IDs; do not ask the model surface to dump the full object table back into the conversation.
- Use `observe` with `fields:["ui"]` when the task depends on the current selection, active camera, transform mode, viewport layout, exact playhead frame, or selected timeline track/keyframe. This is transient read-only state and does not participate in revision deltas.
- Use `observe` with `fields:["objects"]`, `object_mode:"hierarchy"`, and optional `max_objects` when parent-child structure matters. The default limit is 200 and the result reports truncation.
- Use `observe.since_revision` with optional `fields` and `max_changes` when only persisted changes since a recent response matter. It reuses the bounded workbench history, excludes transient UI state, and never includes the unchanged full scene.
- `author` accepts up to 128 actions; build big scenes as a few sequential batches instead of many small calls.
- Every successful response carries the new `project_revision`; direct callers may chain it explicitly, while the CLI and MCP surfaces cache it and retry one stale cache automatically.
- Do not manually issue concurrent calls in one session; the target binding and revision chain are per-session state. The Harness may execute consecutive read-only calls in a bounded parallel window. Across providers and sessions, the Gateway coordinates calls bound to the same exact Director target; every mutation remains an exclusive barrier, and a queued cancellation is removed before browser dispatch.
- For a generated scene, keep one deterministic script that emits every batch. Use it to reproduce work in a fresh project when requested; do not clear the active project after a local divergence. Inspect the failed region and repair only that region.
- If an edit fails with "disconnected during the edit", the batch may still have landed: `inspect` one of its new object ids before resending.
- For scripted batches, designate one new object id per batch as a probe: before any resend, `inspect` the probe; a present probe means the batch landed and must not be resent. This keeps concurrent sessions from duplicating work across flaky tabs and gateway restarts.
- Parallel sessions coexist safely when every session only `add_object`s under its own unique id prefix and never issues `start_scene`, `replace_project`, or edits to objects it did not create.

### Cameras and capture

- The live Stage stays in director orbit. Do not judge a shot from a free +Y / god-view orbit. `set_active_camera` (and `add_camera` with `activate: true`) snaps that orbit onto the shot; `compose_blocking` still uses a pulled-back overview. Confirm composition with `capture` or `author.evidence` through a named `camera_id`.
- For tall architecture, keep 35–65 mm, camera distance at least ~1.8× subject height, and a depression/elevation under ~15°. A 24 mm lens from a 50 m crane turns a pagoda into a tube. Offset the camera off the subject's axis so verticals do not collapse into the lens.
- `add_camera.object_id` is optional and defaults to `${id}-rig`; callers only need to invent the camera `id`.
- `frame_shot` aims an existing camera at a subject from crew vocabulary — `size` (extreme-wide…extreme-close-up), `view` (front/front-quarter/profile/rear-quarter/back), `side`, `level` (ground…overhead), optional `focal_length_mm` — and reports the derived slate in the result notes. A physically impossible request lengthens the lens along the prime ladder or flattens the level and says so; it does not fail silently. `observe` cameras carry the same `framing` report the viewfinder slate shows, so read framing from observe instead of re-deriving it.
- A camera move is authored by framing twice and marking twice: `mark_camera_move` pins the camera's current framing (rig transform, aim, fov) as one keyframe on the camera's own animation track at `frame`. `describe_camera_move` (read-only, also serves disconnected) names the move the marked track geometrically proves between `from_frame`/`to_frame` — dolly/push-in/pull-out/pan/tilt/orbit/crane/zoom/contra-zoom — and returns a prompt-ready phrase plus per-segment slates.
- `critique` and `audit` framing facts include `visible_fraction` (share of the subject's projected rect inside the frame) and `occluded_by` (nearer bodies covering its centre) per object, plus a `subject_occluded` issue when the requested subject is blocked. These are bounding-rect approximations: treat them as strong hints, and confirm with `capture` when pixels matter.
- Video prompt expansion automatically carries each camera's measured framing phrase and named track moves; keep the Stage blocking honest instead of contradicting it in prompt text.
- `capture.camera_id` is optional and defaults to the active camera. Supply it only when a specific non-active camera is required.
- `capture` requires `frame`. Pass paired `width`/`height` for an exact offscreen raster; omitting them snapshots the live viewport, which can be stale in a hidden tab.
- For an edit that genuinely needs immediate visual verification, add `evidence:{}` to `author`. It captures one clean 640×360 camera frame by default against the exact committed revision and returns the image through the attachment channel; omit it for non-visual edits. Use `{"op":"describe","target":"author.evidence"}` for optional camera, frame, size, and depth-of-field fields; `evidence:true` is invalid. Ephemeral `capture` / `author.evidence` frames are not shot evidence — persist them with `author` action `add_camera_captures` (describe that action) when the Camera panel / storyboard must keep the PNG.
- Capture exposure and depth of field follow the camera's physical optics. f/2.8, ISO 800, 180° shutter at 24 fps is neutral exposure; smaller apertures darken the image. Always set `focus_distance_m` to the subject distance — the default is a close-up focus and blurs wide landscape shots.
- Untargeted calls in one agent session stick to the tab that served the previous call, so an author→capture sequence stays on one project state. Keep one capture-ready Stage tab open.
- A camera focused at or beyond its hyperfocal distance skips the depth-of-field pass automatically. Pass `depth_of_field: false` to force a deep-focus verification render.
- When a render must match a reference image, use `compare`: quantify with `score.composite`, locate with the `grid.worst` normalized regions, fix only those regions with `author`, then compare again. Either endpoint may be a stage render, a Gallery still, or a reconstruction keyframe; `reconstruction.compare` is the plan-bound form of the same scorer. The normative parameter vocabulary is `capabilities` (`compare_contract`) and `describe` (`target:"compare"`), not this file.

### Asset selection

White-box is a clay look on real meshes, not LLM kitbash of Stage primitives. Public `director_workbench` calls that set `geometry_type` are rejected.

- Pick sources in this order:
  1. `catalog:"assets"`, `catalog:"character_assets"`, and `catalog:"character_motions"` for packaged props, buildings, characters, and clips.
  2. `catalog:"project_assets"` for models the user uploaded, generated, or that Blender already projected into this project. Submit returned `authoring.actions` unchanged.
  3. `blender_native` to model what the catalog does not have (architecture, openings, unique set pieces). Successful native edits project back automatically; do not export GLB to re-import.
  4. `generated_3d` when a unique mesh should be generated rather than modeled: `providers` → `submit` → poll `get` → `promote`, then place through `project_assets`.
- Do not invent asset IDs or URLs. `project_assets` items carry one prepared `add_object` action and need no upsert.
- Read an item's `spatial` facts (metres: `bounds_m`, `footprint_m`, `height_m`) to sanity-check scale before `compose_blocking` or `place_relative`. Imported architecture must keep `modelNormalization:"preserve"`; do not let a building shrink to the 2 m character default.
- Chinese queries are supported; `name_zh`, aliases, and `tags` are indexed.

### White-box workflow

A white-box request ("搭一个某地点的白膜") delivers a metric clay model with readable silhouettes. Materials and textures are not the completion bar, and neither is a pile of primitives. Default to this order:

1. `catalog:"assets"` (Chinese queries work) for buildings and props that already exist; place with `author.add_object` and keep imported architecture on `modelNormalization:"preserve"` so metric scale survives.
2. Model missing architecture with `blender_native` `create_blockout`: presets `room` (floor + 4 walls), `corridor` (floor + 2 walls), `stairs` (one flight; `depth` is total run, `height` total rise), `wall` / `floor` (single slabs). Sizes are metres with `wallThickness`; created objects get stable ids `<idPrefix>:1..n` (room: floor first, then north/south/east/west walls) and a neutral clay material. One preset call beats hand-placing five `create_primitive` cubes.
3. A single missing volume uses `create_primitive` with `dimensions` (the only metric size) and `grounded:true`; `transform` carries no scale. A unique hero mesh that cannot be modeled quickly goes through `generated_3d` → `promote` → `project_assets`.
4. Doors and windows are `create_opening` on the wall (`kind` door/window, `sillHeight` ~1.0 for windows, `offset` slides along the wall), or `add_modifier` BOOLEAN + `set_modifier` DIFFERENCE for a custom cutter. Never fake an opening with a darker box.
5. Keep each build step one `apply` transaction with a designated probe id; on a lost outcome, `inspect` the probe before resending, and repair only the failed region.
6. Name and organize by structure (`move_to_collection`, `set_parent`) so shell, openings, and props read as a hierarchy.
7. Accept visually: a named 35–65 mm camera at ~1.8× subject height distance and under ~15° pitch, then `capture` or `author.evidence`. `audit.ready` is structural only. Check that the silhouette reads: massing hierarchy, real openings, ground contact at the floor pivot, believable metric proportions.

### Stage primitives

- Stage `geometry_type` (box, sphere, cylinder, torus, cone, pyramid) is a human-UI and reconstruction implementation detail. Public agents must not send it. If a volume is missing, instance a catalog mesh, model it in Blender, or generate it.
- `transform.position` on placed meshes is the **floor pivot** (bottom centre). Do not add half of height to `position.y`.
- Windows, doors, and wall openings are Blender `create_opening` (or an imported mesh with holes), never a darker box on a wall. There is no `boolean_difference` op: mesh subtraction is `add_modifier` with `modifierType:"BOOLEAN"`, then `set_modifier` `{operation:"DIFFERENCE", object:"<cutter id>"}`.

## Native Blender modeling

- Use the **`blender_native` tool**, never `director_workbench`, for native Blender geometry, modifiers, Edit Mode, materials, rigs, or native scene state. `director_workbench` has no `apply` op.
- Do not send `{"op":"apply","operations":[...]}` to `director_workbench`. Stage instances catalog or project meshes with `author.add_object`; unique geometry, modifiers, Edit Mode, and openings use `blender_native`. Describe typed apply fields with `blender_native {"op":"describe","target":"create_primitive"}` (no live kernel). Describe RNA with `blender_native {"op":"describe","operator":"mesh.bevel"}`.
- A public caller may submit one `apply` transaction with only its operations. Director snapshots the native scene and injects the missing scene epoch, revision, and intent ID. A caller-managed multi-step flow may still read `scene` and supply those fields explicitly.
- Blender is the modeling kernel of the same Director project. A successful native edit is projected back into that project automatically, including stable IDs, transforms, measured bounds, cameras, lights, and revision. Never export GLB or inline base64 and import it through `director_creative interchange` to "return" Blender work to Director.
- `director_creative` supports contract reflection. When an interchange or other creative request shape is unknown, call `{"op":"describe","target":"interchange"}` (or the relevant top-level op) and use the returned schema exactly.
- If native `apply` returns `outcome_unknown`, replay only the complete `retry_ticket.input`; do not replace its intent ID or refresh its revision. A failed transaction must not be continued with guessed state.
- Prefer the typed blockout (`create_blockout`), transform, hierarchy, camera, light, and opening (`create_opening`) operations. Search objects by name with `blender_native {"op":"query","query":"清华"}` (also `name_pattern`); spatial batches use `queries` with RAYCAST/GROUND/OVERLAP/CLOSEST_POINT/NAME. Search CC0 libraries with `{"op":"polyhaven_search","assetType":"models","query":"chair"}` then `apply` `polyhaven_import` (HDRIs, textures, models). Sketchfab is `sketchfab_search` / `sketchfab_import` and needs `SKETCHFAB_API_TOKEN` in the Blender environment or the Studio preference. Use `catalog` then `describe` before a long-tail Blender operator whose identifier or properties are unknown. `invoke_operator` can call most Blender RNA, including import, export, render, and sculpt. Do not quit Blender (`wm.quit_blender`).
- `execute_code` is the blender-mcp analogue: run Python in the live scene (`bpy`, `bmesh`, and `mathutils` are provided). Assign `result` or `print` for the receipt. New objects receive stable IDs. Prefer typed ops and `invoke_operator` when they exist. Call `blender_native` directly; do not wrap it in the DSH `code` tool. Missing `bpy.data.objects["name"]` is `None` and `remove(None)` is a no-op; `bmesh.types.BMeshVert` aliases `BMVert`. Delete only `bpy.context.scene.objects`; do not loop `bpy.data.meshes.remove` across the whole `.blend`. Native stills are `{"op":"capture"}` or the alias `{"op":"capture_render"}` with `cameraId`. Apply results expose `receipt` and `metrics` on the tool envelope.
- In native `create_primitive`, `dimensions` is the only metric size. `transform` accepts position and rotation, not scale. Set `grounded:true` when the local origin must be the floor-centre pivot; do not manually add half-height afterward.
- Use typed `set_world_environment` for a solid Blender world colour and strength. Do not emulate the world with a giant sphere, wall, or camera-facing card. `set_rna_property` may target `object`, `object_data`, `modifier`, `constraint`, `material`, `collection`, `scene`, or `world`.
- A provisioned native object's material and geometry remain Blender-owned. Use `assign_material`, material-node, UV, modifier, or Edit Mode operations through `blender_native`; `director_workbench update_object.material` is intentionally rejected instead of pretending to change Blender.
- For native materials, inspect the object once (`sceneMaterials` lists names already in the Blender file) and reuse those names. `assign_material` matches exact, case-insensitive, and separator-insensitive names (`gold_plaque` → `Gold Plaque`). Omit `createIfMissing` or pass `true` to create a Principled material; names like gold/leaf/bark/brick/stone/roof can fill a default colour when `parameters` omit it. `createIfMissing: false` never creates: a still-missing name skips that object and the rest of the batch still applies. Do not replace an existing custom graph just to assign its material.
- Match the requested fidelity. For a real location, search the catalog first, then model missing architecture in Blender (openings, boolean, materials) or generate a mesh with `generated_3d`. Never describe an all-box Stage scene as a finished white-box.
- After a mutation, inspect only the changed object or capture the relevant camera. `inspect` returns `dimensions` and `position` on the result (and at the top level of the DSH envelope). Do not dump the whole Blender scene back into the conversation. Do not wrap `director_workbench` / `blender_native` in the DSH `code` tool.
- Reuse the same intent ID when retrying a request whose result was lost; use a new intent ID for a new edit.

## DCC and engine handoff (`director_dcc` tool)

- Use `director_dcc` to hand a Director project to an external host (Blender files, Unreal, Unity, Godot) and to import its return. It is not a modeling surface: live Blender geometry stays on `blender_native`.
- Call `{"op":"discover"}` first and trust its readiness fields. `installed` means an executable was found; `exchangeReady` means the portable GLB/USDA package works; `nativeReady` means the Director-authored connector, the host executable, and a versioned health check all passed. Never infer native readiness from `installed`, and never tell the user a host is natively connected while `nativeReady` is false.
- `export_exchange_package` works for every provider: a canonical metre/Y-up, stable-ID layout package (scene hierarchy, transforms, cameras). Capability maturity (`native` / `exchange` / `planned`, each with a `layer`) is the honest fidelity claim — Unreal claims them `native` only for its tested subset (Gateway-baked Sequencer transform/camera tracks, skinned-GLB skeletal import in bind pose, PBR material instances; Control Rig poses and motion clips warn-and-omit with structured `omittedAnimationChannels` records, textures warn-and-omit); Unity's connector bakes animation onto Timeline, builds Avatars, and applies PBR material fallback natively; Godot 4 bakes AnimationPlayer animation, imports skinned-GLB Skeleton3D in bind pose, and translates StandardMaterial3D with hashed textures. Do not promise lossless transfer for any engine.
- `send_to_engine` runs the fixed Director-authored Unreal/Unity/Godot connector headlessly against the configured engine project (`DIRECTOR_UNREAL_EDITOR_BIN`+`DIRECTOR_UNREAL_PROJECT`, `DIRECTOR_UNITY_BIN`+`DIRECTOR_UNITY_PROJECT`, `DIRECTOR_GODOT_BIN`+`DIRECTOR_GODOT_PROJECT`). When the provider is not `nativeReady` it returns structured diagnostics `{provider, mode, ready, warnings, recovery}`; relay the recovery steps instead of retrying unchanged. For Unreal, `clean_frame: true` additionally requests one best-effort offscreen still without gizmos or labels; the result carries a `cleanFrame` receipt that is either `rendered` (hash-pinned image) or `skipped` with a reason — a skip never fails the handoff.
- Engine returns are a two-step, revision-guarded flow: `receive_from_engine` previews the host's `director-dcc-return-v1` package as an import plan (matched by stable `director_id`, converted at the provider boundary), then `apply_import_plan` with the same `provider` applies it. Blender file returns keep `import_return_package` + `apply_import_plan` without a provider, and can carry camera optics, `director_id` lights, portable character pose controls (rotation edits on bones covered by the stamped bone-role map reconcile into control deltas; unmapped bone edits stay warn-and-omit), and hashed `object_addition` entries for new roots the artist stamped with a fresh `director_id` — those import as props only under the explicit `include_new_objects: true` opt-in and never automatically. Out-of-range values bake to the nearest Director limit with an explicit plan warning.
- There is no authoritative live engine viewport. Unreal `live_link` is `native` as a preview-only loopback camera channel (live frames are never applied as project mutations). Unity `live_link` is `native` as a preview-only outbound polling channel (Unity Editor long-polls the gateway with a per-session bearer token and sequence numbers; never authoritative, no remote-execute). Blender's native kernel additionally exposes a bounded preview-only live-link delta feed (`blender_native {"op":"live_link"}` with a `{sceneEpoch, seq}` cursor, replay-protected, resync on gap or epoch change). Godot `live_link` is `native` as a preview-only outbound sequence-numbered transport (never authoritative, Godot never listens on a port). The supported durable channel is always the headless snapshot/patch round trip above.
- Humans see the same operations in the editor's interchange menu under the "DCC / engine handoff" dock (Blender / Unreal / Unity / Godot tabs): provider readiness, connector health and recovery, send receipts with structured omitted channels, dry-run return previews, and preview-only live-link status. When walking a user through a handoff, point them there rather than at raw HTTP routes.

## Game-engine scene import (Unreal / Unity)

- Use the **`director_dcc` tool** to bring an Unreal Engine or Unity scene into Director. Check the runtime first with `{"op":"status","provider":"unreal"}` or `"unity"`: `nativeReady` means the engine executable and its Director connector were both detected; `exchangeReady` means portable `director-engine-scene-v1` `.zip` packages can be imported without the engine.
- Two ways to obtain a package: `{"op":"extract_engine_scene","provider":"unity","project_dir":"<engine project>","scene":"Assets/Scenes/Main.unity"}` runs the installed engine headlessly (Unreal loads `integrations/unreal/interchange/director_scene_export.py`; Unity gets `integrations/unity/interchange/DirectorSceneExport.cs` copied into `Assets/Editor/DirectorInterchange/`), or upload a `.zip` the connector exported inside the engine to `POST /api/dcc/engine-scene/uploads?provider=unreal|unity`. Both return a validated package with a `packageDir`.
- Then plan and apply: `{"op":"preview_engine_scene_import","provider":"...","package_dir":"<packageDir>"}` returns the import plan (scene GLB asset, cameras, lights, warnings, conflicts); `{"op":"apply_engine_scene_import","plan_id":"<planId>","expected_revision":"<revision>","idempotency_key":"<uuid>"}` executes it. Narrow with `selection` (`includeScene`, `cameraSourceIds`, `lightSourceIds`) when only part of the scene is wanted.
- Package transforms are already in Director's right-handed Y-up metre convention — the in-engine exporters own the coordinate conversion and declare the linear map in the manifest. Geometry, materials, and skinned meshes ride inside `assets/scene.glb`; cameras and lights become native Director cameras and lights. Unreal needs the glTF Exporter plugin enabled and Unity needs `com.unity.cloud.gltfast` for geometry; without them the package still imports cameras, lights, and hierarchy with an explicit gap entry. Round-trip back to the engines is `planned`, not available.

## World systems

- The optional `project.world` block drives ambient living-world layers: global settings (seeded wind, weather presets, fixed/cycling time of day), emitter effects (fire, smoke, steam, sparks, fireflies, dust, rain, snow; ≤64), rectangular or spline-river shader water bodies (≤8), wildlife groups (birds, butterflies, fish, deer, rabbits, wolves, sheep; ≤16, ≤256 heads each), and ambient traffic roads (≤16, ≤24 vehicles each). Rain/storm wet scene materials, snow dusts upward faces, foliage names sway in wind, precipitation vanishes under roofs, pond rims pick up bank foam from a camera-centred height map, and a seeded wind/rain/snow bed plays in the viewport (muted during capture, and when Stage sound is off). Player Mode footsteps and stage timeline rehearsal follow the same toggle; export mixing is unchanged. Author leftover dampness with `weather.wetness`.
- Author it with `set_world_settings`, `add_world_effect`/`update_world_effect`/`remove_world_effects`, `add_world_water_body`/`update_world_water_body`/`remove_world_water_bodies`, `add_world_wildlife_group`/`update_world_wildlife_group`/`remove_world_wildlife_groups`, and `add_world_road`/`update_world_road`/`remove_world_roads` inside a normal `author` batch. Water identity fields are `body_id` / `body_ids` (`water_body_id` / `water_body_ids` are accepted aliases). Wildlife identity fields are `group_id` / `group_ids`.
- The first world action creates `project.world` on demand with default settings (`enabled: true`) and says so in the result `notes`; `set_world_settings` deep-merges partial `wind`/`time_of_day`/`weather` patches without clobbering sibling fields.
- `weather.evolution {mode: "static"|"cycle", period_seconds?}` turns the five presets into a seeded weather state machine: `cycle` ramps cloud cover, precipitation, and wind gain between preset nodes on a seeded schedule and integrates `weather.wetness` over world time (rain/storm wet the ground, clear dries it), all a pure function of `(seed, worldSeconds)`. Absent or `static` keeps the authored values verbatim; `evolution: null` removes the block. Sky, precipitation, surface wetness, water, ambient audio, and wildlife all read the evaluated climate.
- Fire effects accept `propagation {enabled, radius_m?, spread_rate?}`: a deterministic checkpointed ground-grid burn seeded at the anchor that spreads with wind, is suppressed by wetness and rain, and never crosses authored water rectangles. Requires kind `fire` with an unbound anchor (`anchor.object_id` null); `propagation: null` removes it.
- Omitted fields get deterministic defaults (per-kind names/wind influence, 20×20 m water at the origin, per-species counts and flight bands, 8 m wide roads with 6 vehicles at 40 km/h) and generated ids (`fx_<kind>_<n>`, `water_<n>`, `wildlife_<species>_<n>`, `road_<n>`); effect `anchor.object_id` must reference an existing object, wildlife `asset_id` an existing asset.
- A water body with `river: {points, width_m, width_profile?}` becomes a Catmull-Rom ribbon: point Y values carry downhill water levels, flow follows the spline tangent, and banks/bends/slopes generate foam. Updating with `river: null` converts it back to a rectangular basin. Lakes and ponds must stay rectangular (`river` omitted or null). A river ribbon will not fill a basin; cutting a hole in the ground plane then reveals the infinite viewport grid (it sits 2 mm above `groundHeight` and is always on in the live Stage). Keep water mean Y above that grid, opacity high enough to hide it, and only cut a hole when the water surface covers the entire opening.
- A road sweeps a Catmull-Rom centerline through `points` (2..64 vec3s, Y carries road height) with two-way instanced low-poly traffic and an optional asphalt ribbon (`show_surface`). `loop: true` drives a closed circuit (inferred when the first and last points coincide); open roads respawn vehicles at their start. Vehicle poses are a pure function of (seed, timeline seconds), so traffic scrubs and exports deterministically.
- Everything is seeded and deterministic — no wall-clock randomness — so scrubbing and export replay identically. Locked entries reject updates/removals until unlocked with patch `{"locked": false}`.

## Drivable vehicles

- Attach a live Player Mode car capability to an existing prop/scene model with `set_vehicle_profile`; omitting `profile` uses the tuned sedan defaults. Remove it idempotently with `clear_vehicle_profile`.
- Vehicle wire fields are snake_case (`mass_kg`, `engine_force_n`, `max_speed_kph`, `seat_offset`, `camera.chase_distance_m`, …). The chassis frame is forward +Z, left +X; the default is left-hand drive with the left-door exit probe first.
- In Player Mode, walk within 2.5 m and press E to enter, use WASD to drive, Space for handbrake, and E to exit. Driving is live-session state only: it does not rewrite deterministic project transforms or export frames.

## Game slice (`director_game`)

- `director_game` authors one playable slice of the current Director project. The default runtime is the live Stage player; engine ids are later export targets, never where the game first runs. The vocabulary — genres, verbs, role kinds, HUD widgets, playability checks, statuses — is `{"op":"capabilities"}`; exact fields are `{"op":"describe","target":"plan"}` (nested slices such as `bind.bindings` and `author_hud.hud` describe the same way). This file does not restate them.
- Working order: capabilities/describe when vocabulary is unknown → `plan` a typed slice from the brief → place real meshes with `director_workbench` author, `blender_native`, or `generated_3d` under the same asset rules as any Stage scene → `bind` those object ids to slice roles → `author_loop` / `author_hud` as typed patches → `playtest` with a scripted input tape → `evaluate` → `export_slice` only once the slice is `playable`.
- Bind before playtest. `playtest` rejects until the player role carries a real Stage object id; role ids come from the planned slice and object ids from `observe` or the catalogs, never invented.
- After bind, `observe` / bind receipts include `suggested_playtest_script` derived from acceptance verbs — use it or an equivalent tape. Playability evidence is a scored playtest trace with corrective issues, never a compile log or trailer. Gateway playtest prefers a connected Stage tab; otherwise it runs the host-free kinematic tape (or accepts an explicit `trace`). Visual acceptance still needs a Stage capture.
- Never generate Unreal/Unity/Godot source, Blueprints, or scripts as "the game". `export_slice` does not emit an engine project; it routes a playable slice to `director_dcc` (`discover` → `status` → `send_to_engine`) under the same readiness and honesty rules as any engine handoff.

## Characters and animation

- Use `character_assets` and `character_motions` catalogs before assigning local resources.
- Use motion operations for clips, pose controls for joint offsets, and IK for hand or foot targets.
- Attach an Agent to a character with author `bind_character_agent` (`object_id` plus `session_id` and/or `profile_id`) and detach with `unbind_character_agent`; observe echoes `agent_binding` on character summaries. Bind the durable session id that will drive the character — the anonymous HTTP fallback `http-default` is rejected as a binding identity. A session that possesses characters may only mutate those characters; global writes such as `start_scene` or `replace_project` are rejected until the binding is removed, `player` `enter`/`set_actor`/`teleport`/`walk_to` must name a possessed `actor_id`, and `pilot record_waypoint` is rejected under possession (transient pilot flight stays available).
- The possession loop is bind → author that character's `set_character_motion` / `set_character_pose_controls` / `set_character_ik` → observe and confirm the echoed `agent_binding`. A possessed character shows an "Agent 接管" badge next to its viewport name label, which disappears on unbind. Explicit `object_id`s remain canonical on every character action. When the caller possesses exactly one character, the gateway preflight fills an omitted character target with that character id; a session possessing several characters must name the target explicitly (omission is rejected as `possession_target_ambiguous`), and unpossessed sessions always require explicit ids.
- Put timeline changes in project frames and keep unrelated tracks unchanged.
- Reusable takes, coverage sequences, cameras, and storyboard shots are ordinary editable project data.

## Canvas, Video Editor, and Gallery

- Observe when node, media, track, clip, folder, or run IDs are unknown. Creative observe accepts exactly `{"op":"observe"}` and does not accept `fields`; an oversized result is summarized in place with complete `snapshot.counts` and bounded ID samples.
- Use `execute_batch` for one multi-step edit so it remains one undoable action.
- Configure generation nodes with `canvas.production.configure`; start and inspect the pipeline by its returned run ID.
- Use `workspace.undo` or `workspace.redo` for reversible corrections.
- Use preview only when visual inspection is relevant to the user's request.
- Prefer interchange plan-import/import with inline, media_id, or workspace_path sources; the human file picker remains available. Gallery permanent delete uses gallery.media.purge with confirm:true; offline media uses media.relink.

## Capture reconstruction (video / RGB-D scan to walkable scene)

- `reconstruction` turns a captured room into an explorable, interactive stage: `submit` a Gallery video or a staged RGB-D scan bundle, poll with `get`, review `plan`, then `apply`.
- RGB-D bundles (zip with capture.json, posed frames, depth) reconstruct deterministically into metric floor, wall segments split around openings, swinging door leaves (Player Mode E-to-open interactions), window panes, and proxy item boxes. Bundles with poses but no depth fuse monocular model depth over the real poses.
- Plain RGB video uses monocular depth estimation when the worker's optional `depth` extra is installed: a single-view metric reconstruction of the visible surfaces (`providers.poses: "estimated"`, `providers.depth: "model"`), with one calibrated compare camera. Trust its warnings — surfaces behind the camera are unknown; extend the room with `author` from the video evidence. Without a depth model it degrades to capture keyframes plus a scaffold.
- `apply` with `include_cameras: true` adds one stage camera per capture key view. Loop: `capture` through a capture-view camera → `reconstruction.compare` scores the render against the keyframe (composite 0..1, worst grid cells first) → fix with `author` (layout, then materials, then light) → re-compare → `audit` before delivering. The general `compare` op runs the same scorer against any reference/candidate image pair.
- Proxy item boxes are placeholders by design: replace them with catalog meshes or Blender-authored geometry of matching `bounds_m`. Do not leave the room as primitive boxes.
- After applying, the room is walkable in Player Mode (doors open with E); drivable vehicles and world systems compose normally with reconstructed rooms.

## Generation and transcription

- Unique meshes with no catalog match: model in `blender_native`, or submit `generated_3d` (`providers` → `submit` → poll `get` → `promote`) and place the returned `project_assets` action. Do not approximate the missing mesh with Stage primitives.
- Discover providers, nodes, or workflows before submitting a job.
- Track jobs by the IDs returned by the provider.
- Long media is chunked by the gateway. After promoting a transcript, use `search` for dialogue/entity lookup and `read` for a bounded time window instead of requesting the complete transcript.
- Promote only completed outputs selected by the user or by the active task.
- If a provider reports an unknown or failed outcome, inspect that job and handle the returned state; do not invent success.
- If a browser-backed mutation returns `outcome_unknown`, retry only the byte-equivalent intent with the key returned in `agent_boundary`; use a new key for changed work.

## Optional diagnostics

`audit`, `correct`, `trace`, preview, capture, and delivery tools remain available for explicit diagnosis, correction, evidence, or export requests. They are not part of every normal edit. `audit.ready` is not visual acceptance.

## Errors

Handle the error that actually occurred. Refresh current state for a real stale-edit conflict, correct invalid IDs or parameters, and retry only the failed intent. Do not build branches for hypothetical failures.

- Overlapping untargeted HTTP/MCP calls now queue on the session reader/writer instead of failing with `session_busy`. Bound calls that carry a `target_token` queue on the exact browser target. Every agent surface (DeepSeek Harness plugin, MCP, CLI) reaches the Gateway through `POST /api/tools/:name`. Read-only `observe` / `query_objects` / `catalog` / `inspect` / `audit` / `diff` / `compare` / `describe_camera_move` calls may run together; mutations still wait for those reads to finish.
- If the Stage tab disconnects, `observe`, `audit`, `query_objects`, `inspect`, `describe_camera_move`, and `capabilities` still return the last persisted Director project and, when the Blender kernel is up, live object counts from that kernel (`workbench_connected:false`). Mutations, capture, and live viewport layout still need a visible Stage tab. Prefer `blender_native` `scene`/`inspect` for live native geometry.
- In the DSH `code` tool, call zero-argument tools as `await tools.get_goal({})`. `tools.get_goal()` with no argument is not lossless JSON. Do not wrap `director_workbench` or `blender_native` in `code`.
- Target tokens stay stable while the gateway process lives, including across tab reloads. After a gateway restart every token dies; one `observe` rebinds and returns a fresh `project_revision`.
- Agent edits advance the same scene-project record the browser restores at boot, so refreshing a tab cannot resurrect an older autosave.
- `workbench_contract_stale` means the bound tab runs an older bundle that could drop newer fields. Reload that exact Director tab, then retry the unchanged request.

Hosted workspace tools can read concise examples at `.claude/skills/director-workbench/references/operations.md`. Packaged skill loaders may resolve [references/operations.md](references/operations.md) relative to this file.
