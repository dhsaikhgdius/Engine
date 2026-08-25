---
title: Pipeline & System Design
description: How Director carries identity, time, cameras, media, evidence, and recovery from a brief to final delivery.
---

Director is one production system with three editing views:

- **Canvas** develops prompts, references, variants, and generation lineage.
- **3D Stage** owns metric blocking, performance, cameras, lenses, and previs.
- **Video Editor** owns picture/audio assembly and editorial timing.

The pipeline is complete only when these views preserve the same production
identities and can produce inspectable, recoverable delivery artifacts.

## Pipeline overview

```text
Brief / Fountain / references
          │
          v
Canvas development ── generation jobs ──> immutable media versions
          │                                      │
          ├──────── selected references ─────────┘
          v
Stage blocking → character performance → camera coverage
          │
          v
Audit → clean frame → Shot IR → hashed Shot Package
          │                          │
          │                          ├─ Blender / Unreal / USD
          │                          └─ video-generation provider
          v
Generated plates and audio return to the media library
          │
          v
Video editorial → OTIO/OTIOZ → review/version approval → archive
```

## Sources of truth

Director deliberately uses more than one model. Each model has one responsibility;
adapters project them into external formats without becoming competing editors.

| Concern                                 | Source of truth        | Important projections                         |
| --------------------------------------- | ---------------------- | --------------------------------------------- |
| Stage, cameras, characters, performance | `DirectorProject v1`   | StageScene v5, Shot IR, DCC package, glTF/USD |
| Canvas graph and Video timeline         | Creative workspace v2  | Agent snapshot, OTIO/OTIOZ, preview/export    |
| Media bytes and derivatives             | Persistent media store | object URLs, proxies, waveforms, thumbnails   |
| Multi-scene project and cuts            | Production record      | scene tabs and project overview               |
| Shared editing and review               | Yjs document           | presence, comments, versions, structural diff |
| External execution                      | Production job         | provider request, progress, error, artifacts  |

Large media bytes never belong in scene or collaboration JSON. These documents keep
stable IDs, metadata, hashes, and safe references; the media or artifact store owns
the actual bytes.

## What is implemented

- Validated `DirectorProject` state with hashed revisions.
- Scene-scoped Canvas/Video state with snapshot fingerprints and atomic Agent edits.
- Rational frame rates, integer frames, SMPTE start timecode, and drop-frame support.
- Catalog-backed Mixamo characters, skeletal motion, semantic pose controls, and IK.
- Reusable performance takes with independent camera coverage.
- Helper-free clean, depth, normal, object-ID, and mask capture.
- Shot IR, camera trajectories, AI control sidecars, artifact hashes, and package
  fingerprints.
- Fountain, OTIO/OTIOZ, glTF, USD, and USDZ adapters with fixtures.
- Persistent media, waveforms, proxies, explicit offline references, and relink.
- Yjs synchronization, awareness, anchored review comments, named versions,
  comparison, and restore.
- Validated Blender export with an optional clay preview and a constrained,
  review-before-apply stable-ID mesh/transform return path.

## What remains partial

### Cross-workspace identity

Canvas, Stage, Video, generation jobs, and DCC packages have stable local IDs, but do
not yet share a single project-level lineage graph. The next major contract should be
a `ProductionGraph` that owns stable asset, screenplay beat, shot, artifact, usage,
and review identities while leaving each editor responsible for its own detailed
state.

### Durable jobs

Image and video jobs are inspectable, but image, video, audio, proxy/transcode, and
DCC work should share one durable state machine:

```text
queued → running → succeeded
                 ↘ failed
                 ↘ cancelled
                 ↘ outcome-unknown → reconcile
```

Retries create attempts and immutable output versions. They must not duplicate graph
nodes or silently overwrite a previously promoted result.

### DCC round trip

Blender mesh replacements and object/camera transforms can return through a hashed,
stable-ID package, reviewable ImportPlan, revision guard, and idempotent authoring
batch. The remaining DCC work is broader semantics: Blender-only object creation,
camera optics and lights, armature pose baking, an interactive add-on, and explicit
fingerprint-bound human approvals. Unreal should use OpenUSD plus CineCamera/Level
Sequence mapping rather than a second proprietary scene format.

## Pipeline gates

### 1. Intake

Create production, scene, creative-scope, timebase, and stable story identities.
Imports are validated and declare whether they create, link, merge, or replace.

### 2. Asset normalization

Hash and probe the source, record provenance/license, create runtime proxies and
decoded derivatives, verify metric bounds and character rigs, and preserve explicit
offline state.

### 3. Canvas development

Freeze provider/model/configuration/input hashes for each job. Generated outputs are
immutable versions that may be compared, promoted, or reused.

### 4. Stage and coverage

Author metre-scale blocking, character performance, physical cameras, rational
timeline frames, reusable takes, and independent camera coverage.

### 5. Shot acceptance

Audit the exact revision, capture helper-free evidence, and emit Shot IR plus a
hashed control package. Downstream providers consume this package instead of
scraping the editor.

### 6. DCC or generation

Translate the accepted package through a capability-checked adapter. Unsupported
controls produce a degradation report instead of disappearing silently.

### 7. Editorial and review

Return outputs as new media versions, preserve source/project timebase distinctions,
edit with matching preview/export semantics, and bind comments or approvals to exact
revision and artifact fingerprints.

### 8. Interchange and archive

Export a manifest first and bytes second. Every adapter publishes supported and
degraded semantics; round trips are fixture tested.

## Core invariants

Every boundary declares:

1. stable identity and source revision/fingerprint;
2. metre scale, handedness, up axis, and camera forward axis;
3. rational frame rate, integer frames, start timecode, and drop-frame mode;
4. display/data color space and helper visibility;
5. source/derivative and provider lineage;
6. create/link/merge/replace behavior;
7. failure, retry, and reconciliation behavior.

Schema validity is only the first gate. Director separately checks graph integrity,
production readiness, rendered evidence, and final visual quality.

## Agent-native operation

A naive Agent uses semantic IDs and outcomes rather than DOM coordinates or raw bone
quaternions:

```text
capabilities/catalog
  → observe exact target and guard
  → execute one atomic intent
  → observe/diff
  → audit
  → preview or deliver
  → inspect pixels and artifacts
```

`director_workbench` owns Stage, `director_creative` owns Canvas/Video,
`stage_video` owns generation jobs, and `director_dcc` owns
DCC handoff.

## Recommended implementation order

1. Add `ProductionGraph v1` and optional graph IDs without replacing existing stores.
2. Add one durable job store for generation, transcode/proxy, and DCC execution.
3. Create immutable `ArtifactVersion` records and explicit promote/use operations.
4. Standardize `ImportPlan`/`ImportReceipt` and
   `ExportManifest`/`ExportReceipt` across adapters.
5. Add Blender return packages and a reviewable atomic merge.
6. Add OpenUSD-based Unreal export with camera/sequence fixtures.
7. Bind review approvals to project, creative, and Shot Package fingerprints.
8. Move heavy media work to cancellable workers or gateway jobs.

The full engineering contract, migration plan, failure table, acceptance matrix, and
source map are maintained in `docs/site/src/content/docs/engineering/PIPELINE_SYSTEM_DESIGN.md`.
