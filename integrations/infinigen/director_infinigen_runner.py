"""Director ↔ Infinigen single-asset runner.

Launched by Director's gateway (InfinigenGenerated3DProvider) inside the
Python environment where the ``infinigen`` package is installed (see
README.md next to this file). The contract with the gateway is one work
directory per task:

    status.json     -- atomically replaced snapshot after every stage
    model.glb       -- baked, Y-up, meter-unit GLB (read by the normalizer)
    thumbnail.png   -- small EEVEE render for the asset library card
    runner.log      -- stdout/stderr of this process

The gateway polls status.json and kills this process on cancellation, so the
runner never talks to the network and never needs Director imports.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import signal
import sys
import traceback
from pathlib import Path

_OUTPUT_DIR: Path | None = None


def write_status(
    status: str,
    progress: float,
    message: str = "",
    error: str = "",
    warnings: list[str] | None = None,
    model: str = "",
    thumbnail: str = "",
) -> None:
    """Atomically replace status.json with the current stage snapshot.

    The gateway polls this file, so a torn write would surface as a JSON
    parse error mid-generation; write-to-temp + os.replace keeps every
    observed snapshot complete. Errors are truncated to keep the file small.
    """
    assert _OUTPUT_DIR is not None
    payload = {"status": status, "progress": round(progress, 4), "warnings": warnings or []}
    if message:
        payload["message"] = message
    if error:
        payload["error"] = error[:4000]
    if model:
        payload["model"] = model
    if thumbnail:
        payload["thumbnail"] = thumbnail
    temp = _OUTPUT_DIR / "status.json.tmp"
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, _OUTPUT_DIR / "status.json")


def _handle_sigterm(_signum, _frame):  # noqa: ANN001
    """Record a cancelled terminal state before dying on gateway cancellation.

    os._exit skips bpy teardown on purpose: Blender atexit handlers can hang
    and the work directory is discarded anyway.
    """
    write_status("cancelled", 0, message="Runner received SIGTERM")
    os._exit(143)


def load_factory(module_path: str, factory_id: str):
    """Import an Infinigen factory class by the module/name pair from factory_catalog.json."""
    module = importlib.import_module(module_path)
    factory = getattr(module, factory_id, None)
    if factory is None:
        raise RuntimeError(f"{module_path} does not export {factory_id}; check factory_catalog.json")
    return factory


# ---------------------------------------------------------------------------
# Environment presets (kind=environment): deterministic heightfield terrain
# built with bpy + numpy only, so they work even on a minimal Infinigen
# install (Infinigen's own terrain feature needs the compiled [terrain] extra
# and hour-scale budgets; these presets answer set-dressing needs in seconds).
# The noise math mirrors backend/inference/worldclaw/src/worldclaw/noise.py.
# ---------------------------------------------------------------------------


def _lattice(ix, iy, seed: int):
    """Deterministic integer-lattice hash to [0, 1); same mix as worldclaw noise."""
    import numpy as np

    h = (
        ix.astype(np.int64) * 374_761_393 + iy.astype(np.int64) * 668_265_263 + np.int64(seed) * 1_442_695_041
    ) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1_274_126_177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


def _value_noise(x, y, seed: int):
    """Smoothstep-interpolated 2D value noise over the lattice hash."""
    import numpy as np

    x0 = np.floor(x)
    y0 = np.floor(y)
    fx = x - x0
    fy = y - y0
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    ix = x0.astype(np.int64)
    iy = y0.astype(np.int64)
    n00 = _lattice(ix, iy, seed)
    n10 = _lattice(ix + 1, iy, seed)
    n01 = _lattice(ix, iy + 1, seed)
    n11 = _lattice(ix + 1, iy + 1, seed)
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy


def _fbm(x, y, octaves: int, seed: int):
    """Fractal Brownian motion: octave-summed value noise normalized to [0, 1]."""
    import numpy as np

    total = np.zeros_like(x, dtype=np.float64)
    amplitude, frequency, maximum = 1.0, 1.0, 0.0
    for octave in range(octaves):
        total += _value_noise(x * frequency, y * frequency, seed + 101 * octave) * amplitude
        maximum += amplitude
        amplitude *= 0.5
        frequency *= 2.0
    return total / maximum


def _ridged(x, y, octaves: int, seed: int):
    """Ridged multifractal noise (folded value noise) for sharp mountain crests."""
    import numpy as np

    total = np.zeros_like(x, dtype=np.float64)
    amplitude, frequency, maximum = 1.0, 1.0, 0.0
    for octave in range(octaves):
        sample = _value_noise(x * frequency, y * frequency, seed + 131 * octave)
        total += (1.0 - np.abs(2.0 * sample - 1.0)) * amplitude
        maximum += amplitude
        amplitude *= 0.5
        frequency *= 2.0
    return total / maximum


def _smoothstep(edge0: float, edge1: float, value):
    """GLSL-style smoothstep used for radial masks and altitude color bands."""
    import numpy as np

    t = np.clip((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _environment_heights(preset: str, nx, ny, seed: int):
    """Height field in [0, 1] over normalized [-1, 1]^2 coordinates."""
    import numpy as np

    if preset == "SurroundingMountains":
        # A ridged mountain ring with a guaranteed-flat stage circle in the
        # middle; peaks live at ~70% radius and fall off before the border.
        radius = np.sqrt(nx * nx + ny * ny)
        ring = _smoothstep(0.34, 0.6, radius) * (1.0 - _smoothstep(0.86, 1.04, radius))
        ridges = _ridged(nx * 3.2, ny * 3.2, 6, seed) ** 1.7
        variation = 0.72 + 0.28 * _fbm(nx * 1.3 + 7.0, ny * 1.3 - 3.0, 3, seed + 5_501)
        return ring * (0.22 + 0.78 * ridges) * variation
    if preset == "MountainValley":
        side = _smoothstep(0.16, 0.5, np.abs(ny))
        ridges = _ridged(nx * 2.6, ny * 2.6, 6, seed) ** 1.5
        floor_detail = 0.04 * _fbm(nx * 5.0, ny * 5.0, 4, seed + 902)
        return side * (0.3 + 0.7 * ridges) + floor_detail
    if preset == "RollingHills":
        rolling = _fbm(nx * 2.4, ny * 2.4, 5, seed) ** 1.25
        return 0.12 + 0.5 * rolling
    if preset == "DesertDunes":
        wander = (_fbm(nx * 1.8, ny * 1.8, 3, seed) - 0.5) * 2.4
        stripes = 0.5 + 0.5 * np.sin(2.0 * np.pi * (ny * 4.5 + wander))
        return 0.08 + 0.55 * stripes**1.6 + 0.08 * _fbm(nx * 7.0, ny * 7.0, 3, seed + 311)
    raise RuntimeError(f"Unknown environment preset {preset}")


_ENVIRONMENT_PALETTES = {
    "SurroundingMountains": {"low": (0.23, 0.3, 0.17), "mid": (0.4, 0.37, 0.34), "high": (0.91, 0.92, 0.95)},
    "MountainValley": {"low": (0.2, 0.32, 0.16), "mid": (0.42, 0.38, 0.33), "high": (0.85, 0.86, 0.9)},
    "RollingHills": {"low": (0.22, 0.34, 0.16), "mid": (0.34, 0.42, 0.2), "high": (0.55, 0.55, 0.35)},
    "DesertDunes": {"low": (0.62, 0.47, 0.3), "mid": (0.74, 0.58, 0.38), "high": (0.86, 0.72, 0.5)},
}

# Proportions before Director's normalizer rescales to targetHeightMeters:
# extent is the square footprint edge, peak the tallest feature, both meters.
_ENVIRONMENT_SHAPES = {
    "SurroundingMountains": {"extent": 2_200.0, "peak": 340.0},
    "MountainValley": {"extent": 1_600.0, "peak": 260.0},
    "RollingHills": {"extent": 900.0, "peak": 70.0},
    "DesertDunes": {"extent": 1_100.0, "peak": 55.0},
}


def create_environment(preset: str, seed: int, resolution: int = 220):
    """Build one environment preset as a vertex-colored heightfield mesh.

    Resets Blender to an empty scene, samples the preset height function on a
    resolution^2 grid, and colors vertices by altitude band plus a slope
    darkening term so the terrain reads without any texture bake. The GLB
    export step downstream carries vertex colors through a Principled BSDF
    wired to the Col attribute. Real-world proportions come from
    _ENVIRONMENT_SHAPES; Director's normalizer rescales afterwards.
    """
    import bpy
    import numpy as np

    bpy.ops.wm.read_factory_settings(use_empty=True)
    axis = np.linspace(-1.0, 1.0, resolution)
    nx, ny = np.meshgrid(axis, axis)
    heights = _environment_heights(preset, nx, ny, seed)
    shape = _ENVIRONMENT_SHAPES[preset]
    half = shape["extent"] / 2.0
    z = heights * shape["peak"]

    vertices = np.stack([nx * half, ny * half, z], axis=-1).reshape(-1, 3)
    index = np.arange(resolution * resolution).reshape(resolution, resolution)
    quads = np.stack(
        [index[:-1, :-1].ravel(), index[:-1, 1:].ravel(), index[1:, 1:].ravel(), index[1:, :-1].ravel()],
        axis=-1,
    )

    mesh = bpy.data.meshes.new(preset)
    mesh.from_pydata(vertices.tolist(), [], quads.tolist())
    mesh.validate()
    mesh.update()

    palette = _ENVIRONMENT_PALETTES[preset]
    relative = (heights / max(float(heights.max()), 1e-6)).reshape(-1, 1)
    gradient_y, gradient_x = np.gradient(z, shape["extent"] / resolution)
    slope = np.clip(np.hypot(gradient_x, gradient_y) * 1.6, 0.0, 1.0).reshape(-1, 1)
    low, mid, high = (np.array(palette[key]) for key in ("low", "mid", "high"))
    # Banded altitude gradient (low → mid → high) instead of a single lerp,
    # so mid altitudes read as rock/soil rather than a washed-out blend.
    to_mid = _smoothstep(0.02, 0.35, relative)
    to_high = _smoothstep(0.72, 0.92, relative)
    base = low[None, :] * (1.0 - to_mid) + mid[None, :] * to_mid
    base = base * (1.0 - to_high) + high[None, :] * to_high
    colors = base * (1.0 - slope * 0.55) + mid[None, :] * (slope * 0.55)
    attribute = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    rgba = np.concatenate([colors, np.ones((colors.shape[0], 1))], axis=1).astype(np.float32)
    attribute.data.foreach_set("color", rgba.ravel())

    material = bpy.data.materials.new(f"{preset}Material")
    if material.node_tree is None:
        material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    principled.inputs["Roughness"].default_value = 0.95
    color_node = nodes.new("ShaderNodeVertexColor")
    color_node.layer_name = "Col"
    material.node_tree.links.new(color_node.outputs["Color"], principled.inputs["Base Color"])
    mesh.materials.append(material)

    obj = bpy.data.objects.new(preset, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _initialize_infinigen(warnings: list[str]) -> None:
    """Mirror the bootstrap of upstream generate_individual_assets (best effort).

    Factories read gin-bound parameters and the surface material registry;
    each step degrades to a warning so a partially available install still
    gets as far as it can instead of failing opaquely.
    """
    try:
        from infinigen.core import init
    except Exception as exc:
        warnings.append(f"infinigen.core.init 不可用，跳过 gin 初始化: {exc}")
        return
    try:
        init.apply_gin_configs(
            ["infinigen_examples/configs_indoor", "infinigen_examples/configs_nature"],
            skip_unknown=True,
        )
    except Exception as exc:
        warnings.append(f"apply_gin_configs 失败（部分工厂参数将用默认值）: {exc}")
    configure = getattr(init, "configure_blender", None)
    if callable(configure):
        try:
            configure()
        except Exception as exc:
            warnings.append(f"configure_blender 跳过: {exc}")
    try:
        from infinigen.core import surface

        registry_initialize = getattr(getattr(surface, "registry", None), "initialize_from_gin", None)
        if callable(registry_initialize):
            registry_initialize()
    except Exception as exc:
        warnings.append(f"surface registry 初始化跳过: {exc}")


def _fixed_seed_context(seed: int):
    """Return Infinigen's FixedSeed context, or seed stdlib random as a fallback.

    Determinism per seed is part of the provider contract: the same
    factory + seed must reproduce the same asset across runs.
    """
    try:
        from infinigen.core.util.math import FixedSeed

        return FixedSeed(seed)
    except Exception:
        import contextlib
        import random

        random.seed(seed)
        return contextlib.nullcontext()


def create_asset(factory_class, seed: int, warnings: list[str]):
    """Instantiate one Infinigen factory asset in a fresh scene.

    Tries the modern spawn_asset API first and falls back to the older
    create_asset, because the catalog spans factories from several Infinigen
    generations. finalize_assets is best-effort: some factories finalize
    inside spawn_asset and raise when called twice.
    """
    import bpy

    bpy.ops.wm.read_factory_settings(use_empty=True)
    _initialize_infinigen(warnings)
    factory = factory_class(seed)
    with _fixed_seed_context(seed):
        try:
            asset = factory.spawn_asset(seed)
        except (AttributeError, TypeError, NotImplementedError):
            asset = factory.create_asset()
    finalize = getattr(factory, "finalize_assets", None)
    if callable(finalize):
        try:
            finalize(asset)
        except Exception as exc:  # some factories finalize inside spawn_asset already
            print(f"[runner] finalize_assets skipped: {exc}")
    return asset


def bake_and_export_glb(output_dir: Path, texture_res: int, warnings: list[str]) -> Path:
    """Bake procedural materials via Infinigen's exporter, then convert to GLB.

    Infinigen materials are Blender node graphs that no interchange format can
    carry directly; upstream's supported path is bake-to-textures + FBX/OBJ/USD.
    We reuse that pipeline (FBX), reimport the baked result into a clean scene,
    and let Blender's glTF exporter pack everything into one binary GLB.
    """
    import bpy

    glb_path = output_dir / "model.glb"
    export_dir = output_dir / "export"
    export_dir.mkdir(exist_ok=True)
    baked_fbx: Path | None = None
    try:
        from infinigen.tools import export as infinigen_export

        infinigen_export.export_curr_scene(
            export_dir, format="fbx", image_res=texture_res, vertex_colors=False, individual_export=False
        )
        baked_fbx = next(export_dir.rglob("*.fbx"), None)
    except Exception as exc:
        warnings.append(f"Infinigen bake pipeline unavailable ({exc}); exporting without baked textures")

    if baked_fbx is not None:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=str(baked_fbx))
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", export_yup=True)
    if not glb_path.exists() or glb_path.stat().st_size == 0:
        raise RuntimeError("glTF export produced no model.glb")
    return glb_path


def render_thumbnail(output_dir: Path) -> Path:
    """Render a 512x512 transparent EEVEE thumbnail of the current scene.

    Frames the combined mesh bounds with a three-quarter camera and a single
    sun so both centimeter-scale props and kilometer-scale terrain presets
    photograph without manual staging.
    """
    import bpy
    from mathutils import Vector

    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("Scene holds no mesh objects to photograph")

    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    center = sum(corners, Vector()) / len(corners)
    radius = max((corner - center).length for corner in corners) or 1.0

    camera_data = bpy.data.cameras.new("director_thumb_cam")
    # Environment presets span kilometers; the default 100m clip end would
    # cull the whole scene and leave a blank thumbnail.
    camera_data.clip_start = max(0.01, radius * 0.005)
    camera_data.clip_end = max(100.0, radius * 12.0)
    camera = bpy.data.objects.new("director_thumb_cam", camera_data)
    scene.collection.objects.link(camera)
    camera.location = center + Vector((1.0, -1.4, 0.9)).normalized() * radius * 2.6
    direction = center - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera

    sun_data = bpy.data.lights.new("director_thumb_sun", type="SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("director_thumb_sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.9, 0.2, 0.6)

    engines = {item.identifier for item in type(scene.render).bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.film_transparent = True
    thumb_path = output_dir / "thumbnail.png"
    scene.render.filepath = str(thumb_path)
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    if not thumb_path.exists():
        raise RuntimeError("Thumbnail render produced no file")
    return thumb_path


def main() -> int:
    """Run one generation task and always leave a terminal status.json.

    Every path — environment preset, factory asset, or crash — ends in a
    succeeded/failed/cancelled snapshot, because the gateway has no other
    channel to learn the outcome.
    """
    global _OUTPUT_DIR
    parser = argparse.ArgumentParser(prog="director_infinigen_runner")
    parser.add_argument("--factory", required=True)
    parser.add_argument("--kind", choices=("asset", "environment"), default="asset")
    parser.add_argument("--module", default=None)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--name", default="Infinigen asset")
    parser.add_argument("--texture-res", type=int, default=1024)
    parser.add_argument("--output", required=True, type=Path)
    # Support both invocation styles: a pip-installed bpy interpreter passes
    # our args directly; the Blender binary prepends its own argv before "--".
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else None
    args = parser.parse_args(argv)

    _OUTPUT_DIR = args.output.resolve()
    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, _handle_sigterm)
    warnings: list[str] = []

    try:
        if args.kind == "environment":
            import bpy

            write_status("running", 0.1, message=f"程序化生成环境地形 {args.name}（seed {args.seed}）")
            create_environment(args.factory, args.seed)
            write_status("running", 0.6, message="导出环境 GLB")
            glb_path = _OUTPUT_DIR / "model.glb"
            bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", export_yup=True)
            if not glb_path.exists() or glb_path.stat().st_size == 0:
                raise RuntimeError("glTF export produced no model.glb")
        else:
            if not args.module:
                raise RuntimeError("kind=asset requires --module")
            write_status("running", 0.05, message=f"加载 Infinigen 工厂 {args.factory}")
            factory_class = load_factory(args.module, args.factory)

            write_status("running", 0.15, message=f"程序化生成 {args.name}（seed {args.seed}）")
            create_asset(factory_class, args.seed, warnings)

            write_status("running", 0.45, message="烘焙程序化材质并导出 GLB")
            glb_path = bake_and_export_glb(_OUTPUT_DIR, args.texture_res, warnings)

        write_status("running", 0.85, message="渲染缩略图", warnings=warnings)
        thumb_path = render_thumbnail(_OUTPUT_DIR)

        write_status(
            "succeeded",
            1.0,
            message=f"{args.factory} 生成完成",
            warnings=warnings,
            model=glb_path.name,
            thumbnail=thumb_path.name,
        )
        return 0
    except Exception as exc:  # terminal state must always reach status.json
        traceback.print_exc()
        write_status("failed", 0, error=f"{type(exc).__name__}: {exc}", warnings=warnings)
        return 1


if __name__ == "__main__":
    sys.exit(main())
