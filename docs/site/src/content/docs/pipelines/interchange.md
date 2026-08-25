---
title: Interchange & DCC Handoff
description: The tested Director subsets for editorial, screenplay, 3D, Blender, and portable shot packages.
---

Director uses a manifest-first interchange contract. Every boundary declares identity, metric
units, axes, timebase, and degradation warnings. “Supported” means the documented Director subset
round-trips through fixtures; it does not imply lossless support for every feature of an external
standard.

## Capability matrix

| Format             | Direction     | Preserved                                                                                                                                         | Deliberate boundary                                                                                                                                              |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fountain           | import/export | Scene headings and Director shot/storyboard metadata                                                                                              | Not a complete screenplay AST or layout engine                                                                                                                   |
| OTIO               | import/export | Cuts, rational time ranges, stable references, track order                                                                                        | Transitions are warned and ignored; unknown schema becomes a gap                                                                                                 |
| OTIOZ              | import/export | Director OTIO subset in a bounded ZIP package                                                                                                     | ZIP is validated for size, CRC, and traversal; not every external media bundle convention                                                                        |
| glTF/GLB           | import/export | Stable IDs, transforms, cameras, asset references, Director metadata                                                                              | Not a lossless material, constraint, or animation round trip for every DCC                                                                                       |
| USDA               | import/export | Metre-scale, Y-up, right-handed Director scene bridge                                                                                             | ASCII scene subset; binary USDC requires a host OpenUSD bridge                                                                                                   |
| USDZ               | import/export | Aligned archive containing `scene.usda` and manifest                                                                                              | Does not currently embed every texture/model payload                                                                                                             |
| OBJ/MTL ZIP        | export        | All or selected supported Stage primitives, baked world transforms, scalar materials, stable IDs, metric/Y-up manifest, and SHA-256 file receipts | Static primitive geometry only; linked model bytes, cameras, lights, animation, texture maps, and hierarchy are omitted with visible warnings                    |
| ASCII STL ZIP      | export        | All or selected supported Stage primitives, baked world transforms, stable-ID solid names, metric/Y-up manifest, and SHA-256 file receipts        | No materials, textures, hierarchy, cameras, lights, animation, or embedded unit declaration; the sidecar is required for full interpretation                     |
| Blender `.blend`   | import        | Active-scene current-frame GLB snapshot, selected static perspective cameras, source-time audit metadata                                          | No deep editable hierarchy, animation playback/timeline remap, live sync, or safe processing of untrusted files; Blender-only semantics are unsupported or lossy |
| Blender round trip | export/return | Validated scene/camera handoff, clay preview, stable-ID mesh/transform return                                                                     | Return is limited to hashed packages below the DCC job root; Blender-only objects and optics/light edits are not auto-imported                                   |

The editor's **Interchange** menu is the human entry point. Stage OTIO and Video workspace OTIO
have separate adapters because they preserve different source models. Import always validates
before replacing or merging state.

## Native Blender mode is not interchange

`npm run blender` starts a local Blender 4.2+ process with `worldengine_studio`, together with the same Director
frontend and Gateway. Director binds its `nativeScene.projectId` to that live scene, renders the
revisioned preview in Stage, and projects native roots into the existing Director scene tree. This
is the normal integrated modeling path, not repeated export/import between two projects.

| Workflow                      | Use it when                                       | Authoritative native data                      |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Integrated Blender       | Directing and modeling one current production     | Bound Blender scene                       |
| Raw `.blend` import           | Starting from an existing trusted Blender file    | Imported current-frame scene snapshot          |
| Director ↔ Blender round trip | Sending a bounded snapshot to another Blender job | Reviewed return package for known Director IDs |

In integrated mode, Director owns the production-facing root projection: identity, name,
visibility, transform, camera/timeline references, and shot context. Blender owns child
hierarchy, mesh topology, Edit Mode, modifiers, materials, UVs, armatures, actions, and NLA.
Director root edits become revision-checked native operations and the resulting snapshot is read
back into the same object. Native child selection resolves to the owning Director root while Mesh
editor and Rig keep child-level editing available in the inspector.

The live scene snapshot is transient shared evidence, not another persisted project. A foreign
project ID is not attached to the current Director project, and native tools are scoped to the
Director-selected root. Use the Interchange menu only when intentionally crossing a file boundary.
See [Scenes & Assets](/editor/scenes-and-assets/#native-blender-assets) for the operator flow
and [Blender Native Backend](/engineering/blender_bridge/) for the engineering contract.

## Existing `.blend` scenes

Raw `.blend` import and Director round trip are separate workflows. Raw import runs Blender
headlessly to produce `director-blend-scene-v1`, then shows a server-persisted
`director-blend-scene-import-plan-v1`. The plan can include the scene bundle and any subset of
perspective cameras. It is read-only until Apply receives its `plan_id`, exact
`expected_revision`, and retry-only `idempotency_key`.

Apply revalidates source and artifact hashes, rebuilds the plan against the live project, copies the
GLB into immutable content-addressed storage, and performs one atomic authoring mutation. Director
uses `modelNormalization: "preserve"`, so the bundle keeps authored metre scale, origin, and world
layout. The generated GLB is served at `/dcc-import/<hash-prefix>/<asset-id>.glb`.

v1 evaluates only Blender's active scene. Its current frame becomes the visible GLB snapshot, and
selected perspective cameras become static Director cameras sampled at that frame. The bundle
remains one Director root scene object. Its child hierarchy, skins, morphs, materials, and embedded
GLB animation clips may remain inside the asset, but Director v1 neither maps nor plays those clips;
children and actions are not converted into editable objects or timeline tracks. The manifest's
rational frame rate, frame range, and current frame are review/provenance metadata only and do not
rewrite the Director project timebase, IN/OUT, playhead, or timeline. Unsupported Blender semantics
are never silently claimed: lights, world/HDRI/compositor state, orthographic cameras, constraints,
custom shader equivalence, lens shift, exact camera roll, and Blender-specific simulation are
warnings or omissions. This is batch import, not live Blender synchronization.

This is a trusted-local operation. `--disable-autoexec` prevents automatic embedded Python/driver
execution, but it does not provide an OS/container sandbox for Blender's native file parser. Private
job paths, size limits, and process timeouts are containment measures, not a sandbox. Process
untrusted `.blend` files in a container or VM before they reach Director.

## Coordinate system

The native Director and glTF convention is:

```text
linear unit: metre
up axis: Y
handedness: right
metersPerUnit: 1
```

Character objects must carry a concrete asset binding across the boundary. An interchange export
fails instead of serializing a character whose visible model would have to be guessed by the
receiver.

## Scoped static mesh export

OBJ and STL are export-only compatibility artifacts, delivered as ZIP archives rather than bare
files. `director-obj.zip` contains `director-scene.obj`, `director-scene.mtl`, and
`director-export.json`; `director-stl.zip` contains `director-scene.stl` and the same report
sidecar. The report records the exact project revision and requested scope, included and omitted
stable IDs, triangle counts, negative-scale winding correction, metres/Y-up/right-handed axes,
warnings, byte lengths, and SHA-256 for every geometry payload.

The Interchange menu can export the whole Stage or the current selection. Agent export accepts the
same exact object IDs through `object_ids`. Both paths are bounded to 2,048 scoped objects and one
million triangles. Hidden objects and unsupported object kinds are omitted visibly; an export with
no supported visible primitive fails. Current primitive tessellation covers box, sphere, cylinder,
torus, cone, and pyramid. Linked GLB/GLTF/OBJ/FBX bytes are not materialized into this browser
exporter, so use glTF/USD or the Blender bridge when those meshes must cross the boundary.

## Professional time

The canonical editorial contract stores rational frame rates, integer frames, SMPTE start
timecode, and drop-frame mode. It supports rates such as `24000/1001`, `30000/1001`, and
`60000/1001`. Some compatibility UI still exposes numeric `fps` or seconds; adapters normalize
those values before interchange.

Keep three concepts separate:

- **project timebase** — the Director timeline's canonical rate and start timecode;
- **source timebase** — the media file's own rate and source range;
- **delivery timebase** — the format requested by export or generation.

Do not round-trip `29.97` as an imprecise decimal when `30000/1001` is available.

## Media, proxies, and offline relink

Director can persist local media metadata/bytes through OPFS or IndexedDB (with a memory fallback),
generate browser-decodable audio waveforms, attach proxies, select a playback source, mark media
offline, and score a user-selected relink candidate. The current workflow is local-browser
oriented. Background server transcoding, remote object storage, and automatic cross-machine relink
are not yet a production service.

An export references stable media identity and provenance. It must not silently convert an offline
reference into a successful online asset.

## Shot and AI control packages

For generation or compositing, use a Stage delivery rather than scraping the viewport. The
`.director-control.zip` package can contain:

- manifest and Shot IR;
- frame-evaluated camera trajectory with rational timebase;
- `ai/control.json`;
- helper-free `clean`, PBR `albedo`/`roughness`/`metalness`/`emissive`/`ao`/`shadow`, packed `depth`,
  view-space `normal`, stable `object-id`, and binary `mask` PNGs;
- optional metric float-depth EXR with explicit camera-space depth semantics;
- SHA-256 for each artifact and one package fingerprint.

The same exact camera/frame evaluator drives capture, Shot IR, and trajectory export. The current
LTX-2.3 adapter consumes the clean frame only; the additional passes are available to other or
future conditioning adapters and must not be described as current LTX multi-control input.

The timeline multimodal frame package can additionally emit one instance-annotation JSON per frame.
It reuses the object-ID pixels and records the stable object ID, RGB value, visible-pixel count,
frame coverage, and top-left pixel bounds. It does not claim an occlusion ratio from a single view.

## Agent boundary

`director_creative interchange` exposes `capabilities`, `plan-export`, `export`, `plan-import`,
and `import` for bounded OTIO/OTIOZ, Fountain, glTF/GLB, USD/USDZ, OBJ, and STL transfer. Every
plan is tied to the exact Stage revision or creative-workspace fingerprint. Export returns UTF-8
or base64 payload, archive SHA-256, byte count, compatibility warnings, and a stable receipt;
inline transfer is capped at 8 MiB. OBJ/STL plans may carry exact `object_ids`, which become part
of the plan identity and ZIP manifest.

JSON import goes through `plan-import` → `import`: the source is `inline` (UTF-8 or base64), a
Gallery `media_id`, or a `workspace_path` resolved by a trusted host. `plan-import` returns an
immutable guard-fingerprinted plan with a summary and warnings; `import` rechecks that fingerprint,
commits atomically, and returns a receipt with before/after guards. OBJ/STL stay export-only, and
the documented **Limited** format-subset boundaries are unchanged. The human Interchange menu file
picker remains available.

For Stage acceptance and provider-neutral evidence, use `director_workbench` `shot_ir`,
`shot_package`, or `deliver`. For Blender, discover and invoke `director_dcc` capabilities.

## Round-trip checklist

1. Record the source project revision/fingerprint.
2. Confirm scale, axes, camera forward direction, and timebase.
3. Validate all character asset bindings and media references.
4. Export and retain the manifest/receipt plus warnings.
5. Re-import into a disposable scope.
6. Compare stable IDs, transforms, cameras, cuts, and time ranges.
7. Inspect a clean camera frame; schema equality does not prove visual equality.

See [Feature status](/reference/feature-status/) for current maturity and
[Pipeline & System Design](/pipelines/system-design/) for the larger production model.
