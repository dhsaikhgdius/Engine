"""Coordinate conversion between Director canonical space and Unreal Engine.

Director canonical space: right-handed, Y-up, metres, camera forward local -Z.
Unreal Engine world space: left-handed, Z-up, centimetres, camera forward +X.

The Director protocol pins the basis change as the signed permutation
``(x, y, z) -> (-z * 100, x * 100, y * 100)`` (see
``packages/dcc-protocol/src/directorDccEngineSpace.ts``). This module is pure
Python (no ``unreal`` import) so the math can be verified host-free with
``python3 director_space.py --self-test`` and by the Gateway test suite.

Rotations are quaternions ``[x, y, z, w]``. Conjugating a rotation by the
improper permutation ``P`` (det -1) equals conjugating by the proper rotation
``-P``, so quaternion vector parts transform as ``v -> -P v`` with ``w``
unchanged. Scale components permute along with the axes.
"""

from __future__ import annotations

import json
import math
import sys
from typing import List, Sequence

UNITS_PER_METER = 100.0

Vec3 = List[float]
Quat = List[float]


def quat_from_euler_xyz(rx: float, ry: float, rz: float) -> Quat:
    """Quaternion for Director's intrinsic XYZ Euler order (three.js 'XYZ')."""
    c1, s1 = math.cos(rx / 2.0), math.sin(rx / 2.0)
    c2, s2 = math.cos(ry / 2.0), math.sin(ry / 2.0)
    c3, s3 = math.cos(rz / 2.0), math.sin(rz / 2.0)
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ]


def quat_multiply(a: Sequence[float], b: Sequence[float]) -> Quat:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def quat_normalize(q: Sequence[float]) -> Quat:
    length = math.sqrt(sum(component * component for component in q))
    if length == 0.0:
        return [0.0, 0.0, 0.0, 1.0]
    return [component / length for component in q]


def quat_rotate_vector(q: Sequence[float], v: Sequence[float]) -> Vec3:
    qx, qy, qz, qw = q
    vx, vy, vz = v
    # v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v)
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ]


def vec_sub(left: Sequence[float], right: Sequence[float]) -> Vec3:
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]


def vec_cross(left: Sequence[float], right: Sequence[float]) -> Vec3:
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]


def vec_length_sq(value: Sequence[float]) -> float:
    return value[0] * value[0] + value[1] * value[1] + value[2] * value[2]


def vec_normalize(value: Sequence[float]) -> Vec3:
    length = math.sqrt(vec_length_sq(value))
    if length == 0.0:
        return [0.0, 0.0, 0.0]
    return [component / length for component in value]


def quat_from_basis(x_axis: Sequence[float], y_axis: Sequence[float], z_axis: Sequence[float]) -> Quat:
    """Quaternion from an orthonormal column basis (mirror of three.js setFromRotationMatrix)."""
    m11, m12, m13 = x_axis[0], y_axis[0], z_axis[0]
    m21, m22, m23 = x_axis[1], y_axis[1], z_axis[1]
    m31, m32, m33 = x_axis[2], y_axis[2], z_axis[2]
    trace = m11 + m22 + m33
    if trace > 0.0:
        scale = 0.5 / math.sqrt(trace + 1.0)
        return quat_normalize([(m32 - m23) * scale, (m13 - m31) * scale, (m21 - m12) * scale, 0.25 / scale])
    if m11 > m22 and m11 > m33:
        scale = 2.0 * math.sqrt(1.0 + m11 - m22 - m33)
        return quat_normalize([0.25 * scale, (m12 + m21) / scale, (m13 + m31) / scale, (m32 - m23) / scale])
    if m22 > m33:
        scale = 2.0 * math.sqrt(1.0 + m22 - m11 - m33)
        return quat_normalize([(m12 + m21) / scale, 0.25 * scale, (m23 + m32) / scale, (m13 - m31) / scale])
    scale = 2.0 * math.sqrt(1.0 + m33 - m11 - m22)
    return quat_normalize([(m13 + m31) / scale, (m23 + m32) / scale, 0.25 * scale, (m21 - m12) / scale])


def camera_look_quaternion(
    position: Sequence[float],
    target: Sequence[float],
    fallback_rotation_euler_xyz: Sequence[float],
) -> Quat:
    """Director camera look-at rotation (camera forward local -Z, +Y up).

    Mirrors ``directorCameraLookQuaternion`` in
    ``packages/dcc-interchange/src/cameraOrientation.ts`` (three.js
    ``Matrix4.lookAt`` semantics) so headless-spawned cameras aim exactly like
    the glTF/OpenUSD exports. Falls back to the camera's authored Euler
    rotation when position and target coincide.
    """
    forward = vec_sub(target, position)
    if vec_length_sq(forward) <= sys.float_info.epsilon:
        return quat_from_euler_xyz(*fallback_rotation_euler_xyz)
    forward = vec_normalize(forward)
    up = [0.0, 0.0, 1.0] if abs(forward[1]) > 0.999 else [0.0, 1.0, 0.0]
    z_axis = vec_normalize(vec_sub(position, target))
    x_axis = vec_cross(up, z_axis)
    if vec_length_sq(x_axis) == 0.0:
        # Mirror three.js lookAt degeneracy handling: nudge z before re-crossing.
        if abs(up[2]) == 1.0:
            z_axis[0] += 0.0001
        else:
            z_axis[2] += 0.0001
        z_axis = vec_normalize(z_axis)
        x_axis = vec_cross(up, z_axis)
    x_axis = vec_normalize(x_axis)
    y_axis = vec_cross(z_axis, x_axis)
    return quat_from_basis(x_axis, y_axis, z_axis)


def compose_world_transform(
    scene_position: Sequence[float],
    scene_rotation_euler_xyz: Sequence[float],
    scene_scale: float,
    local_position: Sequence[float],
    local_rotation_quaternion: Sequence[float],
    local_scale: Sequence[float],
) -> dict:
    """Compose Director scene transform (uniform scale) with a local TRS.

    Uniform scene scale commutes with rotation, so the world decomposition is
    exact: no matrix decompose is needed.
    """
    scene_quat = quat_from_euler_xyz(*scene_rotation_euler_xyz)
    scaled = [component * scene_scale for component in local_position]
    rotated = quat_rotate_vector(scene_quat, scaled)
    return {
        "location": [rotated[index] + scene_position[index] for index in range(3)],
        "rotationQuaternion": quat_normalize(quat_multiply(scene_quat, local_rotation_quaternion)),
        "scale": [component * scene_scale for component in local_scale],
    }


def director_point_to_unreal(point: Sequence[float]) -> Vec3:
    """Director metres (RH Y-up) -> Unreal centimetres (LH Z-up)."""
    x, y, z = point
    return [-z * UNITS_PER_METER, x * UNITS_PER_METER, y * UNITS_PER_METER]


def unreal_point_to_director(point: Sequence[float]) -> Vec3:
    x, y, z = point
    return [y / UNITS_PER_METER, z / UNITS_PER_METER, -x / UNITS_PER_METER]


def director_direction_to_unreal(direction: Sequence[float]) -> Vec3:
    x, y, z = direction
    return [-z, x, y]


def unreal_direction_to_director(direction: Sequence[float]) -> Vec3:
    x, y, z = direction
    return [y, z, -x]


def director_quat_to_unreal(q: Sequence[float]) -> Quat:
    """Vector part transforms as -P v with P v = (-z, x, y); w unchanged."""
    x, y, z, w = q
    return quat_normalize([z, -x, -y, w])


def unreal_quat_to_director(q: Sequence[float]) -> Quat:
    x, y, z, w = q
    return quat_normalize([-y, -z, x, w])


def director_scale_to_unreal(scale: Sequence[float]) -> Vec3:
    x, y, z = scale
    return [z, x, y]


def unreal_scale_to_director(scale: Sequence[float]) -> Vec3:
    x, y, z = scale
    return [y, z, x]


def director_transform_to_unreal(transform: dict) -> dict:
    """Canonical wire TRS (location/rotationQuaternion/scale) -> Unreal TRS."""
    return {
        "location": director_point_to_unreal(transform["location"]),
        "rotationQuaternion": director_quat_to_unreal(transform["rotationQuaternion"]),
        "scale": director_scale_to_unreal(transform["scale"]),
    }


def unreal_transform_to_director(transform: dict) -> dict:
    return {
        "location": unreal_point_to_director(transform["location"]),
        "rotationQuaternion": unreal_quat_to_director(transform["rotationQuaternion"]),
        "scale": unreal_scale_to_director(transform["scale"]),
    }


# Golden cases mirrored by the Gateway host-free tests
# (backend/gateway/tests/dcc/engineConnectorSpace.test.ts).
SELF_TEST_CASES = [
    {
        "name": "unit point one metre forward",
        "director_point": [0.0, 0.0, -1.0],
        "unreal_point": [100.0, 0.0, 0.0],
    },
    {
        "name": "up axis",
        "director_point": [0.0, 1.0, 0.0],
        "unreal_point": [0.0, 0.0, 100.0],
    },
    {
        "name": "right axis",
        "director_point": [1.0, 0.0, 0.0],
        "unreal_point": [0.0, 100.0, 0.0],
    },
    {
        "name": "identity quaternion",
        "director_quat": [0.0, 0.0, 0.0, 1.0],
        "unreal_quat": [0.0, 0.0, 0.0, 1.0],
    },
    {
        "name": "quarter turn about director Y (yaw left)",
        "director_quat": [0.0, math.sin(math.pi / 4.0), 0.0, math.cos(math.pi / 4.0)],
        "unreal_quat": [0.0, 0.0, -math.sin(math.pi / 4.0), math.cos(math.pi / 4.0)],
    },
]


def _close(left: Sequence[float], right: Sequence[float], tolerance: float = 1e-9) -> bool:
    return len(left) == len(right) and all(abs(a - b) <= tolerance for a, b in zip(left, right))


def _quat_close(left: Sequence[float], right: Sequence[float], tolerance: float = 1e-9) -> bool:
    # q and -q encode the same rotation.
    dot = sum(a * b for a, b in zip(left, right))
    return abs(abs(dot) - 1.0) <= tolerance


def run_self_test() -> int:
    failures = []
    for case in SELF_TEST_CASES:
        if "director_point" in case:
            forward = director_point_to_unreal(case["director_point"])
            backward = unreal_point_to_director(case["unreal_point"])
            if not _close(forward, case["unreal_point"]):
                failures.append(f"{case['name']}: forward point {forward} != {case['unreal_point']}")
            if not _close(backward, case["director_point"]):
                failures.append(f"{case['name']}: backward point {backward} != {case['director_point']}")
        if "director_quat" in case:
            forward = director_quat_to_unreal(case["director_quat"])
            backward = unreal_quat_to_director(case["unreal_quat"])
            if not _quat_close(forward, case["unreal_quat"]):
                failures.append(f"{case['name']}: forward quat {forward} != {case['unreal_quat']}")
            if not _quat_close(backward, case["director_quat"]):
                failures.append(f"{case['name']}: backward quat {backward} != {case['director_quat']}")
    # Round-trip invariants over a spread of representative values.
    samples = [
        [0.3, -1.25, 4.5],
        [-2.0, 0.0, 0.125],
        [10.0, -10.0, 10.0],
    ]
    for sample in samples:
        if not _close(unreal_point_to_director(director_point_to_unreal(sample)), sample, 1e-9):
            failures.append(f"point round trip failed for {sample}")
        quaternion = quat_normalize(sample + [1.0])
        if not _quat_close(unreal_quat_to_director(director_quat_to_unreal(quaternion)), quaternion):
            failures.append(f"quaternion round trip failed for {quaternion}")
        if not _close(unreal_scale_to_director(director_scale_to_unreal(sample)), sample):
            failures.append(f"scale round trip failed for {sample}")
    # Camera look-at: identity when looking down -Z, quarter yaw toward +X,
    # Euler fallback for coincident targets, and the forward-carrying property.
    if not _quat_close(camera_look_quaternion([0, 0, 0], [0, 0, -1], [0, 0, 0]), [0, 0, 0, 1], 1e-9):
        failures.append("look-at toward -Z is not the identity rotation")
    quarter = math.sqrt(0.5)
    if not _quat_close(camera_look_quaternion([0, 0, 0], [1, 0, 0], [0, 0, 0]), [0, -quarter, 0, quarter], 1e-9):
        failures.append("look-at toward +X is not a -90 degree yaw")
    fallback = quat_from_euler_xyz(0.3, -0.4, 0.5)
    if not _quat_close(camera_look_quaternion([1, 2, 3], [1, 2, 3], [0.3, -0.4, 0.5]), fallback, 1e-9):
        failures.append("coincident look-at target does not fall back to the Euler rotation")
    for eye, target in [([0, 1, 0], [2, 0.5, -3]), ([-1, 2, 4], [-1, -5, 4.0001]), ([3, 3, 3], [3, 9, 3])]:
        rotation = camera_look_quaternion(eye, target, [0, 0, 0])
        carried = quat_rotate_vector(rotation, [0.0, 0.0, -1.0])
        expected_forward = vec_normalize(vec_sub(target, eye))
        if not _close(carried, expected_forward, 1e-3):
            failures.append(f"look-at from {eye} to {target} does not carry -Z onto the forward ray: {carried}")
    if failures:
        print(json.dumps({"ok": False, "failures": failures}))
        return 1
    print(json.dumps({"ok": True, "cases": len(SELF_TEST_CASES) + len(samples)}))
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(run_self_test())
    print(__doc__)
