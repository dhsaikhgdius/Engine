---
title: CoStage Capability Audit and Native Integration
description: A capability-by-capability audit of cs68614-hash/costage, its licensing boundary, and Director's native integration decisions.
---

Audit date: 2026-08-02  
Upstream repository: <https://github.com/cs68614-hash/costage>  
Locked revision: `fa1b7fa0b40d6f71c2700ed503613dea088b6f70`  
Revision subject: `Add action-stage timeline synchronization`

## Conclusion

CoStage is a small, well-scoped Codex MCP App. It embeds a Three.js directing stage as a
native widget and lets an Agent modify the scene through semantic MCP operations and
filmmaking knowledge skills. Director already covers and exceeds most of its 3D, camera,
character, timeline, and Agent capabilities. The capability worth absorbing in this pass is
composable spatial-relation semantics—not another widget, scene model, or snapshot timeline.

Director now provides these operations natively:

- `place_relative` places an object relative to world, target-local, or camera-screen coordinates;
- `arrange_group` creates line, grid, circle, and arc formations with deterministic orientation;
- `arrange_facing_pair` atomically sets two actors' spacing, positions, and mutual orientation;
- `orient_toward` faces an object toward another real object or a world-space point;
- shared rotated bounds determine default relative distances and formation spacing, while
  `clearance_m` expresses visible edge-to-edge clearance;
- the same Zod contracts and project model provide lock protection, revision guards,
  idempotency, Undo, audit, and the `deliver` evidence loop.

## License and reuse boundary

The locked revision has no root `LICENSE` file, and its `package.json` declares no license.
This audit therefore uses CoStage only as a behavioral reference and implements the selected
behavior independently. It does not copy, translate, or adapt CoStage source, skill chapters,
models, or other assets. Director's reference reuse ledger records this decision.

## Complete capability scope

| CoStage capability                                             | Upstream evidence                                          | Director status                                                                               | Native decision                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex-native full-screen and inline widget                     | `mcp/server.mjs`, `mcp/lib/widget-resource.mjs`            | Director uses a complete browser application plus a portable MCP plugin                       | Do not copy a second UI. Keep the browser as the single visual truth and bind MCP to an exact target.                                            |
| Inlined static widget build and CSP handling                   | `mcp/lib/static-widget.mjs`                                | The Vite application and bundled MCP server build separately                                  | Do not adopt it; avoid inlining a large editor into every tool result.                                                                           |
| Thread- and project-level `stageDir` storage                   | `mcp/lib/stage-storage.mjs`                                | Project scenes, production manifest, browser persistence, and Agent-session persistence       | Semantics are covered; do not add a third storage protocol.                                                                                      |
| Revision reads and stale whole-document saves                  | `get_director_stage_revision`, `save_director_stage_state` | SHA-256 project revisions, exact browser leases, idempotency, and unknown-outcome recovery    | Director is stricter; retain its existing protocol.                                                                                              |
| SSE scene and selection synchronization                        | `mcp/lib/stage-events.mjs`                                 | Gateway WebSocket, page-state bridge, and Yjs collaboration                                   | Covered and exceeded.                                                                                                                            |
| Create, switch, rename, duplicate, and delete scenes           | Scene actions in `applyStageOperations`                    | Production manifest, ProductionPanel, host scene switch, and Workbench Agent                  | Integrated natively with one revision/idempotency contract; duplication writes to an independent project scope.                                  |
| Character, prop, camera, and environment hierarchy             | `frontend/director/src/App.tsx`                            | Grouped object tree, assets, characters, composites, cameras, and scene panels                | Covered and exceeded.                                                                                                                            |
| Eight bundled GLB characters and IndexedDB cache               | `public/assets/3d-characters`, `directorStageClient.ts`    | Mixamo/XBot catalog, rig and geometry hashes, previews, motion catalog, and local asset cache | Covered and exceeded; do not copy the upstream GLBs.                                                                                             |
| Adaptive insertion near the current shot                       | `adaptiveScenePlacement`                                   | Catalog authoring payload, grounding, shared bounds, and camera framing                       | Spatial clearance is native; future work should improve frustum and detailed-mesh acceptance only.                                               |
| Translate/rotate/scale gizmos and visual centers               | `EditableObject`, `TransformControls`                      | Director gizmos, visual centers, composite parents, lasso, and four-view layout               | Covered and exceeded.                                                                                                                            |
| Lock, duplicate, delete, and select                            | Scene-tree handlers and selection MCP                      | UI/MCP authoring, lock ownership, explicit force override, and Undo                           | Covered and exceeded.                                                                                                                            |
| Static 25-field pose and joint markers                         | `Pose`, `applyCharacterPose`, `PoseSkeletonOverlay`        | Mixamo skeletal motion, semantic pose controls, hand/foot IK, retargeting, and root motion    | Exceeded; do not regress to a static 25-field copy.                                                                                              |
| Pose presets                                                   | `characterAssets` and pose UI                              | Pose presets, semantic controls, and motion catalog                                           | Covered and exceeded.                                                                                                                            |
| Multiple cameras with position, target, FOV, and aspect        | `CameraPlan`, `CameraPanel`                                | Focal length, sensor gate, aperture, focus, shutter, ISO, crop, anamorphic squeeze, and shake | Exceeded; retain the physical camera model.                                                                                                      |
| Camera PIP, clean camera view, and screenshots                 | `CameraMarker`, `CameraFrame3D`, clean render              | Movable PIP, clean capture, revision-bound render passes, and Shot Package                    | Exceeded.                                                                                                                                        |
| 2:1 panorama upload, validation, and hashed storage            | Panorama tools and `panorama-assets.mjs`                   | Equirectangular/backdrop import, seam and pole handling, and asset model                      | Covered; server-side content-addressed binary storage can still be strengthened.                                                                 |
| Panorama rotation, horizon, and light intensity                | `EnvironmentState`                                         | Yaw/radius plus background and ground display                                                 | Partially covered; pitch and panorama-based lighting are separate rendering improvements and should not be coupled to a spatial-semantics patch. |
| Static scene snapshots for timeline shots                      | `TimelineShot.sceneSnapshot`                               | Frame-native transform, pose, and camera animation plus storyboard, takes, and coverage       | Director exceeds this model; do not add a second snapshot timeline.                                                                              |
| Synchronized refresh between action stage and multiple cameras | `createTimelineShot`, `refreshTimelineShot`                | PerformanceTake plus CoverageSequence/Shot reuse one performance                              | Director's non-destructive take/coverage model is stronger and remains the sole production truth.                                                |
| Shot ordering, rename, duration, deletion, and playback        | `updateTimeline`, `TimelinePanel`                          | Stage timeline, storyboard, coverage, and Video Editor                                        | Covered and exceeded.                                                                                                                            |
| Semantic scene CRUD                                            | `apply_director_stage_operations`                          | The `production` operation in `director_workbench`                                            | Integrated natively with server-side atomic validation, conflict codes, idempotent replay, and browser-confirmed switching.                      |
| Relative placement                                             | `place_relative`                                           | `place_relative` plus directional OBB support                                                 | Integrated natively.                                                                                                                             |
| Line/grid/circle/arc formations                                | `arrange_group`                                            | `arrange_group` plus bounds-aware default spacing                                             | Integrated natively.                                                                                                                             |
| Facing pair                                                    | `arrange_facing_pair`                                      | `arrange_facing_pair` plus bounds-aware clearance                                             | Integrated natively.                                                                                                                             |
| Orient toward an object or point                               | `orient_toward`                                            | `orient_toward` added in this integration pass                                                | Integrated natively.                                                                                                                             |
| Whole-state replacement, partial operations, and selection MCP | `mcp/server.mjs`                                           | `director_workbench` observe/inspect/author/select/patch/replace                              | Covered and exceeded.                                                                                                                            |
| Filmmaking fundamentals and practical shot-design skills       | `skills/shot-design-*`                                     | One workbench skill plus operations, reference, and documentation                             | The capability belongs in the verified control loop. Write independent, testable shot recipes; do not copy unlicensed chapters.                  |
| Character-action design skill                                  | `skills/character-action-design`                           | Motion/pose/IK catalogs plus the workbench skill                                              | The technical capability is stronger; continue adding independently authored action-acceptance recipes.                                          |
| Read-back acceptance after Agent edits                         | Execution Contract in every CoStage skill                  | observe → author → audit/correct → deliver → inspect pixels                                   | Director is stricter; retain its existing loop.                                                                                                  |

## Designs not to copy

### Monolithic `App.tsx`

CoStage concentrates its main UI, types, defaults, 3D runtime, pose system, hierarchy,
Inspector, and timeline in one file of roughly 4,600 lines. Director is already layered by
schema, runtime, canvas, timeline, panels, Agent, and server; it should not regress to a
monolith merely to adopt a widget presentation.

### A second scene truth

CoStage's `DirectorStageDocument`, per-shot `sceneSnapshot`, and MCP storage form a coherent
small model. Importing them directly into Director would create competing truths beside
`DirectorProject`, Production Take/Coverage, the Canvas/Video artifact graph, and collaboration
revisions. New capabilities must compile into the existing `DirectorProject` model.

### Static poses and discrete camera moves

The upstream system explicitly does not support continuous skeletal animation, hand/foot IK,
contact constraints, or smooth camera trajectories; it represents motion through multiple
static snapshots. Director already has frame-native animation, Mixamo clips, IK, camera
actions, and deterministic capture. It must not degrade those systems to match the upstream
representation.

### Weakly structured patches

CoStage's operation schemas use open records for `patch` and `value`, while whole-document
saves use `z.any()`; `stage-storage.mjs` also retains handwritten field checks. Director keeps
one Zod contract and strict action schemas. Spatial semantics compile only into the existing
`update_object` operation.

## Execution semantics implemented in this pass

### Coordinate references

- `world`: world `+Z` is forward and `+X` is right;
- `target`: forward/right use the anchor's current Y-axis rotation;
- `camera`: the horizontal projection of the real camera position → target defines the basis;
  foreground moves toward the camera and background moves deeper into the shot;
- `offset_m` is always `[right, up, forward]`, so an Agent never has to guess XYZ semantics.

### Safety and acceptance

- Missing references, duplicate IDs, zero-length axes, self-orientation, and missing cameras
  are rejected atomically.
- Existing `update_object` protection still guards locked objects; only explicit `force:true`
  can override it.
- `look_target_object_id` persists only when a real target object exists.
- Every coordinate and yaw is rounded deterministically, so retries do not drift.
- A successful mutation is not proof of completion; the latest revision still requires
  `audit`/`deliver` and clean-frame inspection.

## Follow-up priorities

1. Write independent shot-design recipes against Director's physical camera, Shot IR, and
   audits; do not copy CoStage's unlicensed skill text.
2. When adding panorama pitch and environment lighting, drive viewport, capture, Shot Package,
   and video-generation output from the same frame evaluator instead of adding panel-only controls.

## Completion criteria

A CoStage capability counts as absorbed into Director only when all of these conditions hold:

1. it uses the existing schema-owned production truth;
2. the UI and Agent operate on the same data and validation;
3. mutations have revision guards, idempotency, Undo, and atomic rollback;
4. unit tests and failure paths exist;
5. a visual capability can be proven through revision-bound capture/deliver;
6. the ledger contains an explicit license and asset-provenance decision.
