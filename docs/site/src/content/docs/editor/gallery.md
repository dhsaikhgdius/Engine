---
title: Project Gallery
description: Review, organize, compare, and preserve production media and embedded generation metadata.
---

Gallery is the project-scoped media desk shared by Canvas, 3D Stage, and Video Editor. It does not
copy assets when you switch workspaces. Ratings, tags, color labels, names, notes, folders, trash
state, and view preferences are stored in the same versioned creative workspace and participate in
undo/redo.

## Browse and organize

Gallery combines storyboard shots, Stage captures, recordings, reference images, and imported
image/video/audio assets. It provides:

- grid, masonry, list, and date-grouped timeline views;
- collection, media-kind, minimum-rating, tag, color, and duplicate filters;
- search across names, notes, tags, IDs, MIME/source fields, and embedded prompt metadata;
- nested folders with drag-and-drop media movement;
- project-persisted sorting, thumbnail size, active folder, subfolder inclusion, and Trash view;
- bounded native off-screen rendering for large catalogs.

Reviewing, naming, filing, or trashing an item catalogs it into the project. Imported assets are
cataloged at import time. This ownership marker keeps Gallery-only media in a project package even
when no Canvas node or Video clip references it yet.

## Review and batch operations

Select one item to edit its display name, folder, color label, zero-to-five-star rating, tags, and
notes. Multi-select exposes batch rating/color/tag changes, folder movement, Canvas handoff, and a
rename dialog with template and regular-expression preview.

Templates support `{name}`, `{index}`, `{type}`, `{date}`, and `{ext}`. Director previews the complete
result before applying it and records the batch as one history unit.

Move to Trash is reversible. Permanent deletion requires explicit confirmation, is limited to
imported media, and is rejected while Canvas or Video still references the media. Stage-owned shots,
captures, and recordings remain managed by their source workspace.

## Viewer and comparison

Double-click a card, or use **Open viewer**, for the full media surface. Image/shot viewing supports
zoom. Video and audio use native playback controls. The viewer exposes dimensions, duration, MIME
type, byte size, creation time, and stable media ID.

Choose another result for A/B side-by-side comparison. Two images can also use a draggable wipe.
Previous/next controls are visible, so the workflow does not depend on keyboard shortcuts.

## ComfyUI metadata

PNG import reads bounded `tEXt`, `zTXt`, and `iTXt` chunks, including common ComfyUI `prompt` and
`workflow` payloads. Gallery extracts searchable positive/negative prompts and seeds while retaining
the original bounded metadata. **Send workflow parameters to Canvas** creates a durable media-backed
node carrying the prompt summary and prompt graph, so project export/import preserves the source ID
and generation context.

## Image and video generation

Choose **Generate** in the Gallery toolbar to open the ComfyUI production drawer. The drawer is a
real provider surface, not a placeholder renderer. It can:

- import arbitrary ComfyUI **API-format** workflow JSON and inspect its node classes;
- expose detected prompt, negative prompt, dimensions, seed, sampler, scheduler, model, LoRA, and
  other typed scalar inputs without editing the graph by hand;
- select one or more configured nodes, submit 1–32 copies with fixed, incrementing, or random seeds,
  and respect each node's concurrency limit;
- display online/busy/offline state, remote queue depth, RAM/VRAM metrics, current workflow stage,
  multi-sampler phase, and sampling steps;
- cancel queued/running work, retry failed work, interrupt a node, and release models/VRAM;
- reconcile an interrupted Gateway session against ComfyUI history instead of inventing a result.

Generation jobs use the shared append-only production-job attempt contract. Completed ComfyUI files
are downloaded into `data/production-jobs/<job>/attempts/<attempt>/`, hashed, and served only through
the authenticated artifact endpoint. **Add to Gallery** then imports the protected bytes into the
browser media library with prompt, seed, workflow, node, parameters, and original PNG metadata.

The HTTP/workflow/artifact path is covered by a simulated ComfyUI integration test. A configured
node is not proof of a hardware render; a real GPU output receipt remains a deployment acceptance
requirement.

## Project packages and Agent control

**Export project** includes Gallery-only cataloged bytes, folders, reviews, preferences, and embedded
generation metadata. Import validates archive paths, declared sizes, CRCs, and media bounds before
mutating the persistent library, then remaps Gallery, Canvas, and Video references to imported IDs.

`director_creative observe` returns the `gallery` projection. Reversible Agent operations cover media
metadata, move, batch rename, Trash/restore, folders, and preferences. Agent mutations use the same
snapshot fingerprint, idempotency, atomic-batch, and undo rules as Canvas and Video. Permanent media
deletion remains human-only because it removes durable browser-owned bytes.

See [Canvas, Video & Gallery Agents](/agents/creative-workspaces/) for operation names and guards.
