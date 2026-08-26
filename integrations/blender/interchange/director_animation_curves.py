"""Host-free reconciliation between Blender fcurves and Director timeline keyframes.

``director_bridge.py`` bakes Director keyframes into plain ``location`` /
``rotation_quaternion`` / ``scale`` fcurves on each tracked root and stamps an
animation baseline (fingerprint plus extracted sample) into the .blend.
``director_return_export.py`` reads the baseline back and, when the curves
changed, extracts the live keyframes so a Blender-authored timeline edit can
return to the same Director entity as an ``animation_update``.

The round trip is deliberately bounded and honest:

- Only plain keyed transform channels on an unparented root return: every key
  carries the exact channel values, and per-key interpolation maps through
  ``CONSTANT``/``LINEAR``/``BEZIER`` -> ``step``/``linear``/``smooth``.
- NLA tracks, drivers, constraints, delta transforms, non-quaternion rotation
  channels, sparse per-channel keys, and exotic interpolation modes have no
  lossless Director mapping. They are refused with a structured code and the
  animation edit is omitted with a warning -- never silently flattened.
- Hand-tuned bezier handles keep their key values but the easing between keys
  approximates to Director ``smooth``; that approximation is warned about.

This module must stay importable without ``bpy`` so the extraction can be
unit tested outside Blender.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

# Portable transform channels the Director bridge bakes and the return trip
# reads back: data_path -> component count.
TRANSFORM_CHANNELS: dict[str, int] = {"location": 3, "rotation_quaternion": 4, "scale": 3}

# Blender keyframe interpolation -> Director timeline interpolation.
INTERPOLATION_TO_DIRECTOR: dict[str, str] = {"CONSTANT": "step", "LINEAR": "linear", "BEZIER": "smooth"}

# Bezier handle types whose easing Blender computes automatically; the bridge
# writes these, so a round trip through them is not an artist handle edit.
AUTO_HANDLE_TYPES = frozenset({"AUTO", "AUTO_CLAMPED", "VECTOR"})

# Keys closer than this (in frames) are treated as the same keyframe time.
FRAME_TOLERANCE = 1e-3

# Channel values survive float32 fcurve storage; comparisons use a coarser
# tolerance than float64 equality to avoid phantom animation changes.
VALUE_TOLERANCE = 1e-4

# Director's return contract bounds one animation_update change.
MAX_RETURN_KEYFRAMES = 2000

# Structured omit codes. Every refusal names one of these so the gateway,
# the UI, and the docs can explain exactly why an edit did not round-trip.
CODE_NLA_TRACKS = "nla_tracks"
CODE_DRIVERS = "drivers"
CODE_CONSTRAINTS = "constraints"
CODE_PARENTED_ROOT = "parented_root"
CODE_DELTA_TRANSFORM = "delta_transform"
CODE_UNSUPPORTED_CHANNELS = "unsupported_channels"
CODE_SPARSE_CHANNELS = "sparse_channels"
CODE_UNSUPPORTED_INTERPOLATION = "unsupported_interpolation"
CODE_MIXED_INTERPOLATION = "mixed_interpolation"
CODE_DEGENERATE_TRANSFORM = "degenerate_transform"
CODE_TOO_MANY_KEYFRAMES = "too_many_keyframes"


def _refuse(code: str, detail: str, warnings: list[str]) -> dict[str, Any]:
    return {"ok": False, "code": code, "detail": detail, "warnings": warnings}


def _channel_default(root: Any, data_path: str, index: int) -> float:
    values = getattr(root, data_path, None)
    if values is None:
        return 1.0 if (data_path == "scale" or (data_path == "rotation_quaternion" and index == 0)) else 0.0
    try:
        return float(values[index])
    except (IndexError, TypeError, ValueError):
        return 1.0 if (data_path == "scale" or (data_path == "rotation_quaternion" and index == 0)) else 0.0


def _delta_transform_present(root: Any) -> bool:
    delta_location = getattr(root, "delta_location", None)
    delta_scale = getattr(root, "delta_scale", None)
    delta_rotation = getattr(root, "delta_rotation_quaternion", None)
    if delta_location is not None and any(abs(float(value)) > 1e-9 for value in delta_location):
        return True
    if delta_scale is not None and any(abs(float(value) - 1.0) > 1e-9 for value in delta_scale):
        return True
    if delta_rotation is not None:
        w, x, y, z = (float(value) for value in delta_rotation)
        if abs(w - 1.0) > 1e-9 or any(abs(value) > 1e-9 for value in (x, y, z)):
            return True
    return False


def extract_transform_animation(root: Any) -> dict[str, Any]:
    """Extract the Director-portable transform keyframes of one tracked root.

    Returns ``{"ok": True, "keyframes": [...], "warnings": [...]}`` where each
    keyframe is ``{"frame", "interpolation", "transform"}`` in Blender wire
    space, or ``{"ok": False, "code", "detail", "warnings"}`` when the live
    animation cannot round-trip losslessly. An object without animation data
    extracts as ``keyframes: []``.
    """
    warnings: list[str] = []
    animation = getattr(root, "animation_data", None)
    if animation is None:
        return {"ok": True, "keyframes": [], "warnings": warnings}
    tracks = list(getattr(animation, "nla_tracks", None) or [])
    if tracks:
        return _refuse(
            CODE_NLA_TRACKS,
            f"{len(tracks)} NLA track(s) drive this object; NLA has no lossless Director timeline mapping.",
            warnings,
        )
    drivers = list(getattr(animation, "drivers", None) or [])
    if drivers:
        return _refuse(
            CODE_DRIVERS,
            f"{len(drivers)} driver(s) animate this object; drivers have no Director timeline mapping.",
            warnings,
        )
    constraints = list(getattr(root, "constraints", None) or [])
    if constraints:
        names = ", ".join(str(getattr(constraint, "name", "constraint")) for constraint in constraints[:4])
        return _refuse(
            CODE_CONSTRAINTS,
            f"object constraints ({names}) shape the evaluated motion; constraints have no Director timeline mapping.",
            warnings,
        )
    if getattr(root, "parent", None) is not None:
        return _refuse(
            CODE_PARENTED_ROOT,
            "the Director root was parented in Blender, so its channels are no longer world-space keyframes.",
            warnings,
        )
    if _delta_transform_present(root):
        return _refuse(
            CODE_DELTA_TRANSFORM,
            "delta transforms offset the keyed channels; Director keyframes carry no delta component.",
            warnings,
        )

    action = getattr(animation, "action", None)
    fcurves = list(getattr(action, "fcurves", None) or []) if action is not None else []
    transform_curves: list[Any] = []
    for curve in fcurves:
        data_path = str(getattr(curve, "data_path", ""))
        if data_path in TRANSFORM_CHANNELS:
            transform_curves.append(curve)
        elif data_path in ("rotation_euler", "rotation_axis_angle"):
            return _refuse(
                CODE_UNSUPPORTED_CHANNELS,
                f"rotation is keyed as {data_path}; Director round-trips quaternion rotation channels only.",
                warnings,
            )
        else:
            warnings.append(
                f"animated channel {data_path!r} is not a portable Director transform channel; "
                "it does not return (only location/rotation_quaternion/scale keys round-trip)."
            )
    if not transform_curves:
        return {"ok": True, "keyframes": [], "warnings": warnings}
    if str(getattr(root, "rotation_mode", "QUATERNION")) != "QUATERNION" and any(
        str(getattr(curve, "data_path", "")) == "rotation_quaternion" for curve in transform_curves
    ):
        return _refuse(
            CODE_UNSUPPORTED_CHANNELS,
            "rotation_quaternion keys exist but the object rotation mode is not QUATERNION, "
            "so the keyed values do not drive the evaluated motion.",
            warnings,
        )

    # Group key times across channels; every animated channel must be keyed at
    # every keyframe time so each Director keyframe carries exact values.
    frames: list[float] = []

    def frame_slot(value: float) -> float:
        for existing in frames:
            if abs(existing - value) <= FRAME_TOLERANCE:
                return existing
        frames.append(value)
        return value

    per_curve_keys: list[tuple[Any, dict[float, Any]]] = []
    for curve in transform_curves:
        keys: dict[float, Any] = {}
        for point in getattr(curve, "keyframe_points", None) or []:
            frame = frame_slot(float(point.co[0]))
            keys[frame] = point
        per_curve_keys.append((curve, keys))
    frames.sort()
    if len(frames) > MAX_RETURN_KEYFRAMES:
        return _refuse(
            CODE_TOO_MANY_KEYFRAMES,
            f"{len(frames)} keyframes exceed the {MAX_RETURN_KEYFRAMES}-key Director return limit; "
            "simplify the curves before returning.",
            warnings,
        )
    for curve, keys in per_curve_keys:
        if len(keys) != len(frames):
            return _refuse(
                CODE_SPARSE_CHANNELS,
                f"channel {getattr(curve, 'data_path', '?')}[{getattr(curve, 'array_index', '?')}] is keyed at "
                "different frames than its sibling channels; key every animated transform channel at each keyframe.",
                warnings,
            )

    keyed_values: dict[tuple[str, int], dict[float, Any]] = {}
    for curve, keys in per_curve_keys:
        keyed_values[(str(getattr(curve, "data_path", "")), int(getattr(curve, "array_index", 0)))] = keys

    handle_warning_emitted = False
    keyframes: list[dict[str, Any]] = []
    for frame in frames:
        interpolations: set[str] = set()
        for _, keys in per_curve_keys:
            point = keys[frame]
            mode = str(getattr(point, "interpolation", "BEZIER"))
            mapped = INTERPOLATION_TO_DIRECTOR.get(mode)
            if mapped is None:
                return _refuse(
                    CODE_UNSUPPORTED_INTERPOLATION,
                    f"keyframe interpolation {mode!r} at frame {frame:g} has no Director mapping "
                    "(use Constant, Linear, or Bezier).",
                    warnings,
                )
            interpolations.add(mapped)
            if mapped == "smooth" and not handle_warning_emitted:
                left = str(getattr(point, "handle_left_type", "AUTO"))
                right = str(getattr(point, "handle_right_type", "AUTO"))
                if left not in AUTO_HANDLE_TYPES or right not in AUTO_HANDLE_TYPES:
                    handle_warning_emitted = True
                    warnings.append(
                        "hand-tuned bezier handles approximate to Director smooth easing; "
                        "key values are exact but the easing between keys may differ."
                    )
        if len(interpolations) > 1:
            return _refuse(
                CODE_MIXED_INTERPOLATION,
                f"channels disagree on interpolation at frame {frame:g} ({', '.join(sorted(interpolations))}); "
                "Director keyframes carry one interpolation per key.",
                warnings,
            )

        def channel(data_path: str, index: int) -> float:
            keys = keyed_values.get((data_path, index))
            if keys is not None and frame in keys:
                return float(keys[frame].co[1])
            return _channel_default(root, data_path, index)

        location = [channel("location", index) for index in range(3)]
        # Blender stores quaternions as (w, x, y, z); the wire contract is [x, y, z, w].
        w, x, y, z = (channel("rotation_quaternion", index) for index in range(4))
        scale = [channel("scale", index) for index in range(3)]
        norm = math.sqrt(w * w + x * x + y * y + z * z)
        if norm < 1e-6 or any(abs(value) < 1e-8 for value in scale):
            return _refuse(
                CODE_DEGENERATE_TRANSFORM,
                f"keyframe at frame {frame:g} has a zero-length rotation or zero scale component.",
                warnings,
            )
        if abs(norm - 1.0) > 1e-3:
            warnings.append(
                f"keyframe rotation at frame {frame:g} was not normalized (length {norm:.4f}); "
                "it was normalized for Director."
            )
        keyframes.append(
            {
                "frame": frame,
                "interpolation": next(iter(interpolations)),
                "transform": {
                    "location": location,
                    "rotationQuaternion": [x / norm, y / norm, z / norm, w / norm],
                    "scale": scale,
                },
            }
        )
    return {"ok": True, "keyframes": keyframes, "warnings": warnings}


def _fingerprint_payload(root: Any, include_data_animation: bool) -> list[Any]:
    payload: list[Any] = []

    def describe(owner_label: str, animation: Any) -> None:
        if animation is None:
            return
        for track in getattr(animation, "nla_tracks", None) or []:
            strips = [
                [str(getattr(strip, "name", "")), f"{float(getattr(strip, 'frame_start', 0.0)):.6g}",
                 f"{float(getattr(strip, 'frame_end', 0.0)):.6g}"]
                for strip in getattr(track, "strips", None) or []
            ]
            payload.append([owner_label, "nla", str(getattr(track, "name", "")), strips])
        for driver in getattr(animation, "drivers", None) or []:
            payload.append(
                [owner_label, "driver", str(getattr(driver, "data_path", "")), int(getattr(driver, "array_index", 0))]
            )
        action = getattr(animation, "action", None)
        curves = (getattr(action, "fcurves", None) or []) if action is not None else []
        for curve in curves:
            keys = [
                [
                    f"{float(point.co[0]):.6g}",
                    f"{float(point.co[1]):.9g}",
                    str(getattr(point, "interpolation", "BEZIER")),
                ]
                for point in getattr(curve, "keyframe_points", None) or []
            ]
            payload.append(
                [owner_label, "fcurve", str(getattr(curve, "data_path", "")), int(getattr(curve, "array_index", 0)), keys]
            )

    describe("object", getattr(root, "animation_data", None))
    if include_data_animation:
        describe("data", getattr(getattr(root, "data", None), "animation_data", None))
    return payload


def animation_fingerprint(root: Any, include_data_animation: bool = False) -> str:
    """Deterministic fingerprint of everything that drives a root's animation.

    Covers action fcurves (channel, key times, values, interpolation), NLA
    tracks/strips, and drivers -- optionally including the datablock's own
    animation (camera lens curves). Any animation edit changes the
    fingerprint; an untouched round trip through .blend save/load does not.
    """
    payload = _fingerprint_payload(root, include_data_animation)
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _values_close(left: Any, right: Any, tolerance: float = VALUE_TOLERANCE) -> bool:
    if not isinstance(left, (list, tuple)) or not isinstance(right, (list, tuple)) or len(left) != len(right):
        return False
    return all(
        abs(float(a) - float(b)) <= max(abs(float(a)), abs(float(b)), 1.0) * tolerance for a, b in zip(left, right)
    )


def _rotations_close(left: Any, right: Any, tolerance: float = VALUE_TOLERANCE) -> bool:
    if not isinstance(left, (list, tuple)) or not isinstance(right, (list, tuple)) or len(left) != 4 or len(right) != 4:
        return False
    left_norm = math.sqrt(sum(float(value) ** 2 for value in left))
    right_norm = math.sqrt(sum(float(value) ** 2 for value in right))
    if left_norm < 1e-8 or right_norm < 1e-8:
        return False
    dot = sum(float(a) * float(b) for a, b in zip(left, right)) / (left_norm * right_norm)
    # q and -q encode the same rotation.
    return abs(abs(dot) - 1.0) <= tolerance


def animation_samples_equal(left: Any, right: Any) -> bool:
    """Compare two extracted keyframe lists with float32-safe tolerances."""
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != len(right):
        return False
    for a, b in zip(left, right):
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        if abs(float(a.get("frame", 0.0)) - float(b.get("frame", 0.0))) > FRAME_TOLERANCE:
            return False
        if a.get("interpolation") != b.get("interpolation"):
            return False
        left_transform = a.get("transform")
        right_transform = b.get("transform")
        if not isinstance(left_transform, dict) or not isinstance(right_transform, dict):
            return False
        if not _values_close(left_transform.get("location"), right_transform.get("location")):
            return False
        if not _values_close(left_transform.get("scale"), right_transform.get("scale")):
            return False
        if not _rotations_close(left_transform.get("rotationQuaternion"), right_transform.get("rotationQuaternion")):
            return False
    return True


def manifest_animation_sample(animation: Any) -> list[dict[str, Any]] | None:
    """Rebuild the baseline sample a legacy .blend implies from the source manifest.

    Keyframes without a transform never became Blender transform keys (the
    bridge skips them), so only transform-bearing keyframes participate.
    Returns ``None`` when the manifest carries no usable animation stanza.
    """
    if not isinstance(animation, list):
        return None
    sample: list[dict[str, Any]] = []
    for keyframe in animation:
        if not isinstance(keyframe, dict):
            return None
        transform = keyframe.get("transform")
        if not isinstance(transform, dict):
            continue
        sample.append(
            {
                "frame": float(keyframe.get("frame", 0.0)),
                "interpolation": str(keyframe.get("interpolation", "linear")),
                "transform": transform,
            }
        )
    return sample


def manifest_animation_has_pose_keys(animation: Any) -> bool:
    """True when the exported animation carried per-keyframe pose values."""
    return isinstance(animation, list) and any(
        isinstance(keyframe, dict) and keyframe.get("poseValues") for keyframe in animation
    )
