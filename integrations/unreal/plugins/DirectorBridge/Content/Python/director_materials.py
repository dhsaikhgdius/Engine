"""Director PBR material parameters -> Unreal material-instance mapping.

Pure Python (no ``unreal`` import): given one Director object's ``material``
stanza (see ``directorPbrMaterialSchema``), produce the parameter overrides
for a MaterialInstanceConstant whose parent is one of the Director-authored
``DirectorPbrOpaque`` / ``DirectorPbrTranslucent`` parents, plus explicit
warn-and-omit records for every channel the simple parent cannot carry.

Color strings are parsed from CSS-style hex / rgb() / named forms and
converted from sRGB to linear, matching Unreal's linear color pipeline.
The Gateway test suite verifies this module host-free with ``python3``.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Dict, List, Optional, Tuple

RgbaLinear = Tuple[float, float, float, float]

# Slots on the Director-authored parent materials.
SCALAR_PARAMETERS = ("Metallic", "Roughness", "Opacity", "EmissiveIntensity")
VECTOR_PARAMETERS = ("BaseColor", "EmissiveColor")

# Director texture slots -> texture parameters on the Director parent
# materials. A slot only binds when the referenced image is bundled as a
# hashed relative file in the exchange package; anything else warn-and-omits.
TEXTURE_SLOT_PARAMETERS = {
    "baseColorMapAssetId": "BaseColorMap",
    "normalMapAssetId": "NormalMap",
    "roughnessMapAssetId": "RoughnessMap",
    "metalnessMapAssetId": "MetalnessMap",
    "emissiveMapAssetId": "EmissiveMap",
    "aoMapAssetId": "AoMap",
    "alphaMapAssetId": "OpacityMap",
}

_NAMED_COLORS = {
    "white": (255, 255, 255),
    "black": (0, 0, 0),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "blue": (0, 0, 255),
    "yellow": (255, 255, 0),
    "cyan": (0, 255, 255),
    "magenta": (255, 0, 255),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "orange": (255, 165, 0),
}

_HEX_PATTERN = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB_PATTERN = re.compile(
    r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)$",
    re.IGNORECASE,
)


def srgb_to_linear(component: float) -> float:
    """One sRGB component in [0,1] to linear, per IEC 61966-2-1."""
    if component <= 0.04045:
        return component / 12.92
    return ((component + 0.055) / 1.055) ** 2.4


def parse_color(value: str) -> Optional[RgbaLinear]:
    """Parse a CSS-style color string into linear RGBA, or None when unsupported."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    named = _NAMED_COLORS.get(text)
    if named is not None:
        red, green, blue = (component / 255.0 for component in named)
        return (srgb_to_linear(red), srgb_to_linear(green), srgb_to_linear(blue), 1.0)
    if _HEX_PATTERN.match(text):
        digits = text[1:]
        if len(digits) in (3, 4):
            digits = "".join(character * 2 for character in digits)
        red = int(digits[0:2], 16) / 255.0
        green = int(digits[2:4], 16) / 255.0
        blue = int(digits[4:6], 16) / 255.0
        alpha = int(digits[6:8], 16) / 255.0 if len(digits) == 8 else 1.0
        return (srgb_to_linear(red), srgb_to_linear(green), srgb_to_linear(blue), alpha)
    rgb_match = _RGB_PATTERN.match(text)
    if rgb_match:
        red, green, blue = (min(255, int(rgb_match.group(index))) / 255.0 for index in (1, 2, 3))
        alpha = min(1.0, float(rgb_match.group(4))) if rgb_match.group(4) is not None else 1.0
        return (srgb_to_linear(red), srgb_to_linear(green), srgb_to_linear(blue), alpha)
    return None


def _round_color(color: RgbaLinear) -> List[float]:
    return [round(component, 9) for component in color]


def make_texture_import_failed_omit(
    director_id: str,
    parameters: List[str],
    *,
    stage: str = "import",
) -> dict:
    """Build a typed ``texture_import_failed`` omit for Agent-facing receipts.

    Bundled hashed textures that fail host import or MaterialInstance parameter
    bind must never stay free-text-only. The MaterialInstance may still apply
    for channels Unreal can carry; failed slots stay unbound.

    @param director_id: Director object id that owns the material override.
    @param parameters: Parent texture parameter names that failed (e.g. BaseColorMap).
    @param stage: ``import`` (AssetImportTask produced no Texture) or ``bind``
        (set_material_instance_texture_parameter_value failed).
    """
    names = ", ".join(parameters)
    if stage == "bind":
        reason = (
            f"Object {director_id}: bundled texture parameter(s) {names} failed to bind on the "
            f"MaterialInstance; those slots stay unbound (warn-and-omit code: texture_import_failed)."
        )
    else:
        reason = (
            f"Object {director_id}: bundled texture parameter(s) {names} failed to import into "
            f"Unreal; the MaterialInstance stays unbound for those slots "
            f"(warn-and-omit code: texture_import_failed)."
        )
    return {"directorId": director_id, "code": "texture_import_failed", "reason": reason}


def map_material(material: dict, entity_name: str = "", texture_files: Optional[Dict[str, str]] = None) -> dict:
    """Map one Director PBR material stanza to Unreal instance overrides.

    @param material: The Director ``material`` dict (already schema-shaped by
        the exchange manifest validation).
    @param entity_name: Owning entity name used in warning strings.
    @param texture_files: Asset-ref id -> package file path for texture images
        bundled in the exchange package. Slots referencing anything else
        warn-and-omit.
    @returns A dict with ``parent`` ("opaque"|"translucent"), ``scalars``,
        ``vectors``, ``textures`` (parameter name -> asset-ref id),
        ``twoSided``, ``omitted`` (channel names), and ``warnings``.
    """
    prefix = f"{entity_name}: " if entity_name else ""
    scalars: Dict[str, float] = {}
    vectors: Dict[str, List[float]] = {}
    mapped_textures: Dict[str, str] = {}
    omitted: List[str] = []
    warnings: List[str] = []
    two_sided = False

    def omit(channel: str, reason: str) -> None:
        omitted.append(channel)
        warnings.append(f"{prefix}material channel '{channel}' {reason} (warn-and-omit).")

    base_color = material.get("baseColor")
    if base_color is not None:
        parsed = parse_color(base_color)
        if parsed is None:
            omit("baseColor", f"uses unsupported color syntax {base_color!r}")
        else:
            vectors["BaseColor"] = _round_color(parsed)

    if material.get("metalness") is not None:
        scalars["Metallic"] = float(material["metalness"])
    if material.get("roughness") is not None:
        scalars["Roughness"] = float(material["roughness"])

    opacity = material.get("opacity")
    translucent = opacity is not None and float(opacity) < 1.0
    if translucent:
        scalars["Opacity"] = float(opacity)

    emissive_color = material.get("emissiveColor")
    emissive_intensity = material.get("emissiveIntensity")
    if emissive_color is not None or emissive_intensity is not None:
        parsed = parse_color(emissive_color) if emissive_color is not None else (1.0, 1.0, 1.0, 1.0)
        if parsed is None:
            omit("emissiveColor", f"uses unsupported color syntax {emissive_color!r}")
        else:
            vectors["EmissiveColor"] = _round_color(parsed)
            scalars["EmissiveIntensity"] = float(emissive_intensity) if emissive_intensity is not None else 1.0

    side = material.get("side")
    if side == "double":
        two_sided = True
    elif side == "back":
        omit("side", "requests back-face-only rendering, which the Director parent material does not model")

    # Channels the simple Director parent materials intentionally do not
    # carry. They warn instead of silently changing the look.
    if material.get("transmission"):
        omit("transmission", "needs a refraction network the Director parent material does not include")
    if material.get("ior") is not None:
        omit("ior", "needs a refraction network the Director parent material does not include")
    if material.get("clearcoat"):
        omit("clearcoat", "needs the clear-coat shading model, which the Director parent material does not enable")
    if material.get("clearcoatRoughness") is not None and "clearcoat" not in omitted:
        omit("clearcoatRoughness", "needs the clear-coat shading model")
    if material.get("wireframe"):
        omit("wireframe", "is a viewport display mode, not a material property")
    if material.get("flatShading"):
        omit("flatShading", "requires re-importing the mesh with faceted normals")

    textures = material.get("textures") or {}
    for slot, reference in sorted(textures.items()):
        if not reference:
            continue
        parameter = TEXTURE_SLOT_PARAMETERS.get(slot)
        if parameter is None:
            omit(f"textures.{slot}", "has no texture parameter slot on the Director parent materials")
            continue
        if not texture_files or reference not in texture_files:
            omit(
                f"textures.{slot}",
                "references a texture that is not bundled as a relative hashed file in the exchange package",
            )
            continue
        if parameter == "OpacityMap" and not translucent:
            omit(
                f"textures.{slot}",
                "is an alpha map on a fully opaque material; the opaque Director parent has no opacity input",
            )
            continue
        mapped_textures[parameter] = reference

    # An emissive map needs a non-zero emissive product to show at all.
    if "EmissiveMap" in mapped_textures:
        scalars.setdefault("EmissiveIntensity", 1.0)
        vectors.setdefault("EmissiveColor", [1.0, 1.0, 1.0, 1.0])

    return {
        "parent": "translucent" if translucent else "opaque",
        "scalars": scalars,
        "vectors": vectors,
        "textures": mapped_textures,
        "twoSided": two_sided,
        "omitted": omitted,
        "warnings": warnings,
    }


def _run_cli(argv: list) -> int:
    """JSON-in/JSON-out CLI used by the host-free Gateway tests."""
    payload = json.loads(sys.stdin.read())
    if isinstance(payload, dict) and payload.get("op") == "texture_import_failed_omit":
        print(
            json.dumps(
                {
                    "ok": True,
                    "result": make_texture_import_failed_omit(
                        str(payload.get("directorId", "")),
                        list(payload.get("parameters") or []),
                        stage=str(payload.get("stage") or "import"),
                    ),
                }
            )
        )
        return 0
    if isinstance(payload, list):
        results = [
            map_material(entry.get("material", {}), entry.get("name", ""), entry.get("textureFiles"))
            for entry in payload
        ]
        print(json.dumps({"ok": True, "result": results}))
        return 0
    print(
        json.dumps(
            {
                "ok": True,
                "result": map_material(payload.get("material", {}), payload.get("name", ""), payload.get("textureFiles")),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_cli(sys.argv[1:]))
