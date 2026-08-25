---
title: Cameras
description: Direct shots with real lens parameters, targets, actions, previews, and clean capture.
---

Director treats a camera as a production object with a lens, an aspect ratio, a target, and
optional shot behavior. The editor navigation view is not the same as the active shot camera.

## Camera properties

| Property           | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Name               | Human-readable shot or rig name                                          |
| Position           | Camera location in scene coordinates                                     |
| Rotation / target  | Camera orientation or look target                                        |
| Focal length       | Lens focal length in millimeters                                         |
| Sensor / filmback  | Super 16, Super 35, Full Frame/VistaVision, or 65mm/IMAX                 |
| Aperture           | Physical f-number driving exposure and color-capture depth of field      |
| Focus distance     | Thin-lens focus plane distance in meters                                 |
| Shutter / ISO      | Real renderer exposure controls; shutter also carries motion-blur intent |
| Near / far clip    | Real viewport, PIP, screenshot, and video-frame clip planes              |
| Anamorphic squeeze | Physical horizontal projection desqueeze and oval-bokeh control          |
| Aspect ratio       | `16:9`, `9:16`, `1:1`, `4:3`, `1.85:1`, or `2.39:1`                      |
| Handheld shake     | Off, subtle, medium, or strong                                           |
| Action mode        | Static, pan, tilt, push-in, pull-out, follow/dolly, or arc               |
| Target object      | Optional semantic subject binding                                        |

Focal length and sensor gate jointly determine field of view; neither is a cosmetic label.
Director fits the selected output aspect inside the physical gate, so wide output crops the
top and bottom while portrait or narrower output crops the sides. Keep the camera-to-subject
distance, sensor, and lens choice deliberate instead of compensating for every framing issue
with object scale.

Legacy projects migrate to Full Frame/VistaVision and retain their original view. Stage v5
still carries an equivalent full-frame focal length, which preserves framing when exchanging
data with the older protocol even though that protocol cannot preserve the sensor name.

## Cinematography advisor

The camera inspector includes a small set of production-oriented recipes for naturalistic
narrative, anamorphic night, Super 16 documentary, close-up, large-format, action, and vertical
work. Applying a recipe authors the real sensor, focal length, aperture, focus distance, shutter,
ISO, squeeze, aspect ratio, and handheld fields, then recomputes the camera FOV. It does not add a
hidden visual filter or overwrite clipping planes, targets, transforms, or animation.

The compatibility check evaluates the current camera independently of the selected recipe. It
flags focus planes outside the clipping range, anamorphic/output mismatches, unstable telephoto
handheld combinations, motion-smear risk, high ISO, and intentionally shallow or staccato choices.
Critical and warning items identify likely production mistakes; informational items describe a
valid but pronounced creative result.

Near and far clipping are applied to the actual Three.js cameras. Aperture, shutter angle,
ISO, and timeline FPS are converted to shutter seconds, EV100, and a calibrated renderer
exposure multiplier. Filmback, crop, focal length, and anamorphic squeeze also alter the actual
projection: squeeze changes the horizontal projection scale while preserving the selected vertical
framing.

For helper-free **clean color** output, Director renders a color target plus hardware depth and
applies a thin-lens depth-of-field pass. Its circle of confusion is calculated from focal length,
aperture, focus distance, and the used sensor height; anamorphic squeeze produces oval rather than
circular blur. The PIP uses the persistent low-quality (half-resolution, lower sample count) pass
to stay responsive, while offline clean capture uses the high-quality pass. `depth`, `normal`, and
`object-id` are technical data passes, so they intentionally bypass depth of field. Motion blur is
still recorded as shutter intent/metadata rather than simulated by this renderer.

## Camera viewport properties

The floating camera property panel provides fast access to name, position, rotation, focal
length, aspect ratio, and handheld settings. It is draggable and stores its session position
separately from project content.

## Camera pilot

Choose **Start camera pilot**, click the viewport to focus it, and hold the left mouse button
while dragging to look. Releasing the button ends the drag without disabling keyboard movement;
Director does not request Pointer Lock. Use `W` `A` `S` `D` to move, `E` / `Q` to rise or descend,
`Shift` / `Alt` for fast or precise movement, the wheel to adjust FOV, and `Enter` to record a
waypoint. `F` locks the current target (or the current view point); while locked, movement orbits
or dollies around that target. Press `F` again to return to free movement. Clicking outside the
viewport releases the controls, and `Esc` exits camera pilot.

## Picture-in-picture

The camera preview renders the selected or active camera while the main viewport remains in
Director view. It uses the same physical projection and low-quality cinematic clean pass as the
shot, but does not read pixels or allocate a new render target for every frame. Use the lock
control to keep a specific camera preview while inspecting other objects or cameras. The preview
panel can also be repositioned without altering the shot.

## Framing and targets

A target can be:

- an explicit world-space point;
- an object binding;
- a timeline-evaluated target;
- an Agent-selected subject used by framing and audit operations.

For Agent work, pass both `camera_id` and `subject_id` to `audit`. This enables normalized
camera-space checks for clipping, out-of-frame subjects, scale, and composition. The critique
facts also report each subject's `visible_fraction` (share of its projected bounds inside the
frame) and `occluded_by` (nearer bodies covering it), so an agent loop can verify that a subject
is actually in picture without reading pixels.

## Film language

One shared film-language module reads every camera/subject pair into crew vocabulary — shot size
(extreme wide through extreme close-up), view (front, front-quarter, profile, rear-quarter,
back), camera side, level (ground through overhead), the nearest prime lens, and the measured
subject distance — and solves the inverse from the same bands, so a solved intent always derives
back to itself. The camera picture-in-picture shows this reading as a live slate
(`CLOSE-UP · PROFILE L · EYE · 50MM`), `observe` publishes the identical report per camera, and
video prompt expansion carries the same measured framing into generation prompts. UI and agents
cannot disagree about what a 35 mm medium profile is.

Agents author framing by intent rather than raw transforms:

- `frame_shot` places and aims an existing camera from vocabulary (`size`, `view`, `side`,
  `level`, optional `focal_length_mm`) relative to a subject object. When a request is physically
  impossible — an extreme close-up on a wide lens would put the camera inside the subject — the
  solver lengthens the lens along the prime ladder or flattens the level and reports the
  adjustment instead of failing silently.
- `mark_camera_move` pins the camera's current framing (rig transform, aim, field of view) as one
  keyframe on the camera's own animation track. Framing twice and marking twice authors a move.
- `describe_camera_move` names the move a marked track geometrically proves between two frames —
  dolly, push-in/pull-out, pan, tilt, orbit, crane, zoom, contra-zoom — and returns a
  prompt-ready phrase plus per-segment slates. It also serves from the persisted project when no
  Stage tab is connected.

## Camera actions

Camera actions can be stored as shot intent and evaluated over the timeline. Use frame-native
keyframes for exact motion, or a semantic action such as an arc when the motion should remain
readable to an Agent.

## Clean camera capture

Camera capture temporarily excludes editor-only helpers such as:

- grids and axes;
- camera frusta and rig icons;
- transform controls and selection bounds;
- labels, trajectory guides, and lasso overlays.

The resulting frame represents the white-box shot intended for review or video generation,
not the editor chrome.

For downstream compositing and model training, Director can render exact-size `clean`, PBR
`albedo`/`roughness`/`metalness`/`emissive`/`ao`/`shadow`, packed `depth`, view-space `normal`,
and deterministic `object-id` PNG passes. Metric float-depth EXR and per-frame instance JSON are
opt-in. The object-ID result includes the stable object-to-RGB table used for that frame.

## Persistent quad view

The **四视图** toolbar control switches the editor to a persisted scissored layout with one
perspective pane and orthographic top, front, and right panes. All four render from the same scene
and current evaluated frame; the layout does not create four canvases or four scene roots. Quad
view is presently an inspection mode: pane navigation and scene-editing interactions are disabled
until returning to the single Director view. This avoids applying a pointer transform from one pane
to a different camera by mistake.

## Practical lens guide

| Focal length | Typical use                                         |
| ------------ | --------------------------------------------------- |
| 18–28 mm     | Establishing shot or intentionally wide perspective |
| 35 mm        | Natural wide shot and environmental blocking        |
| 50 mm        | Neutral medium shot                                 |
| 70–100 mm    | Portrait, detail, or compressed staging             |

These are creative guidelines, not validation rules.
