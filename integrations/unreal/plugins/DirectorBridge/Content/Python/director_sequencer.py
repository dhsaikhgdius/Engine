"""Host-side LevelSequence authoring for the Director Unreal connector.

This module imports ``unreal`` lazily through the caller: every function takes
the ``unreal`` module as its first argument so the pure-Python helpers it
delegates to (``director_timebase``, ``director_bake``) stay host-free
testable while the Sequencer wiring runs only inside UnrealEditor-Cmd.

Authoring rules:

- The sequence display rate is the Director timeline's rational rate
  (23.976 = 24000/1001, 24, 25, 29.97 DF = 30000/1001, 30, ...), never a
  rounded integer.
- The tick resolution comes from ``director_timebase.tick_resolution`` so
  every display frame lands on an integer tick.
- A non-zero start timecode shifts the playback range and every key/cut by
  the timecode's frame offset at the display rate (drop-frame aware).
- Storyboard shots become camera-cut sections; baked entities become
  per-frame-keyed transform tracks; baked camera optics become
  ``CurrentFocalLength`` float tracks on the CineCameraComponent.
"""

from __future__ import annotations

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import director_bake as dbake  # noqa: E402
import director_timebase as dtimebase  # noqa: E402

TRANSFORM_CHANNEL_NAMES = (
    "Location.X",
    "Location.Y",
    "Location.Z",
    "Rotation.X",
    "Rotation.Y",
    "Rotation.Z",
    "Scale.X",
    "Scale.Y",
    "Scale.Z",
)


def resolve_timebase(manifest: dict, bake) -> dict:
    """The effective timebase: the bake's when present, else from the manifest timeline."""
    if bake:
        return bake["timebase"]
    return dtimebase.timebase_from_manifest(manifest["project"]["scene"].get("timeline"))


def start_frame_offset(timebase: dict) -> int:
    """Frame offset of the start timecode at the display rate (0 when unparseable)."""
    rate = dtimebase.normalize_rate(timebase["rate"])
    parsed = dtimebase.parse_timecode(timebase["startTimecode"], rate, timebase["dropFrame"])
    return parsed if parsed is not None else 0


def playback_bounds(manifest: dict, bake, shots: list) -> tuple:
    """(frameStart, frameEnd) in Director timeline frames, before the timecode offset."""
    if bake:
        return (bake["playback"]["frameStart"], bake["playback"]["frameEnd"])
    timeline = manifest["project"]["scene"].get("timeline")
    if timeline is not None:
        start = int(round(timeline["frameStart"]))
        return (start, max(start, int(round(timeline["frameEnd"]))))
    if shots:
        return (
            min(int(shot["frameStart"]) for shot in shots),
            max(int(shot["frameEnd"]) for shot in shots),
        )
    return (0, 0)


def _add_double_keys(unreal, channel, keys, warnings: list) -> int:
    """Add linear keys to one scripting channel; returns the key count."""
    added = 0
    for frame, value in keys:
        channel.add_key(
            unreal.FrameNumber(int(frame)),
            float(value),
            0.0,
            unreal.SequenceTimeUnit.DISPLAY_RATE,
            unreal.MovieSceneKeyInterpolation.LINEAR,
        )
        added += 1
    return added


def _ordered_transform_channels(section):
    """The section's 9 double channels in Location/Rotation/Scale XYZ order.

    Prefers channel-name matching; falls back to positional order when the
    scripting API does not expose channel names.
    """
    channels = list(section.get_all_channels())
    named = {}
    for channel in channels:
        try:
            named[str(channel.get_editor_property("channel_name"))] = channel
        except Exception:  # noqa: BLE001 - name lookup is best-effort
            named = {}
            break
    if len(named) >= len(TRANSFORM_CHANNEL_NAMES) and all(name in named for name in TRANSFORM_CHANNEL_NAMES):
        return [named[name] for name in TRANSFORM_CHANNEL_NAMES]
    return channels[:9]


def _key_transform_track(unreal, sequence, binding, entity_keys, range_start, range_end, warnings: list) -> int:
    """Author one 3D transform track from baked keys; returns the key count."""
    track = binding.add_track(unreal.MovieScene3DTransformTrack)
    section = track.add_section()
    section.set_range(range_start, range_end)
    channels = _ordered_transform_channels(section)
    if len(channels) < 9:
        warnings.append("Transform section exposed fewer than 9 channels; the track was left unkeyed.")
        return 0
    added = 0
    for key in entity_keys:
        frame = key["frame"]
        values = [*key["location"], *key["rotation"], *key["scale"]]
        for channel, value in zip(channels, values):
            channel.add_key(
                unreal.FrameNumber(int(frame)),
                float(value),
                0.0,
                unreal.SequenceTimeUnit.DISPLAY_RATE,
                unreal.MovieSceneKeyInterpolation.LINEAR,
            )
            added += 1
    return added


def _key_focal_length_track(unreal, sequence, camera_actor, focal_keys, filmback, range_start, range_end, warnings):
    """Author a CurrentFocalLength track on the CineCameraComponent; returns key count."""
    component = camera_actor.get_cine_camera_component()
    if filmback:
        try:
            component_filmback = component.get_editor_property("filmback")
            component_filmback.set_editor_property("sensor_width", float(filmback["sensorWidthMm"]))
            component_filmback.set_editor_property("sensor_height", float(filmback["sensorHeightMm"]))
            component.set_editor_property("filmback", component_filmback)
        except Exception as error:  # noqa: BLE001 - filmback is best-effort, focal keys still land
            warnings.append(f"Filmback could not be applied to {camera_actor.get_actor_label()}: {error}")
    binding = sequence.add_possessable(component)
    track = binding.add_track(unreal.MovieSceneFloatTrack)
    track.set_property_name_and_path("CurrentFocalLength", "CurrentFocalLength")
    section = track.add_section()
    section.set_range(range_start, range_end)
    channels = list(section.get_all_channels())
    if not channels:
        warnings.append(f"Focal length section for {camera_actor.get_actor_label()} exposed no channels.")
        return 0
    return _add_double_keys(unreal, channels[0], [(key["frame"], key["focalLengthMm"]) for key in focal_keys], warnings)


def build_sequence(unreal, manifest: dict, bake, spawned: dict, cameras: dict, content_root: str, warnings: list):
    """Author the Director LevelSequence for one import job.

    @param unreal: The ``unreal`` module (host-only).
    @param manifest: The validated exchange package manifest.
    @param bake: The validated Sequencer bake, or None for a static import.
    @param spawned: director_id -> spawned object actor.
    @param cameras: director_id -> spawned CineCameraActor.
    @param content_root: Content root such as ``/Game/Director``.
    @param warnings: Warning sink shared with the import report.
    @returns A Sequencer receipt dict (see directorUnrealSequencerReceiptSchema),
        or None when there is nothing to author.
    """
    storyboard = manifest["project"].get("storyboard")
    shots = [shot for shot in (storyboard or {}).get("shots", []) if shot.get("cameraId") in cameras]
    baked_entities = list(bake["entities"]) if bake else []
    if not shots and not baked_entities:
        return None

    timebase = resolve_timebase(manifest, bake)
    rate = dtimebase.normalize_rate(timebase["rate"])
    tick = dtimebase.tick_resolution(rate)
    drop_frame = bool(timebase["dropFrame"])
    start_timecode = timebase["startTimecode"]
    offset = start_frame_offset(timebase)
    frame_start, frame_end = playback_bounds(manifest, bake, shots)

    package_folder = "".join(
        character if character.isalnum() or character in "_-" else "_" for character in manifest["packageId"][:8]
    )
    sequence_path = f"{content_root}/Sequences/{package_folder}"
    sequence_name = "DirectorShots"
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    sequence = asset_tools.create_asset(sequence_name, sequence_path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())

    # Tick resolution first: changing it after keys exist would rescale them.
    sequence.set_tick_resolution(unreal.FrameRate(tick[0], tick[1]))
    sequence.set_display_rate(unreal.FrameRate(rate[0], rate[1]))
    playback_start = offset + frame_start
    playback_end = offset + max(frame_end, frame_start + 1)
    sequence.set_playback_start(playback_start)
    sequence.set_playback_end(playback_end)

    bindings = {}

    def binding_for(director_id: str, actor):
        if director_id not in bindings:
            bindings[director_id] = sequence.add_possessable(actor)
        return bindings[director_id]

    camera_cut_count = 0
    if shots:
        camera_cut_track = sequence.add_track(unreal.MovieSceneCameraCutTrack)
        for shot in shots:
            camera_actor = cameras[shot["cameraId"]]
            binding = binding_for(shot["cameraId"], camera_actor)
            section = camera_cut_track.add_section()
            section.set_range(offset + int(shot["frameStart"]), offset + int(shot["frameEnd"]))
            camera_binding_id = unreal.MovieSceneObjectBindingID()
            camera_binding_id.set_editor_property("guid", binding.get_id())
            section.set_editor_property("camera_binding_id", camera_binding_id)
            camera_cut_count += 1

    transform_track_count = 0
    focal_length_track_count = 0
    baked_key_count = 0
    for entity in baked_entities:
        director_id = entity["directorId"]
        actor = cameras.get(director_id) if entity["entityType"] == "camera" else spawned.get(director_id)
        if actor is None:
            warnings.append(
                f"Baked entity {director_id} has no spawned actor in this import; its tracks were skipped."
            )
            continue
        keys = dbake.entity_track_keys(entity)
        offset_transform_keys = [{**key, "frame": offset + key["frame"]} for key in keys["transform"]]
        binding = binding_for(director_id, actor)
        baked_key_count += _key_transform_track(
            unreal, sequence, binding, offset_transform_keys, playback_start, playback_end, warnings
        )
        transform_track_count += 1
        if entity["entityType"] == "camera" and keys["focalLength"]:
            offset_focal_keys = [{**key, "frame": offset + key["frame"]} for key in keys["focalLength"]]
            baked_key_count += _key_focal_length_track(
                unreal,
                sequence,
                actor,
                offset_focal_keys,
                entity.get("filmback"),
                playback_start,
                playback_end,
                warnings,
            )
            focal_length_track_count += 1

    unreal.EditorAssetLibrary.save_asset(f"{sequence_path}/{sequence_name}")

    # Read the applied values back from the asset so the receipt proves what
    # was authored rather than echoing the request.
    applied_display = sequence.get_display_rate()
    applied_tick = sequence.get_tick_resolution()
    return {
        "sequencePath": f"{sequence_path}/{sequence_name}",
        "displayRate": dtimebase.serialize_rate((applied_display.numerator, applied_display.denominator)),
        "tickResolution": dtimebase.serialize_rate((applied_tick.numerator, applied_tick.denominator)),
        "dropFrame": drop_frame,
        "startTimecode": start_timecode,
        "startFrameOffset": offset,
        "playbackStart": sequence.get_playback_start(),
        "playbackEnd": sequence.get_playback_end(),
        "cameraCutCount": camera_cut_count,
        "transformTrackCount": transform_track_count,
        "focalLengthTrackCount": focal_length_track_count,
        "bakedKeyCount": baked_key_count,
    }
