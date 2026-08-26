---
title: UI/Agent parity inventory — Stage DirectorStore
description: Inventory of Stage DirectorStore project mutators and whether each shares the Agent authoring dispatch path.
---

This is the Milestone 0 inventory from the
[Agent-Native Roadmap](/engineering/agent_native_roadmap/): every mutating action on the Stage
`DirectorStore` (`frontend/director/src/comprehensive/editor/store/directorStore.ts`, referred to
as `directorStore.ts` below), what semantic authoring action it maps to, and whether the UI and
the Agent already produce the same project revision through one executor.

Last verified: **2026-08-26**.

## Status legend

- **shared** — one-shot UI calls route through `dispatchDirectorAuthoringActions`
  (`frontend/director/src/agent/dispatchDirectorAuthoringActions.ts`), which calls the same
  `applyDirectorAuthoringActions` the Agent uses, so both produce the same revision. Compile
  helpers live in `frontend/director/src/agent/compileDirectorUiAuthoringActions.ts`. All shared
  mutators fall back to the legacy direct writer inside slider/gizmo undo batches
  (`undoBatchDepth > 0`) and for the specific inexpressible patches noted per row.
- **ui-only** — still writes the project through `commitMutation` / `withProjectPatch` only. Rows
  marked *(deliberately local)* carry a documented divergence reason in the store and are not
  migration candidates; the rest either lack a semantic action or await compilation.
- **human-only-interactive** — intentionally not routed through authoring: per-frame interactive
  feel, DCC projections, runtime measurements, selection, history, and project lifecycle.

## Coverage summary

| Category | Count |
| ------------------------------------ | ----- |
| shared Stage project mutators | 77 |
| ui-only Stage project mutators | 10 |
| Coverage (shared / project mutators) | **77 / 87 ≈ 89%** |

Everything still ui-only either has no semantic action yet (object lists,
capture evidence writes, catalog ingest) or is deliberately local with a documented
divergence reason in the store (snapshot cameras, preset/crowd/asset add flows).

Parity is regression-tested in
`frontend/director/tests/agent/dispatchDirectorAuthoringActions.test.ts`: the same
`DirectorProject` is mutated once through the store and once through a direct
`applyDirectorAuthoringActions`, and `getDirectorProjectRevision` must match.

## Objects and transforms

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `deleteObjects` / `deleteSelectedObject` | `directorStore.ts` | `update_object` (detach children) + `delete_objects` | shared |
| `updateObjectTransform` | `directorStore.ts` | `update_object` | shared (camera rigs, composite parents, and object-focused-camera refresh keep the legacy writer) |
| `toggleObjectVisible` / `toggleObjectLocked` | `directorStore.ts` | `update_object` | shared (camera rigs keep the legacy writer) |
| `toggleObjectInteraction` | `directorStore.ts` | `update_object` (via `updateObjectTransform`) | shared |
| `setObjectAnimation` | `directorStore.ts` | `set_animation` | shared |
| `updateObjectTransforms` (multi-select) | `directorStore.ts` | `update_object` batch | shared (batches containing camera rigs, composite parents, or object-focused-camera targets keep the legacy writer wholesale) |
| `batchUpdateObjects` / `resetObjectTransforms` | `directorStore.ts` | `update_object` batch | shared (composite-parent transform propagation, object-focused-camera refresh, and color/material/layer patches on provisioned native Blender objects keep the legacy writer) |
| `alignObjects` / `distributeObjects` | `directorStore.ts` | `align_objects` / `distribute_objects` | shared (object-focused-camera targets keep the legacy writer) |
| `isolateObjects` / `showAllObjects` | `directorStore.ts` | `isolate_objects` + `set_object_layer_state` / `show_all_objects` | shared (show-all with a hidden camera rig keeps the legacy reveal) |
| `setObjectPivot` | `directorStore.ts` | `set_object_pivot` | shared |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround` | `directorStore.ts` | `update_object` transform / `placement_mode` patches (crowds fan out per member) | shared (composite parents, object-focused cameras, and grounded drops on provisioned native Blender objects keep the legacy writer) |
| `updateObjectName` / `updateCrowdLabel` | `directorStore.ts` | `update_object` `name` / `crowd_label`; camera rigs rename through `update_camera` | shared (unstable-fov snapshot cameras, asset-less character renames, and mid-typing whitespace crowd labels keep the legacy writer) |
| `updateObjectColor` / `updateCrowdColor` | `directorStore.ts` | `update_object` `color` (crowds fan out per member) | shared (camera rigs and provisioned native Blender objects/members keep the legacy writer) |
| `updateObjectMaterial` / `updateObjectMaterialTexture` | `directorStore.ts` | `update_object` material patch, pre-merged to match the store's partial-merge semantics | shared (composite parents, camera rigs, and provisioned native Blender objects keep the legacy writer) |
| `setObjectVehicleProfile` | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile` | shared (only unlocked prop/scene objects are authorable; others keep the legacy writer) |
| `updateObjectReferenceBindings` | `directorStore.ts` | `update_object` `reference_bindings` | shared (camera rigs and provisioned native Blender objects keep the legacy writer) |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite` | `directorStore.ts` | `group_objects` / `update_object` `parent_id` patches | shared (provisioned native Blender children keep the legacy writer) |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | no semantic action; object lists are a UI selection helper, not composite groups | ui-only (deliberately local) |
| `pasteClipboardObjects` | `directorStore.ts` | `duplicate_objects` (one action per paste; ids, names, offsets, and crowd remaps allocate identically on both paths) | shared (stale clipboard snapshots that no longer match the live objects, camera objects without a linked shot, Blender-native objects without a model asset, and pastes an object-focused camera participates in — as copied source, focus target of a copied source, or with a drifted stored target — keep the legacy writer) |

## Cameras

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `updateCamera` | `directorStore.ts` | `update_camera` (also syncs the linked rig object) | shared (captures/animation patches, rotated or scaled rig transforms, and frustum-depth close-ups keep the legacy writer) |
| `setActiveCamera` | `directorStore.ts` | `set_active_camera` | shared |
| `addCameraShot` | `directorStore.ts` | `add_camera` diverges: snapshot cameras keep the viewport's exact fov while `add_camera` derives fov from focal length, and sequential `cam_N` ids plus active-camera optics inheritance are not authoring concepts | ui-only (deliberately local) |
| `setCameraAnimation` | `directorStore.ts` | `set_animation` | shared |
| `addCameraCaptures` | `directorStore.ts` | no semantic action yet (capture evidence write) | ui-only |

## Characters

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `applyPosePreset` / `applyCrowdPosePreset` | `directorStore.ts` | `update_object` (`pose_preset_id`) | shared |
| `updatePoseControl` / `updateCrowdPoseControl` | `directorStore.ts` | `set_character_pose_controls` | shared |
| `setCharacterMotion` / `setCrowdCharacterMotion` | `directorStore.ts` | `set_character_motion` / `clear_character_motion` | shared (migration-only `authored` root motion keeps the legacy writer) |
| `setCharacterIkEffector` / `setCrowdCharacterIkEffector` | `directorStore.ts` | `set_character_ik` | shared |
| `clearCharacterIkEffector` / `clearCrowdCharacterIkEffector` | `directorStore.ts` | `clear_character_ik` | shared |
| `updateCharacterBodyType` | `directorStore.ts` | `update_object` `body_type` | shared (object-focused cameras keep the legacy writer for the UI focus-height refresh) |
| `updateUniformScale` / `updateCrowdUniformScale` | `directorStore.ts` | `update_object` transform scale (crowds fan out per member) | shared (camera rigs, composite parents, and object-focused cameras keep the legacy writer) |

## Lights

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addLight` | `directorStore.ts` | `add_light` | shared |
| `updateLight` | `directorStore.ts` | `update_light` | shared (light type changes reset type-specific fields and keep the legacy writer) |
| `removeLight` | `directorStore.ts` | `delete_lights` | shared |

## Scene, world, and storyboard

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `updateScene` | `directorStore.ts` | `set_scene` | shared (patches with keys `set_scene` cannot express keep the legacy writer) |
| `updateWorldSettings` | `directorStore.ts` | `set_world_settings` | shared |
| `upsertWorldEffect` | `directorStore.ts` | `add_world_effect` / `update_world_effect` | shared (locked entries and non-default add flags keep the legacy writer) |
| `removeWorldEffects` | `directorStore.ts` | `remove_world_effects` | shared |
| `upsertWorldWaterBody` / `removeWorldWaterBodies` | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies` | shared |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups` | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared (adds relying on the default flight band keep the legacy writer) |
| `upsertWorldRoad` / `removeWorldRoads` | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads` | shared |
| `updateStoryboard` | `directorStore.ts` | `set_storyboard` | shared |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation` | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations` | shared |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements` | shared |
| `setObjectLayerState` | `directorStore.ts` | `set_object_layer_state` | shared (no-op state writes are skipped to keep the undo stack clean) |
| `moveObjectLayer` | `directorStore.ts` | `reorder_object_layer` | shared |
| `removePanoramaAsset` | `directorStore.ts` | `remove_assets` (clears `panoramaAssetId` when the panorama asset id is removed) | shared (when characters still need the default Mixamo asset but it is missing from `assets`, migrate would rehydrate it — keep the legacy writer that only drops the panorama entry) |

## Timeline audio

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | `add_timeline_audio_clip` / `update_timeline_audio_clip` / `remove_timeline_audio_clips` / `set_timeline_audio_track_muted` | shared |

## Assets and creation flows

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addImportedAsset` | `directorStore.ts` | no semantic action yet (catalog ingest + optional scene placement) | ui-only |
| `setAssetRealWorldSize` | `directorStore.ts` | `upsert_asset` with the patched `realWorldSizeM` / `sizeSource` | shared (clearing to `null` keeps the legacy writer so migrate's estimated 2 m backfill does not refill the Prop inspector) |
| `removeImportedAsset` | `directorStore.ts` | `remove_assets` with `cascade` | shared (removals whose cascade would also delete children, clear look targets, camera follow/path bindings, or material texture references keep the legacy writer, which leaves those untouched) |
| `addObjectFromAsset` | `directorStore.ts` | `add_object` diverges: `createSceneObjectFromAsset` stamps Blender `nativeSource` provisioning markers and character rig defaults that `add_object` does not author | ui-only (deliberately local) |
| `addPresetCharacter` / `addCrowdCharacters` | `directorStore.ts` | `add_object` diverges: preset adds keep per-add body types and a rotating color palette, and crowd grouping (`crowdId`) is UI-only state `add_object` cannot author | ui-only (deliberately local) |
| `addGeometryPrimitive` | `directorStore.ts` | `add_object` with `geometry_type` (accepted in-process; only the public workbench agent wire rejects it) | shared |

## Human-only interactive surfaces

These stay direct writers on purpose; forcing them through authoring on every frame would break
interactive feel or conflate DCC/runtime projections with user authoring intents.

| Mutator | File | Reason | Status |
| --- | --- | --- | --- |
| `beginUndoBatch` / `endUndoBatch` + in-batch fallbacks of every shared mutator | `directorStore.ts` | TransformControls / slider RAF batches; pointer-up lands in one undo entry | human-only-interactive |
| Viewport navigation and pilot feel (`setViewMode`, `setTransformMode`, `setViewport*`, `resetViewportNavigation`) | `directorStore.ts` | `commitUiPatch` UI state; no project write | human-only-interactive |
| Selection and inspector (`selectObject`, `selectObjects`, `selectCrowd`, `toggleObjectSelection`, `openSceneInspector`) | `directorStore.ts` | UI state; no project write | human-only-interactive |
| `syncBlenderScene` / `prepareBlenderSync` / `ensureNativeSceneBinding` | `directorStore.ts` | DCC projection of the authoritative Blender scene, not user authoring | human-only-interactive |
| `setObjectMeasuredLocalBounds` | `directorStore.ts` | runtime geometry measurement, `trackUndo: false` | human-only-interactive |
| `copySelectedObjects` | `directorStore.ts` | clipboard UI state only (paste is the project write) | human-only-interactive |
| `undo` / `redo` | `directorStore.ts` | history replay of full snapshots | human-only-interactive |
| `replaceProject` / `applyAuthoredProject` / `openScopedScene` / `saveLatestSnapshot` / `restoreLatestSnapshot` | `directorStore.ts` | project lifecycle and persistence, including the shared dispatch landing point | human-only-interactive |

## Canvas / Video

Canvas and Video expose typed Agent JSON operations through `director_creative`
(`packages/protocol/src/creativeWorkspaceProtocol.ts`). One-shot UI mutations now route through
`dispatchCreativeWorkspaceOperations`
(`frontend/director/src/agent/dispatchCreativeWorkspaceOperations.ts`), the same executor the
Agent envelope uses, so both fill the snapshot-fingerprint guard and an idempotency key and
produce the same revision (roadmap M1 batches 1e/1f). Parity is regression-tested in
`frontend/director/tests/agent/dispatchCreativeWorkspaceOperations.test.ts`.

Shared today:

- Canvas node/edge/layout authoring (`canvas.node.*`, `canvas.edge.*`, `canvas.dag.layout`),
  media import cataloging (`gallery.media.update`), and the undo/redo buttons
  (`workspace.undo` / `workspace.redo`).
- Video clip inspector edits, split, remove (including ripple), cross dissolve, discrete
  keyboard fade steps, the "+" placement into the first free slot (`edit.clip.add`), track
  management, settings, import cataloging, and undo/redo (buttons and shortcuts).
- The Canvas-to-timeline bridge (`edit.clip.add` + `workspace.switch`), Stage capture import as
  one atomic `execute_batch` (catalog + node add roll back together), and media review
  rating/tag upserts (`gallery.media.update`, with a direct-store fallback only when the
  contract does not know the media id).

Still direct, with reasons:

- Continuous interactions — node drags, clip drags/trims, fade drags, range sliders, live
  typing — keep locally batched history (`beginHistoryBatch`/`endHistoryBatch`), matching the
  Stage slider/gizmo policy.
- Remaining overwrite-adjacent flows still on `commitClipPlacement` (frame nudges, trim-into
  neighbour, duplicate-after). Explicit media drops now share `edit.clip.add` with
  `overwrite: true` (same `resolveDirectorTrackOverwrite` resolver).
- Media-less text/caption clips (`text:` ids), Canvas z-order raises, view state, and section
  bookkeeping — no semantic operations yet.
- Media relink reference rewrites, canvas pipeline result cataloging, legacy review-mirror
  migration, and bulk review clearing — multi-store or migration bookkeeping flows.
