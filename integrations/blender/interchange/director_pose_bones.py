"""Host-free mapping between Blender pose bones and Director portable pose controls.

``director_bridge.py`` resolves the Mixamo-style bone roles of an imported
character armature and stamps the mapping plus per-bone baselines into the
.blend. ``director_return_export.py`` reads them back and reconciles direct
pose-bone rotations into portable ``director_pose.*`` control values when the
edited bone maps to a Director character binding.

Reconciliation is deliberately bounded and honest:

- Only local rotations of mapped bones reconcile, as per-axis degree deltas
  added to the export-time control baseline. Single-axis edits (bend an elbow,
  turn the head) recover exactly; large combined multi-axis edits are an
  approximation because Euler composition does not commute.
- Rotation components on axes that have no portable control, bone location or
  scale edits, and edits to unmapped bones are warned about and omitted --
  never silently flattened into a wrong pose.

This module must stay importable without ``bpy`` so the mapping can be unit
tested outside Blender.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable

# Mirror of frontend/director/src/comprehensive/editor/runtime/mixamo/
# mixamoBoneRoleAliases.json. A unit test compares the two files; edit the
# JSON first, then update this table to match.
MIXAMO_BONE_ROLE_ALIASES: dict[str, tuple[str, ...]] = {
    "body": ("Hips",),
    "torso": ("Spine2", "Spine1", "Spine"),
    "head": ("Head",),
    "leftShoulder": ("LeftArm", "LeftShoulder"),
    "rightShoulder": ("RightArm", "RightShoulder"),
    "leftElbow": ("LeftForeArm", "LeftLowerArm"),
    "rightElbow": ("RightForeArm", "RightLowerArm"),
    "leftHand": ("LeftHand",),
    "rightHand": ("RightHand",),
    "leftHip": ("LeftUpLeg", "LeftUpperLeg"),
    "rightHip": ("RightUpLeg", "RightUpperLeg"),
    "leftKnee": ("LeftLeg", "LeftLowerLeg"),
    "rightKnee": ("RightLeg", "RightLowerLeg"),
    "leftFoot": ("LeftFoot",),
    "rightFoot": ("RightFoot",),
}

_AXIS_NAMES = ("X", "Y", "Z")

# Inverse of getMixamoPoseBoneRotations (mixamoCharacterRig.ts): for each bone
# role, the portable control and sign that own each local euler axis (Three.js
# "XYZ" order). ``None`` marks an axis with no portable control; a rotation
# component there is warned about and omitted. The static neutral-shoulder
# offset is part of the visual base pose, not of these deltas.
POSE_CONTROL_AXES: dict[str, tuple[tuple[str | None, float], ...]] = {
    "body": (("body.pitch", 1.0), ("body.yaw", 1.0), ("body.roll", 1.0)),
    "torso": (("torso.pitch", 1.0), ("torso.yaw", 1.0), ("torso.roll", 1.0)),
    "head": (("head.pitch", 1.0), ("head.yaw", 1.0), ("head.roll", 1.0)),
    "leftShoulder": (("leftShoulder.spread", 1.0), ("leftShoulder.twist", 1.0), ("leftShoulder.pitch", 1.0)),
    "rightShoulder": (("rightShoulder.spread", -1.0), ("rightShoulder.twist", 1.0), ("rightShoulder.pitch", -1.0)),
    "leftElbow": ((None, 1.0), (None, 1.0), ("leftElbow.bend", 1.0)),
    "rightElbow": ((None, 1.0), (None, 1.0), ("rightElbow.bend", -1.0)),
    "leftHand": (("leftHand.pitch", 1.0), ("leftHand.twist", 1.0), ("leftHand.roll", 1.0)),
    "rightHand": (("rightHand.pitch", 1.0), ("rightHand.twist", 1.0), ("rightHand.roll", 1.0)),
    "leftHip": (("leftHip.pitch", 1.0), ("leftHip.twist", 1.0), ("leftHip.spread", -1.0)),
    "rightHip": (("rightHip.pitch", 1.0), ("rightHip.twist", 1.0), ("rightHip.spread", -1.0)),
    "leftKnee": (("leftKnee.bend", -1.0), (None, 1.0), (None, 1.0)),
    "rightKnee": (("rightKnee.bend", -1.0), (None, 1.0), (None, 1.0)),
    "leftFoot": (("leftFoot.pitch", 1.0), ("leftFoot.twist", 1.0), ("leftFoot.roll", 1.0)),
    "rightFoot": (("rightFoot.pitch", 1.0), ("rightFoot.twist", 1.0), ("rightFoot.roll", 1.0)),
}

# Rotations below this angle are treated as float noise, not artist intent.
MIN_DELTA_DEGREES = 0.05
# Residual components above this angle on an unmapped axis get a warning.
RESIDUAL_WARNING_DEGREES = 0.25
# Bone translation/scale baselines use an absolute tolerance in local units.
LOCATION_TOLERANCE = 1e-4
SCALE_TOLERANCE = 1e-4

_NAMESPACE_PREFIX = re.compile(r"^mixamorig(?:[_\s-]*\d+)?(?:[:._\s-]+)?", re.IGNORECASE)
_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]", re.IGNORECASE)


def canonical_bone_name(name: str) -> str:
    """Port of canonicalizeHumanoidBoneName (humanoidRig.ts); keep byte-identical."""
    leaf = re.split(r"[|/\\]", str(name).strip())[-1]
    without_namespace = _NAMESPACE_PREFIX.sub("", leaf)
    return _NON_ALPHANUMERIC.sub("", without_namespace).lower()


def resolve_pose_bone_roles(bone_names: Iterable[str]) -> dict[str, str]:
    """Map Director bone roles to actual bone names, first alias match wins.

    Mirrors resolveBoneRefs in blenderCharacterAdapter.ts: bone names are
    canonicalized, the first bone that claims a canonical token keeps it.
    """
    by_canonical: dict[str, str] = {}
    for bone_name in bone_names:
        canonical = canonical_bone_name(bone_name)
        if canonical and canonical not in by_canonical:
            by_canonical[canonical] = str(bone_name)
    resolved: dict[str, str] = {}
    for role, aliases in MIXAMO_BONE_ROLE_ALIASES.items():
        for alias in aliases:
            bone_name = by_canonical.get(canonical_bone_name(alias))
            if bone_name is not None:
                resolved[role] = bone_name
                break
    return resolved


def _normalize_quaternion(quaternion: Iterable[float]) -> tuple[float, float, float, float]:
    """Unit-normalize a (w,x,y,z) quaternion; degenerate input becomes identity."""
    w, x, y, z = (float(value) for value in quaternion)
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if norm < 1e-12:
        return (1.0, 0.0, 0.0, 0.0)
    return (w / norm, x / norm, y / norm, z / norm)


def quaternion_multiply(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """Hamilton product of two (w,x,y,z) quaternions (left applied after right)."""
    lw, lx, ly, lz = left
    rw, rx, ry, rz = right
    return (
        lw * rw - lx * rx - ly * ry - lz * rz,
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
    )


def pose_bone_rotation_delta(
    baseline: Iterable[float],
    current: Iterable[float],
) -> tuple[float, float, float, float]:
    """Local rotation delta (baseline^-1 * current) as a normalized (w,x,y,z).

    Matches how Director applies control rotations on top of the base pose
    (``bone.quaternion.multiply(controlQuaternion)`` in mixamoCharacterRig.ts).
    """
    bw, bx, by, bz = _normalize_quaternion(baseline)
    return _normalize_quaternion(quaternion_multiply((bw, -bx, -by, -bz), _normalize_quaternion(current)))


def rotation_angle_degrees(quaternion: Iterable[float]) -> float:
    """Total rotation angle of a quaternion in degrees (sign-insensitive)."""
    w = _normalize_quaternion(quaternion)[0]
    return math.degrees(2.0 * math.acos(min(1.0, abs(w))))


def three_xyz_euler_from_quaternion(quaternion: Iterable[float]) -> tuple[float, float, float]:
    """Decompose (w,x,y,z) into Three.js "XYZ"-order Euler angles in radians.

    This mirrors Euler.setFromRotationMatrix(order="XYZ"), the convention used
    by the Director rig adapter, and is intentionally NOT Blender's mathutils
    XYZ convention (which composes in the opposite order).
    """
    w, x, y, z = _normalize_quaternion(quaternion)
    m11 = 1.0 - 2.0 * (y * y + z * z)
    m12 = 2.0 * (x * y - w * z)
    m13 = 2.0 * (x * z + w * y)
    m22 = 1.0 - 2.0 * (x * x + z * z)
    m23 = 2.0 * (y * z - w * x)
    m32 = 2.0 * (y * z + w * x)
    m33 = 1.0 - 2.0 * (x * x + y * y)
    euler_y = math.asin(max(-1.0, min(1.0, m13)))
    if abs(m13) < 0.9999999:
        euler_x = math.atan2(-m23, m33)
        euler_z = math.atan2(-m12, m11)
    else:
        euler_x = math.atan2(m32, m22)
        euler_z = 0.0
    return (euler_x, euler_y, euler_z)


def reconcile_pose_bone_deltas(
    deltas_by_role: dict[str, Any],
    baseline_controls: dict[str, Any],
) -> tuple[dict[str, float], list[str]]:
    """Convert per-role local rotation deltas into portable control values.

    ``deltas_by_role`` maps a bone role to its (w,x,y,z) rotation delta.
    Returns the changed controls as absolute values (baseline + per-axis
    delta) plus warn-and-omit notes for everything that does not map.
    """
    controls: dict[str, float] = {}
    warnings: list[str] = []
    for role in sorted(deltas_by_role):
        axes = POSE_CONTROL_AXES.get(role)
        delta = _normalize_quaternion(deltas_by_role[role])
        if axes is None:
            warnings.append(f"pose bone role {role!r} has no portable Director controls; the edit was omitted.")
            continue
        if rotation_angle_degrees(delta) < MIN_DELTA_DEGREES:
            continue
        euler = three_xyz_euler_from_quaternion(delta)
        for axis_index, (control, sign) in enumerate(axes):
            angle_degrees = math.degrees(euler[axis_index])
            if abs(angle_degrees) < MIN_DELTA_DEGREES:
                continue
            if control is None:
                if abs(angle_degrees) >= RESIDUAL_WARNING_DEGREES:
                    warnings.append(
                        f"{role} bone rotation of {angle_degrees:.2f}° around local {_AXIS_NAMES[axis_index]} has no "
                        "portable Director control; that component was omitted."
                    )
                continue
            baseline_value = baseline_controls.get(control)
            if not isinstance(baseline_value, (int, float)) or not math.isfinite(float(baseline_value)):
                warnings.append(
                    f"{role} bone edit maps to {control!r}, which is not part of this character's exported control "
                    "baseline; the edit was omitted."
                )
                continue
            controls[control] = float(baseline_value) + sign * angle_degrees
    return controls, warnings


def vectors_close(left: Iterable[float], right: Iterable[float], tolerance: float) -> bool:
    """Absolute component-wise comparison for bone location/scale baselines."""
    left_values = [float(value) for value in left]
    right_values = [float(value) for value in right]
    if len(left_values) != len(right_values):
        return False
    return all(abs(a - b) <= tolerance for a, b in zip(left_values, right_values))
