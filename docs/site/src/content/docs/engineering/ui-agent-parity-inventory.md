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
- **ui-only** — still writes the project through `commitMutation` / `withProjectPatch` only. The
  Agent has no guarantee of an identical revision for the same intent yet. Rows marked
  "intentionally local" carry an in-code rationale and are not open compile gaps.
- **human-only-interactive** — intentionally not routed through authoring: per-frame interactive
  feel, DCC projections, runtime measurements, selection, history, and project lifecycle.

## Coverage summary

| Category | Count |
| ------------------------------------ | ----- |
| shared Stage project mutators | 69 |
| ui-only Stage project mutators | 18 |
| Coverage (shared / project mutators) | **69 / 87 ≈ 79%** |

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
| `updateObjectTransforms` (multi-select) | `directorStore.ts` | `update_object` batch | shared (batches containing camera rigs, composite parents, or object-focused cameras keep the legacy writer) |
| `batchUpdateObjects` / `resetObjectTransforms` | `directorStore.ts` | `update_object` batch | shared (composite-parent transform propagation and object-focused-camera refresh keep the legacy writer) |
| `alignObjects` / `distributeObjects` | `directorStore.ts` | `align_objects` / `distribute_objects` | shared (selections watched by object-focused cameras keep the legacy writer) |
| `isolateObjects` / `showAllObjects` | `directorStore.ts` | `isolate_objects` + `set_object_layer_state` / `show_all_objects` | shared (reveals that include hidden camera objects keep the legacy writer) |
| `setObjectPivot` | `directorStore.ts` | `set_object_pivot` | shared |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround` | `directorStore.ts` | `update_object` (not yet compiled) | ui-only |
| `updateObjectName` | `directorStore.ts` | `update_object` / `update_camera` (camera rigs) | shared (fov-drifted snapshot cameras and characters without a bound asset keep the legacy writer) |
| `updateObjectColor` | `directorStore.ts` | `update_object` | shared (camera rigs and provisioned native Blender objects keep the legacy writer) |
| `updateCrowdLabel` / `updateCrowdColor` | `directorStore.ts` | `update_object` crowd fan-out (not yet compiled) | ui-only |
| `updateObjectMaterial` / `updateObjectMaterialTexture` | `directorStore.ts` | `update_object` material patch | shared (composite parents, camera rigs, and provisioned native Blender objects keep the legacy writer) |
| `setObjectVehicleProfile` | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile` | shared (only unlocked prop and scene objects route; others keep the legacy writer) |
| `updateObjectReferenceBindings` | `directorStore.ts` | `update_object` (`reference_bindings`) | shared (camera rigs and provisioned native Blender objects keep the legacy writer) |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite` | `directorStore.ts` | `group_objects` / `update_object` parent patches | shared (composites containing provisioned native Blender objects keep the legacy writer) |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | no semantic action (object lists are a UI selection helper, not composite groups) | ui-only (intentionally local) |
| `pasteClipboardObjects` | `directorStore.ts` | `add_object` batch (not yet compiled; documented gap) | ui-only |

## Cameras

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `updateCamera` | `directorStore.ts` | `update_camera` (also syncs the linked rig object) | shared (captures/animation patches, rotated or scaled rig transforms, and frustum-depth close-ups keep the legacy writer) |
| `setActiveCamera` | `directorStore.ts` | `set_active_camera` | shared |
| `addCameraShot` | `directorStore.ts` | `add_camera` (not routed) | ui-only (intentionally local: snapshot cameras keep the viewport's exact fov while `add_camera` derives fov from focal length, sequential `cam_N` ids and active-camera optics inheritance are UI conventions, and selection rides in the same commit) |
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
| `updateCharacterBodyType` | `directorStore.ts` | `update_object` (not yet compiled; refreshes focused cameras) | ui-only |
| `updateUniformScale` / `updateCrowdUniformScale` | `directorStore.ts` | `update_object` (not yet compiled) | ui-only |

## Lights

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addLight` | `directorStore.ts` | `add_light` | shared |
| `updateLight` | `directorStore.ts` | `update_light` | shared (light type changes reset type-specific fields and keep the legacy writer) |
| `removeLight` | `directorStore.ts` | `delete_lights` | shared |

## Scene, world, and storyboard

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `updateScene` | `directorStore.ts` | `set_scene` | shared |
| `updateWorldSettings` | `directorStore.ts` | `set_world_settings` | shared |
| `upsertWorldEffect` | `directorStore.ts` | `add_world_effect` / `update_world_effect` (including fire `propagation`) | shared (locked entries, hidden/locked adds, and anchors bound to missing objects keep the legacy writer) |
| `removeWorldEffects` | `directorStore.ts` | `remove_world_effects` | shared |
| `upsertWorldWaterBody` / `removeWorldWaterBodies` | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies` | shared |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups` | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared (adds relying on the default flight band keep the legacy writer) |
| `upsertWorldRoad` / `removeWorldRoads` | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads` | shared |
| `updateStoryboard` | `directorStore.ts` | `set_storyboard` | shared |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation` | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations` | shared |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements` | shared |
| `setObjectLayerState` | `directorStore.ts` | `set_object_layer_state` | shared |
| `moveObjectLayer` | `directorStore.ts` | `reorder_object_layer` | shared |
| `removePanoramaAsset` | `directorStore.ts` | `remove_assets` | shared (dangling panorama references without a catalog entry keep the legacy writer) |

## Timeline audio

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | `set_scene` timeline replace | shared (volume-slider undo batches keep the legacy writer) |

## Assets and creation flows

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addImportedAsset` | `directorStore.ts` | `upsert_asset` | shared for library-only imports (scene-instancing and panorama-binding imports keep the legacy writer: object construction stamps UI conventions authoring does not express) |
| `setAssetRealWorldSize` | `directorStore.ts` | `upsert_asset` | shared (size clears keep the legacy writer so the metric backfill cannot re-estimate the cleared value) |
| `removeImportedAsset` | `directorStore.ts` | `update_object` (detach children) + `remove_assets` cascade | shared |
| `addObjectFromAsset` / `addPresetCharacter` / `addCrowdCharacters` | `directorStore.ts` | `add_object` (not routed) | ui-only (intentionally local: object construction stamps Blender `nativeSource` provisioning markers and rig defaults that `add_object` does not author) |
| `addGeometryPrimitive` | `directorStore.ts` | `add_object` (in-process white-box `geometry_type`) | shared |

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

Canvas and Video already expose typed Agent JSON operations through `director_creative`
(`packages/protocol/src/creativeWorkspaceProtocol.ts`). Their UI stores still patch workspace
snapshots directly and are **not** covered by this Stage inventory; migrating them onto the
creative contract is roadmap M1 batches 1e/1f and remains open.
