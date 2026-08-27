---
title: Competitive Union
description: Source-verified capability union and delivery gates for Director's 3D production architecture.
---

:::caution[Archived research input — not a product roadmap]
This page is a locked competitive audit kept as research input. It does not gate or order
delivery work. The product direction is the verified shot north star recorded in
[ADR 0005](/engineering/adr/0005-verified-shot-north-star/).
:::

Director's target is the tested union of seven production tools, not a visual
collection of their controls. The detailed, revision-locked audit lives in
`docs/site/src/content/docs/engineering/COMPETITIVE_UNION_ARCHITECTURE.md`.

## Locked references

| Project                                                             | Verified strength                                                                    | Reuse boundary                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| [Blockout](https://github.com/wassermanproductions/blockout)        | Coverage/takes, real sensor gates, exact frame and control-package export            | Apache-2.0 plus NOTICE; audit FFmpeg separately   |
| [3D Director Desk](https://github.com/xiaozangao/3d-director-desk)  | Camera piloting, target-aware paths, clean capture                                   | MIT code; assets have separate licenses           |
| [Nomi](https://github.com/aqm857886159/Nomi)                        | Non-destructive takes, infinite-canvas generation flow, fixed-time reference capture | Apache-2.0; audit assets separately               |
| [CineForge Previz](https://github.com/Work-Fisher/cineforge-previz) | Joint camera/object waypoints and isolated MP4 export                                | CC BY-NC-SA; clean-room behavior only             |
| [Storyboarder](https://github.com/wonderunit/storyboarder)          | IK, pose library, bone-aware framing, Shot Explorer                                  | Restrictive EULA; clean-room behavior only        |
| [Framepilot](https://github.com/rahmanef63/framepilot)              | Single-renderer quad view and provider-neutral prompt IR                             | MIT                                               |
| [Infinite Canvas](https://github.com/tigerowo/infinite-canvas)      | Typed media DAG and capture-to-node flow                                             | AGPL-3.0; clean-room behavior or separate license |

The revisions, source paths, verified implementation limits, and asset-license
warnings are recorded in the full audit. A README claim without a reachable source
path does not count as implemented capability.

For clean-room rows, Director uses independently documented behavioral requirements,
not protected source with renamed symbols or altered syntax. MIT and Apache-2.0
implementation reuse remains possible when notices and modification obligations are
preserved; code and model assets are always audited separately.

The site's `docs/site/src/content/docs/engineering/REFERENCE_REUSE_LEDGER.md` is the maintained provenance
record. It distinguishes behavior-only study from actual source copying, tracks code
and assets independently, and requires exact upstream/local paths before a focused
MIT or Apache-2.0 adaptation is merged. At the current audit date, no source copy
from these seven repositories is registered. A renamed, translated, or structurally
rewritten fragment would still be recorded as source reuse.

## Unified architecture

Director converges the union into one production truth:

```text
DirectorProduction
  SceneBlocking
    Cast / Props / Environment / Lights
    PerformanceTake[]
      EntityTrack[] / PoseTrack[] / EventTrack[]
  CoverageSequence[]
    CoverageShot[]
      takeId / frame range / camera / optics
  ArtifactGraph
    ShotIR / passes / generated media / editorial nodes
```

One pure frame evaluator must drive the viewport, multi-view, capture, render
passes, prompt compiler, quality audit, and Agent observation. Provider prompts and
render adapters are projections of this state; they are never allowed to become a
second scene model.

## Required capability gates

### Production and camera

- Reuse one actor performance across multiple independent camera coverages.
- Use real sensor gates and crop-to-aspect FOV, then add aperture, focus, shutter,
  ISO, near/far, and optional anamorphic optics.
- Generate editable, subject-aware shot sizes and camera movement—not prompt-only
  descriptions.
- Evaluate actor, prop, camera, lens, focus, light, and editorial cuts at one exact
  frame.

### Character and spatial control

- Provide end-effector IK, pole targets, pose mirror/search/save, retargeting, root
  motion, foot lock, and reliable grounding.
- Provide seeded crowd formations, canon, mirror, pair reactions, and shared paths.
- Use swept/capsule collision for editor, camera, and actor paths; use navigation
  data where routing is required.

### Viewport and output

- The delivered persisted quad inspection layout renders perspective, top, front, and right
  panes from one WebGL renderer and one scene state. Its panes are deliberately read-only today;
  configurable Camera/Side/custom panes and per-pane navigation remain a delivery gate.
- Put labels, paths, gizmos, grids, and camera helpers on explicit helper layers.
- The timeline can export a deterministic inclusive IN/OUT PNG ZIP with explicit microsecond
  timing, per-frame SHA-256, a package fingerprint, progress, and cancellation. A real
  WebCodecs encoder plus container muxer is required before the same path emits playable
  MP4/WebM; it never renames the ZIP to a video file.
- The separate browser `MediaRecorder` path is a real-time preview recording, not a
  deterministic render claim.
- Package exact video, stills, camera plot, marks, metadata, provenance, ShotIR,
  prompt adapters, and workflow files with hashes.

### Generation, editorial, and Agent control

- Compile one provider-neutral ShotIR to generator-specific adapters.
- Represent shots, takes, captures, references, generated media, and editorial
  results as a typed, undoable artifact graph.
- Reject stale Agent mutations through revision/fingerprint preconditions and make
  long-running exports retryable jobs.
- Give the UI and Agent the same operations, validation, graph rules, and evidence.

## Delivery sequence

Current landed foundations include physical filmback/crop math, physical anamorphic projection,
color-plus-hardware-depth DOF (low quality in persistent PIP and high quality in offline clean
capture), a persisted single-renderer read-only quad inspection view, schema-backed Performance
Takes and Coverage Shots, a pure production evaluator, production-aware ShotIR through
browser/HTTP/MCP, deterministic project revisions with stale-write guards, and deterministic PNG
frame-package export. The remaining items below are still delivery gates—not claims that a
control or document already equals a finished renderer.

1. **P0: production truth** — sensor gates, PerformanceTake/CoverageShot migration,
   pure frame evaluator, ShotIR, and stale-write protection.
2. **P0: deterministic package** — offscreen fixed-frame rendering, clean/depth/
   normal/ID passes, deterministic PNG ZIP is landed; production container encoding and
   complete hashed shot packages remain.
3. **P1: character and composition** — IK, retargeting, bone-aware framing, Shot
   Explorer, movement/choreography library, and joint waypoints.
4. **P1: multiview and collision** — scissored views, helper layers, swept collision,
   and optional navigation.
5. **P2: artifact graph and editorial** — non-destructive takes, generation nodes,
   multi-shot audio/captions/transitions, and reconform.

## Definition of complete

A capability counts only when it has all of the following:

1. a schema-owned persisted representation or documented derived artifact;
2. a real UI path and Agent path using the same state;
3. deterministic validation plus undo/retry behavior;
4. domain unit tests and primary-flow browser E2E coverage;
5. export evidence showing that it affects the resulting artifact;
6. a provenance and license decision for every dependency and asset.

Disabled controls, documentation-only features, and prompt fallbacks presented as
executed 3D changes do not count.
