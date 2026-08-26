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
  marked _(deliberately local)_ carry a documented divergence reason in the store and are not
  migration candidates; the rest either lack a semantic action or await compilation.
- **human-only-interactive** — intentionally not routed through authoring: per-frame interactive
  feel, DCC projections, runtime measurements, selection, history, and project lifecycle.

## Coverage summary

| Category                             | Count             |
| ------------------------------------ | ----------------- |
| shared Stage project mutators        | 84                |
| ui-only Stage project mutators       | 3                 |
| Coverage (shared / project mutators) | **84 / 87 ≈ 97%** |

Everything still ui-only is deliberately local with a documented divergence
reason in the store (snapshot cameras and preset/crowd character adds).

Parity is regression-tested in
`frontend/director/tests/agent/dispatchDirectorAuthoringActions.test.ts`: the same
`DirectorProject` is mutated once through the store and once through a direct
`applyDirectorAuthoringActions`, and `getDirectorProjectRevision` must match.

## Objects and transforms

| Mutator                                                                                                 | File               | Semantic action(s)                                                                                                   | Status                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteObjects` / `deleteSelectedObject`                                                                | `directorStore.ts` | `update_object` (detach children) + `delete_objects`                                                                 | shared                                                                                                                                                                                                                                                                                                                          |
| `updateObjectTransform`                                                                                 | `directorStore.ts` | `update_object`                                                                                                      | shared (camera rigs, composite parents, and object-focused-camera refresh keep the legacy writer)                                                                                                                                                                                                                               |
| `toggleObjectVisible` / `toggleObjectLocked`                                                            | `directorStore.ts` | `update_object`                                                                                                      | shared (camera rigs keep the legacy writer)                                                                                                                                                                                                                                                                                     |
| `toggleObjectInteraction`                                                                               | `directorStore.ts` | `update_object` (via `updateObjectTransform`)                                                                        | shared                                                                                                                                                                                                                                                                                                                          |
| `setObjectAnimation`                                                                                    | `directorStore.ts` | `set_animation`                                                                                                      | shared                                                                                                                                                                                                                                                                                                                          |
| `updateObjectTransforms` (multi-select)                                                                 | `directorStore.ts` | `update_object` batch                                                                                                | shared (batches containing camera rigs, composite parents, or object-focused-camera targets keep the legacy writer wholesale)                                                                                                                                                                                                   |
| `batchUpdateObjects` / `resetObjectTransforms`                                                          | `directorStore.ts` | `update_object` batch                                                                                                | shared (composite-parent transform propagation, object-focused-camera refresh, and color/material/layer patches on provisioned native Blender objects keep the legacy writer)                                                                                                                                                   |
| `alignObjects` / `distributeObjects`                                                                    | `directorStore.ts` | `align_objects` / `distribute_objects`                                                                               | shared (object-focused-camera targets keep the legacy writer)                                                                                                                                                                                                                                                                   |
| `isolateObjects` / `showAllObjects`                                                                     | `directorStore.ts` | `isolate_objects` + `set_object_layer_state` / `show_all_objects`                                                    | shared (show-all with a hidden camera rig keeps the legacy reveal)                                                                                                                                                                                                                                                              |
| `setObjectPivot`                                                                                        | `directorStore.ts` | `set_object_pivot`                                                                                                   | shared                                                                                                                                                                                                                                                                                                                          |
| `dropObjectToGround` / `updateCrowdTransform` / `dropCrowdToGround`                                     | `directorStore.ts` | `update_object` transform / `placement_mode` patches (crowds fan out per member)                                     | shared (composite parents, object-focused cameras, and grounded drops on provisioned native Blender objects keep the legacy writer)                                                                                                                                                                                             |
| `updateObjectName` / `updateCrowdLabel`                                                                 | `directorStore.ts` | `update_object` `name` / `crowd_label`; camera rigs rename through `update_camera`                                   | shared (unstable-fov snapshot cameras, asset-less character renames, and mid-typing whitespace crowd labels keep the legacy writer)                                                                                                                                                                                             |
| `updateObjectColor` / `updateCrowdColor`                                                                | `directorStore.ts` | `update_object` `color` (crowds fan out per member)                                                                  | shared (camera rigs and provisioned native Blender objects/members keep the legacy writer)                                                                                                                                                                                                                                      |
| `updateObjectMaterial` / `updateObjectMaterialTexture`                                                  | `directorStore.ts` | `update_object` material patch, pre-merged to match the store's partial-merge semantics                              | shared (composite parents, camera rigs, and provisioned native Blender objects keep the legacy writer)                                                                                                                                                                                                                          |
| `setObjectVehicleProfile`                                                                               | `directorStore.ts` | `set_vehicle_profile` / `clear_vehicle_profile`                                                                      | shared (only unlocked prop/scene objects are authorable; others keep the legacy writer)                                                                                                                                                                                                                                         |
| `updateObjectReferenceBindings`                                                                         | `directorStore.ts` | `update_object` `reference_bindings`                                                                                 | shared (camera rigs and provisioned native Blender objects keep the legacy writer)                                                                                                                                                                                                                                              |
| `createCompositeObject` / `addObjectsToComposite` / `removeObjectsFromComposite`                        | `directorStore.ts` | `group_objects` / `update_object` `parent_id` patches                                                                | shared (provisioned native Blender children keep the legacy writer)                                                                                                                                                                                                                                                             |
| `createObjectList` / `addObjectsToObjectList` / `removeObjectsFromObjectList` / `updateObjectListLabel` | `directorStore.ts` | `create_object_list` / `add_objects_to_object_list` / `remove_objects_from_object_lists` / `rename_object_list`      | shared (the compiled create allocates the same sequential `object_list_N` id and non-crowd membership the legacy writer computes; blank labels, unknown lists, and empty live membership keep the legacy no-op)                                                                                                                 |
| `pasteClipboardObjects`                                                                                 | `directorStore.ts` | `duplicate_objects` (one action per paste; ids, names, offsets, and crowd remaps allocate identically on both paths) | shared (stale clipboard snapshots that no longer match the live objects, camera objects without a linked shot, Blender-native objects without a model asset, and pastes an object-focused camera participates in — as copied source, focus target of a copied source, or with a drifted stored target — keep the legacy writer) |

## Cameras

| Mutator              | File               | Semantic action(s)                                                                                                                                                                                                  | Status                                                                                                                    |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `updateCamera`       | `directorStore.ts` | `update_camera` (also syncs the linked rig object)                                                                                                                                                                  | shared (captures/animation patches, rotated or scaled rig transforms, and frustum-depth close-ups keep the legacy writer) |
| `setActiveCamera`    | `directorStore.ts` | `set_active_camera`                                                                                                                                                                                                 | shared                                                                                                                    |
| `addCameraShot`      | `directorStore.ts` | `add_camera` diverges: snapshot cameras keep the viewport's exact fov while `add_camera` derives fov from focal length, and sequential `cam_N` ids plus active-camera optics inheritance are not authoring concepts | ui-only (deliberately local)                                                                                              |
| `setCameraAnimation` | `directorStore.ts` | `set_animation`                                                                                                                                                                                                     | shared                                                                                                                    |
| `addCameraCaptures`  | `directorStore.ts` | `add_camera_captures`                                                                                                                                                                                               | shared                                                                                                                    |

## Characters

| Mutator                                                      | File               | Semantic action(s)                                          | Status                                                                                     |
| ------------------------------------------------------------ | ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `applyPosePreset` / `applyCrowdPosePreset`                   | `directorStore.ts` | `update_object` (`pose_preset_id`)                          | shared                                                                                     |
| `updatePoseControl` / `updateCrowdPoseControl`               | `directorStore.ts` | `set_character_pose_controls`                               | shared                                                                                     |
| `setCharacterMotion` / `setCrowdCharacterMotion`             | `directorStore.ts` | `set_character_motion` / `clear_character_motion`           | shared (migration-only `authored` root motion keeps the legacy writer)                     |
| `setCharacterIkEffector` / `setCrowdCharacterIkEffector`     | `directorStore.ts` | `set_character_ik`                                          | shared                                                                                     |
| `clearCharacterIkEffector` / `clearCrowdCharacterIkEffector` | `directorStore.ts` | `clear_character_ik`                                        | shared                                                                                     |
| `updateCharacterBodyType`                                    | `directorStore.ts` | `update_object` `body_type`                                 | shared (object-focused cameras keep the legacy writer for the UI focus-height refresh)     |
| `updateUniformScale` / `updateCrowdUniformScale`             | `directorStore.ts` | `update_object` transform scale (crowds fan out per member) | shared (camera rigs, composite parents, and object-focused cameras keep the legacy writer) |

## Lights

| Mutator       | File               | Semantic action(s) | Status                                                                            |
| ------------- | ------------------ | ------------------ | --------------------------------------------------------------------------------- |
| `addLight`    | `directorStore.ts` | `add_light`        | shared                                                                            |
| `updateLight` | `directorStore.ts` | `update_light`     | shared (light type changes reset type-specific fields and keep the legacy writer) |
| `removeLight` | `directorStore.ts` | `delete_lights`    | shared                                                                            |

## Scene, world, and storyboard

| Mutator                                                                     | File               | Semantic action(s)                                                                          | Status                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `updateScene`                                                               | `directorStore.ts` | `set_scene`                                                                                 | shared (patches with keys `set_scene` cannot express keep the legacy writer)                                                                                                         |
| `updateWorldSettings`                                                       | `directorStore.ts` | `set_world_settings`                                                                        | shared                                                                                                                                                                               |
| `upsertWorldEffect`                                                         | `directorStore.ts` | `add_world_effect` / `update_world_effect`                                                  | shared (locked entries and non-default add flags keep the legacy writer)                                                                                                             |
| `removeWorldEffects`                                                        | `directorStore.ts` | `remove_world_effects`                                                                      | shared                                                                                                                                                                               |
| `upsertWorldWaterBody` / `removeWorldWaterBodies`                           | `directorStore.ts` | `add_world_water_body` / `update_world_water_body` / `remove_world_water_bodies`            | shared                                                                                                                                                                               |
| `upsertWorldWildlifeGroup` / `removeWorldWildlifeGroups`                    | `directorStore.ts` | `add_world_wildlife_group` / `update_world_wildlife_group` / `remove_world_wildlife_groups` | shared (adds relying on the default flight band keep the legacy writer)                                                                                                              |
| `upsertWorldRoad` / `removeWorldRoads`                                      | `directorStore.ts` | `add_world_road` / `update_world_road` / `remove_world_roads`                               | shared                                                                                                                                                                               |
| `updateStoryboard`                                                          | `directorStore.ts` | `set_storyboard`                                                                            | shared                                                                                                                                                                               |
| `addSceneAnnotation` / `updateSceneAnnotation` / `removeSceneAnnotation`    | `directorStore.ts` | `add_annotation` / `update_annotation` / `remove_annotations`                               | shared                                                                                                                                                                               |
| `addSceneMeasurement` / `updateSceneMeasurement` / `removeSceneMeasurement` | `directorStore.ts` | `add_measurement` / `update_measurement` / `remove_measurements`                            | shared                                                                                                                                                                               |
| `setObjectLayerState`                                                       | `directorStore.ts` | `set_object_layer_state`                                                                    | shared (no-op state writes are skipped to keep the undo stack clean)                                                                                                                 |
| `moveObjectLayer`                                                           | `directorStore.ts` | `reorder_object_layer`                                                                      | shared                                                                                                                                                                               |
| `removePanoramaAsset`                                                       | `directorStore.ts` | `remove_assets` (clears `panoramaAssetId` when the panorama asset id is removed)            | shared (when characters still need the default Mixamo asset but it is missing from `assets`, migrate would rehydrate it — keep the legacy writer that only drops the panorama entry) |

## Timeline audio

| Mutator                                                                                                                                 | File               | Semantic action(s)                                                                                                          | Status |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `addTimelineAudioClip` / `updateTimelineAudioClip` / `moveTimelineAudioClip` / `removeTimelineAudioClip` / `setTimelineAudioTrackMuted` | `directorStore.ts` | `add_timeline_audio_clip` / `update_timeline_audio_clip` / `remove_timeline_audio_clips` / `set_timeline_audio_track_muted` | shared |

## Assets and creation flows

| Mutator                                     | File               | Semantic action(s)                                                                                                                                                  | Status                                                                                                                                                                                           |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addImportedAsset`                          | `directorStore.ts` | `upsert_asset`; panoramas also `set_panorama_asset`; model scene placement also `add_object` (characters pass `placement_mode` / `body_type` / `color`)             | shared (catalog-only, panorama, and model placement including Mixamo characters; authoring rejection falls through to the legacy writer)                                                         |
| `setAssetRealWorldSize`                     | `directorStore.ts` | `upsert_asset` with the patched `realWorldSizeM` / `sizeSource`                                                                                                     | shared (clearing to `null` keeps the legacy writer so migrate's estimated 2 m backfill does not refill the Prop inspector)                                                                       |
| `removeImportedAsset`                       | `directorStore.ts` | `remove_assets` with `cascade`                                                                                                                                      | shared (removals whose cascade would also delete children, clear look targets, camera follow/path bindings, or material texture references keep the legacy writer, which leaves those untouched) |
| `addObjectFromAsset`                        | `directorStore.ts` | `add_object` (characters also pass `placement_mode` / `body_type` / `color`; `nativeSource` stamped when `asset_id` is set)                                         | shared                                                                                                                                                                                           |
| `addPresetCharacter` / `addCrowdCharacters` | `directorStore.ts` | `add_object` diverges: preset adds keep per-add body types and a rotating color palette, and crowd grouping (`crowdId`) is UI-only state `add_object` cannot author | ui-only (deliberately local)                                                                                                                                                                     |
| `addGeometryPrimitive`                      | `directorStore.ts` | `add_object` with `geometry_type` (accepted in-process; only the public workbench agent wire rejects it)                                                            | shared                                                                                                                                                                                           |

## Human-only interactive surfaces

These stay direct writers on purpose; forcing them through authoring on every frame would break
interactive feel or conflate DCC/runtime projections with user authoring intents.

| Mutator                                                                                                                 | File               | Reason                                                                         | Status                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ | ---------------------- |
| `beginUndoBatch` / `endUndoBatch` + in-batch fallbacks of every shared mutator                                          | `directorStore.ts` | TransformControls / slider RAF batches; pointer-up lands in one undo entry     | human-only-interactive |
| Viewport navigation and pilot feel (`setViewMode`, `setTransformMode`, `setViewport*`, `resetViewportNavigation`)       | `directorStore.ts` | `commitUiPatch` UI state; no project write                                     | human-only-interactive |
| Selection and inspector (`selectObject`, `selectObjects`, `selectCrowd`, `toggleObjectSelection`, `openSceneInspector`) | `directorStore.ts` | UI state; no project write                                                     | human-only-interactive |
| `syncBlenderScene` / `prepareBlenderSync` / `ensureNativeSceneBinding`                                                  | `directorStore.ts` | DCC projection of the authoritative Blender scene, not user authoring          | human-only-interactive |
| `setObjectMeasuredLocalBounds`                                                                                          | `directorStore.ts` | runtime geometry measurement, `trackUndo: false`                               | human-only-interactive |
| `copySelectedObjects`                                                                                                   | `directorStore.ts` | clipboard UI state only (paste is the project write)                           | human-only-interactive |
| `undo` / `redo`                                                                                                         | `directorStore.ts` | history replay of full snapshots                                               | human-only-interactive |
| `replaceProject` / `applyAuthoredProject` / `openScopedScene` / `saveLatestSnapshot` / `restoreLatestSnapshot`          | `directorStore.ts` | project lifecycle and persistence, including the shared dispatch landing point | human-only-interactive |

## Canvas / Video

Canvas and Video expose typed Agent JSON operations through `director_creative`
(`packages/protocol/src/creativeWorkspaceProtocol.ts`). One-shot UI mutations now route through
`dispatchCreativeWorkspaceOperations`
(`frontend/director/src/agent/dispatchCreativeWorkspaceOperations.ts`), the same executor the
Agent envelope uses, so both fill the snapshot-fingerprint guard and an idempotency key and
produce the same revision (roadmap M1 batches 1e/1f). Parity is regression-tested in
`frontend/director/tests/agent/dispatchCreativeWorkspaceOperations.test.ts`.

Shared today:

- Canvas node/edge/layout/z-order/section/viewport authoring (`canvas.node.*` including
  `canvas.node.bring_to_front` / `canvas.node.assign_section`, `canvas.section.*`,
  `canvas.board.set_viewport` / `canvas.board.fit_content`, `canvas.edge.*`,
  `canvas.dag.layout`), media import cataloging (`gallery.media.update`), and the undo/redo
  buttons (`workspace.undo` / `workspace.redo`). Observe exposes `board.sections`,
  `node.section_id`, and `board.viewport`.
- Video clip inspector edits, split, remove (including ripple), cross dissolve, discrete
  keyboard fade steps, the "+" placement into the first free slot (`edit.clip.add`), track
  management, settings, import cataloging, and undo/redo (buttons and shortcuts).
- The Canvas-to-timeline bridge (`edit.clip.add` + `workspace.switch`), Stage capture import as
  one atomic `execute_batch` (catalog + node add roll back together), and media review
  rating/tag upserts (`gallery.media.update`, with a direct-store fallback only when the
  contract does not know the media id).
- Offline media recovery from Canvas/Video file pickers through
  `dispatchCreativeWorkspaceMediaRelink` → `executeCreativeWorkspaceMediaRelinkFile` (same body
  Agents reach after resolving a `media.relink` wire source to a `File`).
- Video Editor proxy file picks: import the candidate, then `media.proxy.attach` through
  `dispatchCreativeWorkspaceOperations` (same linker Agents use on two cataloged ids).
- Explicit Video overwrite placement: media drops, keyboard frame nudges, and duplicate-after
  share `edit.clip.add` / `edit.clip.update` with `overwrite: true` (and optional `in_sec` /
  `opacity` / `volume` on add so duplicate-after keeps the full clip look). Both paths run the
  same `resolveDirectorTrackOverwrite` resolver via `commitClipPlacement`.
- Media-less text/caption clips: `edit.clip.add` accepts virtual `text:` / `text:caption:…`
  media ids without a Gallery asset (video tracks only). The Video Editor "标题文字" button and
  caption/SRT import / transcription promote dispatch the same ops Agents use; caption display
  names are capped at the shared 200-char clip name limit.
- Clip rename from the inspector "名称" field: every contract-expressible keystroke dispatches
  `edit.clip.update` with a `name` patch (the same patch Agents send), so a locked track
  surfaces a rejection instead of the store's silent no-op. Because a title/caption clip
  renders its name as the overlay text, editing that text shares the same op, and the input
  enforces the shared 200-char clip name cap. Mirroring the Stage mid-typing whitespace
  policy, states the schema would reject or rewrite — an emptied field, leading/trailing
  whitespace, or an over-cap programmatic value — keep the legacy writer.
- Fountain script import ("导入剧本"): the Canvas modal dispatches
  `canvas.script.apply_plan`, the same executor Agents call. The receipt reports
  `storyboard_shots`, `nodes_added`, the new `sections`, `replaced_section_ids`, and typed
  `omitted[]` (`board_capacity` for shots dropped at the 240-node cap, plus the Fountain
  importer's `character_dialogue` / `boneyard_note` / … codes) so neither surface overclaims;
  a full board rejects with `capacity` before any mutation, and one undo entry restores the
  replaced section list.

Still direct, with reasons:

- Continuous interactions — node drags, clip drags/trims, fade drags, range sliders, and
  mid-typing clip-name states the contract cannot express (emptied, whitespace-edged, or
  over-cap values) — keep locally batched history (`beginHistoryBatch`/`endHistoryBatch`) or
  the direct writer, matching the Stage slider/gizmo policy. Clip drag/trim still resolve
  overwrite locally via `commitClipPlacement` at pointer-up (discrete
  nudges/duplicate-after/explicit drops are shared above). Continuous Canvas pointer
  pan/wheel stay local.
- Canvas board viewport discrete writes — `canvas.board.set_viewport` and
  `canvas.board.fit_content` (toolbar/post-layout fit) share the agent contract; continuous
  pan/wheel remain local. Zoom clamps to `[0.1, 2.5]`; fit defaults to a 1280×800 surface
  when no live DOM measure is available.
- Canvas pipeline result cataloging, legacy review-mirror migration, and bulk review clearing —
  multi-store or migration bookkeeping flows.
