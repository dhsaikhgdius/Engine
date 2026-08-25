---
title: Animation & Timeline
description: Author frame-native tracks, keyframes, trajectories, playback, and recorded motion.
---

Director uses a frame-native timeline. Project FPS determines the conversion between frames
and displayed time, while keys and shot ranges remain stored as frames.

## Timeline anatomy

- **Track list** — objects and cameras that own animation data.
- **Property lanes** — transform, camera, action, path, or clip data.
- **Ruler** — frames and seconds at the current zoom level.
- **Playhead** — current evaluated frame.
- **IN/OUT markers** — the selected recording or export range.
- **Transport** — play, stop, rehearse, record, and export controls.

## Add a track

Choose **Add track**, select a scene object or camera, then choose the property or motion
type. A track is tied to a stable entity ID; renaming the object does not break the binding.

## Transform keyframes

Transform tracks can animate position, rotation, and scale. Director interpolates the
object state at the current frame and returns control to direct manipulation when the
animation workflow is not playing or recording.

## Paths and trajectories

Path tracks store ordered points, speed, and optional gait intent. Orbit and camera
trajectories remain visible as editor helpers but are omitted from clean camera capture.

Character trajectories can select walk, jog, or sprint behavior. The open mannequin runtime
uses procedural gait controls while preserving the project track as the source of truth.

## Camera animation

Camera tracks can animate:

- position and target;
- focal length;
- semantic camera actions;
- frame ranges used by storyboard shots.

Use a camera target binding when the subject should remain stable through motion. Use explicit
target keyframes when the composition intentionally changes.

## Recording

Director can record supported interactive motion into tracks. The selected automatic or
manual format controls how samples are converted to keyframes.

Set the blue IN marker and red OUT marker before starting a bounded recording. Avoid placing
markers and labels on the same visual lane when reviewing dense timelines; zoom the timeline
or move the playhead to inspect exact frame values.

## Exact-frame handoff

For an IN/OUT range intended for video generation or repeatable review, use **确定性帧包** rather
than a real-time recording. It samples every output frame in sequence (including both IN and OUT),
records microsecond timestamps/durations, and packages the real PNGs with per-frame and package
hashes. The range is still authored as integer timeline frames; project FPS determines the output
timebase. The separate automatic video export remains a browser `MediaRecorder` path and is useful
for a quick preview, not a deterministic media assertion.

## Playback and undo

Playback evaluates project data without rewriting it. Recording and interactive movement are
committed as undoable edits. Related mutations are batched so one production gesture does not
fill the undo stack with every intermediate pointer sample.
