"""Generate the small, original model library bundled with Director Desk.

Run with Blender so the emitted FBX files are produced by Blender's supported
exporter rather than copied from a third-party asset pack:

    blender --background --factory-startup --python generate_builtin_models.py

Use ``-- --check`` to verify the committed files against SHA256SUMS without
rewriting them.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import math
import sys
from pathlib import Path

import bpy


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[4]
ASSET_ROOT = PROJECT_ROOT / "assets" / "runtime" / "model-library"
CHECKSUM_FILE = ASSET_ROOT / "SHA256SUMS"
FIXED_EXPORT_TIME = datetime.datetime(2026, 1, 1, 0, 0, 0)

ASSETS = (
    ("便利生活", "ATM_low.fbx", "自动取款机", "atm", "#5ba8ff"),
    ("户外出行", "backpack_low.fbx", "背包", "backpack", "#f2a65a"),
    ("户外出行", "thermus_low.fbx", "保温瓶", "thermos", "#65c7b0"),
    ("户外出行", "deer_skull_low.fbx", "鹿头骨", "skull", "#d8c8a8"),
    ("工具配件", "wrench_low.fbx", "扳手", "wrench", "#aab7c4"),
    ("工具配件", "drill_press_low.fbx", "台钻", "drill", "#e17d77"),
)


def _configure_deterministic_fbx_export() -> None:
    """Remove Blender FBX timestamp and Python hash-seed variation.

    Blender's exporter normally writes ``datetime.now()`` and derives FBX IDs
    from Python's randomized ``hash()``. Neither affects geometry, but both make
    byte-for-byte release verification impossible. The wrapper below supplies
    a fixed creation time and SHA-256-derived signed-int64 IDs while leaving the
    exporter and resulting FBX structure unchanged.
    """

    from io_scene_fbx import export_fbx_bin, fbx_utils

    original_header = export_fbx_bin.fbx_header_elements

    def fixed_header(root, scene_data, time=None):
        del time
        return original_header(root, scene_data, FIXED_EXPORT_TIME)

    def stable_key_to_uuid(used_uuids, key):
        if isinstance(key, int) and 0 <= key < 2**63:
            value = key
        else:
            digest = hashlib.sha256(repr(key).encode("utf-8")).digest()
            value = int.from_bytes(digest[:8], "big") & ((1 << 63) - 1)
        compact = value % 1_000_000_000
        if value > 1_000_000_000 and compact not in used_uuids:
            value = compact
        while value in used_uuids:
            value += 1
        return fbx_utils.UUID(value)

    export_fbx_bin.fbx_header_elements = fixed_header
    fbx_utils._key_to_uuid = stable_key_to_uuid


def _arguments() -> argparse.Namespace:
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output-root", type=Path, default=ASSET_ROOT)
    return parser.parse_args(script_args)


def _clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def _material(name: str, color: tuple[float, float, float, float]):
    material = bpy.data.materials.new(name=name)
    material.diffuse_color = color
    material.roughness = 0.68
    return material


def _finish_object(obj, material, *, smooth: bool = False):
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.append(material)
    if smooth and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    obj["asset_origin"] = "ComfyUI 3D Director procedural model library"
    return obj


def _box(name, location, scale, material, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish_object(obj, material)


def _cylinder(name, location, radius, depth, material, rotation=(0.0, 0.0, 0.0), vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return _finish_object(obj, material, smooth=True)


def _sphere(name, location, scale, material):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish_object(obj, material, smooth=True)


def _torus(name, location, major_radius, minor_radius, material, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=12,
        minor_segments=6,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return _finish_object(obj, material, smooth=True)


def _beam_between(name, start, end, radius, material):
    from mathutils import Vector

    start_v = Vector(start)
    end_v = Vector(end)
    direction = end_v - start_v
    obj = _cylinder(name, (start_v + end_v) / 2, radius, direction.length, material, vertices=8)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return obj


def _make_atm(materials):
    blue, dark, light = materials
    _box("ATM_Body", (0, 0, 1.05), (0.6, 0.38, 1.05), blue)
    _box("ATM_Top", (0, -0.04, 2.22), (0.63, 0.41, 0.16), light)
    _box("ATM_ScreenFrame", (0, -0.405, 1.55), (0.41, 0.05, 0.34), dark, (math.radians(-12), 0, 0))
    _box("ATM_Screen", (0, -0.46, 1.57), (0.32, 0.025, 0.23), light, (math.radians(-12), 0, 0))
    _box("ATM_Keypad", (0, -0.43, 0.98), (0.28, 0.05, 0.16), dark)
    _box("ATM_CashSlot", (0, -0.43, 0.56), (0.34, 0.045, 0.055), dark)
    _box("ATM_Base", (0, 0, 0.08), (0.72, 0.48, 0.08), dark)


def _make_backpack(materials):
    orange, dark, light = materials
    _sphere("Backpack_Body", (0, 0, 0.9), (0.58, 0.32, 0.82), orange)
    _box("Backpack_Flap", (0, -0.31, 1.28), (0.43, 0.06, 0.24), dark, (math.radians(-8), 0, 0))
    _box("Backpack_Pocket", (0, -0.37, 0.63), (0.38, 0.08, 0.24), light)
    _torus("Backpack_Handle", (0, 0.0, 1.75), 0.22, 0.045, dark, (math.radians(90), 0, 0))
    _torus("Backpack_LeftStrap", (-0.32, 0.24, 0.95), 0.32, 0.035, dark, (math.radians(90), 0, 0))
    _torus("Backpack_RightStrap", (0.32, 0.24, 0.95), 0.32, 0.035, dark, (math.radians(90), 0, 0))


def _make_thermos(materials):
    green, dark, light = materials
    _cylinder("Thermos_Body", (0, 0, 0.75), 0.36, 1.5, green, vertices=16)
    _cylinder("Thermos_Shoulder", (0, 0, 1.52), 0.29, 0.14, light, vertices=16)
    _cylinder("Thermos_Cap", (0, 0, 1.68), 0.24, 0.22, dark, vertices=16)
    _torus("Thermos_Handle", (0.36, 0, 1.0), 0.34, 0.055, dark, (math.radians(90), 0, 0))
    _cylinder("Thermos_Base", (0, 0, 0.05), 0.38, 0.1, dark, vertices=16)


def _make_skull(materials):
    bone, dark, light = materials
    _sphere("Skull_Cranium", (0, 0, 1.05), (0.48, 0.34, 0.58), bone)
    _sphere("Skull_Muzzle", (0, -0.18, 0.55), (0.25, 0.22, 0.5), light)
    _sphere("Skull_LeftEye", (-0.22, -0.29, 1.12), (0.13, 0.05, 0.12), dark)
    _sphere("Skull_RightEye", (0.22, -0.29, 1.12), (0.13, 0.05, 0.12), dark)
    for side in (-1, 1):
        points = [
            (0.28 * side, 0.0, 1.38),
            (0.48 * side, 0.02, 1.76),
            (0.68 * side, 0.03, 2.05),
        ]
        _beam_between(f"Antler_{side}_A", points[0], points[1], 0.055, bone)
        _beam_between(f"Antler_{side}_B", points[1], points[2], 0.045, bone)
        _beam_between(f"Antler_{side}_Tine1", points[1], (0.37 * side, -0.02, 2.04), 0.035, bone)
        _beam_between(f"Antler_{side}_Tine2", points[2], (0.78 * side, -0.02, 2.27), 0.03, bone)


def _make_wrench(materials):
    metal, dark, light = materials
    _box("Wrench_Shaft", (0, 0, 0), (0.16, 0.07, 0.85), metal, (0, math.radians(-20), 0))
    _torus("Wrench_Ring", (-0.29, 0, -0.8), 0.3, 0.1, dark, (math.radians(90), 0, 0))
    _box("Wrench_JawLeft", (0.25, 0, 0.82), (0.12, 0.08, 0.33), light, (0, math.radians(-38), 0))
    _box("Wrench_JawRight", (0.56, 0, 0.7), (0.12, 0.08, 0.33), light, (0, math.radians(22), 0))


def _make_drill(materials):
    red, dark, light = materials
    _box("DrillPress_Base", (0, 0, 0.08), (0.62, 0.46, 0.08), dark)
    _cylinder("DrillPress_Column", (0.34, 0.18, 1.25), 0.09, 2.35, light, vertices=12)
    _box("DrillPress_Table", (0.0, -0.02, 0.9), (0.5, 0.38, 0.07), dark)
    _box("DrillPress_Head", (0.02, 0.08, 2.2), (0.58, 0.42, 0.34), red)
    _cylinder("DrillPress_Chuck", (-0.18, -0.02, 1.76), 0.11, 0.42, dark, vertices=12)
    _cylinder("DrillPress_Bit", (-0.18, -0.02, 1.42), 0.025, 0.34, light, vertices=8)
    _beam_between("DrillPress_Handle", (0.48, -0.02, 2.15), (0.9, -0.02, 1.92), 0.035, dark)


BUILDERS = {
    "atm": _make_atm,
    "backpack": _make_backpack,
    "thermos": _make_thermos,
    "skull": _make_skull,
    "wrench": _make_wrench,
    "drill": _make_drill,
}


def _svg_thumbnail(label: str, icon: str, accent: str) -> str:
    silhouettes = {
        "atm": '<rect x="116" y="42" width="88" height="116" rx="8"/><rect x="132" y="60" width="56" height="38" class="cut"/><path d="M138 119h44M144 132h32"/>',
        "backpack": '<path d="M108 86q0-34 52-34t52 34v76H108z"/><path d="M130 58q4-28 30-28t30 28M126 116h68v32h-68z"/>',
        "thermos": '<path d="M126 52h68v112h-68zM140 34h40v18h-40z"/><path d="M194 76q38 4 32 44t-32 24"/>',
        "skull": '<path d="M116 82q8-40 44-40t44 40q0 36-24 50v30h-40v-30q-24-14-24-50z"/><path d="M130 36l-22-24M190 36l22-24M132 91h10M178 91h10"/>',
        "wrench": '<path d="M111 150l70-70q-8-25 14-42 20-16 42-2l-24 24 12 12 24-24q12 22-4 42-17 22-42 14l-70 70z"/>',
        "drill": '<path d="M104 164h112M190 164V50M126 62h76v38h-76zM138 112h54M151 100v52"/>',
    }
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" role="img" aria-label="{label}">
  <rect width="320" height="220" rx="18" fill="#111a2b"/>
  <circle cx="160" cy="106" r="88" fill="{accent}" opacity=".14"/>
  <g fill="{accent}" stroke="{accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">{silhouettes[icon]}</g>
  <style>.cut{{fill:#111a2b;stroke:none}} text{{font:600 18px system-ui,sans-serif}}</style>
  <text x="160" y="204" text-anchor="middle" fill="#ecf4ff">{label}</text>
</svg>
'''


def _build_one(output_root: Path, category: str, file_name: str, label: str, icon: str, accent: str) -> None:
    from io_scene_fbx import fbx_utils

    # Give each file an independent deterministic ID namespace.
    fbx_utils._keys_to_uuids.clear()
    fbx_utils._uuids_to_keys.clear()
    _clear_scene()
    primary = _material(f"{icon}_primary", tuple(int(accent[index:index + 2], 16) / 255 for index in (1, 3, 5)) + (1.0,))
    dark = _material(f"{icon}_dark", (0.08, 0.1, 0.14, 1.0))
    light = _material(f"{icon}_light", (0.72, 0.78, 0.84, 1.0))
    BUILDERS[icon]((primary, dark, light))

    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")
    target_dir = output_root / category
    target_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=str(target_dir / file_name),
        use_selection=True,
        apply_unit_scale=True,
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="STRIP",
        axis_forward="-Z",
        axis_up="Y",
    )

    thumbnail_dir = target_dir / "缩略图"
    thumbnail_dir.mkdir(parents=True, exist_ok=True)
    (thumbnail_dir / f"{label}.svg").write_text(_svg_thumbnail(label, icon, accent), encoding="utf-8")


def _asset_files(output_root: Path):
    return sorted(
        path
        for path in output_root.rglob("*")
        if path.is_file() and path.name not in {CHECKSUM_FILE.name, "README.md", "LICENSE"}
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_checksums(output_root: Path) -> None:
    lines = [f"{_sha256(path)}  {path.relative_to(output_root).as_posix()}" for path in _asset_files(output_root)]
    (output_root / CHECKSUM_FILE.name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def _check(output_root: Path) -> None:
    checksum_file = output_root / CHECKSUM_FILE.name
    expected = {}
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        digest, relative = line.split("  ", 1)
        expected[relative] = digest
    actual = {path.relative_to(output_root).as_posix(): _sha256(path) for path in _asset_files(output_root)}
    if actual != expected:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(path for path in actual.keys() & expected.keys() if actual[path] != expected[path])
        raise SystemExit(f"model library checksum mismatch: missing={missing}, extra={extra}, changed={changed}")
    print(f"verified {len(actual)} generated model-library files")


def main() -> None:
    args = _arguments()
    output_root = args.output_root.resolve()
    if args.check:
        _check(output_root)
        return
    _configure_deterministic_fbx_export()
    output_root.mkdir(parents=True, exist_ok=True)
    for asset in ASSETS:
        _build_one(output_root, *asset)
    _write_checksums(output_root)
    _check(output_root)


if __name__ == "__main__":
    main()
