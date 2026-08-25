# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Import Director model assets into the bound native Blender scene."""

from __future__ import annotations

from pathlib import Path
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import bpy
from mathutils import Vector

from . import blockout
from .coordinates import director_to_blender_point


ASSET_ROOT_PROPERTY = "director_asset_root"
ASSET_ID_PROPERTY = "director_asset_id"
SUPPORTED_EXTENSIONS = {".fbx", ".obj", ".glb", ".gltf"}
AUTO_TARGET_SIZE_M = 2.0


def _object_result(obj: bpy.types.Object) -> dict[str, object]:
    return {
        "objectId": blockout.ensure_stable_id(obj),
        "name": blockout.object_display_name(obj),
        "kind": str(obj.get("worldengine_kind", "object")),
    }


def _download_asset(source_url: str, file_name: str, directory: Path) -> Path:
    extension = Path(file_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported Director model format: {extension or file_name}")
    parsed = urlparse(source_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Director model assets must use an HTTP source URL")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Director model assets must be served from the local gateway (loopback host)")

    target = directory / f"source{extension}"
    request = Request(source_url, headers={"User-Agent": "Director-Blender/1"})
    with urlopen(request, timeout=30) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    return target


def _import_file(path: Path) -> None:
    extension = path.suffix.lower()
    if extension in {".glb", ".gltf"}:
        outcome = bpy.ops.import_scene.gltf(filepath=str(path))
    elif extension == ".fbx":
        outcome = bpy.ops.import_scene.fbx(filepath=str(path))
    elif extension == ".obj" and hasattr(bpy.ops.wm, "obj_import"):
        outcome = bpy.ops.wm.obj_import(filepath=str(path))
    else:
        outcome = bpy.ops.import_scene.obj(filepath=str(path))
    if 'FINISHED' not in outcome:
        raise RuntimeError(f"Blender could not import Director asset {path.name}")


def _world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    minimum = Vector((float("inf"), float("inf"), float("inf")))
    maximum = Vector((float("-inf"), float("-inf"), float("-inf")))
    found = False
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for source in objects:
        if source.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META', 'VOLUME'}:
            continue
        evaluated = source.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            point = evaluated.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
            found = True
    if not found:
        raise ValueError("Director model asset contains no visible geometry")
    return minimum, maximum


def _normalization(
    minimum: Vector,
    maximum: Vector,
    *,
    mode: str,
    grounded: bool,
    target_height: float | None,
) -> tuple[Vector, float]:
    size = maximum - minimum
    center = (minimum + maximum) * 0.5
    if target_height is not None:
        scale = target_height / size.z if size.z > 0 else 1.0
        return Vector((-center.x * scale, -center.y * scale, -minimum.z * scale)), scale
    if mode == "preserve":
        return Vector((0.0, 0.0, -minimum.z if grounded else 0.0)), 1.0
    maximum_size = max(size.x, size.y, size.z)
    scale = AUTO_TARGET_SIZE_M / maximum_size if maximum_size > 0 else 1.0
    return Vector((-center.x * scale, -center.y * scale, -minimum.z * scale)), scale


def _apply_director_transform(obj: bpy.types.Object, transform: dict[str, object] | None) -> None:
    if not transform:
        return
    if "position" in transform:
        obj.location = director_to_blender_point(transform["position"])
    if "rotation" in transform:
        obj.rotation_mode = 'XYZ'
        obj.rotation_euler = blockout.director_rotation_to_blender(transform["rotation"])
    if "scale" in transform:
        x, y, z = transform["scale"]
        obj.scale = (float(x), float(z), float(y))


def import_asset(operation: dict[str, object]) -> dict[str, object]:
    existing = blockout.find_object(str(operation["id"]))
    if existing is not None:
        return {**_object_result(existing), "created": False, "createdObjectIds": []}

    scene = bpy.context.scene
    before = set(scene.objects)
    with tempfile.TemporaryDirectory(prefix="director-native-asset-") as temporary:
        source = _download_asset(
            str(operation["sourceUrl"]),
            str(operation["fileName"]),
            Path(temporary),
        )
        _import_file(source)

    imported = [obj for obj in scene.objects if obj not in before]
    if not imported:
        raise ValueError("Blender imported no objects from the Director asset")
    bpy.context.view_layer.update()
    minimum, maximum = _world_bounds(imported)

    root = bpy.data.objects.new(str(operation["name"]), None)
    blockout.set_object_display_name(root, str(operation["name"]))
    scene.collection.objects.link(root)
    root[blockout.ID_PROPERTY] = str(operation["id"])
    root[blockout.DIRECTOR_ID_PROPERTY] = str(operation["directorId"])
    root[ASSET_ROOT_PROPERTY] = True
    root[ASSET_ID_PROPERTY] = str(operation["assetId"])
    root["worldengine_kind"] = str(operation["kind"])

    normalization_root = bpy.data.objects.new(f"{operation['name']} Geometry", None)
    scene.collection.objects.link(normalization_root)
    normalization_root.parent = root
    blockout.ensure_stable_id(normalization_root, "asset-data")

    imported_set = set(imported)
    for obj in imported:
        obj[blockout.ID_PROPERTY] = blockout.new_stable_id("asset-object")
        if blockout.DIRECTOR_ID_PROPERTY in obj:
            del obj[blockout.DIRECTOR_ID_PROPERTY]
        if ASSET_ROOT_PROPERTY in obj:
            del obj[ASSET_ROOT_PROPERTY]
    for obj in imported:
        if obj.parent in imported_set:
            continue
        world_matrix = obj.matrix_world.copy()
        obj.parent = normalization_root
        obj.matrix_parent_inverse = normalization_root.matrix_world.inverted_safe()
        obj.matrix_world = world_matrix

    offset, scale = _normalization(
        minimum,
        maximum,
        mode=str(operation.get("normalization", "auto")),
        grounded=bool(operation.get("grounded", False)),
        target_height=(
            float(operation["targetHeightM"])
            if operation.get("targetHeightM") is not None
            else None
        ),
    )
    normalization_root.location = offset
    normalization_root.scale = (scale, scale, scale)
    _apply_director_transform(root, operation.get("transform"))
    blockout._select_only(root)
    bpy.context.view_layer.update()

    created_ids = [blockout.ensure_stable_id(root), blockout.ensure_stable_id(normalization_root)]
    created_ids.extend(blockout.ensure_stable_id(obj) for obj in imported)
    return {
        **_object_result(root),
        "created": True,
        "assetId": operation["assetId"],
        "createdObjectIds": created_ids,
    }


def asset_subtree(root: bpy.types.Object) -> list[bpy.types.Object]:
    descendants: list[bpy.types.Object] = []
    pending = list(root.children)
    while pending:
        current = pending.pop()
        descendants.append(current)
        pending.extend(current.children)
    return descendants


__all__ = (
    "ASSET_ROOT_PROPERTY",
    "asset_subtree",
    "import_asset",
)
