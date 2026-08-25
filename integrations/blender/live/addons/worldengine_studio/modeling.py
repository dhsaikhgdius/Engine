# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Agent-facing access to Blender's native modeling kernel.

Typed Director operations cover common blocking work. This module also exposes
Blender's operator/RNA long tail and `execute_code` (Python in the live scene).
Only quit/window-close and a few UI categories stay outside invoke_operator.
"""

from __future__ import annotations

from array import array
import base64
from collections import Counter
from contextlib import contextmanager, nullcontext, redirect_stdout
import difflib
import io
import mathutils
import os
import sys
import tempfile
import types
from typing import Any, Iterable, Iterator

import bmesh
import bpy
from mathutils import Vector

from . import blockout, kernel_policy, material_nodes, mixamo_actions, rig, semantic_geometry
from .live_protocol import CONTRACT as LIVE_CONTRACT
from .coordinates import blender_to_director_point


EXECUTE_CODE_MAX_CHARS = 100_000
EXECUTE_CODE_STDOUT_MAX_CHARS = 32_768

INSPECTION_SELECTION_SAMPLE_LIMIT = 64

# Names LLM scripts commonly invent for bmesh.types (canonical names are BM*).
_BMESH_TYPE_ALIASES = {
    "BMeshVert": "BMVert",
    "BMeshEdge": "BMEdge",
    "BMeshFace": "BMFace",
    "BMeshLoop": "BMLoop",
}

# ID collections agents index by name before delete/rebuild.
_SAFE_DATA_COLLECTIONS = frozenset(
    {
        "objects",
        "meshes",
        "cameras",
        "lights",
        "collections",
        "curves",
        "armatures",
        "materials",
        "images",
        "worlds",
    }
)


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    try:
        return [_json_value(item) for item in value]
    except (TypeError, AttributeError):
        return str(value)


def _operator(identifier: str):
    parts = identifier.split(".")
    if len(parts) != 2 or not all(part and part.replace("_", "").isalnum() for part in parts):
        raise ValueError("Blender operator must use category.name format")
    category, name = parts
    namespace = getattr(bpy.ops, category, None)
    operator = getattr(namespace, name, None) if namespace is not None else None
    if operator is None:
        raise ValueError(f"Unknown Blender operator: {identifier}")
    return operator


def _operator_available(operator) -> bool:
    try:
        return bool(operator.poll())
    except RuntimeError:
        return False


def _operator_summary(identifier: str, operator) -> dict[str, Any]:
    rna = operator.get_rna_type()
    return {
        "id": identifier,
        "name": rna.name,
        "description": rna.description or "",
        "category": identifier.split(".", 1)[0],
        "available": _operator_available(operator),
    }


def discover_operators(
    *,
    query: str = "",
    category: str | None = None,
    scope: str = "modeling",
    available_only: bool = False,
    limit: int = 80,
) -> dict[str, Any]:
    """Return a compact, searchable catalog backed by Blender RNA."""
    query = query.strip().lower()
    categories = [category] if category else [name for name in dir(bpy.ops) if not name.startswith("_")]
    if scope == "modeling" and category is None:
        categories = [
            name
            for name in categories
            if name not in kernel_policy.OPERATOR_CATEGORY_DENYLIST
        ]

    category_counts: dict[str, int] = {}
    matches: list[dict[str, Any]] = []
    total = 0
    for category_name in sorted(categories):
        namespace = getattr(bpy.ops, category_name, None)
        if namespace is None:
            continue
        count = 0
        for operator_name in sorted(name for name in dir(namespace) if not name.startswith("_")):
            operator = getattr(namespace, operator_name, None)
            if operator is None or not hasattr(operator, "get_rna_type"):
                continue
            identifier = f"{category_name}.{operator_name}"
            if not kernel_policy.is_allowed_operator(identifier):
                continue
            summary = _operator_summary(identifier, operator)
            searchable = f"{identifier} {summary['name']} {summary['description']}".lower()
            if query and query not in searchable:
                continue
            if available_only and not summary["available"]:
                continue
            total += 1
            count += 1
            if len(matches) < limit:
                matches.append(summary)
        if count:
            category_counts[category_name] = count
    return {
        "scope": scope,
        "query": query,
        "category": category,
        "total": total,
        "returned": len(matches),
        "categories": category_counts,
        "operators": matches,
    }


def _property_description(prop) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": prop.identifier,
        "name": prop.name,
        "description": prop.description or "",
        "type": prop.type,
        "required": bool(getattr(prop, "is_required", False)),
        "readOnly": bool(getattr(prop, "is_readonly", False)),
    }
    if hasattr(prop, "default"):
        result["default"] = _json_value(prop.default)
    if getattr(prop, "is_array", False):
        result["arrayLength"] = int(prop.array_length)
        result["default"] = _json_value(prop.default_array)
    if prop.type in {"INT", "FLOAT"}:
        result.update(
            {
                "min": _json_value(prop.hard_min),
                "max": _json_value(prop.hard_max),
                "softMin": _json_value(prop.soft_min),
                "softMax": _json_value(prop.soft_max),
            }
        )
    if prop.type == "ENUM":
        result["enumItems"] = [
            {
                "id": item.identifier,
                "name": item.name,
                "description": item.description or "",
            }
            for item in prop.enum_items
        ]
    return result


def describe_operator(identifier: str) -> dict[str, Any]:
    kernel_policy.assert_kernel_policy({"op": "describe_operator", "operator": identifier})
    operator = _operator(identifier)
    result = _operator_summary(identifier, operator)
    result["properties"] = [
        _property_description(prop)
        for prop in operator.get_rna_type().properties
        if prop.identifier != "rna_type"
    ]
    return result


def _object(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    return obj


def _rna_properties(value: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    rna = getattr(value, "bl_rna", None)
    if rna is None:
        return result
    for prop in rna.properties:
        if prop.identifier == "rna_type" or prop.is_readonly or prop.is_hidden:
            continue
        if prop.type in {"POINTER", "COLLECTION"}:
            continue
        try:
            result[prop.identifier] = _json_value(getattr(value, prop.identifier))
        except (AttributeError, TypeError, ValueError):
            continue
    return result


def _director_point(value: Any) -> list[float]:
    return list(blender_to_director_point(tuple(float(component) for component in value)))


def _evaluated_bounds(obj: bpy.types.Object) -> dict[str, list[float]]:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    corners = [_director_point(evaluated.matrix_world @ Vector(corner)) for corner in evaluated.bound_box]
    if not corners:
        corners = [_director_point(evaluated.matrix_world.translation)]
    minimum = [min(point[index] for point in corners) for index in range(3)]
    maximum = [max(point[index] for point in corners) for index in range(3)]
    return {
        "min": minimum,
        "max": maximum,
        "center": [(minimum[index] + maximum[index]) / 2.0 for index in range(3)],
        "size": [maximum[index] - minimum[index] for index in range(3)],
    }


def _selection_flags(elements) -> array:
    flags = array("b", [0]) * len(elements)
    elements.foreach_get("select", flags)
    return flags


def _evaluated_mesh_metrics(obj: bpy.types.Object) -> dict[str, Any]:
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        edge_count = len(mesh.edges)
        loop_edge_indices = array("i", [0]) * len(mesh.loops)
        mesh.loops.foreach_get("edge_index", loop_edge_indices)
        # Face users per edge: 1 face is a boundary edge, exactly 2 is manifold,
        # so wire edges (0 users) count as non-manifold like bmesh reports.
        edge_face_users = Counter(loop_edge_indices)
        boundary_edges = sum(1 for users in edge_face_users.values() if users == 1)
        non_manifold_edges = edge_count - sum(
            1 for users in edge_face_users.values() if users == 2
        )
        edge_vertex_indices = array("i", [0]) * (edge_count * 2)
        mesh.edges.foreach_get("vertices", edge_vertex_indices)
        loose_vertices = len(mesh.vertices) - len(set(edge_vertex_indices))
        source_mesh = obj.data

        def selection_summary(elements) -> dict[str, Any]:
            flags = _selection_flags(elements)
            count = int(sum(flags))
            limit = min(count, INSPECTION_SELECTION_SAMPLE_LIMIT)
            sample: list[int] = []
            for index, flag in enumerate(flags):
                if len(sample) == limit:
                    break
                if flag:
                    sample.append(index)
            return {"count": count, "sample": sample}

        return {
            "vertices": len(mesh.vertices),
            "edges": len(mesh.edges),
            "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles),
            "looseVertices": loose_vertices,
            "boundaryEdges": boundary_edges,
            "nonManifoldEdges": non_manifold_edges,
            "materialSlots": len(obj.material_slots),
            "selection": {
                "vertices": selection_summary(source_mesh.vertices),
                "edges": selection_summary(source_mesh.edges),
                "faces": selection_summary(source_mesh.polygons),
            },
            "uvLayers": [layer.name for layer in source_mesh.uv_layers],
            "uvLayerDetails": _uv_layer_details(source_mesh),
            "colorAttributes": [attribute.name for attribute in source_mesh.color_attributes],
            "shapeKeys": [key.name for key in source_mesh.shape_keys.key_blocks] if source_mesh.shape_keys else [],
        }
    finally:
        evaluated.to_mesh_clear()


def _principled_node(material: bpy.types.Material):
    tree = material.node_tree if material.use_nodes else None
    if tree is None:
        return None
    return next((node for node in tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)


def _principled_values(material: bpy.types.Material) -> dict[str, Any] | None:
    principled = _principled_node(material)
    if principled is None:
        return None
    base_color = principled.inputs["Base Color"].default_value
    return {
        "baseColor": [float(base_color[0]), float(base_color[1]), float(base_color[2])],
        "roughness": float(principled.inputs["Roughness"].default_value),
        "metallic": float(principled.inputs["Metallic"].default_value),
        "alpha": float(principled.inputs["Alpha"].default_value),
    }


def _uv_layer_details(mesh: bpy.types.Mesh) -> list[dict[str, Any]]:
    active = mesh.uv_layers.active
    details = []
    for layer in mesh.uv_layers:
        loop_count = len(layer.data)
        minimum = [0.0, 0.0]
        maximum = [0.0, 0.0]
        if loop_count:
            coordinates = array("f", [0.0]) * (loop_count * 2)
            layer.data.foreach_get("uv", coordinates)
            for axis in range(2):
                axis_coordinates = coordinates[axis::2]
                minimum[axis] = min(axis_coordinates)
                maximum[axis] = max(axis_coordinates)
        details.append({
            "name": layer.name,
            "active": layer == active,
            "activeRender": bool(layer.active_render),
            "loopCount": loop_count,
            "coordinateBounds": {"min": minimum, "max": maximum},
        })
    return details


def _material_node_summaries(obj: bpy.types.Object) -> list[dict[str, Any]]:
    summaries = []
    seen = set()
    for slot in obj.material_slots:
        material = slot.material
        if material is None or material.name in seen:
            continue
        seen.add(material.name)
        tree = material.node_tree if material.use_nodes else None
        node_types: dict[str, int] = {}
        if tree is not None:
            for node in tree.nodes:
                node_type = str(node.type)
                node_types[node_type] = node_types.get(node_type, 0) + 1
        summaries.append({
            "material": material.name,
            "useNodes": bool(material.use_nodes),
            "nodeCount": len(tree.nodes) if tree is not None else 0,
            "linkCount": len(tree.links) if tree is not None else 0,
            "nodeTypes": node_types,
            "principled": _principled_values(material),
        })
    return summaries


def _material_slot_summaries(obj: bpy.types.Object) -> list[dict[str, Any]]:
    data_materials = (
        obj.data.materials
        if obj.data is not None and hasattr(obj.data, "materials")
        else ()
    )
    summaries = []
    for index, slot in enumerate(obj.material_slots):
        resolved = slot.material
        data_material = data_materials[index] if index < len(data_materials) else None
        summaries.append({
            "index": index,
            "name": slot.name,
            "link": slot.link,
            "resolvedMaterial": resolved.name if resolved is not None else None,
            "dataMaterial": data_material.name if data_material is not None else None,
        })
    return summaries


def _animation_summary(obj: bpy.types.Object) -> dict[str, Any]:
    return rig.inspect_animation(obj)


def inspect_object(identifier: str) -> dict[str, Any]:
    obj = _object(identifier)
    if obj.mode == 'EDIT' and obj.type == 'MESH':
        obj.update_from_editmode()
    active = bpy.context.view_layer.objects.active
    warnings = []
    result: dict[str, Any] = {
        "id": blockout.ensure_stable_id(obj),
        "name": blockout.object_display_name(obj),
        "type": obj.type,
        "mode": obj.mode,
        "dimensions": [float(obj.dimensions.x), float(obj.dimensions.z), float(obj.dimensions.y)],
        "position": _director_point(obj.matrix_world.translation),
        "evaluatedBounds": _evaluated_bounds(obj),
        "selection": {"selected": bool(obj.select_get()), "active": active == obj},
        "modifiers": [
            {"name": modifier.name, "type": modifier.type, "properties": _rna_properties(modifier)}
            for modifier in obj.modifiers
        ],
        "constraints": [
            {"name": constraint.name, "type": constraint.type, "properties": _rna_properties(constraint)}
            for constraint in obj.constraints
        ],
        "materials": [material.name if material is not None else None for material in obj.data.materials]
        if obj.data is not None and hasattr(obj.data, "materials")
        else [],
        "sceneMaterials": blockout.list_scene_material_names(),
        "materialNodes": _material_node_summaries(obj),
        "materialSlots": _material_slot_summaries(obj),
        "materialGraphs": material_nodes.inspect_object_material_graphs(obj),
        "geometryGraphs": semantic_geometry.inspect_object_geometry_graphs(obj),
        "animation": _animation_summary(obj),
        "warnings": warnings,
    }
    if obj.type == 'MESH':
        result["mesh"] = _evaluated_mesh_metrics(obj)
        if result["mesh"]["nonManifoldEdges"]:
            warnings.append(f"Mesh has {result['mesh']['nonManifoldEdges']} non-manifold edges")
        if result["mesh"]["faces"] == 0:
            warnings.append("Mesh has no evaluated faces")
    if obj.type == 'CURVE':
        result["curve"] = semantic_geometry.inspect_curve(obj)
    if obj.type == 'FONT':
        result["text"] = semantic_geometry.inspect_text(obj)
    if obj.type == 'ARMATURE':
        pose_bones = list(obj.pose.bones)
        bones = list(obj.data.edit_bones) if obj.mode == 'EDIT' else list(obj.data.bones)
        result["armature"] = {
            "bones": [bone.name for bone in bones],
            "poseBones": [bone.name for bone in pose_bones],
        }
        result["rig"] = {
            **rig.inspect_rig(obj),
            "mixamoCompatibility": mixamo_actions.inspect_compatibility(obj),
        }
        result["animation"]["nlaTracks"] = mixamo_actions.inspect_nla(obj)
    return result


def capture_render(operation: dict[str, Any]) -> dict[str, Any]:
    """Render a clean Agent-visible frame through Blender's active camera."""
    scene = bpy.context.scene
    camera_id = operation.get("cameraId")
    camera = _object(camera_id) if camera_id else scene.camera
    if camera is None or camera.type != 'CAMERA':
        raise ValueError("A Blender camera is required for capture")
    width = int(operation.get("width", 640))
    height = int(operation.get("height", 360))
    render = scene.render
    previous = {
        "camera": scene.camera,
        "filepath": render.filepath,
        "format": render.image_settings.file_format,
        "width": render.resolution_x,
        "height": render.resolution_y,
        "percentage": render.resolution_percentage,
        "transparent": render.film_transparent,
    }
    descriptor, path = tempfile.mkstemp(prefix="worldengine-capture-", suffix=".png")
    os.close(descriptor)
    try:
        scene.camera = camera
        render.filepath = path
        render.image_settings.file_format = 'PNG'
        render.resolution_x = width
        render.resolution_y = height
        render.resolution_percentage = 100
        render.film_transparent = bool(operation.get("transparent", False))
        bpy.ops.render.render(write_still=True)
        with open(path, "rb") as image_file:
            data = base64.b64encode(image_file.read()).decode("ascii")
        return {
            "mimeType": "image/png",
            "dataBase64": data,
            "width": width,
            "height": height,
            "cameraId": blockout.ensure_stable_id(camera),
        }
    finally:
        scene.camera = previous["camera"]
        render.filepath = previous["filepath"]
        render.image_settings.file_format = previous["format"]
        render.resolution_x = previous["width"]
        render.resolution_y = previous["height"]
        render.resolution_percentage = previous["percentage"]
        render.film_transparent = previous["transparent"]
        if os.path.exists(path):
            os.unlink(path)


def export_scene_preview() -> dict[str, Any]:
    """Export the active Blender scene as a self-contained GLB preview."""
    from .native_session import scene_epoch_value

    scene = bpy.context.scene
    character_rig_states = {}
    for obj in scene.objects:
        identifier = obj.get(blockout.ID_PROPERTY)
        state_token = obj.get(rig.DIRECTOR_CHARACTER_STATE_PROPERTY) if obj.type == 'ARMATURE' else None
        if not identifier or not isinstance(state_token, str):
            continue
        character_rig_states[str(identifier)] = {
            "stateToken": state_token,
            "pose": {bone.name: bone.matrix_basis.copy() for bone in obj.pose.bones},
        }
    for obj in scene.objects:
        if obj.type == 'MESH' and obj.mode == 'EDIT':
            obj.update_from_editmode()

    descriptor, path = tempfile.mkstemp(prefix="worldengine-preview-", suffix=".glb")
    os.close(descriptor)
    try:
        outcome = bpy.ops.export_scene.gltf(
            filepath=path,
            export_format='GLB',
            use_active_scene=True,
            use_visible=True,
            export_cameras=False,
            export_lights=False,
            export_apply=True,
            export_skins=False,
            export_materials='EXPORT',
            export_animations=False,
            export_extras=True,
            export_hierarchy_flatten_objs=False,
        )
        if 'FINISHED' not in outcome:
            raise RuntimeError("Blender could not export the active scene preview")
        with open(path, "rb") as preview_file:
            data = preview_file.read()
        return {
            "contract": LIVE_CONTRACT,
            "sceneEpoch": scene_epoch_value(),
            "revision": int(scene.worldengine_studio.scene_revision),
            "mimeType": "model/gltf-binary",
            "dataBase64": base64.b64encode(data).decode("ascii"),
            "byteLength": len(data),
        }
    finally:
        for identifier, state in character_rig_states.items():
            obj = blockout.find_object(identifier)
            if obj is None or obj.type != 'ARMATURE':
                continue
            if obj.get(rig.DIRECTOR_CHARACTER_STATE_PROPERTY) != state["stateToken"]:
                obj[rig.DIRECTOR_CHARACTER_STATE_PROPERTY] = state["stateToken"]
                obj.update_tag()
            for bone_ref, matrix_basis in state["pose"].items():
                pose_bone = obj.pose.bones.get(bone_ref)
                if pose_bone is not None and pose_bone.matrix_basis != matrix_basis:
                    pose_bone.matrix_basis = matrix_basis
        if character_rig_states:
            bpy.context.view_layer.update()
        if os.path.exists(path):
            os.unlink(path)


def _set_object_selection(selected_ids: Iterable[str], active_id: str | None, mode: str) -> None:
    active = _object(active_id) if active_id else None
    current_active = bpy.context.view_layer.objects.active
    if current_active is not None and current_active.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    selected = [_object(identifier) for identifier in selected_ids]
    if active is not None and active not in selected:
        selected.append(active)
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active or (selected[0] if selected else None)
    if mode != 'OBJECT':
        if bpy.context.view_layer.objects.active is None:
            raise ValueError(f"Blender mode {mode} requires an active object")
        bpy.ops.object.mode_set(mode=mode)


def _selection_state() -> dict[str, Any]:
    active = bpy.context.view_layer.objects.active
    return {
        "activeObjectId": blockout.ensure_stable_id(active) if active is not None else None,
        "selectedObjectIds": sorted(
            blockout.ensure_stable_id(obj) for obj in bpy.context.selected_objects
        ),
        "mode": active.mode if active is not None else "OBJECT",
    }


def set_selection(operation: dict[str, Any]) -> dict[str, Any]:
    selected_ids = operation.get("selectedIds", [])
    active_id = operation.get("activeId")
    mode = operation.get("mode", "OBJECT")
    _set_object_selection(selected_ids, active_id, mode)
    return _selection_state()


def select_mesh_elements(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    if obj.type != 'MESH':
        raise ValueError(f"WorldEngine object is not a mesh: {operation['id']}")
    _set_object_selection([operation["id"]], operation["id"], "OBJECT")
    mesh = obj.data
    domain = operation.get("domain", "FACE")
    action = operation.get("action", "SET")
    indices = set(operation.get("indices", []))
    elements = {"VERTEX": mesh.vertices, "EDGE": mesh.edges, "FACE": mesh.polygons}[domain]
    total = len(elements)
    if action == "SET":
        for collection in (mesh.vertices, mesh.edges, mesh.polygons):
            collection.foreach_set("select", array("b", [0]) * len(collection))
    if action in {"ALL", "NONE"}:
        flags = array("b", [1 if action == "ALL" else 0]) * total
    elif action == "INVERT":
        flags = array("b", [0 if flag else 1 for flag in _selection_flags(elements)])
    else:
        flags = array("b", [0]) * total
        if action != "SET":
            elements.foreach_get("select", flags)
        selected = 1 if action in {"SET", "ADD"} else 0
        for index in indices:
            if 0 <= index < total:
                flags[index] = selected
    elements.foreach_set("select", flags)
    mesh.update()
    bpy.ops.object.mode_set(mode='EDIT')
    # Blender's select_mode enum uses VERT while the Director protocol uses VERTEX.
    bpy.ops.mesh.select_mode(type='VERT' if domain == "VERTEX" else domain)
    return {
        "objectId": operation["id"],
        "domain": domain,
        "action": action,
        "indices": sorted(indices),
        **_selection_state(),
    }


def _ensure_principled_material(material: bpy.types.Material):
    material.use_nodes = True
    tree = material.node_tree
    principled = _principled_node(material)
    if principled is None:
        principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    output = next((node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL'), None)
    if output is None:
        output = tree.nodes.new("ShaderNodeOutputMaterial")
    surface = output.inputs["Surface"]
    if not surface.is_linked or surface.links[0].from_node != principled:
        for link in tuple(surface.links):
            tree.links.remove(link)
        tree.links.new(principled.outputs["BSDF"], surface)
    material_nodes.ensure_default_node_refs(material, principled, output)
    return principled


_MATERIAL_NAME_HINTS: tuple[tuple[tuple[str, ...], dict[str, Any]], ...] = (
    (("gold", "gild", "gilt", "brass", "plaque"), {"baseColor": (0.83, 0.68, 0.21), "metallic": 0.9, "roughness": 0.25}),
    (("copper", "bronze"), {"baseColor": (0.72, 0.45, 0.2), "metallic": 0.85, "roughness": 0.35}),
    (("iron", "steel", "metal"), {"baseColor": (0.43, 0.45, 0.47), "metallic": 0.8, "roughness": 0.4}),
    (("leaf", "foliage", "canopy", "grass", "moss"), {"baseColor": (0.2, 0.42, 0.16), "roughness": 0.7}),
    (("bark", "trunk", "wood", "timber"), {"baseColor": (0.36, 0.22, 0.12), "roughness": 0.85}),
    (("brick", "cinnabar", "vermilion"), {"baseColor": (0.55, 0.18, 0.14), "roughness": 0.78}),
    (("roof", "tile", "slate"), {"baseColor": (0.18, 0.16, 0.16), "roughness": 0.72}),
    (("stone", "marble", "granite", "concrete"), {"baseColor": (0.72, 0.7, 0.66), "roughness": 0.8}),
    (("water", "river", "pond"), {"baseColor": (0.15, 0.32, 0.45), "roughness": 0.12}),
    (("glass",), {"baseColor": (0.85, 0.9, 0.92), "roughness": 0.08, "alpha": 0.35}),
    (("snow", "white"), {"baseColor": (0.86, 0.86, 0.84), "roughness": 0.55}),
)


def _material_hint_parameters(name: str) -> dict[str, Any]:
    key = name.casefold()
    for tokens, parameters in _MATERIAL_NAME_HINTS:
        if any(token in key for token in tokens):
            return dict(parameters)
    return {"baseColor": (0.55, 0.55, 0.52), "roughness": 0.7, "metallic": 0.0}


def assign_material(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    if obj.data is None or not hasattr(obj.data, "materials"):
        raise ValueError(f"WorldEngine object cannot receive materials: {operation['id']}")

    material_name = operation["materialName"]
    material, resolved_kind = blockout.resolve_material(material_name)
    created = material is None
    if material is None:
        if not operation.get("createIfMissing", True):
            warning = (
                f"{blockout.unknown_material_message(material_name)} "
                "This object was skipped; other operations in the batch still applied."
            )
            return {
                "objectId": operation["id"],
                "skipped": True,
                "reason": "unknown_material",
                "requestedMaterial": material_name,
                "nearbyMaterials": blockout.nearby_material_names(material_name),
                "sceneMaterials": blockout.list_scene_material_names(),
                "warning": warning,
                **_selection_state(),
            }
        material = bpy.data.materials.new(material_name)

    parameters = dict(operation.get("parameters") or {})
    if created:
        for field, value in _material_hint_parameters(material_name).items():
            parameters.setdefault(field, value)
    if created or (parameters and not material.use_nodes):
        principled = _ensure_principled_material(material)
    elif material.use_nodes:
        principled = _principled_node(material)
        if parameters and principled is None:
            raise ValueError(
                f"Blender material has no Principled BSDF node: {material_name}"
            )
    else:
        principled = None
    if "baseColor" in parameters:
        red, green, blue = parameters["baseColor"]
        current = principled.inputs["Base Color"].default_value
        principled.inputs["Base Color"].default_value = (red, green, blue, current[3])
    for field, input_name in (
        ("roughness", "Roughness"),
        ("metallic", "Metallic"),
        ("alpha", "Alpha"),
    ):
        if field in parameters:
            principled.inputs[input_name].default_value = parameters[field]

    values = _principled_values(material)
    if values is not None and (created or parameters):
        material.diffuse_color = (*values["baseColor"], values["alpha"])
    materials = obj.data.materials
    slot_index = next(
        (index for index, candidate in enumerate(materials) if candidate == material),
        -1,
    )
    slot_created = slot_index < 0
    if slot_index < 0:
        materials.append(material)
        slot_index = len(materials) - 1
    obj.active_material_index = slot_index
    face_scope = operation.get("faceScope", "ALL")
    assigned_face_indices = []
    can_paint_faces = obj.type == "MESH" and obj.data is not None
    if can_paint_faces and face_scope == "ALL":
        if obj.mode == 'EDIT':
            edit_mesh = bmesh.from_edit_mesh(obj.data)
            assigned_face_indices = sorted(face.index for face in edit_mesh.faces)
            for face in edit_mesh.faces:
                face.material_index = slot_index
            bmesh.update_edit_mesh(obj.data, loop_triangles=False, destructive=False)
        else:
            polygons = obj.data.polygons
            assigned_face_indices = list(range(len(polygons)))
            polygons.foreach_set("material_index", array("i", [slot_index]) * len(polygons))
    elif can_paint_faces and face_scope == "SELECTED":
        if obj.mode == 'EDIT':
            edit_mesh = bmesh.from_edit_mesh(obj.data)
            assigned_face_indices = sorted(
                face.index for face in edit_mesh.faces if face.select
            )
            for face in edit_mesh.faces:
                if face.select:
                    face.material_index = slot_index
            bmesh.update_edit_mesh(obj.data, loop_triangles=False, destructive=False)
        else:
            polygons = obj.data.polygons
            material_indices = array("i", [0]) * len(polygons)
            polygons.foreach_get("material_index", material_indices)
            assigned_face_indices = [
                index for index, flag in enumerate(_selection_flags(polygons)) if flag
            ]
            for index in assigned_face_indices:
                material_indices[index] = slot_index
            polygons.foreach_set("material_index", material_indices)
    if hasattr(obj.data, "update"):
        obj.data.update()

    graph = material_nodes.inspect_material_graph(material)
    affected_object_ids = {operation["id"]}
    if created or parameters:
        affected_object_ids.update(graph["objectIds"])
    if slot_created or face_scope != "PRESERVE":
        affected_object_ids.update(
            blockout.ensure_stable_id(candidate)
            for candidate in bpy.data.objects
            if candidate.data == obj.data
        )
    affected_object_ids = sorted(affected_object_ids)
    result = {
        "objectId": operation["id"],
        "affectedObjectIds": affected_object_ids,
        "dirtyObjectIds": affected_object_ids,
        "material": {
            "name": material.name,
            "created": created,
            "slotIndex": slot_index,
            "principled": values,
        },
        "faceScope": face_scope,
        "assignedFaceIndices": assigned_face_indices,
        **_selection_state(),
    }
    if values is not None:
        result["material"].update(values)
    result["material"]["requestedName"] = material_name
    if resolved_kind and resolved_kind != "exact":
        result["material"]["resolvedFrom"] = material_name
        result["material"]["resolvedKind"] = resolved_kind
    return result


def project_uv(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    if obj.type != 'MESH':
        raise ValueError(f"WorldEngine object is not a mesh: {operation['id']}")

    method = operation.get("method", "SMART")
    layer_name = operation.get("uvLayerName", "UVMap")
    replace_existing = operation.get("replaceExisting", False)
    mesh = obj.data
    existing_layer = mesh.uv_layers.get(layer_name)
    if existing_layer is not None and not replace_existing:
        raise ValueError(f"UV layer already exists: {layer_name}")

    active_before = bpy.context.view_layer.objects.active
    selected_before = [blockout.ensure_stable_id(item) for item in bpy.context.selected_objects]
    active_id_before = (
        blockout.ensure_stable_id(active_before) if active_before is not None else None
    )
    mode_before = active_before.mode if active_before is not None else "OBJECT"
    if obj.mode == 'EDIT':
        obj.update_from_editmode()
    selected_elements = {
        "vertices": _selection_flags(obj.data.vertices),
        "edges": _selection_flags(obj.data.edges),
        "faces": _selection_flags(obj.data.polygons),
    }

    try:
        _set_object_selection([operation["id"]], operation["id"], "OBJECT")
        layer = existing_layer or mesh.uv_layers.new(
            name=layer_name,
            do_init=False,
        )
        mesh.uv_layers.active = layer
        layer.active_render = True
        layer.data.foreach_set("uv", array("f", [0.0]) * (len(layer.data) * 2))
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_mode(type='FACE')
        bpy.ops.mesh.select_all(action='SELECT')
        operator = {
            "SMART": bpy.ops.uv.smart_project,
            "UNWRAP": bpy.ops.uv.unwrap,
            "CUBE": bpy.ops.uv.cube_project,
        }[method]
        with _context_override():
            if not operator.poll():
                raise ValueError(f"Blender UV projection is unavailable: {method}")
            outcome = operator('EXEC_DEFAULT', False)
        if 'FINISHED' not in outcome:
            raise RuntimeError(f"Blender UV projection did not finish: {method}")
        bpy.ops.object.mode_set(mode='OBJECT')
        mesh.update()
        details = next(item for item in _uv_layer_details(mesh) if item["active"])
        bounds = details["coordinateBounds"]
        if details["loopCount"] and all(
            bounds["max"][axis] - bounds["min"][axis] <= 1e-6
            for axis in range(2)
        ):
            raise ValueError(
                f"Blender UV projection produced no usable coordinates: {method}"
            )
    finally:
        if obj.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        obj.data.vertices.foreach_set("select", selected_elements["vertices"])
        obj.data.edges.foreach_set("select", selected_elements["edges"])
        obj.data.polygons.foreach_set("select", selected_elements["faces"])
        obj.data.update()
        _set_object_selection(selected_before, active_id_before, mode_before)

    return {
        "objectId": operation["id"],
        "method": method,
        "outcome": sorted(outcome),
        "replaceExisting": replace_existing,
        "replaced": existing_layer is not None,
        "uvLayer": details,
        **_selection_state(),
    }


def _context_override():
    window = bpy.context.window
    screen = window.screen if window is not None else None
    if screen is None:
        return nullcontext()
    area = next((item for item in screen.areas if item.type == 'VIEW_3D'), None)
    region = next((item for item in area.regions if item.type == 'WINDOW'), None) if area else None
    if area is None or region is None:
        return nullcontext()
    return bpy.context.temp_override(window=window, screen=screen, area=area, region=region)


def operator_context():
    """Return the best native VIEW_3D context available to background work."""
    return _context_override()


def _ensure_object_mode() -> None:
    active = bpy.context.view_layer.objects.active
    if active is None or active.mode == "OBJECT":
        return
    if bpy.ops.object.mode_set.poll():
        bpy.ops.object.mode_set(mode="OBJECT")


def invoke_operator(operation: dict[str, Any]) -> dict[str, Any]:
    kernel_policy.assert_kernel_policy(operation)
    context = operation.get("context") or {}
    if context:
        _set_object_selection(
            context.get("selectedIds", []),
            context.get("activeId"),
            context.get("mode", "OBJECT"),
        )
    operator = _operator(operation["operator"])
    properties = operation.get("properties") or {}
    before = {obj.session_uid for obj in bpy.data.objects}
    with _context_override():
        if not _operator_available(operator):
            raise ValueError(f"Blender operator is unavailable in the current context: {operation['operator']}")
        # The surrounding WorldEngine batch owns the undo boundary.  Suppress
        # per-operator entries so one Agent intent remains one Blender undo.
        outcome = operator('EXEC_DEFAULT', False, **properties)
    if 'FINISHED' not in outcome:
        raise RuntimeError(
            f"Blender operator did not finish: {operation['operator']} "
            f"({', '.join(sorted(outcome))})"
        )
    created = []
    for obj in bpy.data.objects:
        if obj.session_uid not in before:
            created.append(blockout.ensure_stable_id(obj))
    return {
        "operator": operation["operator"],
        "outcome": sorted(outcome),
        "createdObjectIds": created,
        **_selection_state(),
    }


def _target(operation: dict[str, Any]) -> Any:
    target = operation["target"]
    kind = target["kind"]
    if kind == "object":
        return _object(target["objectId"])
    if kind == "object_data":
        obj = _object(target["objectId"])
        if obj.data is None:
            raise ValueError(f"WorldEngine object has no data: {target['objectId']}")
        return obj.data
    if kind in {"modifier", "constraint"}:
        obj = _object(target["objectId"])
        collection = obj.modifiers if kind == "modifier" else obj.constraints
        value = collection.get(target["name"])
        if value is None:
            raise ValueError(f"Unknown Blender {kind}: {target['name']}")
        return value
    if kind == "material":
        material, _kind = blockout.resolve_material(target["name"])
        if material is None:
            raise ValueError(blockout.unknown_material_message(target["name"]))
        return material
    if kind == "collection":
        collection = bpy.data.collections.get(target["name"])
        if collection is None:
            raise ValueError(f"Unknown Blender collection: {target['name']}")
        return collection
    if kind == "scene":
        return bpy.context.scene
    if kind == "world":
        world = bpy.context.scene.world
        if world is None:
            raise ValueError("Scene has no world")
        return world
    raise ValueError(f"Unsupported Blender RNA target: {kind}")


def _step(value: Any, segment: str | int) -> Any:
    if isinstance(segment, int):
        return value[segment]
    if hasattr(value, segment):
        return getattr(value, segment)
    return value[segment]


def set_rna_property(operation: dict[str, Any]) -> dict[str, Any]:
    kernel_policy.assert_kernel_policy(operation)
    value = _target(operation)
    path = operation["path"]
    for segment in path[:-1]:
        value = _step(value, segment)
    final = path[-1]
    if isinstance(final, int):
        value[final] = operation["value"]
    elif hasattr(value, final):
        setattr(value, final, operation["value"])
    else:
        value[final] = operation["value"]
    return {"target": operation["target"], "path": path, "value": _json_value(_step(value, final))}


def _install_bmesh_aliases() -> None:
    types_mod = bmesh.types
    for alias, canonical in _BMESH_TYPE_ALIASES.items():
        if hasattr(types_mod, canonical) and not hasattr(types_mod, alias):
            setattr(types_mod, alias, getattr(types_mod, canonical))


class _IdCollectionProxy:
    """ID collection that treats a missing name as None instead of KeyError.

    Agent scripts commonly write ``bpy.data.objects.remove(bpy.data.objects["x"])``
    as a prelude to rebuilding geometry. A missing key should not abort the rest
    of the script.
    """

    __slots__ = ("_inner",)

    def __init__(self, inner: Any) -> None:
        object.__setattr__(self, "_inner", inner)

    def _inner_collection(self) -> Any:
        return object.__getattribute__(self, "_inner")

    def __getitem__(self, key: Any) -> Any:
        inner = self._inner_collection()
        try:
            return inner[key]
        except KeyError:
            if isinstance(key, str):
                return None
            raise

    def get(self, key: Any, default: Any = None) -> Any:
        return self._inner_collection().get(key, default)

    def remove(self, obj: Any, *args: Any, **kwargs: Any) -> Any:
        if obj is None:
            return None
        return self._inner_collection().remove(obj, *args, **kwargs)

    def __contains__(self, key: Any) -> bool:
        return key in self._inner_collection()

    def __iter__(self) -> Iterator[Any]:
        return iter(self._inner_collection())

    def __len__(self) -> int:
        return len(self._inner_collection())

    def __bool__(self) -> bool:
        return bool(self._inner_collection())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner_collection(), name)


class _BlendDataProxy:
    __slots__ = ("_inner", "_cache")

    def __init__(self, inner: Any) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_cache", {})

    def __getattr__(self, name: str) -> Any:
        inner = object.__getattribute__(self, "_inner")
        value = getattr(inner, name)
        if name not in _SAFE_DATA_COLLECTIONS:
            return value
        cache: dict[str, _IdCollectionProxy] = object.__getattribute__(self, "_cache")
        proxied = cache.get(name)
        if proxied is None:
            proxied = _IdCollectionProxy(value)
            cache[name] = proxied
        return proxied


class _BpyModule(types.ModuleType):
    """Transparent bpy wrapper so ``import bpy`` inside execute_code keeps shims."""

    def __init__(self, real: Any) -> None:
        super().__init__("bpy")
        self.__dict__["_real"] = real
        self.__dict__["data"] = _BlendDataProxy(real.data)
        for copied in ("__file__", "__spec__", "__loader__", "__package__", "__path__", "__doc__"):
            if hasattr(real, copied):
                self.__dict__[copied] = getattr(real, copied)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.__dict__["_real"], name)


def _nearby_object_names(key: str, limit: int = 8) -> list[str]:
    names = [obj.name for obj in bpy.data.objects]
    close = difflib.get_close_matches(key, names, n=limit, cutoff=0.4)
    return close or names[:limit]


def _execute_code_failure(error: BaseException) -> str:
    name = type(error).__name__
    message = str(error)
    hints: list[str] = []
    if name == "StopIteration":
        hints.append(
            "next() was empty. execute_code starts in OBJECT mode so mesh.primitive_*_add creates a new object; enter EDIT mode only when editing an existing mesh."
        )
    if name == "KeyError" and "bpy_prop_collection" in message:
        marker = 'key "'
        start = message.find(marker)
        key = ""
        if start >= 0:
            start += len(marker)
            end = message.find('"', start)
            if end > start:
                key = message[start:end]
        nearby = _nearby_object_names(key) if key else [obj.name for obj in bpy.data.objects][:8]
        target = f' "{key}"' if key else ""
        hints.append(
            f"Object{target} is not in the scene. Use bpy.data.objects.get(name) before remove. "
            f"Present: {', '.join(nearby) if nearby else '(none)'}."
        )
    suffix = f" Hint: {' '.join(hints)}" if hints else ""
    return f"Blender execute_code failed: {name}: {error}{suffix}"


@contextmanager
def _execute_code_environment() -> Iterator[Any]:
    _install_bmesh_aliases()
    previous = sys.modules.get("bpy", bpy)
    proxy = _BpyModule(bpy)
    sys.modules["bpy"] = proxy
    try:
        yield proxy
    finally:
        sys.modules["bpy"] = previous


def execute_code(operation: dict[str, Any]) -> dict[str, Any]:
    """Run Python in the live Blender scene (blender-mcp execute_blender_code analogue)."""
    code = operation.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("execute_code.code must be a non-empty string")
    if len(code) > EXECUTE_CODE_MAX_CHARS:
        raise ValueError(
            f"execute_code.code must be at most {EXECUTE_CODE_MAX_CHARS} characters"
        )
    before = {obj.session_uid for obj in bpy.data.objects}
    stdout_buffer = io.StringIO()
    with _execute_code_environment() as bpy_proxy:
        namespace: dict[str, Any] = {
            "bpy": bpy_proxy,
            "bmesh": bmesh,
            "mathutils": mathutils,
            "Vector": Vector,
        }
        try:
            compiled = compile(code, "<blender_native.execute_code>", "exec")
            with _context_override(), redirect_stdout(stdout_buffer):
                _ensure_object_mode()
                exec(compiled, namespace, namespace)
        except Exception as error:
            raise ValueError(_execute_code_failure(error)) from error
        result = namespace.get("result")
    created = []
    for obj in bpy.data.objects:
        if obj.session_uid not in before:
            created.append(blockout.ensure_stable_id(obj))
    stdout = stdout_buffer.getvalue()
    truncated = False
    if len(stdout) > EXECUTE_CODE_STDOUT_MAX_CHARS:
        stdout = stdout[-EXECUTE_CODE_STDOUT_MAX_CHARS:]
        truncated = True
    return {
        "stdout": stdout,
        "stdoutTruncated": truncated,
        "result": None if result is None else _json_value(result),
        "createdObjectIds": created,
        **_selection_state(),
    }


def undo_scene() -> dict[str, Any]:
    with operator_context():
        if not bpy.ops.ed.undo.poll():
            raise ValueError("Blender undo is unavailable in the current context")
        outcome = bpy.ops.ed.undo()
    return {"outcome": sorted(outcome)}


def redo_scene() -> dict[str, Any]:
    with operator_context():
        if not bpy.ops.ed.redo.poll():
            raise ValueError("Blender redo is unavailable in the current context")
        outcome = bpy.ops.ed.redo()
    return {"outcome": sorted(outcome)}


__all__ = (
    "describe_operator",
    "discover_operators",
    "capture_render",
    "execute_code",
    "export_scene_preview",
    "inspect_object",
    "invoke_operator",
    "operator_context",
    "assign_material",
    "project_uv",
    "redo_scene",
    "select_mesh_elements",
    "set_rna_property",
    "set_selection",
    "undo_scene",
)
