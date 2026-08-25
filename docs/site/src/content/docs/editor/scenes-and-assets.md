---
title: Scenes & Assets
description: Build a scene from primitives, characters, local models, groups, and environments.
---

## Scene settings

The scene inspector controls:

- global scene scale, translation, and rotation;
- sky/background color;
- panorama assignment, yaw, and radius;
- ground visibility, opacity, and height;
- grid snapping and character-label visibility.

Scene transforms are applied above production objects. Use them for global coordinate
alignment, not as a substitute for object-level staging.

## Object types

Director projects can contain:

- primitives and procedural geometry;
- open mannequins and rigged characters;
- imported GLB, GLTF, and OBJ models;
- 3D gaussian splatting captures (PLY, SPLAT, KSPLAT, SPZ, SOG);
- crowds and character arrangements;
- groups with child relationships;
- camera rig objects;
- scene assets and bindings.

The compact Stage protocol exposes a smaller white-box vocabulary: `cube`, `sphere`,
`cylinder`, `cone`, `plane`, `torus`, `pyramid`, `humanoid`, and camera entities.

## Model library

The model library combines bundled local assets with user-imported models. Cards use asset
thumbnails where available and defer expensive 3D previews until requested.

### Import

Use **Import model** for one asset or **Import folder** for a local collection. Imported
files remain local to the project/browser context unless a gateway operation explicitly
persists a derived artifact.

### Place by drag and drop

Drag a model card into the viewport. Placement resolves in this order:

1. a valid visible model surface under the pointer;
2. the configured scene ground plane;
3. a fallback point derived from the current view.

Director uses the asset's visual bounds to offset the object so its lowest rendered point
rests on the target surface. Grid snapping is applied after the world-space placement is
computed.

## Gaussian splat captures

Director imports 3D gaussian splatting captures — `.ply` (3DGS training output, including
compressed variants), `.splat`, `.ksplat`, `.spz`, and `.sog` — through the same **Import
model** flow as mesh assets. Splats render in the Stage through the Spark renderer, fused
with mesh objects at correct depth, and are included in screenshots, clean frames, and
video capture.

A splat capture behaves like a normal prop: it grounds, scales through the shared
`realWorldSizeM` metric normalization, and is selected through its capture bounds. Captures
are baked upright from the OpenCV/COLMAP training frame (Y down) into Director's Y-up
stage; rotate the object if a capture uses a different convention.

Splats carry no triangle mesh. OBJ/STL export omits them with an explicit reason in the
loss report, and native Blender handoff skips them, since Blender has no splat
importer.

### 4D sequences

A dynamic (4DGS) capture imports as one `.zip` containing per-frame splat files, named so
they sort in playback order, plus an optional `manifest.json` declaring `fps` (default 30).
The gateway unpacks the frames and the asset becomes a `.4dgs.json` frame manifest. On the
Stage the sequence plays back against the Director timeline clock — play, pause, and
scrubbing all land on the matching frame, and the sequence loops past its end. Frames are
fetched through a bounded prefetch window with least-recently-used eviction, so long
sequences never load fully into memory. The first frame anchors grounding and metric
normalization for the whole sequence.

## Native Blender assets

Run `npm run blender` when the production needs native mesh, material, UV, modifier, or rig
editing. This launches one integrated Director workflow: Director remains the directing desk and
Blender remains the native scene kernel. It is not a second Director project and does not use
the file-import workflow for every edit.

When the current Director project is bound to Blender:

1. A Director model instance is provisioned once as a native root with the same production ID.
2. Blender-created native roots appear in the Director scene tree as normal selectable objects.
3. Clicking a native child in the Stage selects its owning Director root; selecting the root in the
   scene tree selects the corresponding native object.
4. Move, rotate, scale, rename, visibility, deletion, and model placement from Director are applied
   through the native revision transaction and then read back into the same object.
5. The right inspector stays semantic and object-specific. Blender-owned topology, material, UV,
   modifier, and rig details are inspected through the **Blender** tab instead of being duplicated
   below Properties.

The scene tree intentionally mirrors native **roots**, not every Blender child. Use Director for
staging, shot identity, cameras, timeline, and high-level character direction. Use **Blender** for
topology, Edit Mode selection, modifiers, and native materials/UVs. Director characters keep one
Character inspector; compatible Action/Pose state is translated to their native armature. Use the
raw Rig inspector for Blender-created armatures that are not Director characters.
Both surfaces address the same bound scene; they do not maintain competing copies of the mesh.

The small native status snapshot is runtime evidence only. It is shared by Stage and inspectors so
one poller supplies a coherent scene epoch, revision, frame, and selection. It is not stored as a
second editable project. See [Data Models](/architecture/data-models/#native-blender-binding)
for the ownership contract and [Interchange](/pipelines/interchange/#native-blender-mode-is-not-interchange)
for the distinction from `.blend` import and round trip.

## Visual bounds and pivots

Imported assets often have modeling origins far away from their visible geometry. Director
measures visual bounds and uses them for:

- grounding;
- selection and framing;
- transform-control placement;
- thumbnail and preview framing;
- Agent spatial audits.

This avoids assuming that the file origin is a usable production pivot.

## Real-world scale

A model asset can declare `realWorldSizeM`, its real-world size in metres measured as the largest
bounding-box dimension. Director scales the model so that dimension matches the declared size,
which keeps props, vehicles, buildings, and characters on one shared metric scale. The value comes
from:

- a default size for the asset's category when it is added from the model library, with finer
  defaults for source folders such as trees, trains, and buildings;
- the authored `bounds_m`/`height_m` of an Asset Catalog v2 item, which is preferred over the
  category default;
- the **Real size** field in the prop inspector, which overrides either default. Clearing the
  field returns the asset to the fallback below.

An asset with no declared size keeps the legacy display normalization, which fits its largest
dimension into 2 m. This affects rendering only. Director no longer pretends that the resulting
model has cubic spatial bounds: the first successful model load records the exact normalized local
bounds on the object, and a bound Blender scene replaces them with evaluated hierarchy bounds.
Until either measurement exists, spatial placement and collision checks report the bounds as
unknown.

Assets marked `modelNormalization: "preserve"` — a promoted generated 3D model or an imported
Blender scene bundle — are never refit and keep their authored metric scale. The prop inspector
hides the field for them.

The Stage viewport and OBJ/STL mesh export use the same normalization, so an exported prop
measures what it measured on the Stage.

## Groups and locked content

Groups are hierarchy, not duplicated geometry. Moving a group moves its children. Agents
must preserve `locked: true` objects unless the user explicitly asks to unlock or force an
operation.

## Panorama backgrounds

Assign one asset as the panorama source, then adjust horizontal rotation and sphere radius.
The editor grid stays visible when a panorama is active and remains an editor-only helper, so
camera capture continues to use the same project scene state without including the grid.

## Character exploration

Select an unlocked character and choose **Character roam** from the viewport toolbar. If that
character has a timeline animation, Director temporarily hands its transform to the player
controller and restores the normal timeline workflow on exit. The editor switches from
transform editing to a collision-aware player camera. Click the viewport to focus the controls,
then hold the left mouse button and drag to look; releasing the button ends the drag while WASD
remains active. Director does not request Pointer Lock. Clicking outside the viewport releases
the controls, and `Esc` exits the mode. Movement becomes one undoable scene edit when you exit.

| Control                      | Action                     |
| ---------------------------- | -------------------------- |
| `W` `A` `S` `D` / arrow keys | Move                       |
| `Shift`                      | Sprint                     |
| `Space`                      | Jump, or rise while flying |
| `Ctrl`                       | Descend while flying       |
| `V`                          | First/third-person view    |
| `F`                          | Toggle flight              |

Roam mode also shows an **Ability casting** bar (on by default). Skills arm with number keys `5`–`0`; left-click casts, right-click cancels; `G` opens the upstream VFX editor, `P` pauses the effect clock, and `B` clears live effects. Those keys do not overlap the roam follow bindings in the table above (including `Q` `E` `R` `F` `V` `C` and emotes `1`–`4`). Turn the bar off to disable the skill hotkeys. Aiming, GPU particles, ground decals, fissures, dynamic lights, screen flash, and camera shake come from the MIT-licensed [LinearAbiltyCastingThreeJS](https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS) sandbox and draw into the live Stage instead of a second renderer.

This is a Director-native implementation inspired by the MIT-licensed
[three-player-controller](https://github.com/hh-hang/three-player-controller). It keeps the
editor's existing R3F camera, persistence, undo, timeline, and scene protocol intact rather
than installing a second render loop or a competing camera controller. Navigation controls and
the camera-pilot workflow are also informed by the MIT-licensed
[3D Director Desk](https://github.com/xiaozangao/3d-director-desk), adapted to Director's
Flick-style stage, camera model, frame-native timeline, and agent protocol.
