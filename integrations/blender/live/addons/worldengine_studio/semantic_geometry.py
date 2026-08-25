# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Typed Curve, Text, and Geometry Nodes authoring for the live protocol."""

from __future__ import annotations

from typing import Any, Iterable

import bpy

from . import blockout, kernel_policy
from .coordinates import blender_to_director_point, director_to_blender_point


# Every bl_idname below was verified against Blender 5.1.2 by instantiating the
# node inside a throwaway GeometryNodeTree (headless probe).
GEOMETRY_NODE_TYPES = {
    "GROUP_INPUT": "NodeGroupInput",
    "GROUP_OUTPUT": "NodeGroupOutput",
    "TRANSFORM_GEOMETRY": "GeometryNodeTransform",
    "SET_POSITION": "GeometryNodeSetPosition",
    "SUBDIVISION_SURFACE": "GeometryNodeSubdivisionSurface",
    "JOIN_GEOMETRY": "GeometryNodeJoinGeometry",
    "MESH_CUBE": "GeometryNodeMeshCube",
    "MESH_CYLINDER": "GeometryNodeMeshCylinder",
    "MESH_UV_SPHERE": "GeometryNodeMeshUVSphere",
    "MESH_ICO_SPHERE": "GeometryNodeMeshIcoSphere",
    "MESH_CONE": "GeometryNodeMeshCone",
    "MESH_GRID": "GeometryNodeMeshGrid",
    "MESH_CIRCLE": "GeometryNodeMeshCircle",
    "CURVE_CIRCLE": "GeometryNodeCurvePrimitiveCircle",
    "CURVE_QUADRILATERAL": "GeometryNodeCurvePrimitiveQuadrilateral",
    "CURVE_TO_MESH": "GeometryNodeCurveToMesh",
    "FILL_CURVE": "GeometryNodeFillCurve",
    "INSTANCE_ON_POINTS": "GeometryNodeInstanceOnPoints",
    "REALIZE_INSTANCES": "GeometryNodeRealizeInstances",
    "EXTRUDE_MESH": "GeometryNodeExtrudeMesh",
    "MESH_BOOLEAN": "GeometryNodeMeshBoolean",
    "DUPLICATE_ELEMENTS": "GeometryNodeDuplicateElements",
    "TRANSLATE_INSTANCES": "GeometryNodeTranslateInstances",
    "SET_MATERIAL": "GeometryNodeSetMaterial",
    "SET_SHADE_SMOOTH": "GeometryNodeSetShadeSmooth",
    "INPUT_POSITION": "GeometryNodeInputPosition",
    "INPUT_NORMAL": "GeometryNodeInputNormal",
    "INPUT_INDEX": "GeometryNodeInputIndex",
    "MATH": "ShaderNodeMath",
    "VECTOR_MATH": "ShaderNodeVectorMath",
    "COMBINE_XYZ": "ShaderNodeCombineXYZ",
    "SEPARATE_XYZ": "ShaderNodeSeparateXYZ",
    "MAP_RANGE": "ShaderNodeMapRange",
    "NOISE_TEXTURE": "ShaderNodeTexNoise",
    "RANDOM_VALUE": "FunctionNodeRandomValue",
    "VALUE": "ShaderNodeValue",
}
BLENDER_GEOMETRY_NODE_TYPES = {value: key for key, value in GEOMETRY_NODE_TYPES.items()}

# Scalar RNA property types that agents may configure on geometry nodes.
_GEOMETRY_NODE_PROPERTY_TYPES = {"ENUM", "BOOLEAN", "INT", "FLOAT"}
# Properties defined on the Node base type (name, label, mute, location, ...)
# are UI plumbing, not node configuration; hide them from the typed surface.
_NODE_BASE_PROPERTY_IDENTIFIERS = frozenset(
    prop.identifier for prop in bpy.types.Node.bl_rna.properties
)


def _object(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    return obj


def _object_result(obj: bpy.types.Object) -> dict[str, Any]:
    return {
        "objectId": blockout.ensure_stable_id(obj),
        "name": blockout.object_display_name(obj),
        "type": obj.type,
    }


def _apply_transform(obj: bpy.types.Object, transform: dict[str, Any] | None) -> None:
    if not transform:
        return
    if "position" in transform:
        obj.location = director_to_blender_point(transform["position"])
    if "rotation" in transform:
        obj.rotation_euler = blockout.director_rotation_to_blender(transform["rotation"])
    if "scale" in transform:
        x, y, z = transform["scale"]
        obj.scale = (float(x), float(z), float(y))


def _set_curve_spline(data: bpy.types.Curve, operation: dict[str, Any]) -> None:
    data.splines.clear()
    spline_type = operation.get("curveType", "POLY")
    spline = data.splines.new(spline_type)
    points = [director_to_blender_point(point) for point in operation["points"]]
    if spline_type == "BEZIER":
        spline.bezier_points.add(len(points) - 1)
        for point, coordinate in zip(spline.bezier_points, points):
            point.co = coordinate
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
    else:
        spline.points.add(len(points) - 1)
        for point, coordinate in zip(spline.points, points):
            point.co = (*coordinate, 1.0)
    if "cyclic" in operation:
        spline.use_cyclic_u = operation["cyclic"]


def _set_curve_style(data: bpy.types.Curve, operation: dict[str, Any]) -> None:
    if "bevelDepth" in operation:
        data.bevel_depth = float(operation["bevelDepth"])
    if "bevelResolution" in operation:
        data.bevel_resolution = int(operation["bevelResolution"])


def create_curve(operation: dict[str, Any]) -> dict[str, Any]:
    name = operation.get("name") or "Director Curve"
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    _set_curve_spline(data, operation)
    _set_curve_style(data, operation)
    obj = bpy.data.objects.new(name, data)
    blockout.set_object_display_name(obj, name)
    bpy.context.scene.collection.objects.link(obj)
    obj[blockout.ID_PROPERTY] = operation["id"]
    _apply_transform(obj, operation.get("transform"))
    blockout._select_only(obj)
    return {**_object_result(obj), "curve": inspect_curve(obj)}


def set_curve_data(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    if obj.type != "CURVE":
        raise ValueError(f"WorldEngine object is not a Curve: {operation['id']}")
    _set_curve_spline(obj.data, operation)
    _set_curve_style(obj.data, operation)
    return {**_object_result(obj), "curve": inspect_curve(obj)}


def inspect_curve(obj: bpy.types.Object) -> dict[str, Any]:
    data = obj.data
    splines = []
    for spline in data.splines:
        source = spline.bezier_points if spline.type == "BEZIER" else spline.points
        splines.append({
            "type": spline.type,
            "cyclic": bool(spline.use_cyclic_u),
            "points": [
                list(blender_to_director_point(list(point.co[:3])))
                for point in source
            ],
        })
    return {
        "bevelDepth": float(data.bevel_depth),
        "bevelResolution": int(data.bevel_resolution),
        "splines": splines,
    }


def _set_text_data(data: bpy.types.TextCurve, operation: dict[str, Any]) -> None:
    data.body = operation["text"]
    for field, attribute in (
        ("size", "size"),
        ("extrude", "extrude"),
        ("bevelDepth", "bevel_depth"),
        ("alignX", "align_x"),
        ("alignY", "align_y"),
    ):
        if field in operation:
            setattr(data, attribute, operation[field])


def create_text(operation: dict[str, Any]) -> dict[str, Any]:
    name = operation.get("name") or "Director Text"
    data = bpy.data.curves.new(name, "FONT")
    _set_text_data(data, operation)
    obj = bpy.data.objects.new(name, data)
    blockout.set_object_display_name(obj, name)
    bpy.context.scene.collection.objects.link(obj)
    obj[blockout.ID_PROPERTY] = operation["id"]
    _apply_transform(obj, operation.get("transform"))
    blockout._select_only(obj)
    return {**_object_result(obj), "text": inspect_text(obj)}


def set_text_data(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    if obj.type != "FONT":
        raise ValueError(f"WorldEngine object is not Text: {operation['id']}")
    _set_text_data(obj.data, operation)
    return {**_object_result(obj), "text": inspect_text(obj)}


def inspect_text(obj: bpy.types.Object) -> dict[str, Any]:
    data = obj.data
    return {
        "text": data.body,
        "size": float(data.size),
        "extrude": float(data.extrude),
        "bevelDepth": float(data.bevel_depth),
        "alignX": data.align_x,
        "alignY": data.align_y,
    }


def _socket_references(sockets: Iterable[bpy.types.NodeSocket]):
    sockets = list(sockets)
    bases = [str(socket.identifier or socket.name) for socket in sockets]
    counts = {base: bases.count(base) for base in set(bases)}
    seen: dict[str, int] = {}
    for socket, base in zip(sockets, bases):
        seen[base] = seen.get(base, 0) + 1
        yield socket, base if counts[base] == 1 else f"{base}#{seen[base]}"


def _socket_ref(sockets: Iterable[bpy.types.NodeSocket], target: bpy.types.NodeSocket) -> str:
    return next(reference for socket, reference in _socket_references(sockets) if socket == target)


def _find_socket(sockets: Iterable[bpy.types.NodeSocket], reference: str):
    socket = next((socket for socket, ref in _socket_references(sockets) if ref == reference), None)
    if socket is None:
        raise ValueError(f"Unknown geometry socket reference: {reference}")
    return socket


def _json_socket_value(value: Any):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    try:
        return [float(component) for component in value]
    except TypeError:
        return None


def _director_socket_value(node, socket, value):
    reference = str(socket.identifier or socket.name)
    if node.bl_idname == "GeometryNodeTransform":
        if reference == "Translation":
            return list(blender_to_director_point(list(value)))
        if reference == "Rotation":
            return blockout.blender_rotation_to_director(value)
        if reference == "Scale":
            return [float(value[0]), float(value[2]), float(value[1])]
    if node.bl_idname == "GeometryNodeSetPosition" and reference in {"Position", "Offset"}:
        return list(blender_to_director_point(list(value)))
    return value


def _blender_socket_value(node, socket, value):
    reference = str(socket.identifier or socket.name)
    if node.bl_idname == "GeometryNodeTransform":
        if reference == "Translation":
            return director_to_blender_point(value)
        if reference == "Rotation":
            return blockout.director_rotation_to_blender(value)
        if reference == "Scale":
            return (float(value[0]), float(value[2]), float(value[1]))
    if node.bl_idname == "GeometryNodeSetPosition" and reference in {"Position", "Offset"}:
        return director_to_blender_point(value)
    return value


def _socket_inspection(node, sockets, socket) -> dict[str, Any]:
    result = {
        "socketRef": _socket_ref(sockets, socket),
        "name": socket.name,
        "type": socket.type,
        "linked": bool(socket.is_linked),
        "enabled": bool(socket.enabled),
        "multiInput": bool(getattr(socket, "is_multi_input", False)),
    }
    if hasattr(socket, "default_value"):
        value = _json_socket_value(_director_socket_value(node, socket, socket.default_value))
        if value is not None:
            result["defaultValue"] = value
    return result


def _is_configurable_node_property(prop) -> bool:
    return (
        prop.identifier not in _NODE_BASE_PROPERTY_IDENTIFIERS
        and not prop.is_readonly
        and prop.type in _GEOMETRY_NODE_PROPERTY_TYPES
        and not getattr(prop, "is_array", False)
    )


def _node_property_inspection(node: bpy.types.Node) -> dict[str, Any]:
    return {
        prop.identifier: _json_socket_value(getattr(node, prop.identifier))
        for prop in node.bl_rna.properties
        if _is_configurable_node_property(prop)
    }


def _apply_geometry_node_properties(node: bpy.types.Node, properties: dict[str, Any]) -> None:
    for key, value in properties.items():
        if kernel_policy._TYPED_PROPERTY_DENY.match(key):
            raise ValueError(
                f"Geometry node property is outside the Director modeling kernel: {key}"
            )
        prop = node.bl_rna.properties.get(key)
        if prop is None:
            raise ValueError(f"Unknown geometry node property: {node.bl_idname}.{key}")
        if not _is_configurable_node_property(prop):
            raise ValueError(
                f"Geometry node property is not an editable enum/boolean/integer/float: {node.bl_idname}.{key}"
            )
        try:
            if prop.type == "ENUM":
                setattr(node, key, value)
            elif prop.type == "BOOLEAN":
                setattr(node, key, bool(value))
            elif prop.type == "INT":
                setattr(node, key, int(value))
            else:
                setattr(node, key, float(value))
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"Invalid value for geometry node property {node.bl_idname}.{key}: {value!r}"
            ) from error


def _node_inspection(node: bpy.types.Node) -> dict[str, Any]:
    result = {
        "nodeRef": node.name,
        "name": node.name,
        "label": node.label,
        "nodeType": BLENDER_GEOMETRY_NODE_TYPES.get(node.bl_idname, "CUSTOM"),
        "blenderType": node.bl_idname,
        "location": [float(node.location.x), float(node.location.y)],
        "inputs": [_socket_inspection(node, node.inputs, socket) for socket in node.inputs],
        "outputs": [_socket_inspection(node, node.outputs, socket) for socket in node.outputs],
    }
    if node.bl_idname in BLENDER_GEOMETRY_NODE_TYPES:
        result["properties"] = _node_property_inspection(node)
    return result


def _link_inspection(link: bpy.types.NodeLink) -> dict[str, Any]:
    return {
        "from": {
            "nodeRef": link.from_node.name,
            "socketRef": _socket_ref(link.from_node.outputs, link.from_socket),
        },
        "to": {
            "nodeRef": link.to_node.name,
            "socketRef": _socket_ref(link.to_node.inputs, link.to_socket),
        },
    }


def _graph(obj: bpy.types.Object, modifier_name: str):
    modifier = obj.modifiers.get(modifier_name)
    tree = modifier.node_group if modifier is not None and modifier.type == "NODES" else None
    if tree is None:
        raise ValueError(f"Unknown Geometry Nodes modifier: {modifier_name}")
    return modifier, tree


_MISSING_MODIFIER_VALUE = object()


def _interface_input_items(tree: bpy.types.NodeTree):
    return [
        item
        for item in tree.interface.items_tree
        if getattr(item, "item_type", None) == "SOCKET" and getattr(item, "in_out", None) == "INPUT"
    ]


def _modifier_input_inspection(modifier, item) -> dict[str, Any]:
    stored = modifier.get(item.identifier, _MISSING_MODIFIER_VALUE)
    value = stored if stored is not _MISSING_MODIFIER_VALUE else getattr(item, "default_value", None)
    return {
        "identifier": str(item.identifier),
        "name": str(item.name),
        "socketType": str(item.socket_type),
        "value": _json_socket_value(value),
    }


def inspect_geometry_graph(obj: bpy.types.Object, modifier, tree) -> dict[str, Any]:
    return {
        "objectId": blockout.ensure_stable_id(obj),
        "modifierName": modifier.name,
        "nodeGroupName": tree.name,
        "modifierInputs": [
            _modifier_input_inspection(modifier, item) for item in _interface_input_items(tree)
        ],
        "nodes": sorted((_node_inspection(node) for node in tree.nodes), key=lambda item: item["nodeRef"]),
        "links": sorted(
            (_link_inspection(link) for link in tree.links),
            key=lambda item: (
                item["from"]["nodeRef"], item["from"]["socketRef"],
                item["to"]["nodeRef"], item["to"]["socketRef"],
            ),
        ),
    }


def inspect_object_geometry_graphs(obj: bpy.types.Object) -> list[dict[str, Any]]:
    return [
        inspect_geometry_graph(obj, modifier, modifier.node_group)
        for modifier in obj.modifiers
        if modifier.type == "NODES" and modifier.node_group is not None
    ]


def _mutation_result(obj, modifier, tree, **evidence: Any) -> dict[str, Any]:
    object_id = blockout.ensure_stable_id(obj)
    return {
        "objectId": object_id,
        "dirtyObjectIds": [object_id],
        "modifierName": modifier.name,
        **evidence,
    }


def ensure_geometry_nodes(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier_name = operation.get("modifierName", "WorldEngine Geometry")
    modifier = obj.modifiers.get(modifier_name)
    if modifier is None:
        modifier = obj.modifiers.new(modifier_name, "NODES")
    if modifier.type != "NODES":
        raise ValueError(f"Modifier is not Geometry Nodes: {modifier_name}")
    tree = modifier.node_group
    if tree is None:
        tree = bpy.data.node_groups.new(f"{obj.name} Geometry", "GeometryNodeTree")
        modifier.node_group = tree
        tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        input_node = tree.nodes.new("NodeGroupInput")
        input_node.name = "group-input"
        input_node.location = (-200, 0)
        output_node = tree.nodes.new("NodeGroupOutput")
        output_node.name = "group-output"
        output_node.is_active_output = True
        output_node.location = (200, 0)
        tree.links.new(input_node.outputs[0], output_node.inputs[0])
    return _mutation_result(obj, modifier, tree, graph=inspect_geometry_graph(obj, modifier, tree))


def _find_node(tree: bpy.types.NodeTree, reference: str):
    node = tree.nodes.get(reference)
    if node is None:
        raise ValueError(f"Unknown geometry node reference: {reference}")
    return node


def create_geometry_node(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    reference = operation["nodeRef"]
    if tree.nodes.get(reference) is not None:
        raise ValueError(f"Geometry node reference already exists: {reference}")
    node = tree.nodes.new(GEOMETRY_NODE_TYPES[operation["nodeType"]])
    node.name = reference
    if operation["nodeType"] == "GROUP_OUTPUT":
        node.is_active_output = True
    if "location" in operation:
        node.location = operation["location"]
    if "label" in operation:
        node.label = operation["label"]
    if "nodeProperties" in operation:
        try:
            _apply_geometry_node_properties(node, operation["nodeProperties"])
        except ValueError:
            # Keep the tree clean so the caller can retry with the same nodeRef.
            tree.nodes.remove(node)
            raise
    return _mutation_result(obj, modifier, tree, node=_node_inspection(node))


def delete_geometry_node(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    node = _find_node(tree, operation["nodeRef"])
    deleted = _node_inspection(node)
    tree.nodes.remove(node)
    return _mutation_result(obj, modifier, tree, deletedNode=deleted)


def set_geometry_node_input(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    node = _find_node(tree, operation["nodeRef"])
    socket = _find_socket(node.inputs, operation["inputSocketRef"])
    if not hasattr(socket, "default_value"):
        raise ValueError(f"Geometry input has no editable default value: {operation['inputSocketRef']}")
    value = _blender_socket_value(node, socket, operation["value"])
    socket.default_value = int(value) if socket.type == "INT" else value
    return _mutation_result(obj, modifier, tree, input=_socket_inspection(node, node.inputs, socket))


def connect_geometry_nodes(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    source = _find_node(tree, operation["from"]["nodeRef"])
    target = _find_node(tree, operation["to"]["nodeRef"])
    output = _find_socket(source.outputs, operation["from"]["socketRef"])
    input_socket = _find_socket(target.inputs, operation["to"]["socketRef"])
    replaced = []
    if not getattr(input_socket, "is_multi_input", False):
        for link in tuple(input_socket.links):
            replaced.append(_link_inspection(link))
            tree.links.remove(link)
    link = tree.links.new(output, input_socket, verify_limits=True)
    return _mutation_result(obj, modifier, tree, link=_link_inspection(link), replacedLinks=replaced)


def disconnect_geometry_node_input(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    node = _find_node(tree, operation["nodeRef"])
    socket = _find_socket(node.inputs, operation["inputSocketRef"])
    links = tuple(socket.links)
    if not links:
        raise ValueError(f"Geometry input is not connected: {operation['inputSocketRef']}")
    disconnected = [_link_inspection(link) for link in links]
    for link in links:
        tree.links.remove(link)
    return _mutation_result(obj, modifier, tree, disconnectedLinks=disconnected)


# v1 scope is scalars/bools only; vector group inputs are excluded deliberately
# (Director/Blender coordinate-space ambiguity).
_GROUP_INPUT_COERCIONS = {
    "NodeSocketFloat": float,
    "NodeSocketInt": int,
    "NodeSocketBool": bool,
}


def set_geometry_modifier_input(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier, tree = _graph(obj, operation["modifierName"])
    reference = operation["inputRef"]
    items = _interface_input_items(tree)
    matches = [item for item in items if item.identifier == reference]
    if not matches:
        matches = [item for item in items if item.name == reference]
    if len(matches) > 1:
        identifiers = ", ".join(item.identifier for item in matches)
        raise ValueError(
            f"Ambiguous geometry group input name: {reference}; "
            f"use one of the socket identifiers instead: {identifiers}"
        )
    if not matches:
        raise ValueError(f"Unknown geometry group input: {reference}")
    item = matches[0]
    coerce = _GROUP_INPUT_COERCIONS.get(str(item.socket_type))
    if coerce is None:
        raise ValueError(
            f"only float/int/bool group inputs are supported, not {item.socket_type}: {reference}"
        )
    value = coerce(operation["value"])
    modifier[item.identifier] = value
    # ID-property writes do not invalidate the depsgraph on their own; touch the
    # node group binding and tag the object so the modifier re-evaluates.
    modifier.node_group = tree
    obj.update_tag()
    return _mutation_result(obj, modifier, tree, input=_modifier_input_inspection(modifier, item))


def assign_geometry_node_group(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    name = operation["nodeGroupName"]
    tree = bpy.data.node_groups.get(name)
    if tree is None:
        raise ValueError(f"Unknown geometry node group: {name}")
    if tree.bl_idname != "GeometryNodeTree":
        raise ValueError(f"Node group is not a Geometry Nodes tree: {name}")
    modifier_name = operation["modifierName"]
    modifier = obj.modifiers.get(modifier_name)
    if modifier is None:
        modifier = obj.modifiers.new(modifier_name, "NODES")
    if modifier.type != "NODES":
        raise ValueError(f"Modifier is not Geometry Nodes: {modifier_name}")
    modifier.node_group = tree
    obj.update_tag()
    return _mutation_result(obj, modifier, tree, graph=inspect_geometry_graph(obj, modifier, tree))


__all__ = (
    "assign_geometry_node_group",
    "connect_geometry_nodes",
    "create_curve",
    "create_geometry_node",
    "create_text",
    "delete_geometry_node",
    "disconnect_geometry_node_input",
    "ensure_geometry_nodes",
    "inspect_curve",
    "inspect_object_geometry_graphs",
    "inspect_text",
    "set_curve_data",
    "set_geometry_modifier_input",
    "set_geometry_node_input",
    "set_text_data",
)
