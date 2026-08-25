# Director operation examples

These examples show the shortest useful request shape. Add optional fields only when the task needs them.

## Observe the Stage

```json
{ "op": "observe" }
```

Bare observe is complete on the executor and HTTP/CLI. Model-facing MCP and DeepSeek Harness surfaces summarize oversized results and keep `project_revision` plus counts. Use focused fields or `inspect` when you need IDs:

```json
{ "op": "observe", "fields": ["objects", "cameras", "timeline"] }
```

Read the current interaction state as one coherent snapshot:

```json
{ "op": "observe", "fields": ["ui"] }
```

`ui` includes the current selection, active camera, transform mode, viewport layout, exact transient
playhead frame, and selected timeline track/keyframe. It is read-only and intentionally excluded
from revision deltas.

Read a bounded parent-child scene graph instead of a flat object table:

```json
{ "op": "observe", "fields": ["objects"], "object_mode": "hierarchy", "max_objects": 200 }
```

Read only persisted changes since a recent workbench response. The supplied revision must still be
present in the bounded workbench history; `max_changes` applies to each changed collection:

```json
{
  "op": "observe",
  "fields": ["objects", "cameras", "lights"],
  "since_revision": "REVISION_FROM_PREVIOUS_RESPONSE",
  "max_changes": 100
}
```

Revision deltas intentionally exclude transient UI state and return `mode:"revision_delta"` plus
collection-level `total_changes` and `truncated` metadata.

For large scenes, query only the relevant objects. Results contain stable object IDs,
canonical world bounds, distance, truncation metadata, and the current `project_revision`.
Find by name or kind without a spatial bound:

```json
{ "op": "query_objects", "name_pattern": "door", "kind": "prop" }
```

`name_pattern` is a case-insensitive substring of the object name or id. Chinese queries
such as `"门"` match `"木门"`. `kind` is one of `character`, `scene`, `prop`, `camera`,
`panorama`. Provide at least one of `spatial`, `name_pattern`, or `kind`.

Or bound the search to a spatial region:

```json
{
  "op": "query_objects",
  "spatial": { "mode": "frustum", "camera_id": "camera-main" },
  "max_results": 50
}
```

Other spatial modes are `{"mode":"aabb","min":[-5,0,-5],"max":[5,8,5]}`,
`{"mode":"radius","center":[0,0,0],"radius_m":12}`, and
`{"mode":"nearby","object_id":"hero","radius_m":8}`.

Inspect one known entity. `entity` is required (`object`, `light`, `camera`, `asset`,
`catalog_asset`, …). Do not pass a spill locator or a display name as `entity`.

```json
{ "op": "inspect", "entity": "object", "id": "door-1" }
```

```json
{ "op": "inspect", "entity": "camera", "id": "cam-main" }
```

Compare the current project to a previous turn or audit. Use the `turn_id` or audit token
from a recent successful response; do not guess a number.

```json
{ "op": "diff", "since_turn": "TURN_ID_FROM_PREVIOUS_RESPONSE" }
```

## Look up one operation's exact parameters

`describe` returns the JSON Schema of one operation or one author action. It is pure contract
reflection: no browser tab, no project state.

```json
{ "op": "describe", "target": "capture" }
```

```json
{ "op": "describe", "target": "author.add_object" }
```

`{"op":"describe","target":"author"}` lists every author action name.

`{"op":"describe","target":"apply"}` is not a `director_workbench` target. Native Blender apply
schemas live on the **`blender_native` tool**:

```json
{ "op": "describe", "target": "create_primitive" }
```

```json
{ "op": "describe", "operator": "mesh.bevel" }
```

## Search packaged assets or motions

```json
{ "op": "catalog", "catalog": "assets", "query": "wood chair", "limit": 12 }
```

```json
{ "op": "catalog", "catalog": "character_motions", "query": "walk", "limit": 12 }
```

Chinese queries match the indexed `name_zh`, aliases, and `tags`:

```json
{ "op": "catalog", "catalog": "assets", "query": "木椅", "limit": 12 }
```

List the current project's uploaded or generated models with `project_assets`. Each item returns one prepared `add_object` action; the asset already exists in the project, so there is no upsert step:

```json
{
  "op": "catalog",
  "catalog": "project_assets",
  "query": "robot",
  "kind": "prop",
  "asset_source": "generated",
  "limit": 12
}
```

## Place a catalog asset by its measured size

Read the item's `spatial` facts (metres: `bounds_m`, `footprint_m`, `height_m`) before placement:

```json
{ "op": "inspect", "entity": "catalog_asset", "id": "flick:furniture:chair.glb" }
```

Then submit the item's `authoring.actions` unchanged and position with the measured footprint:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "upsert_asset",
      "asset": {
        "id": "flick:furniture:chair.glb",
        "kind": "prop",
        "sourceType": "model",
        "fileName": "chair.glb",
        "name": "Chair",
        "url": "/flick-stage-props/furniture/chair.glb",
        "assetSource": "library"
      }
    },
    {
      "action": "add_object",
      "id": "catalog-instance-flick:furniture:chair.glb",
      "name": "Chair",
      "kind": "prop",
      "asset_id": "flick:furniture:chair.glb",
      "placement_mode": "grounded"
    },
    {
      "action": "place_relative",
      "object_id": "catalog-instance-flick:furniture:chair.glb",
      "anchor_id": "table-main",
      "relation": "front",
      "clearance_m": 0.3
    }
  ]
}
```

## Author one Stage intent

Search the catalog (or `project_assets`) and submit the returned `authoring.actions` unchanged.
Do not send `geometry_type` on the public agent wire; those calls are rejected. Unique
architecture, openings, and boolean work go through `blender_native`, which projects meshes
back into the same project. Generate a missing unique mesh with `generated_3d`, then place
the promoted `project_assets` action.

`position` is the **floor pivot** (bottom centre).

`visible` and `locked` default to `true` / `false` on `add_light`; omit them unless you need to
override. Stored lights still persist those fields.

```json
{
  "op": "author",
  "actions": [
    {
      "action": "add_light",
      "light": {
        "id": "light-key",
        "name": "Key light",
        "type": "spot",
        "color": "#ffe8cc",
        "intensity": 4,
        "position": [3, 5, 2],
        "target": [0, 1, 0]
      }
    }
  ]
}
```

## Chain batched writes without preflight observes

Delete Stage objects with `delete_objects` and `object_ids`. `remove_object` /
`delete_object` with `id` are accepted aliases. Catalog instances on Stage are
not Blender datablocks; clearing the live Blender scene does not remove them.

```json
{
  "op": "author",
  "actions": [{ "action": "delete_objects", "object_ids": ["tree-left-1", "tree-left-2"] }]
}
```

`author` accepts up to 128 actions. Each successful response returns the new
`project_revision`; pass it as the next call's `expected_revision` so a long
build is one round trip per batch:

```json
{ "op": "author", "expected_revision": "<project_revision from the previous response>", "actions": [ … ] }
```

On `stale_project_revision` or `target_unavailable`, observe once and resume the
chain from the returned revision. Do not run two calls concurrently in one session.

## Add a camera and capture through it

The live Stage remains director orbit. `set_active_camera` snaps that orbit onto
the shot; do not judge framing from a free top-down view. For tall subjects keep
35–65 mm and stay far enough that verticals do not collapse into the lens.

`object_id` is optional and defaults to `${id}-rig`. Set `focus_distance_m` to
the subject distance or wide shots will be defocused, and keep near f/2.8 +
ISO 800 + 180° shutter for neutral capture exposure:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "add_camera",
      "id": "cam-hero",
      "name": "Hero view",
      "position": [540, 330, 820],
      "target": [0, 10, -40],
      "focal_length_mm": 35,
      "aperture_f_stop": 2.8,
      "focus_distance_m": 1000,
      "activate": true
    }
  ]
}
```

```json
{ "op": "capture", "frame": 0, "render_pass": "clean", "width": 1600, "height": 900 }
```

When the same edit needs one immediate visual check, request lightweight post-commit evidence in
the `author` call instead of making a second `capture` round trip:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "add_object",
      "id": "catalog-instance-flick:furniture:chair.glb",
      "name": "Chair",
      "kind": "prop",
      "asset_id": "flick:furniture:chair.glb",
      "placement_mode": "grounded"
    }
  ],
  "evidence": { "camera_id": "camera-main" }
}
```

`evidence` defaults to a clean 640×360 camera frame. Image bytes use the ordinary tool image
attachment; `result.evidence` contains only metadata. If capture is unavailable after the edit
commits, the mutation remains successful and `result.evidence.status` is `unavailable`.

`frame` is required. Omitted `camera_id` uses the active camera. Paired
`width`/`height` render an exact offscreen raster; omitting them snapshots the
live viewport, which can be stale in a hidden tab.

For a multi-character scene, prefer one semantic blocking action:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "compose_blocking",
      "layout": "facing",
      "characters": [
        { "id": "character-a", "name": "Character A", "facing": "toward" },
        { "id": "character-b", "name": "Character B", "facing": "toward" }
      ],
      "camera": {
        "id": "camera-main",
        "object_id": "camera-main-rig",
        "name": "Main camera",
        "angle": "three-quarter",
        "height": "eye",
        "shot": "full"
      }
    }
  ]
}
```

## Film-language framing and camera moves

`frame_shot` aims an existing camera from crew vocabulary; the result notes carry
the derived slate, and any physically forced lens or level adjustment is reported:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "frame_shot",
      "camera_id": "camera-main",
      "subject_object_id": "hero",
      "size": "medium-close-up",
      "view": "profile",
      "side": "left",
      "level": "eye",
      "activate": true
    }
  ]
}
```

Author a move by framing twice and marking twice, then name what the marked
track geometrically proves:

```json
{
  "op": "author",
  "actions": [
    { "action": "frame_shot", "camera_id": "camera-main", "subject_object_id": "hero", "size": "full", "view": "front-quarter", "side": "right", "focal_length_mm": 35 },
    { "action": "mark_camera_move", "camera_id": "camera-main", "frame": 0 },
    { "action": "frame_shot", "camera_id": "camera-main", "subject_object_id": "hero", "size": "close-up", "view": "front-quarter", "side": "right", "focal_length_mm": 35 },
    { "action": "mark_camera_move", "camera_id": "camera-main", "frame": 48 }
  ]
}
```

```json
{ "op": "describe_camera_move", "camera_id": "camera-main", "subject_object_id": "hero", "from_frame": 0, "to_frame": 48 }
```

The read is disconnected-safe and returns the named move (`push-in` here), a
prompt-ready phrase, and per-segment slates. Every `observe` camera already
carries the same `framing` report the viewfinder slate shows.

## Author the living world

World actions ride in a normal `author` batch. The first one creates `project.world` (enabled, seeded defaults) on demand and reports that in the result `notes`:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "set_world_settings",
      "settings": {
        "wind": { "direction_degrees": 210, "speed_mps": 6 },
        "weather": {
          "preset": "rain",
          "intensity": 0.7,
          "evolution": { "mode": "cycle", "period_seconds": 300 }
        },
        "time_of_day": { "mode": "fixed", "hours": 19.5 }
      }
    },
    {
      "action": "add_world_effect",
      "kind": "fire",
      "anchor": { "object_id": "campfire-logs", "position": [0, 0.4, 0] },
      "intensity": 1.4,
      "color_tint": "#ff7733"
    },
    {
      "action": "add_world_effect",
      "kind": "fire",
      "anchor": { "position": [24, 0, -14] },
      "intensity": 1,
      "propagation": { "enabled": true, "radius_m": 16, "spread_rate": 1 }
    },
    {
      "action": "add_world_water_body",
      "surface": { "center": [10, 0, -6], "size_x": 30, "size_z": 18 },
      "flow_direction_degrees": 45
    },
    {
      "action": "add_world_water_body",
      "id": "river_north",
      "name": "North river",
      "river": {
        "points": [
          [-20, 1, -12],
          [-6, 0.6, -2],
          [8, 0.2, 5],
          [22, 0, 16]
        ],
        "width_m": 6,
        "width_profile": [0.7, 1, 1.2, 1.5]
      },
      "flow_speed_mps": 1.4,
      "foam_intensity": 0.8
    },
    {
      "action": "add_world_wildlife_group",
      "species": "birds",
      "count": 24,
      "area": { "center": [0, 0, 0], "radius": 20 },
      "altitude": { "min_m": 8, "max_m": 25 }
    },
    {
      "action": "add_world_road",
      "id": "road_ring",
      "points": [
        [18, 0.05, 12],
        [-18, 0.05, 12],
        [-18, 0.05, -12],
        [18, 0.05, -12],
        [18, 0.05, 12]
      ],
      "width_m": 8,
      "vehicle_count": 8,
      "speed_kph": 45
    }
  ]
}
```

Update with a partial snake_case patch (empty patches are rejected); remove by explicit ids:

```json
{
  "op": "author",
  "actions": [
    { "action": "update_world_effect", "effect_id": "fx_fire_1", "patch": { "intensity": 2, "wind_influence": 0.5 } },
    { "action": "update_world_water_body", "body_id": "water_1", "patch": { "foam_intensity": 0.8 } },
    { "action": "remove_world_water_bodies", "body_ids": ["water_1"] },
    { "action": "update_world_wildlife_group", "group_id": "wildlife_birds_1", "patch": { "count": 40 } },
    { "action": "remove_world_effects", "effect_ids": ["fx_smoke_1"] }
  ]
}
```

Ids are generated as `fx_<kind>_<n>`, `water_<n>`, `wildlife_<species>_<n>`, and `road_<n>` when omitted. Effect `anchor.object_id` must exist in the project (`null` means a world-space anchor at `position`). Capacity is bounded: 64 effects, 8 water bodies, 16 wildlife groups (≤256 heads each), 16 roads (≤24 vehicles each); over-limit adds fail with the matching `remove_world_*` hint.

River water bodies use Catmull-Rom control points in metres. Each point's Y value is its water level; descending points create rapids, `width_profile` changes the channel width from source to mouth, and flow/foam follows the curved ribbon. Set an existing body's patch to `{ "river": null }` to return it to rectangular-basin rendering. Lakes must stay rectangular: a river ribbon will not fill a basin, and a ground-plane hole then shows the always-on viewport grid.

Roads reuse the same Catmull-Rom point convention (Y carries road height). Defaults when omitted: `width_m` 8, `vehicle_count` 6, `speed_kph` 40, `show_surface` true, and `loop` inferred from coinciding first/last points. Ambient vehicles are stateless in time — each pose is a pure function of the world seed and the timeline clock — so open roads teleport vehicles back to their start instead of simulating despawns.

## Author a drivable vehicle

Attach the tuned sedan defaults to an existing prop or scene object:

```json
{
  "op": "author",
  "actions": [{ "action": "set_vehicle_profile", "object_id": "car-hero" }]
}
```

Override only the desired snake_case fields; all others retain their existing/default values:

```json
{
  "op": "author",
  "actions": [
    {
      "action": "set_vehicle_profile",
      "object_id": "car-hero",
      "profile": {
        "mass_kg": 1650,
        "engine_force_n": 12000,
        "max_speed_kph": 180,
        "camera": { "chase_distance_m": 7.5, "chase_height_m": 3 }
      }
    }
  ]
}
```

In Player Mode, approach within 2.5 m and press E to enter; drive with WASD, handbrake with Space, and press E to exit. Remove the capability idempotently with `{ "action": "clear_vehicle_profile", "object_id": "car-hero" }`. Vehicle motion is live-session state and does not rewrite deterministic project transforms.

## Run a saved macro

```json
{
  "op": "run_macro",
  "macro_id": "macro-lighting-setup",
  "parameters": { "keyIntensity": 2.4 }
}
```

## Model in native Blender (`blender_native` tool)

Send these payloads to **`blender_native`**, never `director_workbench`. Stage instances catalog
meshes; unique geometry uses native apply. `director_workbench` has no `apply` op; describing `apply`
there returns 400.

For a single naive call, send only the native operations. Director observes the authoritative scene
and injects the missing epoch, revision, and intent ID:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "create_primitive",
      "id": "hero-plinth",
      "primitive": "cube",
      "dimensions": [4, 0.6, 2],
      "grounded": true,
      "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0] }
    }
  ]
}
```

`dimensions` is the primitive's metric size. Do not also send `transform.scale`; it is rejected
because it previously overwrote dimensions. `grounded:true` places the local origin at the bottom
centre.

Find native objects by name substring. The result includes `objects` with `id` and `name`:

```json
{ "op": "query", "query": "清华" }
```

Spatial queries still use `queries` (`RAYCAST`, `GROUND`, `OVERLAP`, `CLOSEST_POINT`, `NAME`).

Set a solid world without proxy sky geometry:

```json
{
  "op": "apply",
  "operations": [{ "op": "set_world_environment", "color": [0.08, 0.12, 0.2], "strength": 0.8 }]
}
```

Use one transaction for one modeling intent. Prefer semantic operations for common white-box work:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "create_blockout",
      "preset": "room",
      "idPrefix": "warehouse-shell",
      "origin": [0, 0, 0],
      "width": 12,
      "depth": 8,
      "height": 5
    }
  ]
}
```

Sizes are metres. The preset returns stable ids `warehouse-shell:1` (floor) then
`warehouse-shell:2..5` (north/south/east/west walls), all with a neutral clay material. Presets:
`room`, `corridor` (`depth` is the corridor length), `stairs` (`depth` total run, `height` total
rise, `stepCount` steps), and single-slab `wall` / `floor`. Cut real doors and windows into the
returned walls in the next transaction — never fake an opening with a darker box:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "create_opening",
      "id": "warehouse-door",
      "targetId": "warehouse-shell:2",
      "kind": "door",
      "width": 1.2,
      "height": 2.2
    },
    {
      "op": "create_opening",
      "id": "warehouse-window-east",
      "targetId": "warehouse-shell:4",
      "kind": "window",
      "width": 1.4,
      "height": 1.2,
      "sillHeight": 1.0,
      "offset": 1.5
    }
  ]
}
```

Then accept the white-box visually, not from `audit.ready`: add a 35–65 mm Stage camera at about
1.8× subject height distance with under ~15° pitch and `capture` (or attach `evidence` to the same
`author` call). Check massing hierarchy, real openings, ground contact, and metric proportions.

If an `apply` result is `outcome_unknown`, resend the complete `retry_ticket.input` unchanged. It
contains the original epoch, revision, intent ID, and operation batch needed for native exact replay.

Assign a reusable native material or generate UVs in one transaction:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "assign_material",
      "id": "warehouse-shell-wall-north",
      "materialName": "Warehouse clay",
      "createIfMissing": true,
      "faceScope": "ALL",
      "parameters": {
        "baseColor": [0.45, 0.42, 0.38],
        "roughness": 0.82,
        "metallic": 0,
        "alpha": 1
      }
    },
    {
      "op": "project_uv",
      "id": "warehouse-shell-wall-north",
      "method": "SMART",
      "uvLayerName": "UVMap",
      "replaceExisting": false
    }
  ]
}
```

Material assignment targets the whole object by default. Use `faceScope: "PRESERVE"` only to attach or activate a slot without changing face assignments, or `SELECTED` for an explicit face selection. Names match existing materials exactly, then case-insensitively, then with `_` / spaces / hyphens ignored. Omit `createIfMissing` or pass `true` to create a missing Principled material; `createIfMissing: false` skips that object instead of aborting the batch. UV projection never overwrites a same-name layer unless `replaceExisting: true` is explicit.

For a shader graph, inspect the object first and reuse the returned `materialName`, `nodeRef`, and `socketRef` values. Keep one graph edit in one transaction:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "create_material_node",
      "id": "warehouse-shell-wall-north",
      "materialName": "Warehouse clay",
      "nodeRef": "surface-bump",
      "nodeType": "BUMP"
    },
    {
      "op": "set_material_node_input",
      "id": "warehouse-shell-wall-north",
      "materialName": "Warehouse clay",
      "nodeRef": "surface-bump",
      "inputSocketRef": "Strength",
      "value": 0.28
    },
    {
      "op": "connect_material_nodes",
      "id": "warehouse-shell-wall-north",
      "materialName": "Warehouse clay",
      "from": { "nodeRef": "surface-bump", "socketRef": "Normal" },
      "to": { "nodeRef": "principled", "socketRef": "Normal" }
    }
  ]
}
```

Curve, Text, and Geometry Nodes also use typed native operations. Create or update curves and text with `create_curve`, `set_curve_data`, `create_text`, and `set_text_data`. For Geometry Nodes, run `ensure_geometry_nodes`, inspect the returned graph, then reuse its `modifierName`, `nodeRef`, and `socketRef` values with the `create_geometry_node`, `set_geometry_node_input`, `connect_geometry_nodes`, and matching delete/disconnect operations. Do not guess node or socket references.

Import packaged Mixamo motion by catalog ID only:

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "import_mixamo_action",
      "id": "character-rig",
      "motionId": "walk",
      "rootMotion": "IN_PLACE",
      "replaceExisting": false
    }
  ]
}
```

After the bound inspect returns the actual action name and Mixamo compatibility, create or edit NLA with `create_nla_track`, `add_nla_strip`, `update_nla_strip`, and `remove_nla_strip`. Never send a local file path and never guess bone names; use `motionId` and the bone/action references returned by inspect.

For long-tail native operations, discover the real Blender identifier and parameters instead of guessing:

```json
{ "op": "catalog", "query": "bevel", "category": "mesh", "limit": 12 }
```

```json
{ "op": "describe", "operator": "mesh.bevel" }
```

`invoke_operator` covers import/export/render as well as mesh edits. Search and import CC0 Poly Haven
assets with typed ops (no `execute_code`):

```json
{ "op": "polyhaven_search", "assetType": "models", "query": "chair", "limit": 8 }
```

```json
{
  "op": "apply",
  "operations": [{ "op": "polyhaven_import", "assetId": "modern_chair", "assetType": "models", "resolution": "1k" }]
}
```

HDRIs use `assetType:"hdris"` and become the scene world. Textures use `assetType:"textures"` and may
set `objectId` to assign the material. Sketchfab search/import needs `SKETCHFAB_API_TOKEN` (or the
WorldEngine Studio preference) and a downloadable model `uid`. Native stills:

```json
{ "op": "capture", "cameraId": "camera_front", "width": 1280, "height": 720 }
```

`capture_render` is the same top-level read as `capture`. There is no `boolean_difference`
typed op. Wall/window/door holes use `create_opening`. Mesh subtraction uses `add_modifier`
with `modifierType:"BOOLEAN"`, then `set_modifier` properties
`{operation:"DIFFERENCE", object:"<cutter id>"}`. For work that has no operator or typed
op (custom bmesh, third-party add-on scripts), use `execute_code`. `bpy`,
`bmesh`, and `mathutils` are in the namespace; assign `result` or `print` for the receipt. New
objects get stable IDs. Missing `bpy.data.objects["name"]` is `None` and `remove(None)` is a no-op.
`bmesh.types.BMeshVert` aliases `BMVert`. Call `blender_native` directly; do not wrap it in the DSH
`code` tool. Apply results expose `receipt` and `metrics` on the tool envelope. Delete only objects
in the current scene (`bpy.context.scene.objects`); looping `bpy.data.meshes.remove` wipes every
Director project packed in the `.blend`. Do not quit Blender.

```json
{
  "op": "apply",
  "operations": [
    {
      "op": "execute_code",
      "code": "import bpy\nbpy.ops.mesh.primitive_uv_sphere_add(location=(2, 0, 1))\nprint(bpy.context.active_object.name)\n"
    }
  ]
}
```

Inspect only the changed object after the transaction:

```json
{ "op": "inspect", "id": "warehouse-shell-wall-north" }
```

Explicit guards are only for a caller-managed multi-step flow that must detect concurrent native
edits between its own steps. Read the authoritative revision once, then pin each write to it:

```json
{ "op": "scene" }
```

```json
{
  "op": "apply",
  "expectedSceneEpoch": "6df72255-95f9-49fd-962d-fbe489ef88bf",
  "expectedRevision": 12,
  "intentId": "4c8b5b13-cbde-4d3d-90ce-9392dbbfc2cb",
  "operations": [{ "op": "create_primitive", "id": "stage-marker", "primitive": "cube" }]
}
```

Reuse the same intent ID only to retry a request whose result was lost; a new edit takes a new
intent ID.

## Edit Canvas or Video

One edit:

```json
{
  "op": "execute",
  "operation": {
    "op": "canvas.node.update",
    "node_id": "shot-01",
    "patch": { "title": "Wide establishing shot" }
  }
}
```

One undoable batch with aliases:

```json
{
  "op": "execute_batch",
  "steps": [
    {
      "step_id": "intent",
      "save_as": "intent",
      "operation": {
        "op": "canvas.node.add",
        "kind": "note",
        "title": "Rainy rooftop chase",
        "x": 80,
        "y": 80
      }
    },
    {
      "step_id": "shot",
      "save_as": "shot",
      "operation": {
        "op": "canvas.node.add",
        "kind": "shot",
        "title": "Shot 01",
        "x": 420,
        "y": 80
      }
    },
    {
      "step_id": "connect",
      "operation": {
        "op": "canvas.edge.add",
        "source_node_id": "@intent",
        "target_node_id": "@shot"
      }
    }
  ]
}
```

## Search a promoted transcript

Search returns bounded, timed matches and can filter by speaker or source time:

```json
{
  "op": "transcription",
  "command": {
    "action": "search",
    "source_media_id": "creative-media:video:interview",
    "query": "lighting change",
    "speaker": "Director",
    "limit": 12
  }
}
```

Read only the relevant source-time window when more context is needed:

```json
{
  "op": "transcription",
  "command": {
    "action": "read",
    "source_media_id": "creative-media:video:interview",
    "from_seconds": 120,
    "to_seconds": 180,
    "max_segments": 80
  }
}
```

## Reconstruct a captured room and refine it against the capture

A capture (Gallery video, or an RGB-D scanner zip staged by the human) becomes
a durable `scene.reconstruct` job; the plan carries metric walls split around
openings, swinging door leaves, proxy item boxes, and one stage camera per
capture key view.

```json
{
  "op": "reconstruction",
  "command": { "action": "submit", "source_media_id": "creative-media:video:room-walkthrough" }
}
```

```json
{ "op": "reconstruction", "command": { "action": "get", "job_id": "canvas-job-…" } }
```

Review the plan, then apply it as one guarded author batch (Director injects
the revision guard and idempotency key for public callers):

```json
{ "op": "reconstruction", "command": { "action": "plan", "job_id": "canvas-job-…" } }
```

```json
{
  "op": "reconstruction",
  "command": { "action": "apply", "job_id": "canvas-job-…", "mode": "replace", "include_cameras": true }
}
```

Close the authoring loop from the exact capture poses: `capture` renders
through a returned `camera_ids` entry for visual inspection, and `compare`
scores the render against the matching capture keyframe (composite 0..1 plus
the worst-agreeing grid cells to fix first):

```json
{ "op": "capture", "camera_id": "capture-view-camera-01", "frame": 0 }
```

```json
{ "op": "reconstruction", "command": { "action": "compare", "job_id": "canvas-job-…", "view_id": "view-01" } }
```

Fix the reported regions with normal `author` edits (layout first, then
materials, then light), re-compare, and finish with `audit`. RGB-only videos
use monocular depth estimation when available (`providers.depth: "model"`,
`providers.poses: "estimated"`): a metric single-view reconstruction of the
visible surfaces with one calibrated compare camera — extend the unseen parts
of the room with `author` from the video evidence. Without a depth model the
result is a degraded scaffold plus keyframes: author the room from the
keyframe evidence instead of trusting the scaffold.

## Optional checks

Use these only when they match the request:

```json
{ "op": "capture", "frame": 48, "render_pass": "clean" }
```

`frame` is required; omitted `camera_id` uses the active camera. For a sharp
deep-focus verification render (or any capture on a machine without GPU depth
textures), disable the cinematic depth-of-field pass:

```json
{ "op": "capture", "frame": 0, "render_pass": "clean", "depth_of_field": false }
```

```json
{ "op": "audit", "camera_id": "camera-main", "subject_id": "character-a" }
```

`audit.ready` is structural only (`visual_judgment: false`). It does not score pixels or
whether a building is recognizable. Do not treat `ready:true` as visual acceptance.

```json
{ "op": "deliver", "camera_id": "camera-main", "quality_profile": "cinematic" }
```

## Real error handling

- A stale-edit error: observe once and rebuild the failed edit against the current state.
- A missing ID: use observe or the relevant catalog and retry with the returned ID.
- A locked object: leave it unchanged unless the user explicitly asks to unlock or force the edit.
- A provider job failure: inspect that job and report or retry the actual provider error.
- A disconnected Stage tab: `observe`/`audit` may still return persisted project or Blender-kernel counts with `workbench_connected:false`. Mutations and capture need a visible tab. Call `get_goal` as `tools.get_goal({})`.

## DeepSeek Harness tools (not Gateway HTTP)

These are DSH-native tools. They are not `POST /api/tools/:name`.

Load the Director skill:

```json
{ "name": "director-workbench" }
```

Write a production todo list with `todo_write`. List Harness background jobs:

```json
{}
```

Read a Harness job (`job_output`) without busy-polling:

```json
{ "job_id": "bash-1", "wait": true }
```

Research then catalog (do not guess asset ids):

```json
{ "query": "Qinghua university gate architecture" }
```

Zero-argument Harness tools in Code Mode:

```js
await tools.get_goal({});
await tools.director_model_routes({});
await tools.job_list({});
```

