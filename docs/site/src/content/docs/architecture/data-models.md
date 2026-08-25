---
title: Data Models
description: Learn how DirectorProject, StageScene, production records, and Agent records relate.
---

## DirectorProject version 1

`DirectorProject` is the complete editor model:

```ts
interface DirectorProject {
  version: 1;
  nativeScene?: DirectorNativeScene;
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
  storyboard?: DirectorStoryboard;
  production?: DirectorProduction;
  activeCameraId: string | null;
  panoramaAssetId: string | null;
}
```

It owns editor scene settings, assets, hierarchy, characters, cameras, animation, storyboard,
and active references. The optional production projection preserves compatibility with older
version 1 documents while separating reusable performance from camera coverage:

```ts
interface DirectorProduction {
  version: 1;
  takes: DirectorPerformanceTake[];
  sequences: DirectorCoverageSequence[];
  activeTakeId: string | null;
  activeSequenceId: string | null;
}
```

A `DirectorPerformanceTake` owns entity animation tracks. Several `DirectorCoverageShot`
records can reference the same take while selecting different cameras, optics, and frame
ranges. `evaluateDirectorProductionAtFrame` is the pure evaluator for this relationship; it
never mutates the editable project.

## Product boundary

Director is the production desk around Blender, not a browser replacement for Blender.

| Continue to develop in Director                                     | Keep in Blender; do not duplicate in Director                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Shot identity, cameras, blocking, character direction, and timeline | Mesh topology, Boolean/extrude tools, modifiers, Geometry Nodes      |
| Agent planning, semantic object IDs, review, audit, and approvals   | Native material graphs, UV authoring, armature internals, simulation |
| Clean frames, white model, masks, depth, metadata, and delivery     | General-purpose Edit Mode and the complete Blender operator surface  |

Director may expose narrow Blender controls when they complete a production workflow, such as
provisioning an asset, invoking one typed refinement transaction, or inspecting the result. It
must not grow another general-purpose modeling application. Existing native modeling panels are
an integration surface and are frozen unless a change is required by a directing or delivery
workflow.

## Native Blender binding

Blender integration extends `DirectorProject`; it does not introduce a second project model
or a larger replacement asset class:

```ts
interface DirectorNativeScene {
  engine: "blender";
  projectId: string;
  sceneEpoch?: string;
  revision?: number;
  contentRevision?: number;
}

interface DirectorNativeObjectSource {
  engine: "blender";
  objectId: string;
  provisioned?: boolean;
}

interface DirectorLocalBounds {
  min: [number, number, number];
  max: [number, number, number];
}
```

`nativeScene.projectId` binds one Director project to one live native scene. Each native root has
one Director object projection whose `nativeSource.objectId` preserves identity across the scene
tree, viewport, inspector, and native transaction API. A mismatched project ID is ignored instead
of attaching another live scene to the current project. Automatic binding and synchronization
writes are allowed only from the visible, focused Director document; background tabs consume
snapshots without becoming a second writer.

The last synchronized native scene epoch and revisions are stored on this binding. They advance the
ordinary `DirectorProject` revision even when a Blender material or topology edit does not change a
root transform, so Agent guards, review evidence, and delivery receipts cannot silently refer to
pre-refinement project state. Snapshot synchronization updates these fields without creating an
extra undo entry for polling. A native Blender edit is recorded in the same chronological undo
history as Director edits; replaying it delegates to Blender's native undo transaction. A Director
edit projected into Blender is marked as the same intent and is therefore not recorded twice.

| Layer                 | Owned state                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `DirectorProject`     | Production identity, root projection, character Action/Pose/IK semantics, cameras, timeline, and shots |
| Blender native scene  | Child hierarchy, mesh topology, Edit Mode, modifiers, materials, UVs, armatures, actions, and NLA      |
| Live runtime snapshot | Scene epoch, revision, frame, selection, cameras/lights, rig compatibility, and native state evidence  |

Director transform, rename, visibility, delete, and model-placement edits are translated into one
revision-checked native transaction. The resulting Blender snapshot is read back into the
same Director object projection without adding an undo entry for polling. Direct Blender edits read
their transform, visibility, name, evaluated bounds, and native revisions back into that projection;
Director-authored projections remain Director-authoritative. Selection of a native child resolves
to its Director root, while the Blender Mesh and Rig inspectors retain access to the selected child
data.

`provisioned: false` means a Director model instance is waiting to be imported as its native root;
`provisioned: true` means that root exists in the bound Blender scene. The transient runtime
snapshot is shared by Stage and the inspectors and is never persisted as another editable scene.

`DirectorAssetRef.localBoundsM` stores reusable catalog measurements and
`DirectorObject.localBoundsM` stores a Blender- or renderer-measured override. Both are in metres,
in the object's local space before its Director transform. Spatial query, placement, collision,
and audit use the same bounds. Unknown imported geometry remains spatially unknown; a scalar
`realWorldSizeM` never becomes a fabricated cube. Loading the model in Director or provisioning
it in Blender measures the geometry and writes the bounds back to the same object projection.

For a compatible native character, the adapter projects canonical Director Action/Pose state onto
the Blender armature with typed operations. Each character Action owns an independent
`Director Motion` NLA track, while one shared scene frame follows the Director playhead. The
armature stores a Director state marker so the same semantic state is not reapplied after polling
or preview export. Native mesh and rig details remain capabilities of the same object; they are not
promoted into another asset superclass or a parallel project. IK stays canonical in
`DirectorProject` but is capability-gated until a native solver adapter is available.

## StageScene version 5

`StageScene` is the compact Agent/legacy model:

```ts
{
  v: 5,
  objects: Record<string, StageObject>,
  show: {
    name: string,
    tracks: StageTrack[]
  },
  recordAspect: "16:9" | "9:16" | "1:1" | "4:3" | "1.85:1" | "2.39:1"
}
```

Use it for portable white-box operations. The adapter in
`frontend/director/src/agent/directorStageAdapter.ts` validates both sides of the conversion.

## Creative workspace version 2

Canvas and Video Editor use a scene-scoped creative workspace:

```ts
interface DirectorCreativeWorkspace {
  boardNodes: DirectorBoardNode[];
  boardEdges: DirectorBoardEdge[];
  editTracks: DirectorEditTrack[];
  editSettings: DirectorEditSettings;
}
```

Media bytes are stored separately in the persistent media library and referenced by stable IDs.
The Agent projection adds a deterministic `snapshot_fingerprint`, normalized field names, exact
counts, media readiness, and safety limits. It is a concurrency view of the same live browser store,
not a second editable model.

An `execute_batch` captures one pre-intent history snapshot. Success creates one undo unit; failure
restores the graph, timeline, settings, and selection. Snapshot fingerprints prevent a mutation
prepared from an old observation from overwriting newer human or Agent work.

## ProductionRecord

The production record stores:

- production ID and revision;
- title and active scene;
- named scene references with source revisions;
- editorial shots with linked or pinned source behavior;
- update actor and timestamp.

Production mutations use an expected revision to prevent silent concurrent overwrite.

The server stores every referenced scene as a separate `ProductionSceneProjectRecord` containing
the validated `DirectorProject`, its scene-local revision, update actor, and timestamp. Manifest
revision and scene-document revision deliberately advance independently: renaming or activating a
scene does not manufacture a content change, while editing scene content does not create a manifest
conflict. Create, duplicate, replacement, and delete commit the manifest and affected documents in
one temporary-file-plus-rename transaction.

## Agent plan

Legacy assistant planning returns a validated list of tool operations plus summary,
verification, and suggested next step. Plans expire and are bound to the scene signature that
was observed when they were created.

The newer Agent workbench uses durable sessions and direct structured tool execution.

## Graph integrity

Schema validity does not prove cross-entity integrity. Director also checks:

- object parent and child references;
- camera rig and target references;
- asset bindings;
- active camera and panorama IDs;
- timeline target IDs;
- storyboard camera IDs and frame ranges.

Invalid graphs are rejected before replacing live project state.

## Migration

Persisted project data is parsed before migration. Backward-compatible optional fields are
normalized to the current `DirectorProject` representation, then validated again before use.
