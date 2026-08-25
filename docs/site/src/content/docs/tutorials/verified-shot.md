---
title: End-to-end Verified Shot
description: Build one metric white-box shot, frame it, and finish with revision-bound visual evidence.
---

This tutorial exercises the smallest complete Director workflow. It creates a grounded subject,
adds a physical camera, validates the project, and produces a clean delivery. It intentionally
uses a primitive so no external asset can hide a control-plane problem.

At the end you will have a delivered shot: a helper-free 1280×720 clean frame plus depth,
normal, object-ID, and mask passes, all bound to one project revision. The only prerequisite is
a working [install](/getting-started/install/).

## 1. Start and verify services

```bash
npm run dev
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8787/health
npm run stage -- director_workbench '{"op":"capabilities"}'
```

Keep <http://127.0.0.1:5175/?workspace=stage> open. A writable Agent target only exists while a
Director browser is connected to the gateway.

## 2. Observe the exact project

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["scene","objects","cameras","timeline"]}'
```

Save the returned `project_revision`. The CLI can preflight and inject a missing guard, but an
integration should always carry the guard explicitly.

The observation also confirms the binding: it names the exact browser target the following
mutations will write to.

## 3. Author one atomic intent

Replace `<REVISION>` before running this command. Field meanings:

```jsonc
{
  "op": "author", // operation: write the scene
  "expected_revision": "<REVISION>", // guard: must match the revision from step 2
  "idempotency_key": "tutorial-verified-shot-v1", // retry key: the same request will not create duplicates
  "quality_gate": "strict", // reject the batch if it would float, sink, or fail framing
  "actions": [ // the actions that make up this one intent
    {
      "action": "start_scene", // clear the current scene
      "preserve_assets": true // keep imported assets when clearing
    },
    {
      "action": "add_object", // add an object
      "id": "hero-block", // stable object id
      "name": "Hero Block", // display name in the editor
      "kind": "prop", // object class; primitives use prop
      "geometry_type": "box", // primitive shape
      "placement_mode": "grounded", // place on the floor pivot
      "color": "#d6a341", // display color
      "transform": { // world transform in metres
        "position": [0, 0, 0], // floor-centre position
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
      "sensor_format": "super35", // sensor format
      "aspect_ratio": "16:9", // frame aspect
      "handheld_shake": "off", // handheld shake: off
      "activate": true // make this the active camera after commit
    }
  ]
}
```

```bash
npm run stage -- director_workbench '{
  "op":"author",
  "expected_revision":"<REVISION>",
  "idempotency_key":"tutorial-verified-shot-v1",
  "quality_gate":"strict",
  "actions":[
    {"action":"start_scene","preserve_assets":true},
    {
      "action":"add_object",
      "id":"hero-block",
      "name":"Hero Block",
      "kind":"prop",
      "geometry_type":"box",
      "placement_mode":"grounded",
      "color":"#d6a341",
      "transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1.2,1.8,1.2]}
    },
    {
      "action":"add_camera",
      "id":"main-camera",
      "object_id":"main-camera-rig",
      "name":"Main Camera",
      "position":[4.5,2.4,6.5],
      "target":[0,0.9,0],
      "target_object_id":"hero-block",
      "focal_length_mm":50,
      "sensor_format":"super35",
      "aspect_ratio":"16:9",
      "handheld_shake":"off",
      "activate":true
    }
  ]
}'
```

`kind:"prop"` plus `geometry_type:"box"` is the full-editor primitive contract. `kind:"cube"`
belongs to the compact Stage compatibility protocol and is not valid here.

In the open browser tab, the gold block and the new camera appear as soon as the batch commits.
The response returns a new `project_revision`; the one you observed in step 2 is now stale.

## 4. Verify state and composition

Observe again and retain the new revision:

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["objects","cameras","graph_issues"]}'
npm run stage -- director_workbench '{"op":"audit","camera_id":"main-camera","subject_id":"hero-block"}'
```

If the audit reports deterministic fixable issues, call `correct` with its `audit_token` and the
latest revision. Then observe and audit again. Do not relabel an elevated object as `floating` just
to silence a grounding failure.

## 5. Deliver visual evidence

Replace `<LATEST_REVISION>` with the revision returned by the last observation. Field meanings:

```jsonc
{
  "op": "deliver", // deliver a clean frame and extra passes from a camera
  "expected_revision": "<LATEST_REVISION>", // guard: must match the latest project revision
  "camera_id": "main-camera", // which camera to render
  "subject_id": "hero-block", // the framed subject
  "quality_profile": "video-gen", // delivery quality profile
  "width": 1280, // output width in pixels
  "height": 720, // output height in pixels
  "render_passes": ["clean", "depth", "normal", "object-id", "mask"] // output passes
}
```

```bash
npm run stage -- director_workbench '{
  "op":"deliver",
  "expected_revision":"<LATEST_REVISION>",
  "camera_id":"main-camera",
  "subject_id":"hero-block",
  "quality_profile":"video-gen",
  "width":1280,
  "height":720,
  "render_passes":["clean","depth","normal","object-id","mask"]
}'
```

Accept the shot only when the response reports `ready:true`, `status:"delivered"`,
`capture_verified:true`, a ready audit, and the expected revision/package fingerprint. Inspect the
clean PNG: it must use the intended camera and contain no grid, label, gizmo, frustum, or selection
outline.

## 6. Continue with a real character

Once this primitive path works, discover a catalog character and motion instead of guessing IDs:

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","query":"X Bot","limit":10}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","query":"walk","limit":10}'
```

Follow [Asset discovery](/agents/assets/) and [Characters](/editor/characters/) to copy the returned
asset action unchanged, create the character with its real `assetRefId`, and layer motion, pose,
and IK safely.

## Failure recovery

| Result                   | Next action                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `stale_project_revision` | Re-observe, recompute remaining intent, use a new idempotency key                     |
| `outcome_unknown`        | Observe/diff first; only replay byte-equivalent input with the original key if absent |
| `target_unavailable`     | Reopen/rebind the intended Director tab; never fall back to another scene             |
| audit not ready          | Correct only reported issues, then audit again                                        |
| capture not verified     | Do not claim completion; repeat delivery against the latest exact revision            |

The complete code-by-code contract lives in the
[Agent Workbench recovery table](/agents/workbench/#revision-conflicts-and-uncertain-outcomes).
