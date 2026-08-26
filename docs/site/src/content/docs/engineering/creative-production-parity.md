---
title: Director creative production parity gate
---

The canonical system boundaries, end-to-end stage gates, model ownership, DCC and
generation evolution, migration order, and recovery contracts are maintained in
[pipeline system design](/engineering/pipeline_system_design/). This document remains the
product-level completion gate; the system-design document explains how the pieces fit
together and what should be built next.

Director is not intended to copy a collection of editor surfaces. Its product boundary is a single, portable production graph:

`brief / script beat → Canvas lineage → Stage state + camera → clean control package → generated artifact → editorial usage`

Every arrow must be inspectable, recoverable, and executable by the user or an Agent. A control is not complete when it only changes the UI; preview, persistence, export, and Agent execution must share the same data semantics.

## Current P0 baseline

- Canvas and Video share a scene-scoped, versioned workspace with undo/redo and debounced persistence.
- Imported image, video, and audio blobs are deduplicated and restored through IndexedDB.
- Portable `.director.zip` projects contain the workspace plus only referenced media, validate CRC and size limits, reject unsafe paths, and remap media IDs on import. Legacy JSON remains readable.
- The timeline supports multi-track picture/audio, visibility and mute as independent signals, trim, split, frame snapping, transform, fit, opacity, volume, fades, captions, playback speed, and real mixed export.
- Preview and export use the same clip timing, transform, fade, speed, and audio rules.
- `director_creative` exposes typed Canvas and Video operations over MCP, HTTP, WebSocket, and the browser bridge. Every mutation requires the latest snapshot fingerprint and an idempotency key; exact retries replay without duplication, while changed key reuse is rejected.
- Multi-step intents are atomic, alias-addressable, become one undo unit, and restore content plus selection on failure. Canvas refuses at capacity instead of deleting older user work.
- One-shot Canvas/Video UI mutations route through the same dispatch layer agents use (`dispatchCreativeWorkspaceOperations`), filling the fingerprint guard and idempotency key so UI and Agent edits produce the same revision and receipts; continuous drag/trim/slider interactions keep local history batches. Coverage is inventoried in the [UI/Agent parity inventory](/engineering/ui-agent-parity-inventory/).
- Gateway observations bind an Agent session to one exact browser/scene/workspace target. A stale target fails closed instead of falling back to a recently visible tab.
- Production audits report graph, media, source-range, overlap, and picture/audio coverage issues and explicitly require final visual verification. `director_creative preview` returns a fingerprint-bound, helper-free PNG of the complete Canvas board or an exact Video time without moving the playhead.
- Stage camera capture and recording use the clean render path rather than editor gizmos and selection helpers.

## Required next gates

### P0 — production graph

1. Replace draft generation cards with a durable job DAG: typed ports, queued/running/succeeded/failed/cancelled states, progress, retry, cancellation, provider/model/config snapshot, cost, and immutable output versions.
2. Give characters, locations, props, styles, voices, shots, and generated artifacts stable project UUIDs. Record hash, source, license, lineage, proxy/source relationship, and reference count in one manifest.
3. Export a shot control package containing clean RGB first frame/reference video, camera intrinsics/extrinsics and trajectory, prompt/config, character references, and optional depth/normal/segmentation/mattes.
4. Move canonical editorial time from floating-point seconds to rational frame rate + integer frame + drop-frame metadata. Seconds remain a presentation and media-decoder view.
5. Add relink, proxy, poster-frame, waveform, generation-version compare/promote, and offline-media recovery journeys.

### P1 — professional interchange and coverage

1. Fountain screenplay import/export and beat-to-shot identity.
2. GLB for browser/runtime proxies; OpenUSD/USDZ for DCC scene, camera, layer, and variant interchange.
3. OpenTimelineIO/OTIOZ for timeline interchange, followed by fixture-tested adapters. EDL is compatibility output, never the canonical timeline.
4. Coverage metadata: shot/take/variant, story order, shooting order, lens package, sensor/filmback, f-stop, focus/CoC, shutter/ISO, safe guides, floor plan, line sheet, and review state.
5. Bidirectional Blender/Unreal bridges based on stable IDs and explicit axis, handedness, and unit contracts. Browser GLB proxies and source USD remain separate artifacts.

## Reuse before invention

Evaluate and license-lock these libraries before adding custom infrastructure:

- [React Flow](https://reactflow.dev/) for typed nodes, ports, selection, subflows, resizers, and keyboard interaction.
- [Yjs](https://docs.yjs.dev/) for structured collaborative state and awareness; media blobs stay outside CRDT documents.
- [glTF Transform](https://gltf-transform.dev/) for glTF pruning, deduplication, resampling, Meshopt/Draco, and KTX2 workflows.
- [Mediabunny](https://mediabunny.dev/) and feature-detected [WebCodecs](https://www.w3.org/TR/webcodecs/) for browser demux/mux/frame/audio work; `ffmpeg.wasm` is a compatibility fallback rather than the real-time renderer.
- [wavesurfer.js](https://wavesurfer.xyz/docs/) for waveform, regions, timeline, envelope, and recording UI.
- Official [OpenTimelineIO](https://opentimelineio.readthedocs.io/) and [OpenUSD](https://openusd.org/release/) tools through local/service bridges rather than handwritten parsers.

Do not bind the core renderer to a library with an incompatible commercial threshold, and do not copy code from repositories with ambiguous or restrictive licensing. Interaction research may inform clean-room implementation.

## Journey-level acceptance

A capability passes only when automated tests and a browser interaction verify the complete recovery path:

- generation fails → error is inspectable → retry creates a new version → refresh restores both;
- media goes offline → clip is visibly missing → relink repairs all references by identity/hash;
- project ZIP round-trips on another browser profile with referenced media intact;
- the same frame produces matching preview/export timing, transform, opacity, and audio position;
- Stage control video contains no editor helpers and preserves camera metadata;
- an Agent observes, executes an atomic batch with target/idempotency/fingerprint guards, receives a mutation receipt, re-observes and audits the result, and can undo it as one group.
- an Agent recovers `outcome_unknown` by observing and reconciling the exact bound target before any retry; only a byte-equivalent retry may reuse the original idempotency key.

## Product references

The gates synthesize official capabilities documented by [Topview](https://www.topview.ai/), [Intangible](https://www.intangible.ai/faq), [Reallusion AI Studio](https://manual.reallusion.com/ai-studio/workflow.htm), [Lightcraft Autoshot](https://docs.lightcraft.pro/autoshot/autoshot-overview), [Previs Pro](https://wiki.previspro.com/), [SceneForge](https://www.vu.studio/sceneforge), [FrameForge](https://support.frameforge.com/article/249-how-do-the-frameforge-editions-compare), [LTX Studio Projects](https://ltx.io/blog/introducing-projects), and [Wonder Unit Shot Generator](https://wonderunit.com/shot-generator/). Their UI and implementation are not source dependencies.
