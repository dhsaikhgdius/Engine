# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Poly Haven and Sketchfab search/import for the live Blender kernel.

Unlike ``asset_import`` (which only trusts the loopback Director gateway),
these operations intentionally reach the public Poly Haven and Sketchfab
APIs — they are the agent-facing "asset library" surface, and the allowed
hosts are pinned in ``asset_library_http``. Downloads always land in a
temporary directory, get imported, and are packed into the .blend so the
scene stays self-contained after the temp dir is deleted.

Common conventions across importers here:

- All network/JSON shape handling is defensive (isinstance checks with
  fallbacks) because these are third-party APIs we do not control; a schema
  drift should degrade to a clear ValueError, not a KeyError traceback.
- Imported objects are grouped under a new root empty that carries the
  stable WorldEngine id, mirroring the Director asset-import hierarchy so
  downstream ops (delete/duplicate/snapshot) treat library assets uniformly.
- Sketchfab requires a user API token (preference or SKETCHFAB_API_TOKEN);
  Poly Haven is anonymous.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import bpy
from mathutils import Vector

from . import asset_import, blockout
from . import asset_library_http as library_http

# Preference-ordered fallbacks: the requested resolution/format is tried
# first, then these, so an asset missing the exact variant still imports.
_RESOLUTION_FALLBACK = ("1k", "2k", "4k")
_HDRI_FORMAT_FALLBACK = ("hdr", "exr", "jpg", "png")
_TEXTURE_FORMAT_FALLBACK = ("exr", "png", "jpg", "jpeg")
_MODEL_FORMAT_FALLBACK = ("gltf", "fbx", "blend")
# Poly Haven names PBR maps inconsistently across assets; each alias tuple is
# checked in order against the lower-cased file map keys.
_COLOR_MAP_KEYS = ("diff", "diffuse", "col", "color", "albedo")
_ROUGH_MAP_KEYS = ("rough", "roughness")
_METAL_MAP_KEYS = ("metal", "metallic", "metalness")
_NORMAL_MAP_KEYS = ("nor_gl", "nor_dx", "normal", "nor")
_DISP_MAP_KEYS = ("disp", "displacement", "bump")


def polyhaven_search(operation: dict[str, Any]) -> dict[str, Any]:
    """List Poly Haven assets matching a query; filtering happens client-side
    because the Poly Haven API has no text search endpoint."""
    asset_type = str(operation.get("assetType") or "models")
    limit = int(operation.get("limit") or 20)
    query = str(operation.get("query") or "")
    categories = operation.get("categories")
    url = library_http.polyhaven_assets_url(
        asset_type=asset_type,
        categories=str(categories) if categories else None,
    )
    payload = library_http.http_json(url)
    assets = library_http.filter_polyhaven_assets(payload if isinstance(payload, dict) else {}, query, limit)
    return {
        "provider": "polyhaven",
        "assetType": asset_type,
        "query": query,
        "count": len(assets),
        "assets": assets,
    }


def sketchfab_search(operation: dict[str, Any]) -> dict[str, Any]:
    """Search downloadable Sketchfab models; the summary keeps license and
    isDownloadable so the agent can pick an importable result up front."""
    token = library_http.sketchfab_api_token()
    if not token:
        raise ValueError("Set SKETCHFAB_API_TOKEN or the WorldEngine Studio Sketchfab API token preference.")
    query = str(operation["query"])
    count = int(operation.get("count") or 5)
    payload = library_http.http_json(
        library_http.sketchfab_search_url(query=query, count=count),
        headers=library_http.sketchfab_auth_headers(token),
    )
    results = payload.get("results") if isinstance(payload, dict) else None
    models: list[dict[str, Any]] = []
    if isinstance(results, list):
        for entry in results:
            if not isinstance(entry, dict):
                continue
            user = entry.get("user") if isinstance(entry.get("user"), dict) else {}
            models.append(
                {
                    "uid": entry.get("uid") or entry.get("id"),
                    "name": entry.get("name"),
                    "isDownloadable": bool(entry.get("isDownloadable")),
                    "user": user.get("displayName") or user.get("username"),
                    "license": (entry.get("license") or {}).get("label") if isinstance(entry.get("license"), dict) else None,
                }
            )
    return {
        "provider": "sketchfab",
        "query": query,
        "count": len(models),
        "models": models,
    }


def polyhaven_import(operation: dict[str, Any]) -> dict[str, Any]:
    """Route one Poly Haven import to the per-type importer: HDRIs become the
    scene world, textures become a PBR material (optionally assigned to an
    object), models become an object subtree under a new root empty."""
    asset_id = str(operation["assetId"])
    asset_type = str(operation["assetType"])
    resolution = str(operation.get("resolution") or "1k")
    files = library_http.http_json(library_http.polyhaven_files_url(asset_id))
    if not isinstance(files, dict):
        raise ValueError(f"Poly Haven returned no files for {asset_id}")
    if asset_type == "hdris":
        return _import_polyhaven_hdri(asset_id, files, resolution, operation.get("fileFormat"))
    if asset_type == "textures":
        return _import_polyhaven_texture(
            asset_id,
            files,
            resolution,
            operation.get("fileFormat"),
            operation.get("objectId"),
        )
    if asset_type == "models":
        return _import_polyhaven_model(
            asset_id,
            files,
            resolution,
            operation.get("objectId"),
            operation.get("targetHeightM"),
        )
    raise ValueError(f"Unsupported Poly Haven assetType: {asset_type}")


def sketchfab_import(operation: dict[str, Any]) -> dict[str, Any]:
    """Download and import one Sketchfab model via its glTF archive.

    Sketchfab's download endpoint returns short-lived signed URLs per format;
    only the glTF variant is used because it round-trips materials most
    reliably through Blender's importer.
    """
    token = library_http.sketchfab_api_token()
    if not token:
        raise ValueError("Set SKETCHFAB_API_TOKEN or the WorldEngine Studio Sketchfab API token preference.")
    uid = str(operation["uid"])
    target_size_m = float(operation.get("targetSizeM") or 1.0)
    payload = library_http.http_json(
        library_http.sketchfab_download_url(uid),
        headers=library_http.sketchfab_auth_headers(token),
    )
    gltf = payload.get("gltf") if isinstance(payload, dict) else None
    url = gltf.get("url") if isinstance(gltf, dict) else None
    if not isinstance(url, str) or not url:
        raise ValueError(f"Sketchfab model {uid} is not available as glTF")
    with tempfile.TemporaryDirectory(prefix="director-sketchfab-") as temporary:
        root = Path(temporary)
        archive = library_http.http_download(url, root / "model.zip")
        gltf_path = library_http.extract_zip(archive, root / "extracted")
        created_ids = _import_model_file(
            gltf_path,
            name=f"sketchfab-{uid[:8]}",
            object_id=operation.get("objectId") if isinstance(operation.get("objectId"), str) else None,
            target_size_m=target_size_m,
        )
    return {
        "provider": "sketchfab",
        "uid": uid,
        "targetSizeM": target_size_m,
        "createdObjectIds": created_ids,
        "objectId": created_ids[0] if created_ids else None,
    }


def _resolution_keys(requested: str) -> tuple[str, ...]:
    ordered = [requested, *[value for value in _RESOLUTION_FALLBACK if value != requested]]
    return tuple(ordered)


def _pick_format_entry(formats: dict[str, Any], preferred: str | None, fallback: tuple[str, ...]) -> tuple[str, dict[str, Any]]:
    """Pick the first format with a usable URL: preferred, then the fallback
    order, then anything downloadable at all."""
    order = ((preferred,) if preferred else ()) + fallback
    for key in order:
        entry = formats.get(key)
        if isinstance(entry, dict) and isinstance(entry.get("url"), str):
            return key, entry
    for key, entry in formats.items():
        if isinstance(entry, dict) and isinstance(entry.get("url"), str):
            return str(key), entry
    raise ValueError("No downloadable file format in Poly Haven response")


def _pick_resolution(tree: dict[str, Any], requested: str) -> dict[str, Any]:
    for key in _resolution_keys(requested):
        entry = tree.get(key)
        if isinstance(entry, dict):
            return entry
    for entry in tree.values():
        if isinstance(entry, dict):
            return entry
    raise ValueError("No matching Poly Haven resolution")


def _import_polyhaven_hdri(asset_id: str, files: dict[str, Any], resolution: str, file_format: str | None) -> dict[str, Any]:
    """Build a fresh world with an environment-texture chain and make it the
    scene world. The image is packed before the temp file disappears."""
    hdri = files.get("hdri")
    if not isinstance(hdri, dict):
        raise ValueError(f"Poly Haven asset {asset_id} is not an HDRI")
    formats = _pick_resolution(hdri, resolution)
    chosen_format, entry = _pick_format_entry(formats, file_format, _HDRI_FORMAT_FALLBACK)
    with tempfile.TemporaryDirectory(prefix="director-polyhaven-hdri-") as temporary:
        path = library_http.http_download(str(entry["url"]), Path(temporary) / f"{asset_id}.{chosen_format}")
        image = bpy.data.images.load(str(path), check_existing=False)
        image.pack()
    world = bpy.data.worlds.new(f"PolyHaven {asset_id}")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    env = nodes.new("ShaderNodeTexEnvironment")
    env.image = image
    env.location = (-300, 0)
    background = nodes.new("ShaderNodeBackground")
    background.location = (0, 0)
    output = nodes.new("ShaderNodeOutputWorld")
    output.location = (300, 0)
    links.new(env.outputs["Color"], background.inputs["Color"])
    links.new(background.outputs["Background"], output.inputs["Surface"])
    bpy.context.scene.world = world
    return {
        "provider": "polyhaven",
        "assetId": asset_id,
        "assetType": "hdris",
        "worldName": world.name,
        "createdObjectIds": [],
    }


def _map_key(name: str) -> str:
    return name.lower().replace(" ", "_")


def _first_map(files: dict[str, Any], aliases: tuple[str, ...]) -> dict[str, Any] | None:
    lowered = {_map_key(key): value for key, value in files.items() if isinstance(value, dict)}
    for alias in aliases:
        entry = lowered.get(alias)
        if isinstance(entry, dict):
            return entry
    return None


def _load_image_map(files: dict[str, Any], aliases: tuple[str, ...], resolution: str, file_format: str | None, dest: Path, stem: str) -> bpy.types.Image | None:
    tree = _first_map(files, aliases)
    if tree is None:
        return None
    formats = _pick_resolution(tree, resolution)
    chosen_format, entry = _pick_format_entry(formats, file_format, _TEXTURE_FORMAT_FALLBACK)
    path = library_http.http_download(str(entry["url"]), dest / f"{stem}.{chosen_format}")
    image = bpy.data.images.load(str(path), check_existing=False)
    image.pack()
    return image


def _import_polyhaven_texture(
    asset_id: str,
    files: dict[str, Any],
    resolution: str,
    file_format: str | None,
    object_id: str | None,
) -> dict[str, Any]:
    """Assemble a Principled BSDF material from whichever PBR maps the asset
    provides; non-color maps get the Non-Color colorspace so roughness/normal
    data is not gamma-corrected. Missing maps are simply skipped."""
    material = bpy.data.materials.new(f"PolyHaven {asset_id}")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    output = next((node for node in nodes if node.type == "OUTPUT_MATERIAL"), None)
    if principled is None or output is None:
        nodes.clear()
        principled = nodes.new("ShaderNodeBsdfPrincipled")
        output = nodes.new("ShaderNodeOutputMaterial")
        links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    with tempfile.TemporaryDirectory(prefix="director-polyhaven-tex-") as temporary:
        dest = Path(temporary)
        color = _load_image_map(files, _COLOR_MAP_KEYS, resolution, file_format, dest, "color")
        rough = _load_image_map(files, _ROUGH_MAP_KEYS, resolution, file_format, dest, "rough")
        metal = _load_image_map(files, _METAL_MAP_KEYS, resolution, file_format, dest, "metal")
        normal = _load_image_map(files, _NORMAL_MAP_KEYS, resolution, file_format, dest, "normal")
        disp = _load_image_map(files, _DISP_MAP_KEYS, resolution, file_format, dest, "disp")
    x = -600
    if color is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = color
        tex.location = (x, 200)
        links.new(tex.outputs["Color"], principled.inputs["Base Color"])
    if rough is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = rough
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (x, 0)
        links.new(tex.outputs["Color"], principled.inputs["Roughness"])
    if metal is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = metal
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (x, -200)
        links.new(tex.outputs["Color"], principled.inputs["Metallic"])
    if normal is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = normal
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (x, -400)
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (x + 280, -400)
        links.new(tex.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    if disp is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = disp
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (x, -600)
        displacement = nodes.new("ShaderNodeDisplacement")
        displacement.location = (x + 280, -600)
        links.new(tex.outputs["Color"], displacement.inputs["Height"])
        links.new(displacement.outputs["Displacement"], output.inputs["Displacement"])
    assigned = None
    if isinstance(object_id, str) and object_id:
        obj = blockout.find_object(object_id)
        if obj is None:
            raise ValueError(f"Unknown object {object_id}")
        if obj.data and hasattr(obj.data, "materials"):
            if obj.data.materials:
                obj.data.materials[0] = material
            else:
                obj.data.materials.append(material)
            assigned = object_id
    return {
        "provider": "polyhaven",
        "assetId": asset_id,
        "assetType": "textures",
        "materialName": material.name,
        "objectId": assigned,
        "createdObjectIds": [],
        "changedObjectIds": [assigned] if assigned else [],
    }


def _download_includes(include: dict[str, Any], dest: Path) -> None:
    """Fetch a glTF's sidecar files (.bin buffers, textures) next to it.

    Relative paths come from the API response, so safe_join guards against
    path traversal out of the temp directory.
    """
    for relative, spec in include.items():
        url = spec.get("url") if isinstance(spec, dict) else None
        if not isinstance(url, str):
            continue
        target = library_http.safe_join(dest, str(relative))
        library_http.http_download(url, target)


def _import_polyhaven_model(
    asset_id: str,
    files: dict[str, Any],
    resolution: str,
    object_id: str | None,
    target_height_m: float | None,
) -> dict[str, Any]:
    # Model files are grouped by kind (gltf/fbx/blend) then resolution; pick
    # the first importable kind and let resolution fall back like textures do.
    model_tree = None
    chosen_kind = None
    for kind in _MODEL_FORMAT_FALLBACK:
        candidate = files.get(kind)
        if isinstance(candidate, dict):
            model_tree = candidate
            chosen_kind = kind
            break
    if model_tree is None or chosen_kind is None:
        raise ValueError(f"Poly Haven asset {asset_id} has no importable model files")
    formats = _pick_resolution(model_tree, resolution)
    file_entry = formats.get(chosen_kind) if isinstance(formats.get(chosen_kind), dict) else None
    if file_entry is None:
        _, file_entry = _pick_format_entry(formats, chosen_kind, _MODEL_FORMAT_FALLBACK)
    url = file_entry.get("url") if isinstance(file_entry, dict) else None
    if not isinstance(url, str):
        raise ValueError(f"Poly Haven model {asset_id} has no download URL")
    include = file_entry.get("include") if isinstance(file_entry.get("include"), dict) else {}
    with tempfile.TemporaryDirectory(prefix="director-polyhaven-model-") as temporary:
        root = Path(temporary)
        extension = ".gltf" if chosen_kind == "gltf" else f".{chosen_kind}"
        source = library_http.http_download(url, root / f"model{extension}")
        if include:
            _download_includes(include, root)
        created_ids = _import_model_file(
            source,
            name=f"polyhaven-{asset_id}",
            object_id=object_id if isinstance(object_id, str) else None,
            target_height_m=float(target_height_m) if target_height_m is not None else None,
        )
    return {
        "provider": "polyhaven",
        "assetId": asset_id,
        "assetType": "models",
        "createdObjectIds": created_ids,
        "objectId": created_ids[0] if created_ids else None,
    }


def _import_model_file(
    path: Path,
    *,
    name: str,
    object_id: str | None,
    target_size_m: float | None = None,
    target_height_m: float | None = None,
) -> list[str]:
    """Import one downloaded model file and wrap it in a root empty.

    Shared tail of both providers' model imports: diff the scene set to find
    what the importer created, pack any new images into the .blend, reparent
    top-level objects under a root empty carrying the stable id, then apply
    either height-based normalization (reusing asset_import's math) or a
    simple largest-dimension fit.
    """
    scene = bpy.context.scene
    before = set(scene.objects)
    before_images = set(bpy.data.images)
    if path.suffix.lower() in {".glb", ".gltf"}:
        outcome = bpy.ops.import_scene.gltf(filepath=str(path))
    elif path.suffix.lower() == ".fbx":
        outcome = bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        raise ValueError(f"Unsupported library model format: {path.suffix}")
    if "FINISHED" not in outcome:
        raise RuntimeError(f"Blender could not import {path.name}")
    imported = [obj for obj in scene.objects if obj not in before]
    if not imported:
        raise ValueError("Library import created no objects")
    for image in bpy.data.images:
        if image in before_images:
            continue
        try:
            image.pack()
        except Exception:
            pass
    bpy.context.view_layer.update()
    root = bpy.data.objects.new(name, None)
    blockout.set_object_display_name(root, name)
    scene.collection.objects.link(root)
    if object_id:
        root[blockout.ID_PROPERTY] = object_id
    else:
        blockout.ensure_stable_id(root, "library")
    imported_set = set(imported)
    for obj in imported:
        if obj.parent in imported_set:
            continue
        world_matrix = obj.matrix_world.copy()
        obj.parent = root
        obj.matrix_parent_inverse = root.matrix_world.inverted_safe()
        obj.matrix_world = world_matrix
        blockout.ensure_stable_id(obj, "library-object")
    minimum, maximum = asset_import._world_bounds(imported)
    if target_height_m is not None:
        offset, scale = asset_import._normalization(
            minimum,
            maximum,
            mode="auto",
            grounded=True,
            target_height=target_height_m,
        )
        root.location = offset
        root.scale = (scale, scale, scale)
    elif target_size_m is not None:
        size = maximum - minimum
        largest = max(size.x, size.y, size.z)
        scale = target_size_m / largest if largest > 0 else 1.0
        center = (minimum + maximum) * 0.5
        root.location = Vector((-center.x * scale, -center.y * scale, -minimum.z * scale))
        root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    created_ids = [blockout.ensure_stable_id(root)]
    created_ids.extend(blockout.ensure_stable_id(obj) for obj in imported)
    return created_ids


__all__ = (
    "polyhaven_import",
    "polyhaven_search",
    "sketchfab_import",
    "sketchfab_search",
)
