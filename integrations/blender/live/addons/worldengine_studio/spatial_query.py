# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Read-only spatial reasoning queries against the evaluated depsgraph.

Every position and direction crosses the wire in Director coordinates
(Y-up, right-handed); this module converts to Blender coordinates (Z-up)
on entry and back on exit. Distances are meters in both systems.
"""

from __future__ import annotations

from typing import Any

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import blockout
from .coordinates import blender_to_director_point, director_to_blender_point


# A cast that keeps landing on excluded objects nudges forward by the epsilon
# and retries; the skip cap bounds worst-case work for degenerate stacks.
_RAYCAST_MAX_SKIPS = 16
_RAYCAST_SKIP_EPSILON = 1e-4
_GROUND_START_EPSILON = 1e-4
_GROUND_MAX_DISTANCE = 100_000.0


def _resolve_object(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    return obj


def _resolve_exclusions(identifiers: Any) -> set[bpy.types.Object]:
    return {_resolve_object(identifier) for identifier in (identifiers or [])}


def _blender_vector(value: Any) -> Vector:
    return Vector(director_to_blender_point([float(component) for component in value]))


def _director_list(vector: Vector) -> list[float]:
    return list(blender_to_director_point((float(vector.x), float(vector.y), float(vector.z))))


def _cast_ray(
    depsgraph,
    origin: Vector,
    direction: Vector,
    max_distance: float,
    excluded: set[bpy.types.Object],
):
    """Cast through excluded objects; return (location, normal, original) or None."""
    scene = bpy.context.scene
    cast_origin = origin.copy()
    for _skip in range(_RAYCAST_MAX_SKIPS + 1):
        remaining = max_distance - (cast_origin - origin).length
        if remaining <= 0.0:
            break
        hit, location, normal, _face_index, hit_object, _matrix = scene.ray_cast(
            depsgraph, cast_origin, direction, distance=remaining
        )
        if not hit:
            break
        original = hit_object.original
        if original not in excluded:
            return location, normal, original
        cast_origin = location + direction * _RAYCAST_SKIP_EPSILON
    return None


def _evaluated_world_bounds(obj: bpy.types.Object, depsgraph) -> tuple[Vector, Vector]:
    evaluated = obj.evaluated_get(depsgraph)
    corners = [evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box]
    minimum = Vector(tuple(min(corner[index] for corner in corners) for index in range(3)))
    maximum = Vector(tuple(max(corner[index] for corner in corners) for index in range(3)))
    return minimum, maximum


def _raycast(depsgraph, query: dict[str, Any]) -> dict[str, Any]:
    origin = _blender_vector(query["origin"])
    direction = _blender_vector(query["direction"])
    if direction.length == 0.0:
        raise ValueError("RAYCAST direction must be a non-zero vector")
    direction.normalize()
    max_distance = float(query.get("maxDistance", 1000.0))
    excluded = _resolve_exclusions(query.get("excludeIds"))
    result = _cast_ray(depsgraph, origin, direction, max_distance, excluded)
    if result is None:
        return {"kind": "RAYCAST", "hit": False}
    location, normal, original = result
    return {
        "kind": "RAYCAST",
        "hit": True,
        "objectId": blockout.ensure_stable_id(original),
        "position": _director_list(location),
        "normal": _director_list(normal),
        "distance": float((location - origin).length),
    }


def _closest_point(depsgraph, query: dict[str, Any]) -> dict[str, Any]:
    obj = _resolve_object(query["targetId"])
    evaluated = obj.evaluated_get(depsgraph)
    if evaluated.type != 'MESH':
        raise ValueError(f"CLOSEST_POINT requires a mesh object: {query['targetId']}")
    point = _blender_vector(query["point"])
    world_matrix = evaluated.matrix_world
    local_point = world_matrix.inverted_safe() @ point
    found, local_position, local_normal, face_index = evaluated.closest_point_on_mesh(local_point)
    if not found:
        return {"kind": "CLOSEST_POINT", "found": False}
    position = world_matrix @ local_position
    normal = world_matrix.to_3x3().inverted_safe().transposed() @ local_normal
    normal.normalize()
    return {
        "kind": "CLOSEST_POINT",
        "found": True,
        "position": _director_list(position),
        "normal": _director_list(normal),
        "distance": float((position - point).length),
        "faceIndex": int(face_index),
    }


def _world_bvh_tree(obj: bpy.types.Object, depsgraph) -> BVHTree:
    if obj.evaluated_get(depsgraph).type != 'MESH':
        raise ValueError(f"OVERLAP requires mesh objects: {blockout.ensure_stable_id(obj)}")
    bm = bmesh.new()
    try:
        bm.from_object(obj, depsgraph)
        bm.transform(obj.matrix_world)
        return BVHTree.FromBMesh(bm)
    finally:
        bm.free()


def _overlap(depsgraph, query: dict[str, Any]) -> dict[str, Any]:
    tree_a = _world_bvh_tree(_resolve_object(query["idA"]), depsgraph)
    tree_b = _world_bvh_tree(_resolve_object(query["idB"]), depsgraph)
    pairs = tree_a.overlap(tree_b)
    return {
        "kind": "OVERLAP",
        "overlapping": bool(pairs),
        "contactPairCount": len(pairs),
    }


def _ground(depsgraph, query: dict[str, Any]) -> dict[str, Any]:
    obj = _resolve_object(query["id"])
    excluded = {obj, *obj.children_recursive}
    excluded |= _resolve_exclusions(query.get("excludeIds"))
    minimum, maximum = _evaluated_world_bounds(obj, depsgraph)
    bottom_center = Vector(((minimum.x + maximum.x) / 2.0, (minimum.y + maximum.y) / 2.0, minimum.z))
    bottom_y = _director_list(bottom_center)[1]
    result: dict[str, Any] = {
        "kind": "GROUND",
        "hit": False,
        "bottomY": float(bottom_y),
    }
    cast = _cast_ray(
        depsgraph,
        bottom_center + Vector((0.0, 0.0, _GROUND_START_EPSILON)),
        Vector((0.0, 0.0, -1.0)),
        _GROUND_MAX_DISTANCE,
        excluded,
    )
    if cast is None:
        return result
    location, _normal, ground_object = cast
    delta = float(location.z - minimum.z)
    current_y = _director_list(obj.matrix_world.translation)[1]
    result["hit"] = True
    result["groundObjectId"] = blockout.ensure_stable_id(ground_object)
    result["suggestedPositionY"] = float(current_y + delta)
    return result


def _name_search(_depsgraph, query: dict[str, Any]) -> dict[str, Any]:
    pattern = str(query["namePattern"]).casefold()
    limit = int(query.get("maxResults", 50))
    matches = []
    for obj in bpy.context.scene.objects:
        name = blockout.object_display_name(obj)
        identifier = blockout.ensure_stable_id(obj)
        director_id = blockout.find_director_id(obj) or ""
        haystack = " ".join((name, obj.name, identifier, director_id)).casefold()
        if pattern not in haystack:
            continue
        transform = blockout.object_world_transform(obj)
        matches.append({
            "id": identifier,
            "name": name,
            "type": obj.type,
            "kind": str(obj.get("worldengine_kind", "camera" if obj.type == 'CAMERA' else "object")),
            "position": transform["position"],
            "dimensions": [
                float(obj.dimensions.x),
                float(obj.dimensions.z),
                float(obj.dimensions.y),
            ],
        })
    truncated = len(matches) > limit
    return {
        "kind": "NAME",
        "namePattern": query["namePattern"],
        "objects": matches[:limit],
        "matched": len(matches),
        "truncated": truncated,
    }


_QUERY_HANDLERS = {
    "RAYCAST": _raycast,
    "CLOSEST_POINT": _closest_point,
    "OVERLAP": _overlap,
    "GROUND": _ground,
    "NAME": _name_search,
}


def query_spatial(operation: dict[str, Any]) -> dict[str, Any]:
    """Answer a batch of read-only spatial queries in Director coordinates."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return {
        "queries": [
            _QUERY_HANDLERS[query["kind"]](depsgraph, query)
            for query in operation["queries"]
        ]
    }


__all__ = ("query_spatial",)
