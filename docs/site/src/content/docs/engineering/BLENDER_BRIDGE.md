---
title: Native Blender Backend and File Interchange
description: Headless Blender modeling plus optional file interchange.
---

The live modeling kernel is the `worldengine_studio` addon at
`integrations/blender/live/addons/worldengine_studio/`. It runs
inside headless Blender 4.2+ and owns the authoritative scene graph, mesh/Edit Mode
operations, modifiers, materials, rigs, animation, cameras, lights, rendering,
and undo. File interchange scripts (trusted `.blend` import and Director
round-trip) live in `integrations/blender/interchange/`. Director is its
Agent-native directing frontend rather than a second geometry database.
Long-tail `invoke_operator` / `set_rna_property` / `execute_code` calls share the live
kernel. Policy is a small denylist (quit Blender, console/help/preferences/screen/workspace),
not a modeling-only allowlist. `execute_code` is the blender-mcp analogue for arbitrary Python.
Typed `polyhaven_search` / `polyhaven_import` and `sketchfab_search` / `sketchfab_import` cover
CC0 Poly Haven HDRIs, textures, and models, plus downloadable Sketchfab glTF (Sketchfab needs
`SKETCHFAB_API_TOKEN` or the Studio preference).

Start the integrated product from the WorldEngine repository root:

```bash
npm run blender
```

Humans can model with the normal Blender UI. Agents use the same native scene by
searching the runtime operator catalog, reading an operator's RNA parameters,
submitting one structured transaction, inspecting the edited object, and taking
a clean Blender camera capture. Common white-model tasks remain high-level
recipes; the dynamic Blender catalog covers the long tail without duplicating
thousands of Blender controls in TypeScript.

Director also renders a revisioned live GLB view of that same Blender scene. Its
compact Native Mesh panel writes Edit Mode operations, modifiers, material
assignment, Principled parameters, UV projection, and a curated Material Nodes
graph through the same scene-epoch/revision transaction contract used by Agents.
The UI and Agent therefore edit one Blender scene and receive the same focused
receipt; they do not maintain a second mesh or shader graph.

The Modeling tab reports the live session itself. A connection header shows the
Blender version, the current scene revision, and a busy indicator while a native
transaction executes, plus a manual recheck control. Each panel action reports
progress, success, or failure as a distinct notice, and successful receipts
dismiss themselves. While the session is offline, the tools are replaced by
launch guidance for `npm run blender`. The scene owner keeps a reduced-rate
status check running, so a restarted Blender session restores the modeling tools
without a page reload or a second panel-owned polling loop.

## One operation contract

`packages/protocol/src/blenderOperationManifest.json` is the canonical catalog for every live
Blender operation. Each entry declares its public surface (`typed`, `longtail`, or `internal`)
and transaction effect (`read`, `selection`, `frame`, `transform`, `content`, `history`, or
`project`). The TypeScript protocol asserts that its executable Zod union has exact catalog
coverage; Gateway receipt classification and Director refresh policy derive from the same effects.
Blender loads a generated copy rather than maintaining handwritten operation sets in Python.

This is a capability Definition/Provider/Consumer boundary: the manifest defines identity and
effect, TypeScript and Blender provide execution, and Gateway/Director consume receipts. It does
not create a second Agent harness or a second scene model. After changing the catalog, synchronize
and verify the Blender copy with:

```bash
npm run sync:blender-operations
npm run sync:blender-operations -- --check
```

## Live ownership and synchronization

`DirectorProject.nativeScene.projectId` is the session binding. The Stage binds an unowned native
runtime once, rejects snapshots from another project, and keeps `BlenderSceneLayer` as the one
scene poller. That layer publishes a transient snapshot to `blenderRuntimeStore`; Modeling,
camera, collision, and right-panel routing consume that same snapshot instead of starting
independent refresh loops. Modeling and Rig inspectors may issue revision-bound object inspections,
but never read a second full-scene snapshot. Every mutation carries an intent ID, expected scene
epoch, and expected revision. Director accepts its focused evidence only when the receipt's
before/after revisions join exactly onto the current snapshot, then projects selection, frame,
transform, deletion, and inspected entities directly into the shared store. Transform-only,
selection, and frame transactions therefore need no second scene read. Content/history changes,
unverifiable receipts, and revision conflicts request one immediate cycle from the shared poller.
Hiding the native preview stops GLB download and parsing while the lower-rate structured scene sync
continues. Only the visible, focused Director document may automatically bind a runtime or submit
synchronization writes. Background tabs remain read-only, preventing two open projects from
repeatedly rebinding or overwriting the same Blender scene.

Each top-level Blender object maps to one `DirectorObject.nativeSource`. Director persists the
production projection needed by cameras, timelines, shots, Agent inspection, and normal scene-tree
editing. Blender persists the native hierarchy and content below that root. Synchronization is
therefore field-specific rather than a second general-purpose asset abstraction:

- Blender → Director creates/removes native root projections and updates root name, visibility,
  and transform without adding polling updates to the Director undo stack;
- Director → Blender provisions model assets and applies root transform, rename, visibility,
  and delete operations in one revision-checked transaction;
- Stage clicks on a native child resolve to its root projection, while Director selection sets the
  corresponding native root selection;
- compatible Character roots keep Action and Pose in `DirectorProject.characterRig`; the scene layer
  maps each Action to an independent per-armature `Director Motion` NLA track and maps Pose to
  inspected bones through typed, idempotent operations. One shared scene-frame update follows the
  Director playhead, so characters never compete for the global Blender frame;
- Properties routes to one Character or Prop inspector, while native mesh authoring stays in the
  top-level Modeling tab. A compatible Director Character never stacks a second Mesh or Rig panel.

A transaction conflict or preview-load failure leaves the last coherent preview mounted and marks
the layer stale; it does not replace the Director project or clear unrelated selection. A new GLB is
loaded only for a new accepted native scene version, while selection evidence can update without
creating a second scene loader. Native preview export bakes the current deformation without exporting
skin state, so generating a preview cannot reset the live armature pose or its Director state token.

### Preview-only live link

The live kernel also publishes a bounded, preview-only delta feed. Every accepted scene snapshot is
diffed into a live-link frame with a per-scene-epoch monotonic sequence number: `transform` frames
carry object/camera/light transform, lens, and energy previews, while `structure` frames carry no
entity data and signal that something bigger changed (created or deleted datablocks, mesh or
material edits, renames, or an oversized delta), so the consumer must refetch the authoritative
snapshot instead of patching. The kernel keeps a fixed ring of recent frames (128 by default) and
reports the feed on `/health` as `liveLink { seq, bufferedFrames, capacity }`; the Modeling
connection header shows the same sequence number.

Clients poll through the read-only `blender_native` operation
`{ "op": "live_link", "cursor": { "sceneEpoch": "…", "seq": N } }` or the equivalent browser route
`GET /api/dcc/blender/live-link?epoch=…&since=N`. The response either returns the
contiguous frames after the cursor or a `resync` marker (`initial`, `epoch_changed`, or
`history_evicted`). The shared replay guard in `packages/protocol/src/blenderLiveLinkProtocol.ts`
drops duplicate or replayed frames and forces a snapshot resync on any sequence gap or epoch change,
so a consumer can never silently desynchronize.

The Stage consumes this feed as a read-only preview: while the Modeling layer is visible, it polls
the delta feed at a faster cadence than the authoritative snapshot loop and re-poses the mounted
preview nodes and the active-camera preview directly. The preview never calls a store mutator and
never writes a project revision — `structure` frames and any replay-guard resync pause the deltas
and force a fresh authoritative snapshot instead of patching.

Live-link frames are never authoritative. Committed Director state changes only through the
revision-guarded live command batches or the reviewed return import, so dropping the link, evicting
buffered history, or restarting Blender leaves the last committed Director revision intact by
construction.

The file-import and round-trip workflows below remain available for projects
that intentionally exchange snapshots with a separate Blender installation.

Alongside the native backend, Director exposes two deliberately separate file paths:

- **Raw scene import** consumes an operator-trusted local `.blend`, extracts one
  current-frame GLB snapshot of its active scene plus supported static perspective
  cameras, previews a plan, and creates new Director entities.
- **Director round trip** snapshots a validated `DirectorProject`, builds a `.blend`
  carrying stable `director_id` properties, and accepts a constrained stable-ID
  mesh/transform return after review.

Raw import is not used to apply edits to a Director export, and round trip is not
an arbitrary `.blend` merger. Keeping the contracts separate prevents Blender-only
objects from being mistaken for edits to a Director-owned project.

## Raw `.blend` scene import

The Interchange menu uploads the raw file to
`POST /api/dcc/blender-scene/uploads?filename=...`. The Gateway writes a private
job, then launches Blender in background mode with `--factory-startup` and
`--disable-autoexec`. The extractor emits `director-blend-scene-v1`:

- source name, byte count, SHA-256, Blender version, and explicit compatibility warnings;
- exact rational frame rate, source frame range, and current frame as audit metadata;
- a metre-scale, Y-up `assets/scene.glb` whose visible state samples the active
  Blender scene at its current frame while preserving authored world layout and
  hierarchy inside the GLB; and
- physical data and current-frame transforms for supported perspective cameras.

The scene GLB may retain materials, skins, morph targets, and embedded animations
that Blender's glTF exporter supports. Director deliberately imports the GLB as one
scene asset and one root object with `modelNormalization: "preserve"`; it does not
recenter, fit-to-box, or auto-rescale the authored scene.

Upload returns a default `director-blend-scene-import-plan-v1`. Re-preview with a
selection when the operator wants only the scene, only selected cameras, or both:

```json
{
  "op": "preview_blend_scene_import",
  "package_dir": "blend-JOB_ID/package",
  "selection": {
    "includeScene": true,
    "cameraSourceIds": ["Camera"]
  }
}
```

Preview is read-only. A conflict-bearing plan is returned with HTTP `409` and
`ready:false`; it cannot be applied. A ready plan is persisted by the server and
applied by identifier, not by trusting a client-supplied plan body:

```json
{
  "op": "apply_blend_scene_import",
  "plan_id": "blend-JOB_ID/plans/SELECTION_HASH.json",
  "expected_revision": "<plan.targetRevision>",
  "idempotency_key": "blender-scene-import-<intent>"
}
```

Apply reloads and schema-validates the plan, re-verifies every package hash, checks
the live revision, rebuilds and byte-compares the plan, copies the GLB to immutable
content-addressed storage, and sends one guarded authoring mutation. Use one
idempotency key only for a byte-equivalent uncertain retry; a new intent needs a new
key. Generated models are served as
`/dcc-import/<hash-prefix>/<asset-id>.glb` from `assets/generated/dcc-import/`.

### Raw import boundary

The scene bundle is a faithful runtime snapshot, not a full Blender-to-Director
authoring conversion. v1 evaluates only Blender's active scene. Its current frame
becomes the visible GLB snapshot, and perspective cameras are created as static
cameras sampled at that frame; camera animation is flattened. Blender child
hierarchy remains inside Blender/GLB rather than becoming individual Director
objects. Embedded GLB animation clips may be preserved in the file, but Director v1
neither maps nor plays them. The manifest's rational frame rate, frame range, and
current frame are review/provenance metadata only: import does not change the
Director project timebase, IN/OUT, playhead, or timeline tracks. Lights,
world/HDRI/compositor settings, orthographic cameras, constraints, custom shader
equivalence, lens shift, exact camera roll, and Blender-specific simulations are
unsupported or lossy and remain visible as warnings. Camera optics are converted
to the nearest supported Director sensor/aspect representation and clamped to
Director limits when necessary. The upload/preview/apply flow is explicit batch
interchange; it is not live synchronization with Blender.

Raw `.blend` upload is a **trusted local desktop boundary**. `--disable-autoexec`
prevents automatic embedded Python/driver execution, but it is not an OS sandbox
for Blender's native parser or dependencies. Never import an untrusted `.blend`
outside a container/VM or another host-level sandbox. Private job paths, size
limits, and process timeouts reduce exposure but do not turn Blender into a sandbox.

## Director round trip

The local Gateway snapshots the current validated `DirectorProject`, writes a
versioned scene package, invokes Blender in background mode, and returns the generated
`.blend`, report, and optional camera preview paths. The return exporter emits a
`director-dcc-return-v1` package containing stable-ID mesh replacements, transform
updates, camera updates (transform plus focal length, aperture, focus distance, and
clip distances), light updates for lights that carry a `director_id`, portable
character pose-control updates with optional root motion, and hashed
`object_addition` entries for new root objects the artist explicitly stamped with a
fresh `director_id`. Director verifies all hashes, builds a reviewable
`director-dcc-import-plan-v1`, and applies the exact plan through the same
revision-guarded authoring engine used by Agents and the UI.

### Agent operations

The same Zod contract drives HTTP and the `director_dcc` MCP tool:

```json
{ "op": "status" }
```

```json
{
  "op": "export_blend",
  "render_preview": true,
  "camera_id": "optional-camera-id",
  "frame": 48
}
```

After refining the generated `.blend`, run `integrations/blender/interchange/director_return_export.py`
with the original `scene.director-dcc.json`. Preview and apply the return:

```json
{
  "op": "import_return_package",
  "package_dir": "JOB_ID/return-package",
  "dry_run": true,
  "include_new_objects": false
}
```

`include_new_objects` defaults to `false`: `object_addition` entries are skipped with a warning
until the operator explicitly opts in, so Director never auto-imports new Blender objects without
review. Opted-in additions plan as `create_prop` operations (asset upsert plus a new prop object); a
`director_id` that already exists in the live project is reported as a `duplicate_director_id`
conflict instead of being applied.

```json
{
  "op": "apply_import_plan",
  "plan": "<the exact returned plan object>",
  "expected_revision": "<plan.targetRevision>",
  "idempotency_key": "blender-return-<packageId>-<manifest hash prefix>"
}
```

`import_return_package` never mutates the live project. Apply re-reads the
package, verifies every SHA-256, checks the source and live revisions, rebuilds
the plan, then emits one authoring batch (`upsert_asset`, `update_object`,
`update_camera`, `update_light`, and character pose-control updates). Take,
Coverage, Storyboard, and Shot IR identities are not replaced.

HTTP equivalents are `GET /api/dcc/status` and
`POST /api/tools/director_dcc`. Raw HTTP clients must first bootstrap the local
gateway and send its token in `X-Director-Browser-Token`; the bundled MCP and CLI
clients do this automatically. Set `DIRECTOR_BLENDER_BIN` only when Blender is not
installed in the standard macOS application path or available on `PATH`.

### Round-trip data contract

- Contract: `director-dcc-scene-v1`
- Source: validated `DirectorProject` v1
- Units: metres
- Director: right-handed, Y-up, camera forward `-Z`
- Blender: right-handed, Z-up, camera forward `-Z`
- Point mapping: `(x, y, z) -> (x, -z, y)`
- Rotations: basis-converted normalized quaternions, never guessed Euler swaps
- Timeline: one shared FPS and frame range for objects and cameras
- Camera: focal length (including animated lens keys), cropped sensor gate,
  aperture, focus distance, shutter angle, ISO, clipping planes, anamorphic
  squeeze metadata, aspect ratio, and target
- Lights: `director_id`-stamped directional/point/spot/rect-area lights carrying
  Director color/intensity plus the exact wattage conversion factor used on
  import, so intensity edits invert losslessly on return
- Character pose: portable `director_pose.*` custom properties (one per control)
  next to a JSON baseline, an armature pose-bone fingerprint, a Director
  bone-role map (`director_pose_bone_map`), and per-role pose-bone baselines
  stamped at import time so mapped bone edits can reconcile on return

Every job lives under `data/dcc-jobs/blender/<uuid>/` and contains:

- `scene.director-dcc.json` — validated handoff package and source revision
- `assets/*.glb` — local Blender-compatible GLB copies
- `scene.blend` — the generated Blender scene
- `report.json` — counts, Blender version, warnings, and output paths
- `preview.png` — optional active-camera clay render

A refined job may also contain `return-package/manifest.json`,
`return-package/meshes/*.glb`, and `return-package/return-report.json`. Imported
GLBs are copied to immutable hash-derived paths under `assets/generated/dcc-import/`; the
original catalog asset remains available and the object pointer moves to the new
asset version.

The preview is rendered through Blender rather than captured from the editor, so
grid lines, axes, labels, camera frusta, paths, selections, gizmos, and lasso UI
cannot appear in the result. A temporary clay material override produces a neutral
white-model frame; the saved `.blend` retains the original imported materials.

### Round-trip asset pipeline and safety

GLB/glTF 2.0 remains the runtime exchange contract. Before Blender import, the
bridge uses the pinned `@gltf-transform/core` and extension decoders to parse and reserialize
models. This removes geometry compression that Blender's importer cannot decode,
without changing the original Web assets. Only local model paths resolved inside
the repository `assets/library/` directory are accepted. Remote, `data:`, `blob:`,
traversal, symlink-escape, non-model, and non-GLB/glTF sources are rejected or
reported as unresolved. Blender receives argument arrays, not shell commands, and
cannot write outside the Gateway-created job directory through this API.

### Current round-trip boundary

This subsection describes the offline Director round trip, not the live native bridge. In the live
bridge, compatible Character Action and Pose state is applied semantically to the native armature;
native IK and motion blend ramps remain capability-gated rather than presenting controls that do
nothing.

Object and camera transforms share the Director timeline and Mixamo/GLB character
geometry is imported. Refined object meshes, object/camera transforms, camera
optics (focal length, aperture, focus distance, clip distances), `director_id`
lights (position, target, color, intensity), and portable character pose controls
with root motion can return by stable ID with preview-before-apply conflict
reporting. Values outside Director's authoring limits are baked to the nearest
limit with an explicit warning, never silently dropped. Sensor-size edits are
warn-and-omit: Blender sensor dimensions never overwrite the Director sensor
format.

Direct armature pose-bone edits reconcile only where the stamped Director
bone-role map covers them: rotation deltas on mapped bones convert into portable
`director_pose.*` control deltas (exact for single-axis edits such as bending an
elbow or turning the head; large combined multi-axis edits are an explicit
warned approximation because Euler composition is not linear). Bone
translations, bone scales, edits to unmapped bones, and legacy `.blend` files
without a stamped bone map remain warn-and-omit, and an explicit
custom-property edit always wins over a bone-derived delta on the same control.

New Blender objects import only through review: the artist stamps a fresh
`director_id` custom property on the new root object, the exporter emits a
hashed `object_addition` with honesty warnings (default datablock names, linked
libraries, unapplied modifiers, non-mesh datablock types), and the plan includes
it only under the explicit `include_new_objects` opt-in — as a prop, never as a
character or light. Objects and lights without a `director_id` stay warnings and
are never auto-created. Materials ride inside the refined GLB, while light
creation, interactive add-on synchronization, final animation rendering,
shader/constraint/simulation transfer (no lossless shaders, constraints, or
simulations), and Unreal Interchange remain outside this round-trip contract.
File interchange always runs Blender with `--factory-startup
--disable-autoexec`, and no request-supplied Python is ever executed.
Arbitrary `.blend` files use the separate scene-import contract above; they do
not gain stable-ID round-trip semantics automatically.
