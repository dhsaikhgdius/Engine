---
title: Storyboard & Recording
description: Organize shots, camera thumbnails, editorial ranges, and clean viewport output.
---

## Storyboard model

A storyboard contains a title, logline, and ordered shots. Every shot records:

- stable shot ID and title;
- camera binding;
- frame start and end;
- shot size;
- camera movement;
- action description;
- optional exact-frame thumbnail evidence: durable media ID, SHA-256, camera/frame,
  raster size, capture time, and source project revision.

Storyboard shots reference project cameras and frame ranges instead of duplicating camera
state. This keeps changes inspectable and lets the editor identify broken references.

Cards can be duplicated or moved earlier/later. Reordering preserves each inclusive shot
duration and rebuilds a contiguous sequence from the timeline start. A duplicated card receives
a new ID and deliberately drops its old frame-bound thumbnail.

## Camera thumbnails

Scene and camera thumbnails provide fast visual orientation. Their caches are session data and
do not become authoritative project content. Storyboard thumbnails use a stronger contract:
**Capture** renders the shot's exact camera at `frameStart` as a helper-free clean PNG, stores the
bytes in IndexedDB, and writes only a bounded hash-bound reference into `DirectorProject`.

Changing a card's camera or start frame marks the picture **Needs recapture** instead of silently
relabeling old pixels. **Fill pictures** captures every missing/stale card sequentially; each
accepted picture is protected by the source project revision.

## Print and verifiable PDF

The storyboard export dialog supports:

- A4 or Letter paper, portrait or landscape;
- one to four columns;
- all cards or an explicit selected subset;
- optional camera/frame/shot metadata and action notes;
- a live page-layout preview.

**Download PDF** rasterizes the layout at 144 DPI before embedding JPEG pages in a standards-valid
PDF, so CJK text uses the browser's real font renderer. **Download verification package** adds
independent page JPEGs and `manifest.json`. The manifest binds the project revision, settings,
ordered shot metadata, source thumbnail provenance, page SHA-256 hashes, and final PDF SHA-256.
Missing, stale, legacy fallback, or hash-mismatched pictures are reported as warnings; mismatched
bytes are never presented as verified evidence.

Agents use `storyboard_artifact` with `capture_thumbnail`, `capture_missing`, or `export_pdf`.
The public boundary injects a missing project revision and retry key; the browser execution boundary
requires both. Exact retries replay the prior result instead of capturing, committing, or downloading
twice. PDF and image bytes remain in the browser; only the bounded manifest crosses the Agent tool wire.

## Production and editorial references

The gateway production manifest stores named scene references and editorial shots with
revision metadata. Linked shots can follow a source scene revision, while pinned shots retain
the intended source revision for review.

## Record a clean shot

1. Choose the active camera and verify its picture-in-picture output.
2. Set the timeline FPS.
3. Place IN and OUT markers.
4. Rehearse the range.
5. Choose either real-time recording or deterministic IN/OUT frame export.
6. Inspect the output separately from the editor viewport.

Camera output excludes editor-only guides. The project, active camera, frame range, aspect
ratio, and FPS remain the reproducible record of how the output was produced.

## Export modes: choose the contract deliberately

| Control                             | Output                                        | Timing contract                                                                                        | Use it for                                                           |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Manual record / **自动导出 IN/OUT** | Browser WebM/MP4 where supported              | Real-time browser `MediaRecorder`; frame delivery and final encode are browser-dependent               | Fast review video                                                    |
| **确定性帧包**                      | ZIP containing real PNG frames and a manifest | Each inclusive IN/OUT sample is captured sequentially with explicit microsecond timestamp and duration | Reproducible white-box frames, video-generation inputs, verification |

The deterministic ZIP manifest contains source/output FPS, frame range, dimensions, per-frame
SHA-256 hashes, and a package fingerprint. The export reports progress and can be cancelled.
Director only emits a playable MP4/WebM through this path when a real WebCodecs encoder and
container muxer are provided. Without them, the truthful result is the PNG ZIP—not a file renamed
to `.mp4`.

Both paths capture the active camera's helper-free **clean** pass. Physical filmback,
anamorphic projection, and clean-pass depth of field therefore affect the pixels; grids, axes,
labels, camera helpers, selection controls, paths, and lasso UI do not.

## Export project evidence

For a reproducible handoff, keep:

- exported `DirectorProject` JSON;
- production manifest revision;
- selected camera and frame range;
- audit result and trace;
- camera capture or recording;
- dependency lockfile and runtime version.
