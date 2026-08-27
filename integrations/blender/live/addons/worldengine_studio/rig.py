# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Typed, inspectable pose and action operations for the native Blender scene.

Implements the live-session rig vocabulary (inspect_rig, select_pose_bones,
set_pose_bone_transform, apply_pose_offsets, action/keyframe operations) on
top of Blender armatures. Values cross the wire in Blender's own local bone
space and Z-up scene frame -- rig data is inspected and edited in place, never
axis-converted, because the Director side treats the armature as an opaque
Blender asset addressed by stable ids and bone names.

Two identity conventions matter here:

- Objects are addressed by their ``worldengine_id`` stable id (see blockout),
  never by Blender datablock names, which are mutable and non-unique.
- Actions are addressed by their Director-visible display name
  (ACTION_DISPLAY_NAME_PROPERTY) scoped to the owning object
  (ACTION_OWNER_PROPERTY), so two characters can each own a "Walk" action
  without colliding in ``bpy.data.actions``' global namespace.

Every mutating operation returns affected/dirty object ids plus fresh
selection and interaction evidence so the gateway can diff state without a
second observe round trip.
"""

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
    """Resolve a stable id to an armature object; reject anything else early."""
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    if obj.type != 'ARMATURE':
        raise ValueError(f"WorldEngine object is not an armature: {identifier}")
    return obj


def _pose_bones(obj: bpy.types.Object, bone_refs: Iterable[str]) -> list[bpy.types.PoseBone]:
    """Resolve bone names to pose bones, failing on the first unknown ref.

    Validation happens before any mutation so a batch with one bad bone name
    rejects cleanly instead of applying a partial pose.
    """
    refs = list(bone_refs)
    missing = [bone_ref for bone_ref in refs if obj.pose.bones.get(bone_ref) is None]
    if missing:
        raise ValueError(f"Unknown pose bone reference: {missing[0]}")
    return [obj.pose.bones[bone_ref] for bone_ref in refs]


def _transform(matrix) -> dict[str, list[float]]:
    """Decompose a Blender matrix into the wire transform record (w-first quaternion)."""
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
    """Active and selected bone names, honoring Edit vs Pose mode storage.

    Blender keeps edit-bone and pose-bone selection in different collections;
    reporting the wrong one would desynchronize the workbench's rig panel.
    """
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
    """Snapshot mode/active/selection as stable ids for the operation result."""
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
    """Describe an armature's bones with per-bone local (pose) and rest transforms.

    ``restLocal`` is always parent-relative so the agent can reason about the
    hierarchy without composing world matrices. In Edit mode the pose delta is
    reported as identity: edit bones ARE the rest geometry, and Blender does
    not evaluate a pose until the armature leaves Edit mode.
    """
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
    """Find the slotted-action handle this object uses for ``action`` (Blender 4.4+).

    Slotted actions can serve several data blocks; the handle is resolved from
    the active assignment first, then NLA strips (only when unambiguous), then
    the object's last-used slot. ``None`` means the f-curves cannot be
    attributed to this object safely.
    """
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
    """List the f-curves of ``action`` that animate ``obj``.

    Supports both the legacy flat ``action.fcurves`` API and the layered
    slotted-action API, so keyframe counts stay correct across Blender
    versions without branching at every call site.
    """
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
    """Sorted unique frame numbers that carry at least one keyframe."""
    return sorted({float(point.co.x) for curve in fcurves for point in curve.keyframe_points})


def _frame_range(fcurves: Iterable[Any]) -> list[float]:
    """[first, last] keyed frame across all curves; [0, 0] for an empty action."""
    frames = [float(point.co.x) for curve in fcurves for point in curve.keyframe_points]
    return [min(frames), max(frames)] if frames else [0.0, 0.0]


def _action_display_name(action: bpy.types.Action) -> str:
    """The Director-visible action name; falls back to the datablock name."""
    value = action.get(ACTION_DISPLAY_NAME_PROPERTY)
    return value if isinstance(value, str) and value else action.name


def _action_summary(action: bpy.types.Action, obj: bpy.types.Object) -> dict[str, Any]:
    """Wire summary of one action as seen from ``obj`` (curves, keys, active flag)."""
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
    """All actions belonging to this object: active, NLA strips, and owned-by-id.

    The ACTION_OWNER_PROPERTY sweep is what keeps a freshly created but not
    yet assigned action visible to the workbench instead of orphaned in
    ``bpy.data.actions``.
    """
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
    """Summarize an object's animation state (actions, curves, drivers, NLA)."""
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
    """Make ``obj`` the sole selected, active object and enter Pose mode.

    Blender's mode operators act on the active object, so any previously
    active object is returned to Object mode first to avoid mode leakage.
    """
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
    """Apply a SET/ADD/SUBTRACT/ALL/NONE bone selection intent in Pose mode.

    All bone refs (including activeBoneRef) validate before any selection
    changes. When the requested active bone would end up deselected, the
    first selected bone is promoted so Blender never reports an active bone
    outside the selection.
    """
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
    """Set one pose bone's local channels; only the provided channels change.

    Rotation writes force QUATERNION mode so the wire value is applied
    literally instead of being reinterpreted through a stale Euler order.
    """
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
    """Apply Director character-control deltas as multiplicative bone offsets.

    ``resetPose`` first zeroes every bone's matrix_basis so the offsets
    compose against the rest pose deterministically. The caller's stateToken
    is stamped on the armature so Director can tell which control state this
    Blender pose reflects (see DIRECTOR_CHARACTER_STATE_PROPERTY).
    """
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
    """Resolve an action by Director display name, scoped to the owning object.

    When ``obj`` is given, lookup is by display name + owner id rather than
    the global datablock name, so per-character actions with the same display
    name resolve to the right datablock.
    """
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
    """Assign the active action, creating animation_data on first use."""
    obj.animation_data_create().action = action


def _action_result(obj: bpy.types.Object, action: bpy.types.Action) -> dict[str, Any]:
    """Standard result envelope for action operations (summary + evidence)."""
    identifier = blockout.ensure_stable_id(obj)
    return {
        "affectedObjectIds": [identifier],
        "dirtyObjectIds": [identifier],
        "action": _action_summary(action, obj),
        "rigSelection": selection_state(obj),
        **_interaction_evidence(),
    }


def create_action(operation: dict[str, Any]) -> dict[str, Any]:
    """Create a new action owned by the armature and make it active.

    Uniqueness is enforced per object display name (not globally), matching
    how the workbench lists actions per character.
    """
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
    """Switch which owned action the armature evaluates."""
    obj = _armature(operation["id"])
    action = _action(operation["actionName"], obj)
    _set_action(obj, action)
    return _action_result(obj, action)


def set_scene_frame(operation: dict[str, Any]) -> dict[str, Any]:
    """Move the scene playhead; reports the frame Blender actually landed on."""
    bpy.context.scene.frame_set(operation["frame"])
    return {
        "affectedObjectIds": [],
        "dirtyObjectIds": [],
        "frame": int(bpy.context.scene.frame_current),
        **_interaction_evidence(),
    }


def _pose_channel_paths(channels: Iterable[str]) -> list[str]:
    """Map wire channel names (LOCATION/ROTATION/SCALE) to RNA data paths."""
    return [POSE_CHANNEL_PATHS[channel] for channel in channels]


def _keyframe_point_count(action: bpy.types.Action, obj: bpy.types.Object) -> int:
    """Total keyframe points of ``action`` on ``obj``; used to report deltas."""
    return sum(
        len(curve.keyframe_points)
        for curve in _action_fcurves(action, obj)
    )


def insert_pose_keyframes(operation: dict[str, Any]) -> dict[str, Any]:
    """Key the requested channels of the given bones at one frame.

    The target action is made active first so keyframe_insert writes into it
    rather than whatever action happened to be assigned. The requested
    interpolation is applied only to the points created at this frame, and
    the result reports the net keyframe-count delta as evidence.
    """
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
    """Remove keyframes on the requested bone channels at one frame."""
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
