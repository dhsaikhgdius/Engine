# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Typed, inspectable pose and action operations for the native Blender scene."""

from __future__ import annotations

from typing import Any, Iterable

import bpy
from mathutils import Matrix, Quaternion, Vector

from . import blockout


ACTION_OWNER_PROPERTY = "worldengine_object_id"
ACTION_DISPLAY_NAME_PROPERTY = "worldengine_display_name"
DIRECTOR_CHARACTER_STATE_PROPERTY = "worldengine_director_character_state"
POSE_CHANNEL_PATHS = {
    "LOCATION": "location",
    "ROTATION": "rotation_quaternion",
    "SCALE": "scale",
}


def _armature(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    if obj.type != 'ARMATURE':
        raise ValueError(f"WorldEngine object is not an armature: {identifier}")
    return obj


def _pose_bones(obj: bpy.types.Object, bone_refs: Iterable[str]) -> list[bpy.types.PoseBone]:
    refs = list(bone_refs)
    missing = [bone_ref for bone_ref in refs if obj.pose.bones.get(bone_ref) is None]
    if missing:
        raise ValueError(f"Unknown pose bone reference: {missing[0]}")
    return [obj.pose.bones[bone_ref] for bone_ref in refs]


def _transform(matrix) -> dict[str, list[float]]:
    location, rotation, scale = matrix.decompose()
    return {
        "location": [float(value) for value in location],
        "rotationQuaternion": [
            float(rotation.w),
            float(rotation.x),
            float(rotation.y),
            float(rotation.z),
        ],
        "scale": [float(value) for value in scale],
    }


def selection_state(obj: bpy.types.Object) -> dict[str, Any]:
    if obj.mode == 'EDIT':
        bones = obj.data.edit_bones
        active = bones.active
    else:
        bones = obj.pose.bones
        active = obj.data.bones.active
    return {
        "activeBoneRef": active.name if active is not None else None,
        "selectedBoneRefs": sorted(bone.name for bone in bones if bone.select),
    }


def _interaction_evidence() -> dict[str, Any]:
    active = bpy.context.view_layer.objects.active
    active_id = active.get(blockout.ID_PROPERTY) if active is not None else None
    selected_ids = [
        str(identifier)
        for obj in bpy.context.selected_objects
        if (identifier := obj.get(blockout.ID_PROPERTY))
    ]
    return {
        "mode": active.mode if active is not None else "OBJECT",
        "activeObjectId": str(active_id) if active_id else None,
        "selectedObjectIds": sorted(selected_ids),
    }


def inspect_rig(obj: bpy.types.Object) -> dict[str, Any]:
    pose_bones = list(obj.pose.bones)
    if obj.mode == 'EDIT':
        edit_bones = list(obj.data.edit_bones)
        inspected_bones = []
        for bone in edit_bones:
            rest_matrix = (
                bone.parent.matrix.inverted_safe() @ bone.matrix
                if bone.parent is not None
                else bone.matrix
            )
            inspected_bones.append({
                "boneRef": bone.name,
                "parentRef": bone.parent.name if bone.parent is not None else None,
                "deform": bool(bone.use_deform),
                "selected": bool(bone.select),
                # Edit bones define rest geometry; no pose delta exists until the
                # armature returns to Object/Pose mode.
                "local": _transform(Matrix.Identity(4)),
                "restLocal": _transform(rest_matrix),
            })
        bones = edit_bones
    else:
        bones = list(obj.data.bones)
        inspected_bones = []
        for pose_bone in pose_bones:
            bone = pose_bone.bone
            rest_matrix = (
                bone.parent.matrix_local.inverted_safe() @ bone.matrix_local
                if bone.parent is not None
                else bone.matrix_local
            )
            inspected_bones.append({
                "boneRef": pose_bone.name,
                "parentRef": pose_bone.parent.name if pose_bone.parent is not None else None,
                "deform": bool(bone.use_deform),
                "selected": bool(pose_bone.select),
                "local": _transform(pose_bone.matrix_basis),
                "restLocal": _transform(rest_matrix),
            })
    state = selection_state(obj)
    return {
        "boneCount": len(bones),
        "poseBoneCount": len(pose_bones),
        "deformBoneCount": sum(1 for bone in bones if bone.use_deform),
        "constraintCount": sum(len(bone.constraints) for bone in pose_bones),
        "activeBoneRef": state["activeBoneRef"],
        "selectedBoneRefs": state["selectedBoneRefs"],
        "directorStateToken": str(obj.get(DIRECTOR_CHARACTER_STATE_PROPERTY, "")),
        "bones": inspected_bones,
    }


def _action_slot_handle(action: bpy.types.Action, obj: bpy.types.Object) -> int | None:
    animation = obj.animation_data
    if animation is None:
        return None
    if animation.action == action:
        handle = animation.action_slot_handle
        return int(handle) if handle else None

    strip_handles = {
        int(strip.action_slot_handle)
        for track in animation.nla_tracks
        for strip in track.strips
        if strip.action == action and strip.action_slot_handle
    }
    if len(strip_handles) == 1:
        return strip_handles.pop()
    if len(strip_handles) > 1:
        return None

    slot_identifier = animation.last_slot_identifier
    if slot_identifier and slot_identifier in action.slots:
        return int(action.slots[slot_identifier].handle)
    return None


def _action_fcurves(action: bpy.types.Action, obj: bpy.types.Object) -> list[Any]:
    legacy_fcurves = getattr(action, "fcurves", None)
    if legacy_fcurves is not None:
        return list(legacy_fcurves)
    slot_handle = _action_slot_handle(action, obj)
    if slot_handle is None:
        return []
    fcurves = []
    for layer in getattr(action, "layers", ()):
        for strip in getattr(layer, "strips", ()):
            for channelbag in getattr(strip, "channelbags", ()):
                if channelbag.slot_handle == slot_handle:
                    fcurves.extend(channelbag.fcurves)
    return fcurves


def _keyed_frames(fcurves: Iterable[Any]) -> list[float]:
    return sorted({float(point.co.x) for curve in fcurves for point in curve.keyframe_points})


def _frame_range(fcurves: Iterable[Any]) -> list[float]:
    frames = [float(point.co.x) for curve in fcurves for point in curve.keyframe_points]
    return [min(frames), max(frames)] if frames else [0.0, 0.0]


def _action_display_name(action: bpy.types.Action) -> str:
    value = action.get(ACTION_DISPLAY_NAME_PROPERTY)
    return value if isinstance(value, str) and value else action.name


def _action_summary(action: bpy.types.Action, obj: bpy.types.Object) -> dict[str, Any]:
    animation = obj.animation_data
    active = animation is not None and animation.action == action
    fcurves = _action_fcurves(action, obj)
    keyed_frames = _keyed_frames(fcurves)
    return {
        "actionName": _action_display_name(action),
        "active": active,
        "frameRange": _frame_range(fcurves),
        "fCurveCount": len(fcurves),
        "keyframeCount": sum(len(curve.keyframe_points) for curve in fcurves),
        "keyedFrames": keyed_frames,
    }


def _actions_for_object(obj: bpy.types.Object) -> list[bpy.types.Action]:
    animation = obj.animation_data
    actions: dict[str, bpy.types.Action] = {}
    if animation is not None:
        if animation.action is not None:
            actions[animation.action.name_full] = animation.action
        for track in animation.nla_tracks:
            for strip in track.strips:
                if strip.action is not None:
                    actions[strip.action.name_full] = strip.action
    identifier = blockout.ensure_stable_id(obj)
    for action in bpy.data.actions:
        if action.get(ACTION_OWNER_PROPERTY) == identifier:
            actions[action.name_full] = action
    return [actions[name] for name in sorted(actions)]


def inspect_animation(obj: bpy.types.Object) -> dict[str, Any]:
    animation = obj.animation_data
    action = animation.action if animation is not None else None
    active_fcurves = _action_fcurves(action, obj) if action is not None else []
    tracks = list(animation.nla_tracks) if animation is not None else []
    actions = [_action_summary(item, obj) for item in _actions_for_object(obj)]
    active_summary = next((item for item in actions if item["active"]), None)
    return {
        "action": _action_display_name(action) if action is not None else None,
        "activeAction": active_summary,
        "actions": actions,
        "fCurveCount": len(active_fcurves),
        "keyframeCount": sum(len(curve.keyframe_points) for curve in active_fcurves),
        "driverCount": len(animation.drivers) if animation is not None else 0,
        "nlaTrackCount": len(tracks),
        "nlaStripCount": sum(len(track.strips) for track in tracks),
    }


def _activate_pose_object(obj: bpy.types.Object) -> None:
    active = bpy.context.view_layer.objects.active
    if active is not None and active.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for selected in bpy.context.selected_objects:
        selected.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if obj.mode != 'POSE':
        bpy.ops.object.mode_set(mode='POSE')


def select_pose_bones(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    bone_refs = operation.get("boneRefs", [])
    _pose_bones(obj, bone_refs)
    active_ref = operation.get("activeBoneRef")
    if active_ref is not None:
        _pose_bones(obj, [active_ref])
    _activate_pose_object(obj)

    action = operation.get("action", "SET")
    pose_bones = list(obj.pose.bones)
    target_refs = set(bone_refs)
    if action in {"SET", "NONE"}:
        for bone in pose_bones:
            bone.select = False
    if action == "ALL":
        for bone in pose_bones:
            bone.select = True
    elif action in {"SET", "ADD"}:
        for bone_ref in target_refs:
            obj.pose.bones[bone_ref].select = True
    elif action == "SUBTRACT":
        for bone_ref in target_refs:
            obj.pose.bones[bone_ref].select = False

    selected = [bone for bone in pose_bones if bone.select]
    if active_ref is not None:
        obj.data.bones.active = obj.data.bones[active_ref]
    elif obj.data.bones.active is None or obj.data.bones.active.name not in {
        bone.name for bone in selected
    }:
        obj.data.bones.active = obj.data.bones[selected[0].name] if selected else None
    state = selection_state(obj)
    identifier = blockout.ensure_stable_id(obj)
    return {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [],
        "rigSelection": state,
        **_interaction_evidence(),
    }


def set_pose_bone_transform(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    pose_bone = _pose_bones(obj, [operation["boneRef"]])[0]
    local = operation["local"]
    if "location" in local:
        pose_bone.location = local["location"]
    if "rotationQuaternion" in local:
        pose_bone.rotation_mode = 'QUATERNION'
        pose_bone.rotation_quaternion = Quaternion(local["rotationQuaternion"])
    if "scale" in local:
        pose_bone.scale = local["scale"]
    bpy.context.view_layer.update()
    identifier = blockout.ensure_stable_id(obj)
    return {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [identifier],
        "bone": {
            "boneRef": pose_bone.name,
            "local": _transform(pose_bone.matrix_basis),
        },
        "rigSelection": selection_state(obj),
        **_interaction_evidence(),
    }


def apply_pose_offsets(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    bone_operations = operation["bones"]
    pose_bones = _pose_bones(obj, [item["boneRef"] for item in bone_operations])
    if operation.get("resetPose", False):
        for pose_bone in obj.pose.bones:
            pose_bone.matrix_basis = Matrix.Identity(4)
    for pose_bone, item in zip(pose_bones, bone_operations):
        pose_bone.rotation_mode = 'QUATERNION'
        offset = Quaternion(item["rotationOffsetQuaternion"])
        offset.normalize()
        pose_bone.rotation_quaternion = pose_bone.rotation_quaternion @ offset
        if "locationOffset" in item:
            pose_bone.location = pose_bone.location + Vector(item["locationOffset"])
    obj[DIRECTOR_CHARACTER_STATE_PROPERTY] = operation["stateToken"]
    obj.update_tag()
    bpy.context.view_layer.update()
    identifier = blockout.ensure_stable_id(obj)
    return {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [identifier],
        "boneRefs": [pose_bone.name for pose_bone in pose_bones],
        "rigSelection": selection_state(obj),
        **_interaction_evidence(),
    }


def _action(action_name: str, obj: bpy.types.Object | None = None) -> bpy.types.Action:
    action = bpy.data.actions.get(action_name)
    if obj is not None:
        identifier = blockout.ensure_stable_id(obj)
        action = next(
            (
                candidate
                for candidate in bpy.data.actions
                if _action_display_name(candidate) == action_name
                and candidate.get(ACTION_OWNER_PROPERTY) == identifier
            ),
            None,
        )
    if action is None:
        raise ValueError(f"Unknown Blender action: {action_name}")
    return action


def _set_action(obj: bpy.types.Object, action: bpy.types.Action) -> None:
    obj.animation_data_create().action = action


def _action_result(obj: bpy.types.Object, action: bpy.types.Action) -> dict[str, Any]:
    identifier = blockout.ensure_stable_id(obj)
    return {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [identifier],
        "action": _action_summary(action, obj),
        "rigSelection": selection_state(obj),
        **_interaction_evidence(),
    }


def create_action(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    action_name = operation["actionName"]
    if any(_action_display_name(action) == action_name for action in _actions_for_object(obj)):
        raise ValueError(f"Blender action already exists: {action_name}")
    action = bpy.data.actions.new(action_name)
    action[ACTION_OWNER_PROPERTY] = blockout.ensure_stable_id(obj)
    action[ACTION_DISPLAY_NAME_PROPERTY] = action_name
    _set_action(obj, action)
    return _action_result(obj, action)


def set_active_action(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    action = _action(operation["actionName"], obj)
    _set_action(obj, action)
    return _action_result(obj, action)


def set_scene_frame(operation: dict[str, Any]) -> dict[str, Any]:
    bpy.context.scene.frame_set(operation["frame"])
    return {
        "affectedObjectIds": [],
        "dirtyObjectIds": [],
        "frame": int(bpy.context.scene.frame_current),
        **_interaction_evidence(),
    }


def _pose_channel_paths(channels: Iterable[str]) -> list[str]:
    return [POSE_CHANNEL_PATHS[channel] for channel in channels]


def _keyframe_point_count(action: bpy.types.Action, obj: bpy.types.Object) -> int:
    return sum(
        len(curve.keyframe_points)
        for curve in _action_fcurves(action, obj)
    )


def insert_pose_keyframes(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    action = _action(operation["actionName"], obj)
    pose_bones = _pose_bones(obj, operation["boneRefs"])
    channels = operation["channels"]
    channel_paths = _pose_channel_paths(channels)
    _set_action(obj, action)
    before = _keyframe_point_count(action, obj)
    frame = operation["frame"]
    for pose_bone in pose_bones:
        for channel, data_path in zip(channels, channel_paths):
            if channel == "ROTATION":
                pose_bone.rotation_mode = 'QUATERNION'
            pose_bone.keyframe_insert(data_path=data_path, frame=frame, group=pose_bone.name)

    interpolation = operation.get("interpolation", "BEZIER")
    target_paths = {
        f"{pose_bone.path_from_id()}.{data_path}"
        for pose_bone in pose_bones
        for data_path in channel_paths
    }
    for curve in _action_fcurves(action, obj):
        if curve.data_path not in target_paths:
            continue
        for point in curve.keyframe_points:
            if abs(float(point.co.x) - frame) < 1e-6:
                point.interpolation = interpolation
    after = _keyframe_point_count(action, obj)
    result = _action_result(obj, action)
    result.update({
        "frame": frame,
        "boneRefs": [pose_bone.name for pose_bone in pose_bones],
        "channels": channels,
        "keyframePointCount": max(0, after - before),
    })
    return result


def delete_pose_keyframes(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _armature(operation["id"])
    action = _action(operation["actionName"], obj)
    pose_bones = _pose_bones(obj, operation["boneRefs"])
    channels = operation["channels"]
    channel_paths = _pose_channel_paths(channels)
    _set_action(obj, action)
    before = _keyframe_point_count(action, obj)
    frame = operation["frame"]
    for pose_bone in pose_bones:
        for data_path in channel_paths:
            pose_bone.keyframe_delete(data_path=data_path, frame=frame)
    after = _keyframe_point_count(action, obj)
    result = _action_result(obj, action)
    result.update({
        "frame": frame,
        "boneRefs": [pose_bone.name for pose_bone in pose_bones],
        "channels": channels,
        "keyframePointCount": max(0, before - after),
    })
    return result


__all__ = (
    "create_action",
    "apply_pose_offsets",
    "delete_pose_keyframes",
    "insert_pose_keyframes",
    "inspect_animation",
    "inspect_rig",
    "select_pose_bones",
    "selection_state",
    "set_active_action",
    "set_pose_bone_transform",
    "set_scene_frame",
)
