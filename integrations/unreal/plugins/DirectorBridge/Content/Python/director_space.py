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
    if failures:
        print(json.dumps({"ok": False, "failures": failures}))
        return 1
    print(json.dumps({"ok": True, "cases": len(SELF_TEST_CASES) + len(samples)}))
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(run_self_test())
    print(__doc__)
