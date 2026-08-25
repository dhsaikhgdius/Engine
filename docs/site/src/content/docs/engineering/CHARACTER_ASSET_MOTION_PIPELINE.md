---
title: Character assets, rigging, and motion pipeline
description: Engineering contract for the Mixamo character catalog, skeletal motion, semantic controls, IK, and future rig adapters.
---

Status: implemented foundation plus staged roadmap. This document is the engineering
contract for acquiring or generating a character, preparing it for the browser, and
making every meaningful operation available to a naive coding Agent.

## Decision summary

Director should not train or embed a new character system before using the mature
parts that already exist:

- ship browser assets as validated GLB/glTF 2.0;
- ship the validated local Mixamo catalog from `assets/library/mixamo-characters/` as the production baseline;
- normalize every imported rig to a small canonical humanoid vocabulary;
- evaluate animation deterministically from project frames;
- layer motion, semantic joint offsets, and IK in that order;
- use Blender/Rigify for authoring and repair, not as the browser runtime;
- add VRM 1.0 through `@pixiv/three-vrm` when facial expression, gaze, and avatar
  portability become required;
- use MediaPipe for video-to-pose capture and treat MotionGPT/MDM as optional
  asynchronous generation services, never as required browser dependencies;
- require catalog metadata, provenance, license, hashes, and quality reports before
  an Agent can add an asset.

The current repository catalogs **108 Mixamo humanoids** and **14 real skeletal animation
clips**. The default character is the catalog-backed Mixamo X Bot (`mixamo:x-bot`); it is not a
viewport-only fallback. The strict production manifests are:

- `assets/library/mixamo-characters/catalog.json`
- `assets/library/mixamo-animations/catalog.json`

`assets/library/director-characters/catalog.json` remains an older asset set and is not the current
production baseline. `frontend/director/src/comprehensive/editor/schema/characterAssetCatalog.ts` is a deprecated
FBX fixture, not the Agent asset source of truth. Agents discover the unified catalog through
`frontend/director/src/comprehensive/editor/schema/directorAgentAssetCatalog.ts`.

The Agent discovers them with `director_workbench {"op":"catalog", ...}` rather
than guessing file names or URLs.

## 1. Where to get good assets

The first filter is legal and operational, not aesthetic. An asset is not library
ready unless Director can record its source, license, author, original file hash,
conversion recipe, output hash, and redistribution policy.

| Source                          | Best use                                                | Policy                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adobe Mixamo                    | Ready-rigged biped characters and broad motion coverage | Current humanoid baseline. Adobe permits royalty-free use in films and games. Keep source provenance; do not present the raw files as Director-owned assets. |
| Poly Haven                      | HDRIs, materials, and environment/prop models           | Preferred redistributable source: its assets are CC0.                                                                                                        |
| Kenney                          | Stylized low-poly props and environment kits            | Preferred redistributable source: asset pages are CC0.                                                                                                       |
| Sketchfab and commercial stores | Specialist hero props and characters                    | User import only unless the exact asset license explicitly permits redistribution. Store the per-asset license; never infer it from the host site.           |
| In-house Blender work           | Hero characters and project-specific geometry           | Preferred when silhouette, deformation, or art direction matters more than breadth.                                                                          |
| Image-to-3D models              | Draft props and background geometry                     | Candidate generator only. Every result must pass the same geometry, texture, license, and visual-review gates as a human-authored model.                     |

Primary references:

- [Adobe Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)
  says Mixamo is for bipedal humanoids, identifies neutral-pose/clean-mesh/origin
  requirements, and permits royalty-free use in films and games.
- [Poly Haven license](https://polyhaven.com/license) declares its HDRIs, textures,
  and models CC0.
- [Kenney support](https://kenney.nl/support) declares game assets on its asset
  pages CC0 and attribution optional.

### Generated 3D candidates

Do not build a bespoke text/image-to-3D model. Put providers behind one job adapter
and benchmark them on the same acceptance set:

| Existing project                                                     | Strength                                                                             | Integration warning                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TRELLIS](https://github.com/microsoft/TRELLIS)                      | Image/text to mesh, Gaussian, or radiance-field output; GLB post-processing examples | GPU service, not browser runtime. Official source is the Git submodule `vendor/trellis` (`npm run setup:trellis`). Official repo recommends image conditioning for quality and reports a 16 GB NVIDIA minimum. Nested FlexiCubes and some mesh/render pip dependencies have separate licenses. |
| [Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)        | High-resolution shape and texture generation                                         | GPU service, not browser runtime. Official source is the Git submodule `vendor/hunyuan3d`. Review the community license (territory / MAU) and set `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1` before `npm run setup:hunyuan3d`. |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR)               | Fast single-image reconstruction                                                     | Produces a draft mesh, not production topology, UVs, rigging, or ground contact.                                                                                       |
| [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects) | Recent object reconstruction reference                                               | Research adapter only until output quality, hardware, and model-license gates pass.                                                                                    |

Generated humanoids should not go directly to auto-rigging. First run cleanup,
retopology, symmetry, separation, and neutral-pose checks. Generated topology often
looks plausible in a turntable while failing badly at shoulders, hips, fingers, and
mouth deformation.

## 2. What makes a good browser character

### Modeling and topology

- Build a clear neutral A- or T-pose, centered at the origin, with feet contacting
  the floor and no unexplained object-level scale.
- Use continuous body topology unless a deliberate rigid attachment is parented to
  a bone. Detached heads or limbs are not suitable for automatic humanoid rigging.
- Place deformation loops around shoulders, elbows, wrists, hips, knees, ankles,
  eyelids, and mouth. Add density where the silhouette bends, not uniformly.
- Remove duplicate vertices, zero-area faces, accidental internal geometry,
  non-finite attributes, and orphaned materials. Correct normals and tangents.
- Author with quads when deformation editing matters; triangulate deterministically
  for delivery and compare the post-triangulation silhouette.
- Limit skinning to four strongest bone influences per vertex for predictable WebGL
  delivery, normalize all weights, and reject vertices with no deform influence.
- Test extreme but plausible poses: arms overhead, elbow at 120 degrees, deep squat,
  crossed legs, wrist rotation, neck tilt, and one-foot contact.

### Coordinate and pivot contract

- Delivery is right-handed, Y-up, metric GLB/glTF. glTF stores meshes, skins,
  animations, morph targets, materials, and textures in one runtime-oriented format;
  see the [Khronos glTF registry](https://registry.khronos.org/glTF/) and
  [glTF reference guide](https://www.khronos.org/files/gltf20-reference-guide.pdf).
- The character's object origin is the floor pivot between the feet.
- `heightM`, `groundOffsetY`, `visualCenter`, and `labelAnchorY` are measured offline
  from the delivered model, never estimated by the Agent at placement time.
- The bind/rest pose and canonical facing direction are recorded in the catalog.
- Imported motion may translate `Hips`; Director separates in-place locomotion from
  authored root motion so object trajectories and skeletal motion do not fight.

### Materials and performance

- Use PBR metal/rough materials. Base color/emissive textures are sRGB; normal,
  roughness, metallic, and occlusion data are linear.
- Prefer one or a few atlases over many tiny materials. A visually simple model with
  40 draw calls is not a lightweight model.
- Generate MikkTSpace tangents when normal maps are present.
- Clamp library textures to a declared tier (the current Mixamo package uses WebP
  with a maximum dimension of 1024) and preserve higher-resolution sources outside
  the runtime package when licensed.
- Use Meshopt for geometry/animation delivery and hash final bytes. The
  [glTF Transform CLI](https://gltf-transform.dev/cli) already provides inspect,
  validate, dedup, prune, meshopt, simplify, resize, texture compression, and
  animation resampling; use it instead of rewriting those operations.
- Budgets must be measured per shot: triangle count, vertices, bones, skinned meshes,
  materials/draw calls, texture bytes, animation bytes, and GPU frame time. Do not
  use triangle count as the sole quality signal.

## 3. Rigging choices and reusable templates

### Current production template: Mixamo humanoid

Use the existing Mixamo skeleton as the first canonical adapter. Adobe's documented
input rules match the required preprocessing: recognizable biped, no large extra
appendages, neutral pose, one centered clean character, and no extra scene objects.
The package records the actual bone prefix and bone names because prefixes differ
between downloaded files.

The runtime maps prefix-independent canonical names such as `Hips`, `Spine`,
`LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, `LeftLeg`, and `LeftFoot`.
Do not key behavior to `mixamorig:` or a numbered prefix.

### Blender authoring template: Rigify

[Blender Rigify](https://docs.blender.org/manual/en/latest/addons/rigging/rigify/basics.html)
already supplies human, quadruped, cat, wolf, horse, and shark meta-rigs and assumes
one Blender unit is one metre. Use it for creating or repairing high-quality rigs.
Rigify generates controls, IK/FK mechanisms, and deform bones, but it does not skin
the mesh; weight painting and deformation QA remain required. Preserve the meta-rig
so the control rig can be regenerated.

Export only the deform skeleton and baked actions to GLB. Browser code should not
attempt to reproduce Rigify's complete animator UI or constraint network.

### Portable avatar template: VRM 1.0

[VRM](https://vrm.dev/en/vrm/vrm_features/) standardizes a glTF-based humanoid,
right-handed Y-up metric coordinates, T-pose, pose/expression/gaze operations,
materials, spring bones, first-person metadata, and per-avatar license information.
When Director adds facial expression, eye gaze, lip sync, or user avatars, use
[`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm) instead of creating another
avatar format. Keep VRM support as an adapter into the same Director canonical
controls, not a parallel UI.

## 4. Joint, bone, and action control

The evaluation order is part of the saved-scene contract:

1. sample the base skeletal clip at the exact project frame;
2. apply semantic pose-control offsets;
3. solve hand/foot IK goals;
4. update world matrices and skinning;
5. hide editor helpers for camera capture/export.

Changing the order makes a hand target drift, breaks deterministic scrubbing, or
causes user offsets to disappear under animation.

### FK and semantic controls

Agents should never author raw bone quaternions by name. They use bounded controls
such as `head.yaw`, `leftShoulder.pitch`, and `leftElbow.bend`. An adapter maps each
semantic control to the target rig's local axes and calibrated rest rotation.

The current schema exposes 38 bounded controls. Values are degrees, except
`body.offsetY`, which is local metres. `merge` preserves other controls; `replace`
starts from neutral. All inputs are Zod validated.

### IK

Use analytic two-bone IK for arms and legs because it is deterministic, fast, easy
to clamp, and gives an explicit pole vector. Targets are character-local metres and
carry `weight` plus `reachClamp`; unreachable targets never stretch a limb.

For longer or arbitrary chains, Three.js already provides
[`CCDIKSolver`](https://threejs.org/docs/pages/CCDIKSolver.html). Adopt it only when
the chain cannot be represented by the current two-bone solver, and persist the
target/effector/link limits rather than opaque solver state.

### Retargeting and instances

Three.js [`SkeletonUtils`](https://threejs.org/docs/pages/module-SkeletonUtils.html)
already provides safe skinned-mesh cloning plus skeleton and clip retargeting. The
current custom Mixamo retargeter remains useful because it enforces Director's exact
root-motion and naming policy; compare it against `SkeletonUtils.retargetClip`
instead of independently expanding generic retargeting logic.

Do not share one mutable skeleton between character instances. Geometry and
materials may be reused; bones and mixer/action state must be per instance.

## 5. Motion acquisition and generation

| Input                    | Existing technology                                                                                        | Recommended role                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Curated animation        | Mixamo clips                                                                                               | Production baseline; deterministic, cheap, and license-understood.                                                                                                       |
| Webcam/video             | [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) | Browser or service-side body landmark extraction. It outputs image and 3D world landmarks; add temporal filtering, foot locking, scale calibration, and rig retargeting. |
| Text prompt              | [MotionGPT](https://github.com/OpenMotionLab/MotionGPT)                                                    | Optional GPU job for text-to-motion, captioning, prediction, and in-between. Its output is joint motion, not a production GLB clip.                                      |
| Text prompt/edit         | [MDM](https://github.com/guytevet/motion-diffusion-model)                                                  | Optional GPU job when diffusion inpainting/body-part or temporal editing is valuable.                                                                                    |
| Research dataset/tooling | [HumanML3D](https://github.com/EricGuo5513/HumanML3D), [PyMO](https://github.com/omimo/PyMO)               | Evaluation and conversion research only; code, datasets, AMASS/SMPL bodies, and checkpoints can have different licenses. Audit each layer separately.                    |

Do not put MotionGPT or MDM in the browser bundle. A motion generation service must
return an immutable candidate with prompt, model/checkpoint revision, seed, FPS,
joint convention, duration, source license, preview, quality metrics, and hash. Only
after normalization, foot-contact cleanup, retarget QA, and user/Agent acceptance is
the clip promoted into the catalog.

The minimum motion QA suite checks:

- no NaN/Infinity values or missing required joints;
- stable frame rate and duration;
- quaternion continuity and normalized rotations;
- plausible joint limits and no sudden angular spikes;
- foot sliding/contact error and root velocity;
- ground penetration and self-intersection warnings;
- retargeted comparison on short, tall, broad, and slim characters;
- frame 0, mid-frame, loop boundary, and exact capture/export parity.

## 6. Agent-native contract

“Agent-native” means every operation needed to finish a shot has a typed discovery,
mutation, observation, and verification path. It does not mean placing a chat box
next to controls intended only for a human.

### Discovery

```json
{
  "op": "catalog",
  "catalog": "character_assets",
  "query": "Abe",
  "offset": 0,
  "limit": 25
}
```

The result returns an exact `asset` object plus thumbnail, geometry/rig measurements,
output hash, source hash, license URL, and pagination. Motions use
`catalog:"character_motions"` and return exact clip IDs and playback defaults.

### Atomic authoring

The Agent passes the selected `asset` unchanged to `upsert_asset`, then references
that ID from `add_object` in the same `author` call. It does not synthesize a URL,
bone prefix, height, or ground offset. Character actions use:

- `set_character_motion` / `clear_character_motion`;
- `set_character_pose_controls` / `clear_character_pose_controls`;
- `set_character_ik` / `clear_character_ik`.

### Perception and acceptance

- `observe.fields:["characters"]` returns motion, controls, and IK state.
- project frames are the only animation clock, so viewport scrubbing, capture, and
  export evaluate the same pose.
- every mutation supports revision guarding and an idempotency key.
- audit catches structural and spatial failures; deliver returns clean camera pixels
  and hashed evidence. Editor bones, grids, labels, gizmos, and helpers never enter
  the clean capture.

### Future generation API

Keep slow or nondeterministic model inference outside `author`:

```text
motion.generate(prompt, duration, constraints, provider) -> job_id
motion.inspect(job_id) -> candidates + previews + provenance
motion.promote(candidate_id) -> immutable catalog clip
author(set_character_motion with promoted clip_id) -> deterministic project edit
```

The same pattern applies to generated 3D assets. An Agent may launch and inspect a
job, but only a validated promoted artifact becomes authorable scene state.

## 7. Delivery gates

A new character asset is complete only when all of the following are true:

1. source and output hashes are recorded;
2. redistribution policy and license URL are explicit;
3. GLB validation passes and all runtime data is local or intentionally remote;
4. metric height, floor pivot, visual center, label anchor, and bounds are measured;
5. rig type, prefix, bone names/count, rest pose, and facing convention are known;
6. textures/materials and draw calls meet a declared performance tier;
7. thumbnails are real renders of the exact output bytes;
8. neutral and stress-pose deformation reviews pass;
9. at least idle, locomotion, semantic controls, and each IK effector are tested;
10. the Agent can discover, add, animate, observe, capture, and remove it without DOM
    clicking or guessing an identifier.

This gate is deliberately stricter than “the model loads.” A character that cannot
be grounded, retargeted, verified, licensed, and operated by an Agent is an import,
not a production asset.
