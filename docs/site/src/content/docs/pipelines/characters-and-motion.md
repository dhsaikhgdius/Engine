---
title: Characters, Rigging & Motion
description: Validated humanoid assets, deterministic skeletal motion, semantic joint controls, IK, and Agent-native discovery.
---

Director treats a character as a licensed, measured, hashed runtime artifact—not as
an arbitrary model URL. Packaged catalog counts live on
[Feature Status](/reference/feature-status/#catalog-counts) (108 Mixamo humanoids and 14
skeletal clips at last verification).

## Runtime order

Every frame evaluates the same stable stack:

1. sample the skeletal motion from the project frame;
2. apply bounded semantic controls such as `head.yaw` or `leftElbow.bend`;
3. solve local-metre hand and foot IK goals;
4. update skinning and render;
5. omit all bones, gizmos, grids, and labels from clean capture.

This makes scrub, still capture, deterministic export, and Agent verification agree.

## Agent discovery

An Agent searches instead of guessing:

```json
{
  "op": "catalog",
  "catalog": "character_assets",
  "query": "Abe",
  "offset": 0,
  "limit": 25
}
```

The result includes a complete `asset` object, thumbnail, measured height and floor
offset, rig metadata, hashes, source provenance, and license URL. Pass `asset`
unchanged to `upsert_asset`, then reference its ID from `add_object` in the same
atomic `author` batch.

Use `catalog:"character_motions"` to discover valid clip IDs and playback defaults.
Apply them with `set_character_motion`; use `set_character_pose_controls` for FK-like
semantic edits and `set_character_ik` for hand/foot targets. Observe `characters`
after authoring to verify all three layers.

## Asset acceptance

A library character must pass GLB validation, hash checks, metric pivot/height
measurement, rig and bone inventory, material/texture budgets, stress-pose skinning
review, animation retarget tests, real rendered thumbnail generation, and source/
license review. “It loads” is not an acceptance criterion.

The full engineering decision record—including asset sources, Blender Rigify and
VRM templates, topology and weight-paint guidance, Three.js retargeting/IK libraries,
MediaPipe capture, MotionGPT/MDM, and image-to-3D model options—is maintained at
`docs/site/src/content/docs/engineering/CHARACTER_ASSET_MOTION_PIPELINE.md`.
