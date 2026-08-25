---
title: UI/Agent parity inventory — Stage DirectorStore
description: Inventory of Stage DirectorStore project mutators and whether each shares the Agent authoring dispatch path.
---

This is the Milestone 0 inventory from the
[Agent-Native Roadmap](/engineering/agent_native_roadmap/): every mutating action on the Stage
`DirectorStore` (`frontend/director/src/comprehensive/editor/store/directorStore.ts`, referred to
as `directorStore.ts` below), what semantic authoring action it maps to, and whether the UI and
the Agent already produce the same project revision through one executor.

Last verified: **2026-08-25**.

## Status legend

- **shared** — one-shot UI calls route through `dispatchDirectorAuthoringActions`
  (`frontend/director/src/agent/dispatchDirectorAuthoringActions.ts`), which calls the same
  `applyDirectorAuthoringActions` the Agent uses, so both produce the same revision. Compile
  helpers live in `frontend/director/src/agent/compileDirectorUiAuthoringActions.ts`. All shared
  mutators fall back to the legacy direct writer inside slider/gizmo undo batches
  (`undoBatchDepth > 0`) and for the specific inexpressible patches noted per row.
- **ui-only** — still writes the project through `commitMutation` / `withProjectPatch` only. The
  Agent has no guarantee of an identical revision for the same intent yet.
- **human-only-interactive** — intentionally not routed through authoring: per-frame interactive
  feel, DCC projections, runtime measurements, selection, history, and project lifecycle.

## Coverage summary

| Category | Count |
| ------------------------------------ | ----- |
| shared Stage project mutators | 35 |
| ui-only Stage project mutators | 52 |
| Coverage (shared / project mutators) | **35 / 87 ≈ 40%** |

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
| `updateObjectTransforms` (multi-select) | `directorStore.ts` | `update_object` batch (not yet compiled) | ui-only |
| `batchUpdateObjects` / `resetObjectTransforms` | `directorStore.ts` | `update_object` batch (not yet compiled) | ui-only |
| `alignObjects` / `distributeObjects` | `directorStore.ts` | `align_objects` / `update_object` batch (not yet compiled) | ui-only |
| `isolateObjects` / `showAllObjects` | `directorStore.ts` | `update_object` batch (not yet compiled) | ui-only |
| `setObjectPivot` | `directorStore.ts` | `set_object_pivot` (not yet compiled) | ui-only |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround` | `directorStore.ts` | `update_object` (not yet compiled) | ui-only |
| `updateObjectName` / `updateCrowdLabel` | `directorStore.ts` | `update_object` (not yet compiled) | ui-only |
| `updateObjectColor` / `updateCrowdColor` | `directorStore.ts` | `update_object` (not yet compiled) | ui-only |
| `updateObjectMaterial` / `updateObjectMaterialTexture` | `directorStore.ts` | `update_object` material patch (not yet compiled) | ui-only |
| `setObjectVehicleProfile` | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile` (not yet compiled) | ui-only |
| `updateObjectReferenceBindings` | `directorStore.ts` | no semantic action yet | ui-only |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite` | `directorStore.ts` | `group_objects` / `ungroup_objects` (not yet compiled) | ui-only |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | no semantic action yet | ui-only |
| `pasteClipboardObjects` | `directorStore.ts` | `add_object` batch (not yet compiled; documented gap) | ui-only |

## Cameras

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `updateCamera` | `directorStore.ts` | `update_camera` (also syncs the linked rig object) | shared (captures/animation patches, rotated or scaled rig transforms, and frustum-depth close-ups keep the legacy writer) |
| `setActiveCamera` | `directorStore.ts` | `set_active_camera` | shared |
| `addCameraShot` | `directorStore.ts` | `add_camera` | shared |
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
| `upsertWorldEffect` | `directorStore.ts` | `add_world_effect` / `update_world_effect` | shared (locked entries and non-default add flags keep the legacy writer) |
| `removeWorldEffects` | `directorStore.ts` | `remove_world_effects` | shared |
| `upsertWorldWaterBody` / `removeWorldWaterBodies` | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies` | shared |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups` | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared (adds relying on the default flight band keep the legacy writer) |
| `upsertWorldRoad` / `removeWorldRoads` | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads` | shared |
| `updateStoryboard` | `directorStore.ts` | `set_storyboard` | shared |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation` | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations` (not yet compiled) | ui-only |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements` (not yet compiled) | ui-only |
| `setObjectLayerState` | `directorStore.ts` | `set_object_layer_state` (not yet compiled) | ui-only |
| `moveObjectLayer` | `directorStore.ts` | `set_scene` layer-order patch (not yet compiled) | ui-only |
| `removePanoramaAsset` | `directorStore.ts` | no semantic action yet | ui-only |

## Timeline audio

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | no semantic actions yet (timeline audio) | ui-only |

## Assets and creation flows

| Mutator | File | Semantic action(s) | Status |
| --- | --- | --- | --- |
| `addImportedAsset` / `setAssetRealWorldSize` | `directorStore.ts` | no semantic action yet (asset catalog writes) | ui-only |
| `removeImportedAsset` | `directorStore.ts` | `remove_assets` (not yet compiled) | ui-only |
| `addObjectFromAsset` / `addPresetCharacter` / `addCrowdCharacters` / `addGeometryPrimitive` | `directorStore.ts` | `add_object` (not yet compiled; UI id/name/placement conventions) | ui-only |

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
