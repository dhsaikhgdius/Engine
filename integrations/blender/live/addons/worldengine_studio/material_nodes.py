# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Semantic Material Nodes operations for the WorldEngine live protocol.

The public contract intentionally exposes a small set of useful shader nodes
and stable node/socket references.  It does not expose Python or Blender RNA
paths, so an Agent can author a graph without depending on UI selection state.
"""

from __future__ import annotations

from typing import Any, Iterable

import bpy

from . import blockout


NODE_TYPES = {
    "PRINCIPLED_BSDF": "ShaderNodeBsdfPrincipled",
    "MATERIAL_OUTPUT": "ShaderNodeOutputMaterial",
    "MIX_COLOR": "ShaderNodeMixRGB",
    "NORMAL_MAP": "ShaderNodeNormalMap",
    "BUMP": "ShaderNodeBump",
    "TEX_COORD": "ShaderNodeTexCoord",
    "MAPPING": "ShaderNodeMapping",
    "NOISE_TEXTURE": "ShaderNodeTexNoise",
}
BLENDER_NODE_TYPES = {value: key for key, value in NODE_TYPES.items()}


def _object(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    return obj


def _material_users(material: bpy.types.Material) -> list[str]:
    return sorted(
        blockout.ensure_stable_id(obj)
        for obj in bpy.context.scene.objects
        if any(slot.material == material for slot in obj.material_slots)
    )


def _material_for_object(
    identifier: str,
    material_name: str,
    *,
    enable_nodes: bool = False,
) -> tuple[bpy.types.Object, bpy.types.Material]:
    obj = _object(identifier)
    material, _kind = blockout.resolve_material(material_name)
    if material is None:
        raise ValueError(blockout.unknown_material_message(material_name))
    if not any(slot.material == material for slot in obj.material_slots):
        raise ValueError(
            f"Material {material.name!r} is not assigned to WorldEngine object: {identifier}"
        )
    if enable_nodes and not material.use_nodes:
        material.use_nodes = True
    if not material.use_nodes or material.node_tree is None:
        raise ValueError(f"Blender material does not use nodes: {material_name}")
    return obj, material


def _node_ref(node: bpy.types.Node) -> str:
    # Blender guarantees unique node names inside one tree, including when a
    # user duplicates a node.  The scene revision guards a later rename.
    return node.name


def _find_node(tree: bpy.types.NodeTree, reference: str) -> bpy.types.Node:
    node = tree.nodes.get(reference)
    if node is None:
        raise ValueError(f"Unknown material node reference: {reference}")
    return node


def _claim_node_ref(tree: bpy.types.NodeTree, node: bpy.types.Node, preferred: str) -> str:
    existing = tree.nodes.get(preferred)
    if existing is None or existing == node:
        node.name = preferred
    return node.name


def ensure_default_node_refs(
    material: bpy.types.Material,
    principled: bpy.types.Node | None = None,
    output: bpy.types.Node | None = None,
) -> None:
    tree = material.node_tree
    if tree is None:
        return
    principled = principled or next(
        (node for node in tree.nodes if node.bl_idname == "ShaderNodeBsdfPrincipled"),
        None,
    )
    output = output or next(
        (node for node in tree.nodes if node.bl_idname == "ShaderNodeOutputMaterial"),
        None,
    )
    if principled is not None:
        _claim_node_ref(tree, principled, "principled")
    if output is not None:
        _claim_node_ref(tree, output, "material-output")


def _socket_references(sockets: Iterable[bpy.types.NodeSocket]):
    sockets = list(sockets)
    bases = [str(socket.identifier or socket.name) for socket in sockets]
    counts = {base: bases.count(base) for base in set(bases)}
    seen: dict[str, int] = {}
    result = []
    for socket, base in zip(sockets, bases):
        seen[base] = seen.get(base, 0) + 1
        reference = base if counts[base] == 1 else f"{base}#{seen[base]}"
        result.append((socket, reference))
    return result


def _find_socket(sockets: Iterable[bpy.types.NodeSocket], reference: str):
    match = next(
        (socket for socket, socket_ref in _socket_references(sockets) if socket_ref == reference),
        None,
    )
    if match is None:
        raise ValueError(f"Unknown material socket reference: {reference}")
    return match


def _socket_ref(sockets: Iterable[bpy.types.NodeSocket], target: bpy.types.NodeSocket) -> str:
    return next(
        reference
        for socket, reference in _socket_references(sockets)
        if socket == target
    )


def _json_socket_value(value: Any):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    try:
        return [float(component) for component in value]
    except TypeError:
        return None


def _socket_inspection(
    sockets: Iterable[bpy.types.NodeSocket],
    socket: bpy.types.NodeSocket,
) -> dict[str, Any]:
    result = {
        "socketRef": _socket_ref(sockets, socket),
        "name": socket.name,
        "type": socket.type,
        "linked": bool(socket.is_linked),
        "enabled": bool(socket.enabled),
        "multiInput": bool(getattr(socket, "is_multi_input", False)),
    }
    if hasattr(socket, "default_value"):
        default_value = _json_socket_value(socket.default_value)
        if default_value is not None:
            result["defaultValue"] = default_value
    return result


def _node_inspection(node: bpy.types.Node) -> dict[str, Any]:
    return {
        "nodeRef": _node_ref(node),
        "name": node.name,
        "label": node.label,
        "nodeType": BLENDER_NODE_TYPES.get(node.bl_idname, "CUSTOM"),
        "blenderType": node.bl_idname,
        "activeOutput": bool(getattr(node, "is_active_output", False)),
        "location": [float(node.location.x), float(node.location.y)],
        "inputs": [_socket_inspection(node.inputs, socket) for socket in node.inputs],
        "outputs": [_socket_inspection(node.outputs, socket) for socket in node.outputs],
    }


def _link_inspection(link: bpy.types.NodeLink) -> dict[str, Any]:
    return {
        "from": {
            "nodeRef": _node_ref(link.from_node),
            "socketRef": _socket_ref(link.from_node.outputs, link.from_socket),
        },
        "to": {
            "nodeRef": _node_ref(link.to_node),
            "socketRef": _socket_ref(link.to_node.inputs, link.to_socket),
        },
    }


def inspect_material_graph(material: bpy.types.Material) -> dict[str, Any]:
    tree = material.node_tree
    nodes = sorted(
        (_node_inspection(node) for node in tree.nodes),
        key=lambda item: item["nodeRef"],
    ) if material.use_nodes and tree is not None else []
    links = sorted(
        (_link_inspection(link) for link in tree.links),
        key=lambda item: (
            item["from"]["nodeRef"],
            item["from"]["socketRef"],
            item["to"]["nodeRef"],
            item["to"]["socketRef"],
        ),
    ) if material.use_nodes and tree is not None else []
    return {
        "materialName": material.name,
        "objectIds": _material_users(material),
        "activeOutputNodeRef": next(
            (
                _node_ref(node)
                for node in tree.nodes
                if node.bl_idname == "ShaderNodeOutputMaterial"
                and node.is_active_output
            ),
            None,
        ) if material.use_nodes and tree is not None else None,
        "nodes": nodes,
        "links": links,
    }


def inspect_object_material_graphs(obj: bpy.types.Object) -> list[dict[str, Any]]:
    materials = []
    seen = set()
    for slot in obj.material_slots:
        material = slot.material
        if material is None or material.as_pointer() in seen:
            continue
        seen.add(material.as_pointer())
        materials.append(material)
    return [inspect_material_graph(material) for material in materials]


def _mutation_result(
    object_id: str,
    material: bpy.types.Material,
    **evidence: Any,
) -> dict[str, Any]:
    affected = _material_users(material)
    return {
        "objectId": object_id,
        "affectedObjectIds": affected,
        "dirtyObjectIds": affected,
        "materialName": material.name,
        **evidence,
    }


def create_material_node(operation: dict[str, Any]) -> dict[str, Any]:
    object_id = operation["id"]
    _, material = _material_for_object(
        object_id,
        operation["materialName"],
        enable_nodes=True,
    )
    tree = material.node_tree
    reference = operation["nodeRef"]
    if tree.nodes.get(reference) is not None:
        raise ValueError(f"Material node reference already exists: {reference}")
    node = tree.nodes.new(NODE_TYPES[operation["nodeType"]])
    node.name = reference
    if node.name != reference:
        tree.nodes.remove(node)
        raise ValueError(f"Blender could not reserve material node reference: {reference}")
    if operation["nodeType"] == "MATERIAL_OUTPUT":
        node.is_active_output = True
    if "location" in operation:
        node.location = operation["location"]
    if "label" in operation:
        node.label = operation["label"]
    return _mutation_result(object_id, material, node=_node_inspection(node))


def delete_material_node(operation: dict[str, Any]) -> dict[str, Any]:
    object_id = operation["id"]
    _, material = _material_for_object(object_id, operation["materialName"])
    tree = material.node_tree
    node = _find_node(tree, operation["nodeRef"])
    deleted = _node_inspection(node)
    tree.nodes.remove(node)
    return _mutation_result(object_id, material, deletedNode=deleted)


def set_material_node_input(operation: dict[str, Any]) -> dict[str, Any]:
    object_id = operation["id"]
    _, material = _material_for_object(object_id, operation["materialName"])
    node = _find_node(material.node_tree, operation["nodeRef"])
    socket = _find_socket(node.inputs, operation["inputSocketRef"])
    if not hasattr(socket, "default_value"):
        raise ValueError(
            f"Material input has no editable default value: {operation['inputSocketRef']}"
        )
    socket.default_value = operation["value"]
    return _mutation_result(
        object_id,
        material,
        input=_socket_inspection(node.inputs, socket),
    )


def connect_material_nodes(operation: dict[str, Any]) -> dict[str, Any]:
    object_id = operation["id"]
    _, material = _material_for_object(object_id, operation["materialName"])
    tree = material.node_tree
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
    return _mutation_result(
        object_id,
        material,
        link=_link_inspection(link),
        replacedLinks=replaced,
    )


def disconnect_material_node_input(operation: dict[str, Any]) -> dict[str, Any]:
    object_id = operation["id"]
    _, material = _material_for_object(object_id, operation["materialName"])
    tree = material.node_tree
    node = _find_node(tree, operation["nodeRef"])
    socket = _find_socket(node.inputs, operation["inputSocketRef"])
    links = tuple(socket.links)
    if not links:
        raise ValueError(f"Material input is not connected: {operation['inputSocketRef']}")
    disconnected = [_link_inspection(link) for link in links]
    for link in links:
        tree.links.remove(link)
    return _mutation_result(object_id, material, disconnectedLinks=disconnected)


__all__ = (
    "create_material_node",
    "delete_material_node",
    "disconnect_material_node_input",
    "ensure_default_node_refs",
    "inspect_material_graph",
    "inspect_object_material_graphs",
    "connect_material_nodes",
    "set_material_node_input",
)
