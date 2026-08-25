---
title: Canvas & Video Editor
description: Organize production lineage on Canvas and assemble durable media on the Video Editor timeline.
---

Canvas, 3D Stage, Video Editor, and Gallery are four views of the same scene-scoped production. Switching
workspaces does not create a second project or copy media. Canvas and Video state is versioned,
undoable, persisted independently per scene, and addressable through `director_creative`.

## Canvas

Canvas is a spatial production graph for shot intent and media lineage. It supports:

- `shot`, `image`, `video`, `audio`, `note`, and `frame` nodes;
- directed edges between different nodes;
- selection, panning, connection mode, node movement, resizing, and deletion;
- media-backed cards using durable media IDs instead of temporary object URLs;
- Stage captures and recordings sent back to the board.

Dragging a supported asset onto Canvas creates a node at the drop location. Moving a card does not
change the media asset. Removing a card removes its connected edges but does not silently delete the
underlying durable media.

Canvas refuses new nodes at its 240-node safety limit. It never makes room by deleting the oldest
user content. Use multiple scene scopes or remove content deliberately when the limit is reached.

## Video Editor

The Video Editor uses ordered picture and audio tracks. Current clip controls include:

- start, source In, duration, split, and cross-track movement;
- playback rate and source-duration validation;
- opacity, volume, fade-in, and fade-out;
- scale, position, rotation, and `contain` / `cover` fitting;
- track visibility, mute, lock, name, add, and remove;
- frame snapping, FPS, aspect ratio, and export quality settings.

Preview and export share the same time mapping and clip transform rules. A clip cannot consume past
the end of its source, and combined fades cannot exceed its duration. Locked tracks reject Agent
clip edits instead of accepting a partial change.

## Durable media

Imported image, video, and audio bytes live in the persistent media library. Canvas nodes and Video
clips store media IDs plus metadata; they do not embed blobs in the project JSON. The project package
includes only referenced media and validates size, CRC, and paths on import.

If a preview is missing, do not replace its ID by guesswork. Relink or re-import the source and verify
that the media kind matches the Canvas node or timeline track.

## Media review metadata

The shared media browser supports a zero-to-five-star rating and reusable tags for every shot,
capture, recording, reference, or import. Search includes tags, while rating and tag selectors can
narrow the library without changing the underlying assets or their timeline references.

Review metadata is stored separately for each scene/workspace scope and appears consistently in
Canvas and Video Editor. Clearing a rating or removing every tag removes the empty review record;
relinking media does not silently transfer a review to a different media ID.

## Undo and atomicity

Normal UI edits participate in workspace undo/redo. An Agent `execute_batch` is recorded as one undo
unit. If any batch step fails, Director restores the nodes, edges, tracks, clips, settings, and the
previous selection; no half-applied Canvas/Video intent remains.

## Production acceptance

The production audit checks graph references, missing or incompatible media, unresolved and
disconnected shots, heavy card overlap, invalid source ranges and fades, overlapping clips, and
picture/audio coverage. Structural readiness is not visual proof: inspect the Canvas layout and
representative Video preview frames before declaring a visual task complete.

See [Canvas, Video & Gallery Agents](/agents/creative-workspaces/) for the structured control contract.
For project-wide media review, folders, compare, embedded generation metadata, and Trash, see
[Project Gallery](/editor/gallery/).
