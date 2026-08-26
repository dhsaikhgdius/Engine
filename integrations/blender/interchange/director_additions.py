"""Host-free mapping of Blender-authored camera and light additions to Director.

New Blender objects only enter the return package when the artist stamps a
fresh ``director_id`` on them (the .blend is never swept). Mesh objects return
as ``object_addition`` props; this module maps the two other reviewable kinds:

- ``camera_addition``: transform plus the portable optics (focal length,
  aperture, focus distance, clip planes). The Director look-at target is
  recovered on the camera's -Z aim ray at the focus distance -- a documented,
  deterministic choice because Blender stores an orientation while Director
  stores a point. Blender sensor dimensions never map to a Director sensor
  gate (named formats), so the new camera keeps Director's default gate with
  a warning when the Blender sensor is non-default.
- ``light_addition``: the deterministic watts-per-intensity table (mirrored
  from ``DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY`` in dcc-protocol; a unit test
  compares the two) inverts Blender energy to Director intensity. SUN/POINT/
  SPOT/AREA map to directional/point/spot/rect-area; DISK and ELLIPSE area
  shapes have no Director equivalent and are refused with a warning, never
  silently baked to a rectangle.

Import stays reviewed and opt-in: Director never applies additions without
``include_new_objects``. This module must stay importable without ``bpy``.
"""

from __future__ import annotations

import math
from typing import Any

# Mirror of DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY in
# packages/dcc-protocol/src/directorDccContract.ts. A unit test compares the
# two tables; edit the TypeScript side first, then update this table to match.
DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY: dict[str, float] = {
    "directional": 1.0,
    "point": 50.0,
    "spot": 50.0,
    "rect-area": 100.0,
}

# Inverse of the bridge's BLENDER_LIGHT_TYPES import table.
BLENDER_TO_DIRECTOR_LIGHT_TYPES: dict[str, str] = {
    "SUN": "directional",
    "POINT": "point",
    "SPOT": "spot",
    "AREA": "rect-area",
}

# Area-light shapes that map exactly onto Director's rect-area gate.
RECTANGULAR_AREA_SHAPES = frozenset({"SQUARE", "RECTANGLE"})

# Directional-style lights and cameras aim at a point Director stores
# explicitly. A new Blender object has no authored target distance, so the
# point sits on the -Z aim ray at this documented, deterministic distance
# (metres); cameras prefer their focus distance when it is meaningful.
DEFAULT_ADDITION_TARGET_DISTANCE_M = 5.0

# Optics fields a new Blender camera can return; sensor dimensions are named
# gates in Director and never map back from raw millimetres.
CAMERA_ADDITION_OPTICS_FIELDS = ("focalLengthMm", "apertureFStop", "focusDistanceM", "nearClipM", "farClipM")

# Blender's default camera sensor (mm); a differing sensor triggers the
# named-gate warning on a camera addition.
BLENDER_DEFAULT_SENSOR_MM = (36.0, 24.0)


def _finite_positive(value: Any) -> bool:
    try:
        return math.isfinite(float(value)) and float(value) > 0.0
    except (TypeError, ValueError):
        return False


def _aim_point(position: list[float], aim: list[float], distance: float) -> list[float]:
    length = math.sqrt(sum(float(value) ** 2 for value in aim))
    if length < 1e-9:
        return [float(position[0]), float(position[1]), float(position[2]) - distance]
    return [float(p) + float(a) / length * distance for p, a in zip(position, aim)]


def camera_addition_change(state: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Build the camera_addition fields (minus directorId) from an evaluated state.

    ``state`` carries name, transform (wire), position, aim (wire -Z direction),
    and the raw Blender optics. Invalid optics values are warned about and
    omitted; the change itself is still emitted so the reviewer decides.
    """
    warnings: list[str] = []
    optics: dict[str, float] = {}
    for field in CAMERA_ADDITION_OPTICS_FIELDS:
        value = state.get(field)
        if value is None:
            continue
        if _finite_positive(value):
            optics[field] = float(value)
        else:
            warnings.append(f"camera {field} {value!r} is not a positive finite number; the value was omitted.")
    sensor = (state.get("sensorWidthMm"), state.get("sensorHeightMm"))
    if all(_finite_positive(value) for value in sensor) and any(
        abs(float(value) - default) > 1e-3 for value, default in zip(sensor, BLENDER_DEFAULT_SENSOR_MM)
    ):
        warnings.append(
            "camera sensor dimensions do not map to a Director sensor gate (named formats); "
            "the new camera keeps Director's default sensor format."
        )
    focus = optics.get("focusDistanceM")
    target_distance = focus if focus is not None and focus > 0.01 else DEFAULT_ADDITION_TARGET_DISTANCE_M
    change: dict[str, Any] = {
        "kind": "camera_addition",
        "entityType": "camera",
        "name": str(state.get("name", "Blender Camera"))[:240],
        "transform": state["transform"],
        "target": _aim_point(state["position"], state["aim"], target_distance),
    }
    if optics:
        change["optics"] = optics
    return change, warnings


def light_addition_change(state: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """Build the light_addition fields (minus directorId) from an evaluated state.

    Returns ``(None, warnings)`` when the Blender light has no honest Director
    equivalent (unknown type, DISK/ELLIPSE area shape, or non-finite energy).
    """
    warnings: list[str] = []
    blender_type = str(state.get("lightType", ""))
    director_type = BLENDER_TO_DIRECTOR_LIGHT_TYPES.get(blender_type)
    if director_type is None:
        warnings.append(f"Blender light type {blender_type!r} has no Director equivalent; the addition was skipped.")
        return None, warnings
    if director_type == "rect-area" and str(state.get("shape", "SQUARE")) not in RECTANGULAR_AREA_SHAPES:
        warnings.append(
            f"area light shape {state.get('shape')!r} has no Director rect-area equivalent; the addition was "
            "skipped (use a Square or Rectangle area light)."
        )
        return None, warnings
    energy = state.get("energy")
    try:
        energy_value = float(energy)
    except (TypeError, ValueError):
        energy_value = math.nan
    if not math.isfinite(energy_value) or energy_value < 0.0:
        warnings.append(f"light energy {energy!r} is not a finite non-negative number; the addition was skipped.")
        return None, warnings
    watts = DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY[director_type]
    intensity = energy_value / watts
    if intensity > 100.0:
        warnings.append(
            f"intensity {intensity:.3f} (from {energy_value:.3f} W at {watts:g} W per unit) is outside "
            "Director's 0-100 range and was baked to 100."
        )
        intensity = 100.0
    change: dict[str, Any] = {
        "kind": "light_addition",
        "entityType": "light",
        "name": str(state.get("name", "Blender Light"))[:240],
        "type": director_type,
        "position": [float(value) for value in state["position"]],
        "color": str(state.get("colorHex", "#ffffff")),
        "intensity": intensity,
        "castShadow": bool(state.get("castShadow", False)),
    }
    if director_type != "point":
        change["target"] = _aim_point(state["position"], state["aim"], DEFAULT_ADDITION_TARGET_DISTANCE_M)
    if director_type == "spot":
        half_angle = float(state.get("spotSizeRad", 0.0)) / 2.0
        clamped = min(math.pi / 2, max(0.001, half_angle))
        if abs(clamped - half_angle) > 1e-9:
            warnings.append(
                f"spot half-angle {half_angle:.4f} rad is outside Director's range and was baked to {clamped:.4f} rad."
            )
        change["angleRad"] = clamped
        change["penumbra"] = min(1.0, max(0.0, float(state.get("spotBlend", 0.0))))
    if director_type == "rect-area":
        width = float(state.get("sizeM", 1.0))
        height = float(state.get("sizeYM", 0.0)) if str(state.get("shape", "SQUARE")) == "RECTANGLE" else width
        if not _finite_positive(width) or not _finite_positive(height):
            warnings.append("area light dimensions are not positive finite numbers; the addition was skipped.")
            return None, warnings
        change["widthM"] = width
        change["heightM"] = height
    return change, warnings
