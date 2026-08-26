"""Director lights -> Unreal light-actor mapping (pure Python, no ``unreal``).

Maps the tested subset of Director light types to Unreal light actor specs:

- ``directional`` -> ``DirectionalLight`` (intensity in lux)
- ``point``       -> ``PointLight`` (intensity in candela)
- ``spot``        -> ``SpotLight`` (intensity in candela, cone from angle/penumbra)
- ``rect-area``   -> ``RectLight`` (intensity in nits, size in centimetres)

``ambient`` and ``hemisphere`` lights have no single-actor Unreal equivalent
(they would need SkyLight / post-process volumes with a different look), so
they are warn-and-omitted as structured records instead of being approximated
silently. Photometric intensity mapping is approximate by design: Director
intensities are unitless three.js values, so each type uses a documented
conversion factor and the mapping says so in a warning.

Transforms stay in Director canonical space (right-handed, Y-up, metres) so
the host applies the same ``director_space`` basis change used for objects and
cameras. Aim rotations reuse the camera look-at math: a Director rotation that
carries local -Z onto the aim direction becomes, after the pinned basis
change, an Unreal rotation that carries local +X (the Unreal light forward
axis) onto the same world direction.

The Gateway test suite verifies this module host-free with ``python3``.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Dict, List, Optional

import director_materials as dmaterials
import director_space as dspace

# Approximate photometric conversion factors from Director's unitless
# three.js intensities. Chosen so the default Director light set reads
# similarly in Unreal's physically based pipeline; exact photometric
# calibration is out of scope and each import says so once.
DIRECTIONAL_LUX_PER_INTENSITY = 10.0
POINT_CANDELA_PER_INTENSITY = 8.0
SPOT_CANDELA_PER_INTENSITY = 8.0
RECT_NITS_PER_INTENSITY = 10.0

CENTIMETERS_PER_METER = 100.0

SUPPORTED_LIGHT_CLASSES = {
    "directional": "DirectionalLight",
    "point": "PointLight",
    "spot": "SpotLight",
    "rect-area": "RectLight",
}

OMITTED_LIGHT_REASONS = {
    "ambient": (
        "Uniform ambient light has no single-actor Unreal equivalent; "
        "a SkyLight or post-process setup would change the look, so the light is omitted (warn-and-omit)."
    ),
    "hemisphere": (
        "Hemisphere sky/ground gradient light has no single-actor Unreal equivalent; "
        "the light is omitted instead of being approximated (warn-and-omit)."
    ),
}

# Aimed types point local -Z at the target (camera look-at semantics).
AIMED_LIGHT_TYPES = ("directional", "spot", "rect-area")


def _light_world_transform(scene: dict, light: dict) -> dict:
    """Canonical world transform of one light (position plus aim rotation)."""
    position = list(light.get("position") or [0.0, 0.0, 0.0])
    if light["type"] in AIMED_LIGHT_TYPES:
        target = list(light.get("target") or [0.0, 0.0, 0.0])
        rotation = dspace.camera_look_quaternion(position, target, [0.0, 0.0, 0.0])
    else:
        rotation = [0.0, 0.0, 0.0, 1.0]
    return dspace.compose_world_transform(
        scene["position"], scene["rotation"], scene["scale"], position, rotation, [1.0, 1.0, 1.0]
    )


def map_light(scene: dict, light: dict) -> dict:
    """Map one Director light to an Unreal spawn spec or an omit record.

    @param scene: The manifest ``project.scene`` stanza (position/rotation/scale).
    @param light: One Director light dict (already schema-shaped upstream).
    @returns ``{"spec": {...}}`` for supported types or ``{"omitted": {...}}``,
        each with a ``warnings`` list.
    """
    warnings: List[str] = []
    light_type = light["type"]
    if light_type not in SUPPORTED_LIGHT_CLASSES:
        reason = OMITTED_LIGHT_REASONS.get(
            light_type, f"Director light type {light_type!r} has no Unreal mapping (warn-and-omit)."
        )
        return {
            "omitted": {"directorId": light["id"], "lightType": light_type, "reason": reason},
            "warnings": [f"Light {light['name']}: {reason}"],
        }

    intensity = float(light.get("intensity", 1.0))
    spec: Dict[str, object] = {
        "directorId": light["id"],
        "name": light["name"],
        "lightType": light_type,
        "unrealClass": SUPPORTED_LIGHT_CLASSES[light_type],
        "transform": _light_world_transform(scene, light),
        "castShadow": bool(light.get("castShadow", False)),
        "hidden": not light.get("visible", True),
    }

    color = dmaterials.parse_color(light.get("color", ""))
    if color is None:
        warnings.append(
            f"Light {light['name']}: color {light.get('color')!r} uses unsupported syntax; "
            "the Unreal default light color is kept (warn-and-omit)."
        )
    else:
        spec["colorLinear"] = [round(component, 9) for component in color[:3]]

    if light_type == "directional":
        spec["intensityUnit"] = "lux"
        spec["intensity"] = intensity * DIRECTIONAL_LUX_PER_INTENSITY
    elif light_type == "point":
        spec["intensityUnit"] = "candela"
        spec["intensity"] = intensity * POINT_CANDELA_PER_INTENSITY
        distance = float(light.get("distance") or 0.0)
        if distance > 0.0:
            spec["attenuationRadiusCm"] = distance * CENTIMETERS_PER_METER
    elif light_type == "spot":
        spec["intensityUnit"] = "candela"
        spec["intensity"] = intensity * SPOT_CANDELA_PER_INTENSITY
        distance = float(light.get("distance") or 0.0)
        if distance > 0.0:
            spec["attenuationRadiusCm"] = distance * CENTIMETERS_PER_METER
        # three.js: angle is the half-angle from the axis; penumbra fades from
        # (1 - penumbra) * angle to angle. Unreal cones use the same half-angle
        # convention in degrees.
        outer_degrees = math.degrees(float(light.get("angle") or math.pi / 6.0))
        penumbra = min(1.0, max(0.0, float(light.get("penumbra") or 0.0)))
        spec["outerConeAngleDeg"] = round(outer_degrees, 6)
        spec["innerConeAngleDeg"] = round(outer_degrees * (1.0 - penumbra), 6)
    else:  # rect-area
        spec["intensityUnit"] = "nits"
        spec["intensity"] = intensity * RECT_NITS_PER_INTENSITY
        spec["sourceWidthCm"] = float(light.get("width") or 1.0) * CENTIMETERS_PER_METER
        spec["sourceHeightCm"] = float(light.get("height") or 1.0) * CENTIMETERS_PER_METER

    if light.get("decay") is not None and float(light["decay"]) != 2.0:
        warnings.append(
            f"Light {light['name']}: decay {light['decay']} is not physical inverse-square falloff; "
            "Unreal always uses inverse-square, so the authored decay is omitted (warn-and-omit)."
        )
    return {"spec": spec, "warnings": warnings}


def map_lights(scene: dict, lights: Optional[List[dict]]) -> dict:
    """Map every Director light in a manifest project.

    @returns ``{"lights": [spec...], "omitted": [record...], "warnings": [...]}``.
    """
    specs: List[dict] = []
    omitted: List[dict] = []
    warnings: List[str] = []
    for light in lights or []:
        mapped = map_light(scene, light)
        warnings.extend(mapped["warnings"])
        if "spec" in mapped:
            specs.append(mapped["spec"])
        else:
            omitted.append(mapped["omitted"])
    if specs:
        warnings.append(
            "Light intensities use approximate photometric conversion factors "
            f"(directional x{DIRECTIONAL_LUX_PER_INTENSITY:g} lux, point/spot x{POINT_CANDELA_PER_INTENSITY:g} candela, "
            f"rect-area x{RECT_NITS_PER_INTENSITY:g} nits); exact calibration is not claimed."
        )
    return {"lights": specs, "omitted": omitted, "warnings": warnings}


def _run_cli() -> int:
    """JSON-in/JSON-out CLI used by the host-free Gateway tests."""
    payload = json.loads(sys.stdin.read())
    result = map_lights(payload.get("scene") or {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1.0},
                        payload.get("lights") or [])
    print(json.dumps({"ok": True, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_cli())
