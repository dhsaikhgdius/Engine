# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Import Director model assets into the bound native Blender scene.

Every imported asset becomes a two-level empty hierarchy::

    <asset root empty>            ← carries the Director identity + transform
      └─ <normalization empty>    ← carries the metric offset/scale
           └─ imported objects…   ← authored geometry, untouched

The split matters: Director transforms (position/rotation/scale from the
Stage) are applied to the root, while unit normalization (recentering,
grounding, auto-scaling to a sane size) lives on the intermediate empty.
That keeps the authored geometry byte-identical and lets a later transform
update never fight with normalization math.

Security invariant: assets are only downloaded from the loopback gateway.
The gateway is the single authority for asset provenance; accepting arbitrary
URLs here would turn every connected Blender into an SSRF proxy.
"""

from __future__ import annotations

from pathlib import Path
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import bpy
from mathutils import Vector

from . import blockout
from .coordinates import director_to_blender_point


# Custom-property markers on the asset root empty. ASSET_ROOT_PROPERTY is how
# delete/duplicate/visibility ops recognize that an object owns a subtree that
# must be treated as one unit.
ASSET_ROOT_PROPERTY = "director_asset_root"
ASSET_ID_PROPERTY = "director_asset_id"
SUPPORTED_EXTENSIONS = {".fbx", ".obj", ".glb", ".gltf"}
# Auto normalization scales the largest bound to 2 m — a prop-scale default
# that keeps arbitrary downloads visible next to human-scale blockouts.
AUTO_TARGET_SIZE_M = 2.0


def _object_result(obj: bpy.types.Object) -> dict[str, object]:
    return {
        "objectId": blockout.ensure_stable_id(obj),
        "name": blockout.object_display_name(obj),
        "kind": str(obj.get("worldengine_kind", "object")),
    }


def _download_asset(source_url: str, file_name: str, directory: Path) -> Path:
    """Stream the asset from the loopback gateway into a temp file.

    The extension comes from the declared fileName (not the URL) because the
    gateway serves assets from opaque storage-key URLs; it also selects the
    Blender importer, so it is validated before any network I/O.
    """
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
    """Dispatch to the right bpy importer; OBJ moved from import_scene.obj to
    wm.obj_import in Blender 4.x, so probe for the new operator first."""
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
    """Axis-aligned world bounds of the renderable objects in the import.

    Uses the evaluated depsgraph so modifier/instance geometry counts; empties
    and armatures are ignored because normalization should size the visible
    silhouette, not helper objects.
    """
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
    # Precedence: an explicit metric target height always wins; otherwise
    # "preserve" keeps authored units (optionally grounding to Z=0); otherwise
    # auto-fit the largest dimension to AUTO_TARGET_SIZE_M. Scaled modes also
    # recenter XY on the origin and rest the minimum Z on the ground plane so
    # the root empty's transform is the asset's logical anchor.
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
    """Execute one validated ``import_asset`` live operation.

    Idempotent by object id: re-running a batch that already imported this id
    returns the existing root with ``created: False`` instead of importing a
    duplicate — required because the live session may retry batches.
    """
    existing = blockout.find_object(str(operation["id"]))
    if existing is not None:
        return {**_object_result(existing), "created": False, "createdObjectIds": []}

    scene = bpy.context.scene
    # bpy importers don't report what they created; diff the scene object set
    # around the import to find out.
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

    # Strip any identity markers the source file may have carried (e.g. a
    # re-exported Director asset) so only the new root owns the binding, then
    # reparent top-level imports under the normalization empty while
    # preserving their world transforms.
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
    """All descendants of an asset root, for whole-asset operations
    (delete, duplicate, visibility)."""
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
