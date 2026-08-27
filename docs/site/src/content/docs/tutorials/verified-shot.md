---
title: End-to-end Verified Shot
description: Build one metric white-box shot, frame it, and finish with revision-bound visual evidence.
---

This tutorial exercises the smallest complete Director workflow. It creates a grounded subject,
adds a physical camera, validates the project, and produces a clean delivery. It uses the
canonical packaged character (`mixamo:x-bot`) as the subject: public `director_workbench`
author calls instance real meshes — catalog or project assets by `asset_id`, Blender-modeled
geometry through `blender_native`, or promoted `generated_3d` output — and reject Stage
`geometry_type` primitives.

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
      "id": "hero-actor", // stable object id
      "name": "Hero Actor", // display name in the editor
      "kind": "character", // object class: a rigged catalog character
      "asset_id": "mixamo:x-bot", // exact catalog id (see step 6 for discovery)
      "placement_mode": "grounded", // place on the floor pivot
      "transform": { // world transform in metres
        "position": [0, 0, 0], // floor-centre position
        "rotation": [0, 0, 0], // rotation in radians
        "scale": [1, 1, 1] // keep the catalog's real-world scale
      }
    },
    {
      "action": "add_camera", // add a camera
      "id": "main-camera", // camera id
      "object_id": "main-camera-rig", // scene object the camera is bound to
      "name": "Main Camera", // display name in the editor
      "position": [4.5, 2.4, 6.5], // camera position in metres
      "target": [0, 1.2, 0], // look-at point
      "target_object_id": "hero-actor", // object the camera aims at
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
      "id":"hero-actor",
      "name":"Hero Actor",
      "kind":"character",
      "asset_id":"mixamo:x-bot",
      "placement_mode":"grounded",
      "transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}
    },
    {
      "action":"add_camera",
      "id":"main-camera",
      "object_id":"main-camera-rig",
      "name":"Main Camera",
      "position":[4.5,2.4,6.5],
      "target":[0,1.2,0],
      "target_object_id":"hero-actor",
      "focal_length_mm":50,
      "sensor_format":"super35",
      "aspect_ratio":"16:9",
      "handheld_shake":"off",
      "activate":true
    }
  ]
}'
```

Public author calls that set a Stage `geometry_type` primitive are rejected with the corrective
`blender_native create_blockout` call; `kind:"cube"` belongs to the compact Stage compatibility
protocol and is not valid here either. Real meshes come from the catalogs (`asset_id`),
`blender_native` modeling, or promoted `generated_3d` output.

In the open browser tab, the character and the new camera appear as soon as the batch commits.
The response returns a new `project_revision`; the one you observed in step 2 is now stale.

## 4. Verify state and composition

Observe again and retain the new revision:

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["objects","cameras","graph_issues"]}'
npm run stage -- director_workbench '{"op":"audit","camera_id":"main-camera","subject_id":"hero-actor"}'
```

If the audit reports deterministic fixable issues, call `correct` with its `audit_token` and the
latest revision. Then observe and audit again. Do not relabel an elevated object as `floating` just
to silence a grounding failure.

## 5. Confirm and deliver visual evidence

`deliver` is on the destructive/publish confirmation list: without explicit confirmation the
gateway answers `403 confirm_required` and does not execute the call. Issue one single-use
confirm token first. The token is bound to tool + operation + role + session and expires
quickly, so issue it right before delivering. `session_id` must match the session the
delivering call uses — the Stage CLI default is `cli-default` (override with
`STAGE_AGENT_SESSION`):

```bash
BASE='http://127.0.0.1:8787'
TOKEN="$(curl -fsS -X POST "$BASE/te-man/director/agent/bootstrap" \
  -H 'Content-Type: application/json' -d '{}' | jq -r '.browserToken')"
CONFIRM_TOKEN="$(curl -fsS -X POST "$BASE/api/agent/confirm-token" \
  -H "X-Director-Browser-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tool":"director_workbench","operation":"deliver","session_id":"cli-default"}' \
  | jq -r '.result.confirm_token')"
```

Replace `<LATEST_REVISION>` with the revision returned by the last observation. Field meanings:

```jsonc
{
  "op": "deliver", // deliver a clean frame and extra passes from a camera
  "confirm_token": "<single-use token>", // publish confirmation; the CLI lifts it into the request envelope
  "expected_revision": "<LATEST_REVISION>", // guard: must match the latest project revision
  "camera_id": "main-camera", // which camera to render
  "subject_id": "hero-actor", // the framed subject
  "quality_profile": "video-gen", // delivery quality profile
  "width": 1280, // output width in pixels
  "height": 720, // output height in pixels
  "render_passes": ["clean", "depth", "normal", "object-id", "mask"] // output passes
}
```

The CLI also reads the token from the `DIRECTOR_CONFIRM_TOKEN` environment variable, which
keeps the JSON free of shell interpolation:

```bash
DIRECTOR_CONFIRM_TOKEN="$CONFIRM_TOKEN" npm run stage -- director_workbench '{
  "op":"deliver",
  "expected_revision":"<LATEST_REVISION>",
  "camera_id":"main-camera",
  "subject_id":"hero-actor",
  "quality_profile":"video-gen",
  "width":1280,
  "height":720,
  "render_passes":["clean","depth","normal","object-id","mask"]
}'
```

Each token confirms exactly one call. If delivery is retried — for example after fixing an
audit issue — issue a fresh token first.

Accept the shot only when the response reports `ready:true`, `status:"delivered"`,
`capture_verified:true`, a ready audit, and the expected revision/package fingerprint. Inspect the
clean PNG: it must use the intended camera and contain no grid, label, gizmo, frustum, or selection
outline.

## 6. Discover assets instead of guessing IDs

This tutorial hard-codes the canonical `mixamo:x-bot` id. For every other character, prop, or
motion, discover the exact catalog id first and copy it unchanged:

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
| `confirm_required`       | Issue a fresh single-use token from `POST /api/agent/confirm-token`, retry the call   |
| audit not ready          | Correct only reported issues, then audit again                                        |
| capture not verified     | Do not claim completion; repeat delivery against the latest exact revision            |

The complete code-by-code contract lives in the
[Agent Workbench recovery table](/agents/workbench/#revision-conflicts-and-uncertain-outcomes).
