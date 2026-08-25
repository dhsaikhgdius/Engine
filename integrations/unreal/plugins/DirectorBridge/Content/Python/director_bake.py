"""Load, verify, and convert the Gateway's Unreal Sequencer bake sidecar.

Pure Python (no ``unreal`` import). The Gateway writes
``director-unreal-sequencer-bake-v1`` (see
``packages/dcc-protocol/src/directorUnrealSequencerContract.ts``) into the
private job directory and pins its SHA-256 through the fixed argument array.
This module refuses tampered sidecars, re-validates the structure, and turns
canonical Director-space samples into per-channel Unreal keys:

- locations in centimetres via the pinned ``director_space`` basis change;
- rotations as Unreal rotator degrees (roll/pitch/yaw) using the same
  quaternion-to-rotator math as ``FQuat::Rotator``, with per-channel
  continuity unwrapping so dense sampled keys never spin through ±180;
- scale factors permuted onto Unreal's axes.

Verified host-free by ``backend/gateway/tests/dcc/unrealConnectorModules.test.ts``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from typing import Dict, List, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import director_space as dspace  # noqa: E402

BAKE_CONTRACT = "director-unreal-sequencer-bake-v1"
MAX_ENTITIES = 2_048
MAX_SAMPLES_PER_ENTITY = 100_000
SINGULARITY_THRESHOLD = 0.4999995


class DirectorBakeError(RuntimeError):
    """Raised when the bake sidecar fails hash or structural validation."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DirectorBakeError(message)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _validate_transform(transform, where: str) -> None:
    _require(isinstance(transform, dict), f"{where}: transform must be an object")
    for key, size in (("location", 3), ("rotationQuaternion", 4), ("scale", 3)):
        value = transform.get(key)
        _require(isinstance(value, list) and len(value) == size, f"{where}: {key} must have {size} components")
        _require(all(_is_number(component) for component in value), f"{where}: {key} must be finite numbers")
    length = math.sqrt(sum(component * component for component in transform["rotationQuaternion"]))
    _require(length > 1e-8, f"{where}: rotationQuaternion must have a non-zero length")


def _validate_samples(samples, where: str, requires_transform: bool) -> None:
    _require(isinstance(samples, list), f"{where}: samples must be an array")
    _require(len(samples) <= MAX_SAMPLES_PER_ENTITY, f"{where}: more than {MAX_SAMPLES_PER_ENTITY} samples")
    previous_frame = None
    for index, sample in enumerate(samples):
        entry = f"{where}[{index}]"
        _require(isinstance(sample, dict), f"{entry}: sample must be an object")
        frame = sample.get("frame")
        _require(isinstance(frame, int) and not isinstance(frame, bool), f"{entry}: frame must be an integer")
        if previous_frame is not None:
            _require(frame > previous_frame, f"{entry}: frames must be strictly increasing")
        previous_frame = frame
        if requires_transform:
            _validate_transform(sample.get("transform"), entry)
        else:
            _require(_is_number(sample.get("focalLengthMm")) and sample["focalLengthMm"] > 0,
                     f"{entry}: focalLengthMm must be a positive number")


def load_bake(path: str, expected_sha256: str, package_id: str, source_revision: str) -> dict:
    """Load and verify a bake sidecar against its pinned hash and package identity.

    @param path: Absolute sidecar path from the fixed argument array.
    @param expected_sha256: The Gateway-pinned SHA-256 of the sidecar bytes.
    @param package_id: The exchange package id this job consumes.
    @param source_revision: The exchange package's project revision.
    @returns The validated bake manifest.
    @raises DirectorBakeError: On any hash, identity, or structural mismatch.
    """
    with open(path, "rb") as handle:
        body = handle.read()
    actual = hashlib.sha256(body).hexdigest()
    _require(
        actual == (expected_sha256 or "").strip().lower(),
        f"Sequencer bake SHA-256 mismatch: expected {expected_sha256}, found {actual}",
    )
    try:
        bake = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DirectorBakeError(f"Sequencer bake is not valid JSON: {error}") from error

    _require(isinstance(bake, dict), "Sequencer bake must be a JSON object")
    _require(bake.get("contract") == BAKE_CONTRACT, f"Unexpected bake contract: {bake.get('contract')!r}")
    _require(bake.get("schemaVersion") == 1, f"Unsupported bake schemaVersion: {bake.get('schemaVersion')!r}")
    _require(bake.get("provider") == "unreal", f"Bake targets provider {bake.get('provider')!r}, expected 'unreal'")
    _require(bake.get("packageId") == package_id, "Bake packageId does not match the exchange package")
    _require(bake.get("sourceRevision") == source_revision, "Bake sourceRevision does not match the exchange package")

    timebase = bake.get("timebase")
    _require(isinstance(timebase, dict), "Bake timebase must be an object")
    rate = timebase.get("rate")
    _require(
        isinstance(rate, dict)
        and isinstance(rate.get("numerator"), int)
        and isinstance(rate.get("denominator"), int)
        and rate["numerator"] > 0
        and rate["denominator"] > 0,
        "Bake timebase rate must be a positive rational",
    )
    _require(isinstance(timebase.get("dropFrame"), bool), "Bake timebase dropFrame must be a boolean")
    _require(isinstance(timebase.get("startTimecode"), str), "Bake timebase startTimecode must be a string")

    playback = bake.get("playback")
    _require(
        isinstance(playback, dict)
        and isinstance(playback.get("frameStart"), int)
        and isinstance(playback.get("frameEnd"), int)
        and playback["frameEnd"] >= playback["frameStart"],
        "Bake playback range must be an ordered integer range",
    )

    entities = bake.get("entities")
    _require(isinstance(entities, list), "Bake entities must be an array")
    _require(len(entities) <= MAX_ENTITIES, f"Bake carries more than {MAX_ENTITIES} entities")
    seen_ids = set()
    for index, entity in enumerate(entities):
        where = f"entities[{index}]"
        _require(isinstance(entity, dict), f"{where}: entity must be an object")
        director_id = entity.get("directorId")
        _require(isinstance(director_id, str) and director_id, f"{where}: directorId must be a non-empty string")
        _require(director_id not in seen_ids, f"{where}: duplicate directorId {director_id!r}")
        seen_ids.add(director_id)
        entity_type = entity.get("entityType")
        _require(entity_type in ("object", "camera"), f"{where}: entityType must be object or camera")
        _validate_samples(entity.get("transformSamples"), f"{where}.transformSamples", requires_transform=True)
        _require(len(entity["transformSamples"]) >= 1, f"{where}: at least one transform sample is required")
        focal_samples = entity.get("focalLengthSamples")
        if focal_samples is not None:
            _require(entity_type == "camera", f"{where}: focalLengthSamples is a camera-only channel")
            _validate_samples(focal_samples, f"{where}.focalLengthSamples", requires_transform=False)
        filmback = entity.get("filmback")
        if filmback is not None:
            _require(entity_type == "camera", f"{where}: filmback is a camera-only channel")
            _require(
                isinstance(filmback, dict)
                and _is_number(filmback.get("sensorWidthMm"))
                and _is_number(filmback.get("sensorHeightMm"))
                and filmback["sensorWidthMm"] > 0
                and filmback["sensorHeightMm"] > 0,
                f"{where}: filmback must carry positive sensor dimensions",
            )
    warnings = bake.get("warnings")
    _require(isinstance(warnings, list) and all(isinstance(warning, str) for warning in warnings),
             "Bake warnings must be an array of strings")
    return bake


def _normalize_axis(degrees: float) -> float:
    """Wrap an angle into (-180, 180], mirroring FRotator::NormalizeAxis."""
    wrapped = math.fmod(degrees, 360.0)
    if wrapped > 180.0:
        wrapped -= 360.0
    elif wrapped <= -180.0:
        wrapped += 360.0
    return wrapped


def unreal_quat_to_rotator(quaternion) -> Tuple[float, float, float]:
    """Unreal-space quaternion [x,y,z,w] -> (roll, pitch, yaw) degrees.

    Mirrors ``FQuat::Rotator`` including the gimbal singularity handling, so
    baked keys land on the same euler values the editor would produce.
    """
    x, y, z, w = quaternion
    singularity = z * x - w * y
    yaw_y = 2.0 * (w * z + x * y)
    yaw_x = 1.0 - 2.0 * (y * y + z * z)
    if singularity < -SINGULARITY_THRESHOLD:
        pitch = -90.0
        yaw = math.degrees(math.atan2(yaw_y, yaw_x))
        roll = _normalize_axis(-yaw - 2.0 * math.degrees(math.atan2(x, w)))
    elif singularity > SINGULARITY_THRESHOLD:
        pitch = 90.0
        yaw = math.degrees(math.atan2(yaw_y, yaw_x))
        roll = _normalize_axis(yaw - 2.0 * math.degrees(math.atan2(x, w)))
    else:
        pitch = math.degrees(math.asin(max(-1.0, min(1.0, 2.0 * singularity))))
        yaw = math.degrees(math.atan2(yaw_y, yaw_x))
        roll = math.degrees(math.atan2(-2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y)))
    return (roll, pitch, yaw)


def unreal_rotator_to_quat(roll: float, pitch: float, yaw: float) -> List[float]:
    """(roll, pitch, yaw) degrees -> Unreal-space quaternion, mirroring FRotator::Quaternion."""
    sp, cp = math.sin(math.radians(pitch) / 2.0), math.cos(math.radians(pitch) / 2.0)
    sy, cy = math.sin(math.radians(yaw) / 2.0), math.cos(math.radians(yaw) / 2.0)
    sr, cr = math.sin(math.radians(roll) / 2.0), math.cos(math.radians(roll) / 2.0)
    return [
        cr * sp * sy - sr * cp * cy,
        -cr * sp * cy - sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    ]


def _unwrap_toward(previous: float, current: float) -> float:
    """Shift ``current`` by whole turns so it is numerically closest to ``previous``."""
    while current - previous > 180.0:
        current -= 360.0
    while current - previous < -180.0:
        current += 360.0
    return current


def entity_track_keys(entity: dict) -> dict:
    """Convert one baked entity to per-channel Unreal keys.

    @param entity: A validated bake entity.
    @returns ``{"transform": [{frame, location, rotation, scale}], "focalLength": [...]}``
        where ``location`` is centimetres, ``rotation`` is continuity-unwrapped
        (roll, pitch, yaw) degrees, and ``scale`` is Unreal-axis-ordered.
    """
    transform_keys = []
    previous_rotation: Optional[Tuple[float, float, float]] = None
    for sample in entity["transformSamples"]:
        engine = dspace.director_transform_to_unreal(sample["transform"])
        rotation = unreal_quat_to_rotator(engine["rotationQuaternion"])
        if previous_rotation is not None:
            rotation = tuple(
                _unwrap_toward(previous_component, component)
                for previous_component, component in zip(previous_rotation, rotation)
            )
        previous_rotation = rotation
        transform_keys.append(
            {
                "frame": sample["frame"],
                "location": engine["location"],
                "rotation": list(rotation),
                "scale": engine["scale"],
            }
        )
    focal_keys = [
        {"frame": sample["frame"], "focalLengthMm": sample["focalLengthMm"]}
        for sample in entity.get("focalLengthSamples") or []
    ]
    return {"transform": transform_keys, "focalLength": focal_keys}


def bake_key_count(bake: dict) -> int:
    """Total number of keys the bake will author across all channels."""
    total = 0
    for entity in bake["entities"]:
        # 9 double channels per transform key (location/rotation/scale xyz).
        total += len(entity["transformSamples"]) * 9
        total += len(entity.get("focalLengthSamples") or [])
    return total


def _quat_close(left, right, tolerance: float = 1e-6) -> bool:
    dot = sum(a * b for a, b in zip(left, right))
    return abs(abs(dot) - 1.0) <= tolerance


def run_self_test() -> int:
    """Verify the rotator math is self-consistent and continuity unwrapping works."""
    failures = []
    samples = [
        [0.0, 0.0, 0.0, 1.0],
        dspace.quat_normalize([0.1, 0.2, 0.3, 0.9]),
        dspace.quat_normalize([-0.5, 0.5, -0.5, 0.5]),
        dspace.quat_normalize([0.7, -0.1, 0.05, 0.7]),
        dspace.quat_normalize([0.0, math.sin(math.pi / 4.0), 0.0, math.cos(math.pi / 4.0)]),
    ]
    for quaternion in samples:
        roll, pitch, yaw = unreal_quat_to_rotator(quaternion)
        rebuilt = unreal_rotator_to_quat(roll, pitch, yaw)
        if not _quat_close(quaternion, rebuilt):
            failures.append(f"rotator round trip failed for {quaternion}: got {rebuilt}")
    # Near-singularity pitch (+90 degrees) must still round trip.
    singular = unreal_rotator_to_quat(25.0, 90.0, 40.0)
    roll, pitch, yaw = unreal_quat_to_rotator(singular)
    if not _quat_close(singular, unreal_rotator_to_quat(roll, pitch, yaw)):
        failures.append("singular pitch round trip failed")
    # Continuity unwrapping keeps a full turn monotonic.
    unwrapped = [0.0]
    for angle in (120.0, -120.0, 0.0):  # naive wrap of 120, 240, 360 degrees
        unwrapped.append(_unwrap_toward(unwrapped[-1], angle))
    if unwrapped != [0.0, 120.0, 240.0, 360.0]:
        failures.append(f"continuity unwrap failed: {unwrapped}")
    if failures:
        print(json.dumps({"ok": False, "failures": failures}))
        return 1
    print(json.dumps({"ok": True, "cases": len(samples) + 2}))
    return 0


def _run_cli(argv: list) -> int:
    """CLI used by the host-free Gateway tests.

    - ``--self-test`` verifies the rotator math.
    - ``--load <path> --sha256 <hex> --package-id <id> --source-revision <rev>``
      validates a sidecar and prints its converted keys.
    """
    if "--self-test" in argv:
        return run_self_test()
    options: Dict[str, str] = {}
    index = 0
    while index < len(argv):
        if argv[index].startswith("--") and index + 1 < len(argv):
            options[argv[index][2:]] = argv[index + 1]
            index += 2
        else:
            index += 1
    try:
        bake = load_bake(
            options["load"],
            options.get("sha256", ""),
            options.get("package-id", ""),
            options.get("source-revision", ""),
        )
        keys = {entity["directorId"]: entity_track_keys(entity) for entity in bake["entities"]}
        print(json.dumps({"ok": True, "keyCount": bake_key_count(bake), "keys": keys}))
        return 0
    except (KeyError, OSError, DirectorBakeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(_run_cli(sys.argv[1:]))
