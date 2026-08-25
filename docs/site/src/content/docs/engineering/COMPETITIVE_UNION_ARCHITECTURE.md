---
title: Director competitive-union architecture
---

Research lock: 2026-07-30

This document turns eight reference repositories into a testable product and
architecture contract for Director. It is not a request to merge source trees.
Capabilities are accepted only when they are visible in source, reachable from a
real user flow, and backed by a reproducible artifact or test.

## Research baseline and reuse boundary

| Repository                                                          | Locked revision                            | License at the locked revision                                                                  | Director reuse rule                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Blockout](https://github.com/wassermanproductions/blockout)        | `f4fca6b298105ed381155d1952f3a81031308a16` | Apache-2.0 plus repository `NOTICE`; bundled FFmpeg binaries have separate GPL notices          | May adapt code only with required notices and attribution; re-source codecs and binaries independently |
| [3D Director Desk](https://github.com/xiaozangao/3d-director-desk)  | `a6c931cd36d8263d986706f74ab4efe9d5151959` | MIT                                                                                             | May adapt code with notice; do not assume model assets share the code license                          |
| [Nomi](https://github.com/aqm857886159/Nomi)                        | `f5f4a2cbc0dca0b62903680895df7ca28438a836` | Apache-2.0                                                                                      | May adapt code with copyright, license, and modification notices; audit every bundled asset separately |
| [CineForge Previz](https://github.com/Work-Fisher/cineforge-previz) | `77f53dfee256a6bb0d239aa7ceeb03d80ffa6ada` | CC BY-NC-SA 4.0                                                                                 | Clean-room behavioral reference only for a commercial or closed-source Director                        |
| [Storyboarder](https://github.com/wonderunit/storyboarder)          | `8b81a25c71d5f7ca46e8d5b8e3d4f7b3968f95c2` | Restrictive EULA in the distribution; no repository-wide open-source license was found          | Clean-room behavioral reference only; do not copy code, presets, models, or assets                     |
| [Framepilot](https://github.com/rahmanef63/framepilot)              | `8828268eb8492ea32169591e058d1191dcf472d4` | MIT                                                                                             | May adapt code with notice; preserve Director's R3F architecture and schemas                           |
| [Infinite Canvas](https://github.com/tigerowo/infinite-canvas)      | `9435f1c76130448ed7c41357b7b8ec5b60046538` | AGPL-3.0; repository documentation additionally describes closed-source commercial restrictions | Clean-room behavior or a separately negotiated commercial license                                      |
| Virtual production study #8                                         | `40c01a6984e35b24bad0c1222c6c5970b64f18d2` | PolyForm Noncommercial 1.0.0; commercial use requires separate written authorization            | Native Director character follow and hero assets; behavioral study only for phone-pilot features       |

Code and asset licensing are separate. Models, motion clips, textures, fonts,
FFmpeg binaries, and vendor logos require their own provenance record even when the
surrounding repository uses MIT or Apache-2.0.

Clean-room means implementing observable behavior from a written specification and
Director's own architecture without translating, lightly rewriting, or structurally
copying protected source. A partial copy or syntax rewrite remains subject to the
upstream license. This boundary does not reduce the capability target; it keeps the
result independently maintainable and aligned with Director's intended distribution
policy, subject to license review.

The maintained, file-level decision record is
[reference reuse ledger](/engineering/reference_reuse_ledger/). It records whether any
source or asset from each locked repository is actually incorporated. At this audit
date, none of the eight references has a registered source copy in Director. Future
focused MIT or Apache-2.0 reuse is allowed only after the copied paths, local
destinations, notices, and modifications are entered there. Renaming or rewriting a
copied fragment does not turn it into clean-room code.

## What the source audit established

### Blockout

- Its strongest idea is `Scene -> BlockingTake -> Shot`: one actor performance is
  reused by multiple camera coverages instead of duplicating the scene for every
  angle.
- Actors and cameras share time-based marks, holds, easing, positions, and via
  points. Camera movement is evaluated from the same time source as performance.
- Super 16, Super 35, full-frame, and 65 mm gates drive crop-to-aspect FOV.
- Subject-aware framing and 39 camera movement functions are real engine behavior.
- The exporter evaluates exact frames and writes clean, depth, and normal passes,
  metadata, stills, prompts, a ComfyUI workflow, and handoff files.
- Its choreography library is broad but its people are procedural joint offsets,
  not a full IK/contact system. Its preview DOF is explicitly an approximation.
- The local control endpoint has useful loopback/token/discovery-file security, but
  its MCP contract and handler validation are duplicated and it lacks revision
  preconditions.

### 3D Director Desk

- WASD/pointer-lock camera piloting, target-aware paths, hold timing, and clean
  camera capture are implemented and tested.
- Its collision is only AABB-style push-out. It is not swept collision, navigation,
  or a general contact solver.
- Browser MP4 relies on `captureStream + MediaRecorder` and wall-clock playback; it
  is not an exact offline renderer.
- Its extension bridge is not a scene-authoring Agent. The valuable part is its
  fingerprint/stale-result discipline for external plugin results.

### Nomi

- The complete flow from document and infinite canvas through image/video
  generation, timeline, and export is real.
- A Scene3D node can create screenshot nodes and non-destructive recorded takes.
  Actor, camera, target, and pose events are sampled and rebuilt as trajectories.
- Offscreen reference-video capture samples fixed times and has context-recovery
  handling.
- Storyboard-to-timeline insertion is stable and idempotent.
- Its export planner has multiple FFmpeg backends, but the current renderer manifest
  still omits several audio, text, overlay, effect, and keyframe capabilities. That
  boundary is not yet end-to-end.
- Complex blocking and camera intent can fall back to text prompts instead of
  becoming real 3D state. Director must not present such fallback as executed 3D.

### CineForge Previz

- It has a large local model catalog, programmatic mannequins, crowds, orthographic
  views, camera and object waypoints, shot sections, and an isolated FFmpeg export
  process.
- A waypoint can snapshot camera and scene objects together, and segment duration is
  derived from the largest movement.
- Its grounding is a useful behavior specification, but collision remains a top-face
  AABB placement rule.
- Timeline keyframes cannot be fully edited in the timeline, video output covers only
  the active shot, and output is fixed 16:9 without audio.

### Storyboarder

- It contains the most complete skeleton-aware shot-planning reference: end-effector
  IK, pole targets, pose search/save/mirror, character proportions, bone-defined shot
  sizes, and Shot Explorer.
- Shot Explorer combines size, angle, rule of thirds, eyeline direction, and roll,
  then writes an actual camera.
- It lacks a modern shared actor/camera animation timeline and a physical optical
  camera. Custom character models are excluded from part of Shot Explorer.

### Framepilot

- One renderer uses scissor rectangles for a POV plus three configurable orthographic
  or custom views. Helpers are isolated from clean output with layers.
- Camera interpolation and focal/FOV geometry are real, not labels.
- A neutral shot description is compiled into platform-specific prompts for multiple
  video generators and exported as structured JSON/CSV/TXT/storyboard artifacts.
- It has no real asset, rig, animation, collision, or video-rendering system.

### Infinite Canvas

- Its useful core is a typed media DAG: image, panorama, text, config, video, audio,
  Director, and group nodes with upstream semantic references.
- Director captures create image nodes and edges; image nodes can feed panorama input;
  portable ZIP export includes project JSON and local media blobs.
- Camera brand/lens controls only change prompt text, not 3D optics.
- The repository does not include auditable source for its embedded 3D Director, so
  documentation claims about that binary are not accepted as implementation evidence.

### Virtual production study #8

- Its strongest differentiator is a coherent set of director input modes: third-person
  character play, smoothed FPV camera piloting, and phone-orientation virtual production.
- The FPV rig has explicit acceleration/deceleration response, look smoothing,
  precision and boost gears, bounded banking, target lock, lens control, and terrain
  floor safety.
- The phone pilot separates sensor-frame normalization, recentering, live camera state,
  remote recording commands, connection freshness, and the desktop render mirror.
- Terrain sculpting uses serializable stamps with raise/lower/smooth/flatten/noise/erode
  modes, so the edit remains replayable instead of mutating renderer geometry as truth.
- The repository contains very large editor and renderer files and lacks a test suite
  comparable to Director's. Its useful behavior must be re-expressed through Director's
  typed store, focused controllers, and existing verification gates.

## Director's current position

Director already has a stronger base than a simple union of demos:

- a Zod-validated `DirectorProject`, validated import/host boundaries, graph checks,
  migration, project-level undo, and debounced persistence;
- an R3F stage with imported models, grounded placement, visual-center gizmos,
  characters, crowds, cameras, paths, lasso selection, and clean capture;
- physical sensor gates, crop-to-aspect FOV, focal length, calibrated exposure, physical
  anamorphic projection, color-plus-depth thin-lens DOF, near/far clipping, aspect ratios,
  handheld presets, camera targets, camera piloting, path/follow/transform actions, and a
  movable low-quality cinematic camera picture-in-picture;
- a persisted single-renderer scissored quad inspection layout (perspective/top/front/right;
  panes currently read-only), frame-native object and camera animation, Bezier trajectory
  handles, pose values, target locks, recording, storyboard shots, and helper-free capture;
- schema-backed `PerformanceTake`, `CoverageSequence`, and `CoverageShot` records with
  a pure exact-frame evaluator and production-aware `ShotIR`;
- deterministic inclusive-range PNG-sequence ZIP export with microsecond timing, per-frame
  SHA-256 hashes, a package fingerprint, progress/cancellation, and an honest WebCodecs-plus-
  muxer-only video path; the separate MediaRecorder recorder remains non-deterministic;
- Agent-native Workbench and Creative control planes with Zod contracts, atomic author/Canvas/Video
  batches, graph validation, project revisions and workspace fingerprints, exact browser-target
  binding, idempotent retry ledgers, audit/correct, diff/trace, undo/redo, evidence delivery, MCP,
  HTTP, CLI, and in-browser control surfaces.

The existing implementation must remain the base. Replacing it with any one
reference repository would lose more capability than it gains.

## Capability-union gap matrix

| Domain                   | Best verified reference            | Director today                                                                                                                                                                                                                                                    | Union target and acceptance condition                                                                                                                                                                                 |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production coverage      | Blockout                           | Persisted takes and coverage shots share one tested performance evaluator and production-aware ShotIR; dedicated editing UI/semantic Agent actions remain                                                                                                         | A performance take can be reused by several shots without copying actors; changing the take updates every linked shot while shot optics remain independent                                                            |
| Camera optics            | Blockout + Framepilot              | Physical sensor/crop math, anamorphic projection, and color+hardware-depth DOF drive helper-free clean capture; PIP uses a persistent low-quality path, offline capture uses high quality; technical depth/normal/ID passes bypass DOF                            | Add simulated motion blur, compositional lens tools, and full end-to-end Agent coverage while preserving sensor gate, crop, focal length, aperture, focus, shutter, ISO, near/far, and squeeze as one tested contract |
| Camera movement          | Blockout + CineForge + VP study #8 | Paths, follow, transform keyframes, target locks, and pilot controls; FPV input now has persisted inertia, look smoothing, boost/precision gears, bounded banking, and explicit focused drag-look without Pointer Lock                                            | A categorized movement library produces editable keys; templates are subject-aware, collision-checked, and never prompt-only                                                                                          |
| Shot composition         | Storyboarder + Blockout            | Basic storyboard sizes and deterministic blocking audit                                                                                                                                                                                                           | Bone/bounds-aware ECU through EWS/OTS framing, multi-subject fit, eyeline, screen-direction, headroom, look-room, and 180-degree-rule checks                                                                          |
| Character control        | Storyboarder                       | UE4/mannequin controls and pose presets                                                                                                                                                                                                                           | End-effector IK, pole targets, pose mirror/search/save, humanoid retargeting, foot locking, root motion, and tested grounding for all supported rigs                                                                  |
| Choreography and crowds  | Blockout                           | Crowd arrays and shared pose/action controls                                                                                                                                                                                                                      | Seeded formations, canon, mirror, pair reactions, shared/offset paths, collision-aware locomotion, and deterministic replay                                                                                           |
| Unified time             | Blockout + CineForge               | Take-owned object tracks and coverage cameras share one pure evaluator used by ShotIR/Agent; the live viewport/capture still uses its compatibility evaluator                                                                                                     | Characters, props, camera, lens, focus, lights, audio, and editorial cuts evaluate from one exact frame function                                                                                                      |
| Joint waypoint recording | CineForge + Nomi                   | Camera pilot records camera keys; actor recording is separate                                                                                                                                                                                                     | One waypoint can atomically record selected actors/props/poses/camera/lens; duration can be computed from bounded speeds and edited later                                                                             |
| Live multiview           | Framepilot                         | Persisted single-renderer scissored quad view is available as perspective/top/front/right inspection; it shares scene state and frame evaluation, while panes are intentionally read-only                                                                         | Add configurable Director/Camera/Side/custom panes and safe pane-specific navigation without duplicate R3F roots                                                                                                      |
| Navigation and collision | 3D Director Desk + CineForge       | Player capsule collision, multi-ray follow camera, grounded drag/drop                                                                                                                                                                                             | Editor, camera path, actor path, and playback share broadphase bounds plus swept/capsule collision; optional navmesh handles routing and crowds                                                                       |
| Clean output             | Blockout + Nomi                    | Real helper-free clean, packed-depth, view-normal, and deterministic object-ID GPU passes now exist; mask/motion-vector passes remain                                                                                                                             | Every output pass uses explicit layer policy; editor helpers can never leak into white-box, beauty, depth, normal, ID, mask, or motion-vector output                                                                  |
| Deterministic render     | Blockout + Nomi                    | Timeline exports inclusive IN/OUT PNG frames sequentially with explicit microsecond timestamps/durations, per-frame SHA-256, package fingerprint, progress/cancel, and deterministic ZIP; browser MediaRecorder remains a separate non-deterministic preview path | Add context-loss recovery plus a tested real muxer deployment for reproducible playable MP4/WebM; never present a ZIP as video                                                                                        |
| Control package          | Blockout                           | Exact-frame pass renderer, deterministic manifest, artifact hashes, package fingerprint, Agent `shot_package`, and a deterministic PNG-sequence archive writer exist                                                                                              | Per-shot package contains clean/depth/normal/ID, stills, camera plot, marks, metadata, prompt IR, generator adapters, workflow, asset provenance, and hashes                                                          |
| Generator prompt IR      | Framepilot                         | Provider-neutral evaluated ShotIR is available through browser/HTTP/MCP; platform compilers are not yet implemented                                                                                                                                               | A provider-neutral `ShotIR` compiles into Runway/Kling/Veo/Luma/Hailuo/Pika/Higgsfield/Wan/Seedance/LTX/ComfyUI adapters; adapter text never becomes scene truth                                                      |
| Node workflow            | Nomi + Infinite Canvas             | Scene-scoped Canvas owns typed shot/image/video/audio/note/frame nodes, directed edges, durable media IDs, undo/redo, atomic Agent batches, and structural audits; typed ports and generation jobs remain                                                         | Typed DAG adds ports, Director/take/panorama/generation/edit nodes, durable job/version lineage, capture-to-node, and panorama-to-stage                                                                               |
| Storyboard/NLE           | Nomi + Storyboarder                | Storyboard plus scene-scoped multi-track picture/audio editor with trim, split, speed, transform, fit, opacity, volume, fades, preview/export parity, persistence, package import/export, and Agent control                                                       | Add professional transitions, waveform/proxy/relink/version promotion, rational frame time, exact reconform, and OTIO interchange                                                                                     |
| Agent control            | Director + Blockout                | Workbench and Creative provide exact-target binding, revisions/fingerprints, idempotent retries, atomic batches/rollback, audits, low-token observations, delivery evidence, and structured recovery codes                                                        | Extend the same contract to durable long-running generation/export jobs, schema-derived public help, result expiry, and cross-service provenance                                                                      |
| Virtual production input | VP study #8                        | No phone sensor/joystick controller yet; camera pilot and deterministic recording already provide the desktop execution boundary                                                                                                                                  | Add a versioned, authenticated phone-pilot protocol with sensor calibration, recentering, freshness/sequence checks, local-network pairing, remote record acknowledgement, and deterministic take conversion          |
| Asset portability        | Nomi + Infinite Canvas             | Project JSON references assets; local catalog and imports exist                                                                                                                                                                                                   | Portable package embeds allowed blobs, hashes every asset, records source/license/author/attribution/redistribution policy, and refuses ambiguous redistribution                                                      |
| Quality gates            | Director                           | Unit tests, lint, build, CI, structured spatial/camera audits                                                                                                                                                                                                     | Add golden shot, camera-math, IK/contact, multi-view parity, render-pass, prompt-adapter, import, node-DAG, and browser E2E suites                                                                                    |

## Target model: one production truth, multiple projections

The target is not eight subsystems glued together. It is one typed production model
with explicit projections:

```text
DirectorProduction
  SceneBlocking
    Cast / Props / Environment / Lights
    PerformanceTake[]
      EntityTrack[] / PoseTrack[] / EventTrack[] / AudioRef[]
  CoverageSequence[]
    CoverageShot[]
      takeId / frame range / camera / optics / shot overrides
  ArtifactGraph
    ShotIR / captures / render passes / generated media / edit nodes
```

The canonical evaluator is pure and frame-based:

```ts
evaluateProductionAtFrame(project, sceneId, takeId, shotId, frame) => EvaluatedShotState
```

The viewport, quad views, thumbnails, capture, MP4, depth/normal passes, prompt
compiler, quality audit, and Agent observations must consume this same result. No
renderer, panel, Agent tool, or export adapter may maintain a second animation or
camera interpretation.

### `ShotIR`

`ShotIR` is an immutable evaluated description, not another editable project model.
It contains:

- stable project/scene/take/shot/revision identifiers;
- frame/time/fps/duration and editorial context;
- camera transform, target, real filmback, lens, focus/exposure, movement semantics,
  framing metrics, and safe-area metadata;
- evaluated subjects, skeleton landmarks, props, lights, environment, motion vectors,
  and visibility;
- reference/provenance links and artifact hashes;
- structured narrative/action intent and negative constraints.

Runtime state produces `ShotIR`; provider adapters consume it. A provider adapter may
omit unsupported fields but may not mutate runtime state.

### Render-pass graph

The render pipeline must expose named passes with an explicit helper policy:

- `whitebox` and `beauty`;
- `depth` with a shot-stable near/far mapping;
- `normal` in a documented coordinate space;
- `object-id`, `character-mask`, and optional `motion-vector`;
- `camera-plot` and `top-down`, which deliberately include directing helpers but are
  never substituted for generation references.

### Agent contract

All mutable Agent requests carry:

- `expected_revision` or an explicit unconditional flag;
- an idempotency key for retryable jobs;
- one Zod-derived operation contract;
- atomic semantic actions and graph validation;
- a resulting revision, diff, trace ID, and artifact fingerprint.

Long-running capture/generation/export actions return job IDs and progress rather than
holding a single request open. Results are rejected or marked stale when their source
revision/fingerprint no longer matches.

## Delivery order

### P0 — production and evaluation core

1. Add schema-backed sensor gates and make crop-to-aspect FOV the only camera math.
2. Introduce `PerformanceTake` and `CoverageShot` without breaking existing project
   imports; migrate the current project into one default take and sequence.
3. Extract a pure exact-frame evaluator used by runtime, capture, audit, prompt, and
   Agent observation.
4. Revision preconditions and idempotency are complete for Workbench authoring and Creative
   mutations; extend the same source fingerprint and retry contract to long-running export jobs.

Exit criteria: two shots share one actor take, use different camera optics, evaluate
identically in viewport/capture/Agent, and reject a stale write.

### P0 — deterministic reference package

1. Add a hidden/offscreen fixed-frame renderer with context-loss recovery.
2. Add clean/depth/normal/ID passes and shot-stable depth mapping.
3. The timeline now emits a deterministic PNG ZIP and hashed manifest. Add a production
   WebCodecs container muxer (or an external encoder) before offering deterministic MP4/WebM;
   do not reuse the separate wall-clock `MediaRecorder` contract for this claim.
4. Generate stills, top-down/camera plot, `ShotIR`, prompts, and ComfyUI workflow in a
   portable per-shot package.

Exit criteria: repeated export of an unchanged 24 fps shot produces the same frame
count, timestamps, manifest, and per-frame image hashes, with no helpers in clean
passes.

### P1 — character, composition, and movement

1. Add rig landmark abstraction, IK targets/poles, foot lock, pose mirror/save/search,
   and humanoid retargeting.
2. Build bone/bounds-aware shot-size solvers and Shot Explorer as clean-room code.
3. Add a data-driven movement/choreography catalog whose output is editable timeline
   data.
4. Add joint waypoint recording and duration derivation from configured actor/camera
   limits.

Exit criteria: a custom humanoid and built-in mannequin can share a pose/action,
generate the same semantic shot sizes, keep feet grounded, and pass collision and
composition audits.

### P1 — multiview and spatial safety

1. Persistent perspective/top/front/right inspection is now one WebGL renderer with scissor
   rectangles. Add configurable pane types and independent pane navigation without duplicating
   the scene or renderer.
2. Put helpers on explicit layers and test clean-layer parity.
3. Add swept collision for editor and camera paths; add optional navmesh routing for
   actors/crowds.

Exit criteria: all view panes show the same evaluated frame and selection, while an
obstacle-crossing actor/camera path is either corrected or rejected before export.

### P2 — artifact graph and editorial completion

1. Add the typed artifact DAG and portable blob package.
2. Make captures, takes, reference videos, generation jobs, and outputs first-class
   nodes with provenance.
3. Complete multi-shot editorial export with audio, captions, transitions, retries,
   and reconform.
4. Add platform prompt adapters over `ShotIR` and golden tests for every adapter.

Exit criteria: a user can compose, perform, move, capture, generate, compare, edit,
and export without losing the source scene/take/shot relationship.

## Definition of “includes and exceeds the union”

The goal is complete only when every row in the gap matrix has:

1. a schema-owned persisted representation or a documented derived artifact;
2. a real UI path and Agent path operating on the same state;
3. deterministic validation and an undo/retry policy;
4. unit tests for the domain math and graph rules;
5. browser E2E coverage for the primary user path;
6. export evidence proving that the capability affects the final artifact;
7. a provenance/license decision for every reused dependency and asset.

Feature labels, disabled controls, prompt-only fallbacks presented as 3D changes, and
documentation-only claims do not count.
