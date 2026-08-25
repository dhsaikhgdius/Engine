---
title: Reference Image Reconstruction
description: Turn a photo or sketch into a bounded, editable Stage plan with explicit provenance.
---

Reference reconstruction is available from **3D Stage → Model Library → Reference Reconstruction**.
It does not mutate the Stage while analysis is running. Director first prepares an inspectable plan,
then applies only the objects and lights that you keep enabled.

## Workflow

1. Choose a PNG, JPEG, or WebP image. Director normalizes it to at most 1280 pixels on its longest
   side and rejects encoded payloads above 5 MiB.
2. Add optional intent such as “block only the architecture” and choose append or replace mode.
3. Select an analysis mode:
   - **Auto** uses an available hosted vision Profile and falls back visibly when none succeeds.
   - **Vision** requires a configured hosted vision Profile and fails instead of silently degrading.
   - **Local scaffold** uses only measured palette, luminance, edge density, foreground coverage,
     and aspect ratio. It is not semantic image understanding.
4. Review the summary, confidence, warnings, object names, primitive types, colors, placement intent,
   positions, scales, and suggested lights.
5. Apply the plan. The complete change is one undoable Stage mutation.

Closing or cancelling the dialog aborts the active request. If the project revision changes after
analysis, apply is blocked and the image must be analyzed again; a stale plan never overwrites newer
Stage work.

## Trust and provenance

The browser computes SHA-256 over the normalized image. The server checks that hash, byte limit, and
PNG/JPEG/WebP magic before any provider call. A vision model can only submit a strict schema with a
bounded primitive and light vocabulary. IDs, target revision, source hash, Profile, model, token
usage, warnings, and final output IDs are Director-owned fields.

The applied project stores the source image as a project asset, one `referenceReconstructions` plan
record, and an image reference binding on each generated object. The plan never stores the source
base64 bytes. Agent-authored objects use the same `reference_bindings` schema, so provenance does not
change meaning across human and Workbench authoring.

## Supported boundary

This workflow creates editable blocking primitives. A configured vision Profile can infer visible
composition and approximate object categories, but single-view depth, scale, occlusion, and unseen
surfaces remain inferred. The local path is deliberately low-confidence and never claims to have
recognized image semantics. Reconstruction is not photogrammetry, mesh recovery, or a guarantee of
model-provider availability.
