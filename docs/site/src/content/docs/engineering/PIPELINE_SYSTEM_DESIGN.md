---
title: Director pipeline and system design
---

## 1. Purpose

Director is not three unrelated editors. It is one production system with three
views over the same filmmaking intent:

- **Canvas** develops references, prompts, variants, and generated media lineage.
- **3D Stage** owns metric blocking, characters, performance, cameras, lenses, and
  frame-native previs.
- **Video Editor** owns editorial timing, picture/audio assembly, captions, and
  delivery order.

The system succeeds when a user or a naive Agent can move from a brief to an
inspectable delivery without silently losing identity, timing, camera intent,
provenance, or recoverability.

This document is the canonical engineering model for that pipeline. It records what
is implemented, what is partial, and what should be built next. UI resemblance to
another product is not an acceptance criterion; shared data semantics and complete
recovery paths are.

## 2. Current status at a glance

| Area                                   | Status           | Current contract                                                               |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| Stage scene and production state       | Implemented      | `DirectorProject v1`, Zod validated, revision hashed                           |
| Compact Agent compatibility            | Implemented      | `StageScene v5`, derived through `directorStageAdapter`                        |
| Canvas and Video state                 | Implemented      | Scene-scoped creative workspace v2 with snapshot fingerprint                   |
| Rational frame rate and SMPTE timecode | Implemented      | Rational rate, integer frame, start timecode, drop-frame metadata              |
| Character asset and motion runtime     | Implemented      | Catalog-backed Mixamo GLB, canonical controls, skeletal clip, IK               |
| Shot evidence                          | Implemented      | Shot IR plus clean/depth/normal/object-ID/mask Shot Package                    |
| Editorial interchange                  | Implemented      | Fountain, OTIO/OTIOZ, glTF, USD/USDZ adapters with fixtures                    |
| Media engineering                      | Implemented core | Persistent bytes, waveform cache, proxy selection, offline state, relink       |
| Collaboration and review               | Implemented core | Yjs document, awareness, comments, versions, comparison, restore               |
| Blender handoff                        | Partial          | Validated one-way `.blend` export and optional preview; no round-trip merge    |
| Unreal Engine handoff                  | Partial          | Headless connector with Sequencer bake, skeletal/material import, and receipts |
| Generation orchestration               | Partial          | Inspectable image/video jobs exist; no unified durable job DAG                 |
| Cross-workspace production graph       | Partial          | Stable local IDs exist, but identity and lineage are still split across stores |

“Implemented core” means the contract and tested logic exist. It does not imply that
large-media background processing, remote collaboration deployment, or every codec is
available in every browser.

## 3. System principles

### 3.1 One source of truth per concern

Director should not force every concern into one giant JSON document. It should have
one authoritative owner for each kind of truth:

| Concern                                    | Authoritative owner        | Derived views                                        |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------- |
| Metric scene, actors, cameras, performance | `DirectorProject`          | StageScene, Shot IR, DCC package, glTF/USD           |
| Canvas graph and editorial timeline        | Creative workspace         | Agent snapshot, OTIO/OTIOZ, preview/export           |
| Media bytes and decoded derivatives        | Persistent media store     | Object URLs, proxies, waveforms, thumbnails          |
| Multi-scene project and editorial cuts     | Production record          | Scene tabs, linked/pinned cuts, project overview     |
| Shared editing and review                  | Yjs collaboration document | Presence, review panel, versions, comparisons        |
| External execution                         | Durable job record         | Provider request, progress UI, output asset versions |

Adapters may project or package these models, but must not become competing editable
sources of truth.

### 3.2 State is not evidence

A valid project proves that data is well shaped. It does not prove that a subject is
visible, a motion deforms correctly, a clean frame contains no helpers, or an export
matches the requested revision. Director therefore separates:

1. **Schema validation** — types, enums, ranges, limits.
2. **Graph validation** — referenced objects, assets, cameras, tracks, and media exist.
3. **Production audit** — grounding, framing, overlap, timing, coverage, online media.
4. **Rendered evidence** — helper-free pixels and technical passes tied to a revision.
5. **Human or multimodal review** — composition and creative quality.

No operation should report creative success after only step 1.

### 3.3 Portable metadata, external binary ownership

Project and collaboration documents contain stable IDs, safe relative references,
hashes, and metadata. Large binary media belongs to the media store, a package, or an
external artifact store. `blob:` and `data:` URLs are runtime handles and must never be
treated as durable interchange identifiers.

### 3.4 Explicit conventions

Every boundary must declare:

- linear unit and scale;
- handedness, up axis, and camera forward axis;
- rational frame rate, integer frame range, start timecode, and drop-frame mode;
- color space and whether a raster is display color or data;
- stable identity and the source revision/fingerprint;
- whether the operation replaces, merges, links, or creates a new version.

## 4. Current model topology

```text
ProductionRecord
  └─ scenes[] ────────────────┐
                              v
                       DirectorProject v1
                       ├─ scene + rational timeline
                       ├─ assets + reference bindings
                       ├─ objects + character rigs
                       ├─ cameras + physical optics
                       ├─ storyboard
                       └─ performance takes + coverage
                              │
              ┌───────────────┼──────────────────┐
              v               v                  v
        StageScene v5       Shot IR       DCC/interchange packages
        compatibility       evaluated      Blender / glTF / USD

Scene-scoped Creative Workspace v2
  ├─ Canvas nodes + edges
  ├─ Video tracks + clips + settings
  └─ stable references to Persistent Media Store
                 │
                 ├─ OTIO / OTIOZ
                 ├─ preview / mixed export
                 └─ generated artifacts returned as media versions

Yjs Shared State
  ├─ validated Stage projection
  ├─ validated Creative projection
  ├─ awareness/presence
  ├─ review comments
  └─ named versions and structural diffs
```

The long-term goal is not to delete these models. It is to place them behind one
production graph that owns cross-workspace identity and lineage.

## 5. End-to-end production pipeline

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
Audit → revision-bound clean frame → Shot IR → Shot Package
          │                                      │
          │                                      ├─ DCC / Blender / Unreal
          │                                      └─ video-generation provider
          v
Generated plates / previs video / audio returned to media library
          │
          v
Video editorial → OTIO/OTIOZ → review/version approval → archive/delivery
```

### Gate 0 — intake and project identity

**Input:** brief, Fountain screenplay, references, existing project, or Agent intent.

**Output:** production ID, scene ID, creative scope ID, rational timebase, stable
character/location/prop/shot identities, and an initial version.

**Required checks:**

- import is size limited and schema validated;
- collisions are handled by explicit create/link/replace policy;
- source files receive hashes and provenance;
- screenplay beats keep stable IDs across re-import.

**Next improvement:** introduce a project-level `ProductionGraph` manifest so the
same shot and asset identities are shared by Canvas, Stage, Video, generation jobs,
and DCC handoffs.

### Gate 1 — asset ingest and normalization

**Input:** GLB/GLTF/OBJ, image, panorama, audio, video, local Mixamo character, or
external catalog reference.

**Output:** immutable source asset plus zero or more derivatives: runtime proxy,
thumbnail/poster, waveform, normalized character metadata, or DCC source.

**Required checks:**

- byte hash, MIME/type probe, dimensions/duration, license/provenance;
- metre scale and grounded bounds for 3D assets;
- rig vocabulary and bone coverage for characters;
- source/derivative relationship and proxy policy;
- offline state remains explicit instead of deleting the reference.

**Implemented foundation:** persistent media, proxy selection, waveform cache,
relink, Mixamo catalog metadata, and glTF normalization.

**Next improvement:** make all source and derivative records use one content-addressed
asset manifest instead of workspace-specific media and model records.

### Gate 2 — Canvas development and generation lineage

**Input:** assets, prompts, style/location/character references, and screenplay beats.

**Output:** a typed graph of creative decisions and immutable generated output
versions. Promoting an output creates or updates a stable production asset; it does
not overwrite historical outputs.

**Required checks:**

- typed input/output ports and provider capability validation;
- provider, model, configuration, seed, cost estimate, and input hashes are frozen;
- job retries create new attempts, not duplicate graph nodes;
- cancellation and unknown outcomes are recoverable;
- outputs retain lineage back to exact inputs.

**Current limitation:** Canvas state is durable, but generation is not yet a unified
queued job DAG shared by all providers and workspaces.

### Gate 3 — Stage blocking, performance, and coverage

**Input:** promoted production assets and shot intent.

**Output:** validated `DirectorProject` objects, reusable performance takes, cameras,
coverage shots, storyboard links, and a frame-native timeline.

**Required checks:**

- primitives and imported models follow metre-scale placement rules;
- characters resolve to a known rig and grounded visual metrics;
- motion, semantic controls, and IK evaluate in one documented order;
- camera filmback, lens, focus, exposure metadata, aspect, and clipping are explicit;
- performance is not duplicated for each camera coverage;
- timeline values use integer frames on the rational project timebase.

**Implemented foundation:** Mixamo retargeting, controls/IK, reusable takes/coverage,
physical camera metadata, quad inspection, deterministic sampling, and workbench audit.

### Gate 4 — shot acceptance and control-package creation

**Input:** camera or coverage shot, exact frame/range, output raster, and latest
project revision.

**Output:**

- helper-free clean color;
- depth, normal, object-ID, and mask passes as requested;
- Shot IR with evaluated scene and optics;
- sampled camera trajectory;
- provider-neutral AI control JSON;
- artifact hashes and package fingerprint.

**Required checks:**

- revision is checked before and after capture;
- every artifact is hashed and listed in the manifest;
- helper visibility and renderer state are restored even on failure;
- technical passes declare data color space;
- package frame range and timecode are exact.

This gate is the boundary between editable production intent and downstream rendering.
A provider should consume a Shot Package, not scrape the live editor.

### Gate 5 — DCC and generative rendering

There are two consumers of the accepted shot:

1. **DCC consumer** — Blender today, Unreal/OpenUSD next. It receives metric scene
   state, cameras, assets, animation, and a return contract.
2. **Generation consumer** — ComfyUI today, provider adapters next. It receives the
   Shot Package, prompt/config, references, and generation policy.

Both should run through the same durable job model:

```ts
interface ProductionJob {
  id: string;
  kind: "dcc-export" | "dcc-import" | "image" | "video" | "audio" | "transcode";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "outcome-unknown";
  attempt: number;
  inputFingerprint: string;
  providerSnapshot: { provider: string; model?: string; configuration: unknown };
  progress: { value: number; phase: string };
  artifacts: string[];
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

The job executor may be browser-local, gateway-local, or remote, but the job contract
and state transitions must remain identical.

### Gate 6 — media return and editorial

**Input:** generated/DCC-rendered plates, recorded previs, audio, captions, and source
media.

**Output:** frame-accurate Video timeline plus OTIO/OTIOZ or final media delivery.

**Required checks:**

- returned media becomes a new immutable asset version;
- source frame rate and project timebase are not conflated;
- trim, speed, transform, opacity, volume, fades, and mute/visibility match preview
  and export;
- proxy choice does not alter edit timing;
- offline clips remain visible and can be relinked by identity/hash;
- overlapping clips preserve lane and track semantics on OTIO round-trip.

### Gate 7 — collaboration, review, and approval

**Input:** shared Stage/Creative state and evidence artifacts.

**Output:** presence, anchored review comments, named versions, structural diffs,
approval decisions, and optionally restored state.

Yjs synchronizes structured state and awareness, not large media bytes. Review
anchors must use stable scene/object/time/track identity. A future approval record
should reference the exact project revision, creative snapshot fingerprint, and Shot
Package fingerprint so “approved” cannot drift as editing continues.

### Gate 8 — interchange and archive

**Input:** approved production graph and referenced artifacts.

**Output:** portable Director archive, OTIOZ, USD/USDZ/glTF, Fountain, DCC package, or
delivery bundle.

An export adapter must publish a capability/round-trip matrix. Unsupported semantics
must produce warnings or sidecar metadata; they must not be silently discarded.

## 6. Identity and lineage design

The next system layer should introduce stable project-level entities:

- `ProductionAsset` — character, location, prop, style, voice, media, or 3D source;
- `AssetVersion` — immutable bytes or external reference plus hash and provenance;
- `Derivative` — proxy, thumbnail, waveform, normalized GLB, render pass;
- `ScriptBeat` — stable Fountain-derived story identity;
- `Shot` — story-order intent independent of one camera or generated plate;
- `PerformanceTake` — actor/object performance over a frame range;
- `Coverage` — camera view over a take;
- `Artifact` — generated or rendered output with lineage;
- `EditUsage` — use of an artifact version in Video editorial;
- `ReviewDecision` — comment/approval against immutable evidence.

Identity rules:

1. Entity IDs are stable and user/Agent addressable.
2. Versions are immutable; edits create a new version or a mutable draft pointing to
   immutable sources.
3. Hash equality may deduplicate bytes but never merges two semantic entities without
   an explicit decision.
4. Derived IDs must not depend on list position, localized names, or browser object
   URLs.
5. External imports retain original IDs in a namespaced provenance field; local IDs
   remain under Director control.

## 7. Adapter and boundary architecture

```text
                   ┌─ StageScene adapter (legacy/compact Agent)
DirectorProject ───┼─ Shot IR / Shot Package builder
                   ├─ glTF / USD / USDZ exporter
                   └─ DCC package builder ── Blender / Unreal adapters

CreativeWorkspace ─┬─ Agent snapshot adapter
                   ├─ OTIO / OTIOZ adapter
                   └─ preview / renderer

ProductionGraph ───┬─ Fountain adapter
                   ├─ archive manifest
                   ├─ generation job requests
                   └─ review/version projection
```

Boundary rules:

- Zod (or an equivalently generated runtime schema) validates external JSON.
- Adapters are pure where possible and fixture tested in both directions.
- File parsing and byte ownership stay outside Zustand mutations.
- An import first produces an `ImportPlan` with warnings and identity collisions;
  commit applies that plan atomically.
- An export first produces a manifest; binary writing is a separate executor step.
- Provider-specific fields live inside namespaced snapshots, not core scene schemas.

## 8. Agent-native execution model

A naive Agent should need semantic IDs and desired outcomes, not DOM coordinates or
bone names. The canonical loop remains:

```text
capabilities/catalog
  → observe exact target and revision/fingerprint
  → execute one atomic intent
  → observe/diff
  → audit
  → preview or deliver
  → inspect pixels and artifacts
```

Tool ownership:

| Concern                             | Tool surface         |
| ----------------------------------- | -------------------- |
| Complete Stage and production model | `director_workbench` |
| Canvas and Video graph/editorial    | `director_creative`  |
| Compact white-box compatibility     | `stage_*`            |
| Image/video provider jobs           | `stage_video`        |
| DCC handoff                         | `director_dcc`       |

Every mutation needs an exact target, stale-write guard, idempotency key, atomic
receipt, and recoverable error code. Every delivery needs evidence bound to the same
revision used for audit.

## 9. DCC evolution

### Implemented: Blender bridge v1

- validates `DirectorProject` before packaging;
- converts Y-up Director metres to Blender Z-up metres;
- preserves camera lens, sensor, focus/exposure metadata, timeline, and transforms;
- resolves local assets and emits warnings for unsupported/missing inputs;
- writes isolated jobs under `data/dcc-jobs/blender/`;
- optionally renders a helper-free preview.

### Next: bidirectional DCC contract v2

Do not import an arbitrary `.blend` back into the project. Export a package with stable
entity IDs, then accept a constrained `DccReturnPackage` containing:

- source package ID and source revision;
- per-entity change operations;
- newly created asset versions and hashes;
- baked skeletal animation or camera curves;
- warnings for unsupported modifiers/materials;
- conflict policy: apply, create variant, or reject.

Return import should generate a reviewable diff and commit atomically only after the
user or Agent accepts the plan.

### Unreal Engine

Use OpenUSD as the scene carrier rather than inventing a Director-specific UE format.
The UE adapter should add:

- deterministic USD prim paths derived from stable Director IDs;
- CineCameraActor mapping for filmback, focal length, aperture, focus, and clipping;
- Level Sequence mapping for cameras and baked object/character animation;
- explicit material/animation fallback reports;
- a return sidecar with created UE asset paths and Director identity metadata.

Live Link or remote control can be added later, but must not become the only way to
reproduce a handoff.

## 10. Generation provider architecture

The current ComfyUI adapter proves the Shot Package boundary. The next provider layer
should be capability driven:

```ts
interface VideoProviderCapabilities {
  imageConditioning: boolean;
  referenceVideo: boolean;
  depthControl: boolean;
  maskControl: boolean;
  cameraTrajectory: boolean;
  maxFrames: number;
  supportedRates: string[];
  supportedAspects: string[];
}
```

Provider adapters translate a provider-neutral request into an immutable provider
snapshot. They may omit unsupported controls only after returning an explicit
degradation report. The provider response is never allowed to rewrite Stage truth;
it creates an artifact version that can be promoted, compared, or placed in Video.

## 11. Failure and recovery contracts

| Failure                            | Required behavior                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Stale project or creative snapshot | Reject before mutation; re-observe and re-plan.                                  |
| Target tab disconnected            | Fail closed; never redirect to another visible tab.                              |
| Media offline                      | Preserve edit/reference; expose relink action and hash candidates.               |
| Generation timeout                 | Record `outcome-unknown`; reconcile provider job before retry.                   |
| DCC process crash                  | Keep package and logs; no partial project import.                                |
| Capture/GPU failure                | Restore renderer/helper state; no success manifest.                              |
| Import collision                   | Produce an import plan; do not rename or overwrite silently.                     |
| Unsupported interchange field      | Warn and preserve namespaced metadata when possible.                             |
| Collaboration conflict             | Resolve through CRDT for shared fields; immutable evidence/versions never merge. |

## 12. Prioritized implementation plan

The milestone-by-milestone module plan and acceptance checklist live in
[implementation roadmap](/engineering/pipeline_implementation_roadmap/). The
cross-workspace decisions are recorded as proposed [architecture decisions](/engineering/adr/).

### P0 — unify identity and execution

1. Add `ProductionGraph v1` with stable asset, beat, shot, artifact, usage, and lineage
   records. Keep `DirectorProject` and Creative workspace as authoritative editors;
   reference graph IDs from them instead of replacing them.
2. Introduce one durable `ProductionJob` store and state machine for image, video,
   audio, proxy/transcode, and DCC jobs.
3. Replace ad hoc generated-output insertion with `ArtifactVersion` creation and an
   explicit promote/use action.
4. Add `ImportPlan`/`ImportReceipt` and `ExportManifest`/`ExportReceipt` contracts to
   all interchange paths.

### P1 — close professional round trips

1. Implement Blender return packages with a reviewable structural diff.
2. Add an OpenUSD-based Unreal package and fixture-tested camera/sequence mapping.
3. Bind Fountain beats, Stage storyboard shots, coverage shots, Canvas nodes, and
   Video usages through stable project-level IDs.
4. Bind approvals to revision and package fingerprints.

### P2 — scale media and collaboration

1. Move waveform/proxy/transcode work to cancellable workers or gateway jobs.
2. Add pluggable object storage for media/artifacts while retaining local-first mode.
3. Add collaboration authorization, room lifecycle, compaction, and server snapshots.
4. Add package garbage collection driven by graph reachability and retention policy.

### P3 — automation and optimization

1. Coverage suggestions based on a declared shot grammar, never direct hidden edits.
2. Background audit and evidence refresh for changed shots.
3. Provider routing based on capability, budget, latency, and approved data policy.
4. Reproducible batch rendering and render-farm execution from frozen Shot Packages.

## 13. Migration strategy

Avoid a big-bang store rewrite:

1. Add graph IDs as optional fields and populate them during load migration.
2. Build read-only projections and consistency tests before enabling graph mutations.
3. Route new jobs/artifacts through the graph while continuing to read legacy records.
4. Export both legacy-compatible and graph manifests during one transition version.
5. Make orphan/dangling graph audits blocking only after repair tooling ships.
6. Remove legacy write paths only after round-trip fixtures and archive migration pass.

## 14. Acceptance matrix

A pipeline capability is complete only when all applicable columns pass:

| Capability       | Schema | Semantic audit        | Persistence        | Undo/atomicity       | Agent operation   | Visual/artifact evidence | Failure recovery | Round trip       |
| ---------------- | ------ | --------------------- | ------------------ | -------------------- | ----------------- | ------------------------ | ---------------- | ---------------- |
| Character motion | yes    | rig/clip IDs          | yes                | yes                  | yes               | sampled frames           | missing clip     | DCC bake planned |
| Shot Package     | yes    | camera/frame/revision | manifest           | read-only            | yes               | hashed passes            | renderer restore | package reader   |
| OTIO/OTIOZ       | yes    | media/time ranges     | import commit      | atomic import        | planned direct op | fixture output           | offline refs     | yes              |
| Blender v1       | yes    | assets/camera/frame   | isolated job       | read-only export     | yes               | optional preview         | warnings/logs    | no, v2 target    |
| Collaboration    | yes    | shared-state parse    | debounced Y update | CRDT/version restore | partial           | presence/diff            | reconnect        | same contract    |

## 15. Required architectural decisions

Before implementing P0, record short ADRs for:

1. ProductionGraph ownership and ID generation.
2. Content-addressed asset/version storage and garbage collection.
3. Job persistence backend and browser/gateway execution split.
4. Import merge semantics and conflict UI.
5. USD prim-path and DCC return identity rules.
6. Provider secret handling and data-retention policy.
7. Collaboration authorization and server snapshot policy.

## 16. Source map

| Concern                | Primary source                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Stage project schema   | `frontend/director/src/comprehensive/editor/schema/directorProject.ts`                                    |
| Runtime validation     | `frontend/director/src/comprehensive/editor/schema/directorProjectSchema.ts`                              |
| Stage persistence/undo | `frontend/director/src/comprehensive/editor/store/directorStore.ts`                                       |
| Creative workspace     | `frontend/director/src/comprehensive/editor/workspaces/directorWorkspaceStore.ts`                         |
| Persistent media       | `frontend/director/src/comprehensive/editor/media/`                                                       |
| Interchange            | `frontend/director/src/comprehensive/editor/interchange/`                                                 |
| Shot IR and package    | `frontend/director/src/comprehensive/editor/shot/`                                                        |
| Collaboration/review   | `frontend/director/src/comprehensive/editor/collaboration/`                                               |
| DCC scene package      | `frontend/director/src/dcc/directorDccContract.ts`                                                        |
| Blender execution      | `backend/gateway/dcc/` and `integrations/blender/`                                                        |
| Agent tools            | `frontend/director/src/agent/`, `backend/gateway/routes/`, and `integrations/plugins/director-workbench/` |

The companion operator-facing overview is published in the docs site at
`pipelines/system-design`.
