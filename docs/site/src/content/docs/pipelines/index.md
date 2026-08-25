---
title: Pipelines
description: Convert references into local 3D assets and validated white-box shots into video jobs.
---

Director keeps staging and generative rendering as separate phases.

## End-to-end system design

The production pipeline connects Canvas lineage, Stage performance and coverage,
revision-bound Shot Packages, DCC/generation jobs, Video editorial, collaboration,
and interchange without turning any adapter into a second source of truth.

[Read the Pipeline & System Design guide](/pipelines/system-design/).

## White-box to video

`stage_video` packages the validated scene, current camera frame, lens plan, timeline actions,
prompt, seed, aspect, FPS, and duration for the LTX-2.3 pipeline under
`vendor/ltx-2`.

[Read the White-box to Video guide](/pipelines/video-generation/).

## Separation of responsibilities

| Director owns           | Downstream model owns            |
| ----------------------- | -------------------------------- |
| Layout and metric scale | Appearance and texture synthesis |
| Subject placement       | Fine temporal detail             |
| Camera and lens         | Lighting embellishment           |
| Aspect and frame range  | Motion rendering                 |
| Structural validation   | Model-specific style             |
| Reference capture       | Final pixel generation           |

This separation makes geometry drift and camera drift visible instead of hiding them inside a
single opaque generation request.

## Reference production gate

The end-to-end reference case is a two-character apartment dialogue. It is complete only when one
project can pass through all of these stages without manual file import or export:

1. A natural-language Agent request creates the room, grounded characters, initial blocking, and
   a named camera in `DirectorProject`.
2. The same stable object IDs are provisioned into the bound Blender scene; a typed Blender
   transaction refines the hero room geometry and returns evaluated local bounds.
3. Director changes blocking, lens, camera movement, and timeline against those same IDs and the
   latest project/native revisions.
4. Review captures are accepted, then the selected camera and frame range produce a final movie,
   white-model frames, object masks, and metric depth.
5. Undo/redo, audit evidence, and delivery receipts remain attached to this one project; no GLB,
   `.blend`, or image file is manually moved between stages.

This gate is intentionally cross-surface. A Blender render alone, a Stage blockout alone, or a set
of disconnected export files does not pass it.

## Artifact policy

Generated job artifacts stay under `data/`:

```text
data/video-jobs/<job_id>/
```

Treat these as runtime evidence, not hand-authored source.

## Current evolution priorities

1. One project-level production graph for cross-workspace identity and lineage.
2. One durable job state machine for generation, DCC, proxy, and transcode work.
3. Immutable artifact versions with explicit promote/use actions.
4. Extend the shipped Blender return package to optics, lights, armature baking,
   and fingerprint-bound approval; add OpenUSD-based Unreal handoff.
5. Approval records bound to exact project and evidence fingerprints.
