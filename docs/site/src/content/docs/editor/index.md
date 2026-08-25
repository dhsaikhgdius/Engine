---
title: 3D Editor
description: Understand the Director workspace and its production-oriented editing model.
---

The application exposes four top-level workspaces: **Canvas**, **3D Stage**, **Video Editor**,
and **Agent**. Canvas organizes shot intent and media lineage, Stage owns
blocking/camera/animation, Video Editor assembles durable media on picture and audio tracks,
and Agent runs durable coding-agent sessions. Project media still lives in Gallery inside
those production workspaces.
The 3D Stage is organized around three
persistent regions:

- **Scene tree** — production objects, groups, characters, cameras, and hierarchy controls.
- **3D viewport** — staging, selection, transform tools, camera previews, and visual feedback.
- **Inspector and tools** — scene properties, modeling, and assets.

The frame timeline remains available beneath the viewport for animation, camera actions,
shot ranges, recording, and storyboard work.

When launched with `npm run blender`, these same regions operate on the bound native scene.
Native roots join the existing scene tree, the Stage handles selection and root transforms, and the
right inspector composes Director properties with object-scoped Mesh and Rig tools. This remains one
Director workflow rather than a second modeling workspace. See [Scenes & Assets](/editor/scenes-and-assets/#native-blender-assets).

## Core interaction model

### Select

Click an object in the viewport or scene tree. Use lasso selection when the scene contains
many objects. Selection is UI state; it does not change the project until an editing action
is applied.

### Transform

Move, rotate, or scale through the viewport gizmo and inspector. Director stores metric
transforms. Primitive `position` is the **floor pivot** (bottom centre), not the geometric
centre: a 3 m wall on the ground uses `position.y = 0` and `scale.y = 3`; writing `y = 1.5`
lifts it off the floor. A ceiling whose underside should sit at 3 m uses `position.y = 3`,
not `3 + thickness/2`. Imported assets use visual-bounds metadata to compute their grounded
placement and transform origin.

### Group

Create a group from the current selection when several objects should move as one. Parent
motion affects children, while locked objects remain protected from Agent edits unless the
user explicitly authorizes an override.

### Navigate

Orbit, pan, and zoom in Director view. Camera preview and active-camera capture are separate
from the editor navigation camera, so inspecting the scene does not silently alter a shot.

## Editor-only helpers

The viewport may show grids, labels, camera frusta, transform gizmos, trajectory guides,
selection bounds, and navigation controls. Camera capture and recorded clean output exclude
these helpers so the white-box frame can be used as downstream video-generation evidence.

## Project-level operations

Director supports project import/export, scene duplication, production references, camera
thumbnails, storyboard shots, and revision-aware synchronization with the local gateway.

For a workspace-by-workspace audit of icon buttons, see the [UI Icon Reference](/editor/ui-icons/).

Continue with [Canvas & Video Editor](/editor/canvas-video/) for graph, media, timeline, persistence,
and export semantics outside the 3D viewport. See [Reference Image Reconstruction](/editor/reference-reconstruction/)
and [Procedural Modeling](/editor/procedural-modeling/) for plan-first Stage generation workflows.
