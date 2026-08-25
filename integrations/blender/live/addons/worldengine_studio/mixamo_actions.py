# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Catalog-bound Mixamo action import and typed NLA editing."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

import bpy

from . import blockout, director_runtime, rig


MOTION_CATALOG = Path("assets/library/mixamo-animations/catalog.json")
MOTION_CLIPS = Path("assets/library/mixamo-animations/clips")
CORE_BONES = (
    "Hips",
    "Spine",
    "Spine1",
    "Spine2",
    "Neck",
    "Head",
    "LeftShoulder",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "RightShoulder",
    "RightArm",
    "RightForeArm",
    "RightHand",
    "LeftUpLeg",
    "LeftLeg",
    "LeftFoot",
    "RightUpLeg",
    "RightLeg",
    "RightFoot",
)
BONE_PATH = re.compile(
    r'^pose\.bones\["(?P<bone>.+)"\]\.(?P<channel>location|rotation_quaternion|scale)$'
)


def _canonical_bone_name(name: str) -> str:
    return name.rsplit(":", 1)[-1]


def _bone_index(obj: bpy.types.Object) -> dict[str, str]:
    result: dict[str, str] = {}
    duplicates: set[str] = set()
    for bone in obj.data.bones:
        canonical = _canonical_bone_name(bone.name)
        key = canonical.casefold()
        if key in result:
            duplicates.add(canonical)
        else:
            result[key] = bone.name
    if duplicates:
        raise ValueError(
            f"Armature has ambiguous Mixamo bone names: {', '.join(sorted(duplicates))}"
        )
    return result


def inspect_compatibility(obj: bpy.types.Object) -> dict[str, Any]:
    index = _bone_index(obj)
    missing = [name for name in CORE_BONES if name.casefold() not in index]
    return {
        "compatible": not missing,
        "missingBoneRoles": missing,
        "mappedBoneCount": len(index),
    }


def _motion_entry(motion_id: str) -> tuple[dict[str, Any], Path]:
    application = director_runtime.resolve_application_directory()
    catalog_path = application / MOTION_CATALOG
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    entry = next(
        (item for item in payload.get("items", []) if item.get("id") == motion_id),
        None,
    )
    if entry is None:
        raise ValueError(f"Unknown packaged Mixamo motion: {motion_id}")
    clip_path = application / MOTION_CLIPS / entry["fileName"]
    if not clip_path.is_file():
        raise ValueError(f"Packaged Mixamo motion is unavailable: {motion_id}")
    return entry, clip_path


def _new_data_snapshot() -> dict[str, set[Any]]:
    return {
        "objects": set(bpy.data.objects),
        "collections": set(bpy.data.collections),
        "meshes": set(bpy.data.meshes),
        "armatures": set(bpy.data.armatures),
        "materials": set(bpy.data.materials),
        "images": set(bpy.data.images),
        "actions": set(bpy.data.actions),
    }


def _remove_imported_data(before: dict[str, set[Any]], keep_action: bpy.types.Action | None) -> None:
    for obj in list(set(bpy.data.objects) - before["objects"]):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(set(bpy.data.collections) - before["collections"]):
        if collection.users == 0:
            bpy.data.collections.remove(collection)
    for name in ("meshes", "armatures", "materials", "images"):
        data = getattr(bpy.data, name)
        for datablock in list(set(data) - before[name]):
            if datablock.users == 0:
                data.remove(datablock)
    for action in list(set(bpy.data.actions) - before["actions"]):
        if action != keep_action and action.users == 0:
            bpy.data.actions.remove(action)


def _import_motion_source(path: Path) -> tuple[bpy.types.Object, bpy.types.Action, dict[str, set[Any]]]:
    before = _new_data_snapshot()
    result = bpy.ops.import_scene.gltf(filepath=str(path))
    if 'FINISHED' not in result:
        _remove_imported_data(before, None)
        raise RuntimeError(f"Mixamo GLB import did not finish: {sorted(result)}")
    armatures = [
        obj
        for obj in set(bpy.data.objects) - before["objects"]
        if obj.type == 'ARMATURE'
        and obj.animation_data is not None
        and obj.animation_data.action is not None
    ]
    if len(armatures) != 1:
        _remove_imported_data(before, None)
        raise ValueError("Packaged Mixamo motion must contain exactly one animated armature")
    source = armatures[0]
    return source, source.animation_data.action, before


def _channelbags(action: bpy.types.Action) -> Iterable[Any]:
    for layer in action.layers:
        for strip in layer.strips:
            yield from strip.channelbags


def _fcurves(action: bpy.types.Action) -> list[Any]:
    return [curve for channelbag in _channelbags(action) for curve in channelbag.fcurves]


def _remove_fcurve(action: bpy.types.Action, curve: Any) -> None:
    for channelbag in _channelbags(action):
        if any(item == curve for item in channelbag.fcurves):
            channelbag.fcurves.remove(curve)
            return


def _shift_action_to_frame_one(action: bpy.types.Action) -> None:
    curves = _fcurves(action)
    first = min(
        (float(point.co.x) for curve in curves for point in curve.keyframe_points),
        default=1.0,
    )
    delta = 1.0 - first
    if abs(delta) < 1e-8:
        return
    for curve in curves:
        for point in curve.keyframe_points:
            point.co.x += delta
            point.handle_left.x += delta
            point.handle_right.x += delta


def _root_vertical_axis(obj: bpy.types.Object, bone_name: str) -> int:
    bone_matrix = obj.data.bones[bone_name].matrix_local.to_3x3()
    object_matrix = obj.matrix_world.to_3x3()
    return max(
        range(3),
        key=lambda index: abs(float((object_matrix @ bone_matrix).col[index].z)),
    )


def _root_scale(source: bpy.types.Object, target: bpy.types.Object, source_index: dict[str, str], target_index: dict[str, str]) -> float:
    source_hips = source.data.bones[source_index["hips"]]
    target_hips = target.data.bones[target_index["hips"]]
    source_feet = [source.data.bones[source_index[name]] for name in ("leftfoot", "rightfoot")]
    target_feet = [target.data.bones[target_index[name]] for name in ("leftfoot", "rightfoot")]
    source_length = sum((source_hips.head_local - foot.head_local).length for foot in source_feet) / 2
    target_length = sum((target_hips.head_local - foot.head_local).length for foot in target_feet) / 2
    return target_length / source_length if source_length > 1e-8 else 1.0


def _retarget_action(
    source: bpy.types.Object,
    source_action: bpy.types.Action,
    target: bpy.types.Object,
    action_name: str,
    root_motion: str,
) -> tuple[bpy.types.Action, dict[str, Any]]:
    source_index = _bone_index(source)
    target_index = _bone_index(target)
    missing = [name for name in CORE_BONES if name.casefold() not in target_index]
    if missing:
        raise ValueError(
            f"Target armature is not Mixamo-compatible; missing: {', '.join(missing)}"
        )

    action = source_action.copy()
    action.name = action_name
    target_id = blockout.ensure_stable_id(target)
    action[rig.ACTION_OWNER_PROPERTY] = target_id
    action[rig.ACTION_DISPLAY_NAME_PROPERTY] = action_name
    mapped: set[str] = set()
    dropped: set[str] = set()
    target.animation_data_create().action = action
    root_scale = _root_scale(source, target, source_index, target_index)
    target_hips = target_index["hips"]
    vertical_axis = _root_vertical_axis(target, target_hips)

    for curve in list(_fcurves(action)):
        match = BONE_PATH.match(curve.data_path)
        if match is None:
            _remove_fcurve(action, curve)
            continue
        source_name = match.group("bone")
        canonical = _canonical_bone_name(source_name)
        target_name = target_index.get(canonical.casefold())
        channel = match.group("channel")
        if target_name is None:
            dropped.add(canonical)
            _remove_fcurve(action, curve)
            continue
        if channel == "scale" or (channel == "location" and canonical.casefold() != "hips"):
            _remove_fcurve(action, curve)
            continue
        if channel == "rotation_quaternion":
            target.pose.bones[target_name].rotation_mode = 'QUATERNION'
        curve.data_path = f'pose.bones["{target_name}"].{channel}'
        mapped.add(canonical)
        if channel != "location":
            continue
        for point in curve.keyframe_points:
            point.co.y *= root_scale
            point.handle_left.y *= root_scale
            point.handle_right.y *= root_scale
        if root_motion == "IN_PLACE" and curve.array_index != vertical_axis:
            value = float(curve.keyframe_points[0].co.y)
            for point in curve.keyframe_points:
                point.co.y = value
                point.handle_left.y = value
                point.handle_right.y = value

    _shift_action_to_frame_one(action)
    bpy.context.view_layer.update()
    return action, {
        "compatible": True,
        "mappedBoneCount": len(mapped),
        "droppedBoneCount": len(dropped),
        "missingBoneRoles": [],
    }


def import_mixamo_action(operation: dict[str, Any]) -> dict[str, Any]:
    target = rig._armature(operation["id"])
    entry, clip_path = _motion_entry(operation["motionId"])
    action_name = operation.get("actionName") or f"Mixamo {entry['name']}"
    existing = next(
        (
            action
            for action in rig._actions_for_object(target)
            if rig._action_display_name(action) == action_name
        ),
        None,
    )
    if existing is not None and not operation.get("replaceExisting", False):
        raise ValueError(f"Blender action already exists: {action_name}")

    source, source_action, before = _import_motion_source(clip_path)
    action: bpy.types.Action | None = None
    try:
        action, compatibility = _retarget_action(
            source,
            source_action,
            target,
            action_name,
            operation.get("rootMotion", "IN_PLACE"),
        )
        if existing is not None:
            bpy.data.actions.remove(existing, do_unlink=True)
            action.name = action_name
    finally:
        _remove_imported_data(before, action)

    rig._activate_pose_object(target)
    result = rig._action_result(target, action)
    result.update({
        "motionId": entry["id"],
        "rootMotion": operation.get("rootMotion", "IN_PLACE"),
        "compatibility": compatibility,
    })
    return result


def _nla_track(obj: bpy.types.Object, name: str) -> Any:
    animation = obj.animation_data
    track = animation.nla_tracks.get(name) if animation is not None else None
    if track is None:
        raise ValueError(f"Unknown NLA track: {name}")
    return track


def _strip_summary(strip: Any) -> dict[str, Any]:
    return {
        "name": strip.name,
        "actionName": rig._action_display_name(strip.action) if strip.action is not None else None,
        "frameStart": float(strip.frame_start),
        "frameEnd": float(strip.frame_end),
        "actionFrameStart": float(strip.action_frame_start),
        "actionFrameEnd": float(strip.action_frame_end),
        "blendMode": strip.blend_type,
        "influence": float(strip.influence),
        "repeat": float(strip.repeat),
        "scale": float(strip.scale),
    }


def inspect_nla(obj: bpy.types.Object) -> list[dict[str, Any]]:
    animation = obj.animation_data
    if animation is None:
        return []
    return [
        {
            "name": track.name,
            "mute": bool(track.mute),
            "solo": bool(track.is_solo),
            "strips": [_strip_summary(strip) for strip in track.strips],
        }
        for track in animation.nla_tracks
    ]


def _nla_result(obj: bpy.types.Object, track: Any, strip: Any | None = None) -> dict[str, Any]:
    identifier = blockout.ensure_stable_id(obj)
    result = {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [identifier],
        "nlaTrack": {
            "name": track.name,
            "mute": bool(track.mute),
            "solo": bool(track.is_solo),
        },
        "rigSelection": rig.selection_state(obj),
        **rig._interaction_evidence(),
    }
    if strip is not None:
        result["nlaStrip"] = _strip_summary(strip)
    return result


def create_nla_track(operation: dict[str, Any]) -> dict[str, Any]:
    obj = rig._armature(operation["id"])
    animation = obj.animation_data_create()
    if animation.nla_tracks.get(operation["trackName"]) is not None:
        raise ValueError(f"NLA track already exists: {operation['trackName']}")
    track = animation.nla_tracks.new()
    track.name = operation["trackName"]
    return _nla_result(obj, track)


def add_nla_strip(operation: dict[str, Any]) -> dict[str, Any]:
    obj = rig._armature(operation["id"])
    action = rig._action(operation["actionName"], obj)
    track = _nla_track(obj, operation["trackName"])
    if track.strips.get(operation["stripName"]) is not None:
        raise ValueError(f"NLA strip already exists: {operation['stripName']}")
    animation = obj.animation_data_create()
    if animation.action == action:
        animation.action = None
    strip = track.strips.new(operation["stripName"], operation["startFrame"], action)
    strip.blend_type = operation.get("blendMode", "REPLACE")
    strip.influence = operation.get("influence", 1.0)
    strip.repeat = operation.get("repeat", 1.0)
    strip.scale = operation.get("scale", 1.0)
    return _nla_result(obj, track, strip)


def update_nla_strip(operation: dict[str, Any]) -> dict[str, Any]:
    obj = rig._armature(operation["id"])
    track = _nla_track(obj, operation["trackName"])
    strip = track.strips.get(operation["stripName"])
    if strip is None:
        raise ValueError(f"Unknown NLA strip: {operation['stripName']}")
    if "blendMode" in operation:
        strip.blend_type = operation["blendMode"]
    if "influence" in operation:
        strip.influence = operation["influence"]
    if "repeat" in operation:
        strip.repeat = operation["repeat"]
    if "scale" in operation:
        strip.scale = operation["scale"]
    return _nla_result(obj, track, strip)


def remove_nla_strip(operation: dict[str, Any]) -> dict[str, Any]:
    obj = rig._armature(operation["id"])
    track = _nla_track(obj, operation["trackName"])
    strip = track.strips.get(operation["stripName"])
    if strip is None:
        raise ValueError(f"Unknown NLA strip: {operation['stripName']}")
    summary = _strip_summary(strip)
    track.strips.remove(strip)
    result = _nla_result(obj, track)
    result["removedNlaStrip"] = summary
    return result


__all__ = (
    "add_nla_strip",
    "create_nla_track",
    "import_mixamo_action",
    "inspect_compatibility",
    "inspect_nla",
    "remove_nla_strip",
    "update_nla_strip",
)
