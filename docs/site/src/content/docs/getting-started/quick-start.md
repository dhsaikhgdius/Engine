---
title: Quick Start
description: Create, frame, animate, and verify a first Director scene.
---

This page builds one minimal scene two ways: by hand in the editor, then through the Agent
contract. Both paths end with the same evidence — a framed subject rendered by a real camera.

## In the editor

1. Start Director with `npm run dev` and open <http://127.0.0.1:5175>.
2. Open the **Assets** panel and add a primitive, character, or local model.
3. Drag the asset into the viewport. Director computes a world-space placement and grounds the
   asset on its visual bounds — it should rest on the floor, not float or sink.
4. Select the object and refine position, rotation, and scale with the transform gizmo or the
   property panel.
5. Add or select a camera, set its focal length and aspect ratio, then aim or frame it. The
   camera preview shows the shot without changing your editor view.
6. Add a transform or camera track and place keyframes on the frame timeline.
7. Capture the active camera, or record the selected IN/OUT range.

**Checkpoint.** The capture shows your subject framed by the camera you configured, with no
grid, gizmo, label, or any other [editor helper](/concepts/glossary/#evidence-and-delivery) in
the image. That helper-free frame is the evidence Director cares about.

## Through the Agent contract

Every provider follows the same loop:

```text
discover → observe exact target/guard → mutate atomically → observe → audit → preview or deliver → inspect pixels
```

Start with capabilities and a selective observation:

```jsonc
{ "op": "capabilities" } // list the operations available right now
```

```jsonc
{
  "op": "observe", // read the bound target's current state
  "fields": ["scene", "objects", "cameras", "selection", "timeline"] // only these slices
}
```

**Checkpoint.** The observation returns the bound target and a `project_revision`. Save that
revision — every mutation below carries it as a guard.

Author one intent as one atomic batch:

```jsonc
{
  "op": "author", // operation: write the scene
  "expected_revision": "<project_revision from observe>", // guard: must match the current project revision
  "idempotency_key": "first-director-shot-v1", // retry key: the same request will not create duplicates
  "quality_gate": "strict", // reject the batch if it would float, sink, or fail framing
  "actions": [ // the actions that make up this one intent
    {
      "action": "start_scene", // clear the current scene
      "preserve_assets": true // keep imported assets when clearing
    },
    {
      "action": "add_object", // add an object
      "id": "hero-block", // stable object id for later references
      "name": "Hero Block", // display name in the editor
      "kind": "prop", // object class; primitives use prop
      "geometry_type": "box", // primitive shape
      "placement_mode": "grounded", // place on the floor pivot, not floating
      "transform": { // world transform in metres
        "position": [0, 0, 0], // floor pivot (bottom centre), not geometric centre
        "rotation": [0, 0, 0], // rotation in radians
        "scale": [1.2, 1.8, 1.2] // exact width / height / depth
      }
    },
    {
      "action": "add_camera", // add a camera
      "id": "main-camera", // camera id
      "object_id": "main-camera-rig", // scene object the camera is bound to
      "name": "Main Camera", // display name in the editor
      "position": [4.5, 2.4, 6.5], // camera position in metres
      "target": [0, 0.9, 0], // look-at point
      "target_object_id": "hero-block", // object the camera aims at
      "focal_length_mm": 50, // focal length in millimetres
      "aspect_ratio": "16:9" // frame aspect
    }
  ]
}
```

This is the full-editor contract: `kind:"prop"` plus `geometry_type:"box"`. Compact `stage_*`
examples that use `kind:"cube"` belong to `StageScene` and must not be copied here.

**Checkpoint.** The batch commits atomically and returns a new `project_revision`. In the open
browser tab, the box and camera appear immediately.

Observe again to obtain the new revision, then finish at the delivery boundary:

```jsonc
{
  "op": "deliver", // deliver a clean frame and extra passes from a camera
  "expected_revision": "<latest project_revision>", // guard: must match the latest project revision
  "camera_id": "main-camera", // which camera to render
  "subject_id": "hero-block", // the framed subject
  "quality_profile": "video-gen", // delivery quality profile
  "render_passes": ["clean", "depth", "normal", "object-id"] // output passes
}
```

**Checkpoint.** Accept the result only when it reports `ready:true` and `status:"delivered"`,
and the returned clean image actually shows the framed subject. If delivery is blocked, run
`audit`, apply `correct` with its audit token, audit again, and retry.

If a mutation is rejected or times out (`stale_project_revision`, `outcome_unknown`, and
similar codes), follow the
[recovery table in Agent Workbench](/agents/workbench/#revision-conflicts-and-uncertain-outcomes)
instead of resubmitting blindly. Canvas and Video Editor use a separate
[fingerprint-guarded creative loop](/agents/creative-workspaces/).

## Minimal CLI smoke test

With Director running, the same contract is available from a terminal:

```bash
npm run stage -- director_workbench '{"op":"observe"}'      # read the current scene
npm run stage -- director_workbench '{"op":"capabilities"}' # list available operations
```

The first command proves that the gateway can read the scene. The second proves that the
typed workbench contract is reachable. `stage_*` remains a legacy compact surface.

For the complete walkthrough — service health, exact revision replacement, clean multi-pass
delivery, and conflict recovery — continue with the
[End-to-end Verified Shot](/tutorials/verified-shot/).
