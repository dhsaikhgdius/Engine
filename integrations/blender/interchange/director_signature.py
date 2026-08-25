"""Shared Director mesh-content fingerprint for the Blender interchange scripts.

``director_bridge.py`` stamps the signature into the .blend on export and
``director_return_export.py`` recomputes it on return. Both sides must feed
byte-identical data into the digest, so this module is the single source of
truth. Changing any hashed byte invalidates every previously stamped scene.
"""

from __future__ import annotations

import hashlib
from array import array
from typing import Any


def _hash_text(digest: Any, label: str, value: Any) -> None:
    digest.update(label.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(value).encode("utf-8"))
    digest.update(b"\0")


def _hash_numbers(digest: Any, label: str, values: Any) -> None:
    _hash_text(digest, label, ",".join(format(float(value), ".12g") for value in values))


def _hash_collection(digest: Any, label: str, collection: Any, attribute: str, width: int, typecode: str) -> None:
    _hash_text(digest, f"{label}.count", len(collection))
    if not collection:
        return
    values = array(typecode, [0]) * (len(collection) * width)
    collection.foreach_get(attribute, values)
    digest.update(label.encode("utf-8"))
    digest.update(b"\0")
    digest.update(values.tobytes())


def _hash_action(digest: Any, target: Any, label: str) -> None:
    animation = getattr(target, "animation_data", None)
    action = getattr(animation, "action", None) if animation else None
    if action is None:
        _hash_text(digest, f"{label}.action", "none")
        return
    _hash_text(digest, f"{label}.action", getattr(action, "name", ""))
    curves = sorted(
        getattr(action, "fcurves", []),
        key=lambda curve: (getattr(curve, "data_path", ""), int(getattr(curve, "array_index", 0))),
    )
    for curve in curves:
        curve_label = f"{label}.curve.{curve.data_path}.{curve.array_index}"
        _hash_text(digest, curve_label, len(curve.keyframe_points))
        for point in curve.keyframe_points:
            _hash_numbers(digest, f"{curve_label}.co", point.co)
            _hash_text(digest, f"{curve_label}.interpolation", point.interpolation)


def _hash_material(digest: Any, material: Any, label: str) -> None:
    if material is None:
        _hash_text(digest, label, "none")
        return
    _hash_text(digest, f"{label}.name", material.name)
    _hash_numbers(digest, f"{label}.diffuse", material.diffuse_color)
    _hash_text(digest, f"{label}.nodes", bool(material.use_nodes))
    node_tree = material.node_tree if material.use_nodes else None
    if node_tree is None:
        return
    for node in sorted(node_tree.nodes, key=lambda candidate: (candidate.bl_idname, candidate.name)):
        node_label = f"{label}.node.{node.bl_idname}.{node.name}"
        _hash_text(digest, node_label, node.label)
        for index, socket in enumerate(node.inputs):
            value = getattr(socket, "default_value", None)
            if isinstance(value, (bool, int, float, str)):
                _hash_text(digest, f"{node_label}.input.{index}", value)
            elif value is not None:
                try:
                    _hash_numbers(digest, f"{node_label}.input.{index}", value)
                except (TypeError, ValueError):
                    pass
    links = sorted(
        node_tree.links,
        key=lambda link: (link.from_node.name, link.from_socket.name, link.to_node.name, link.to_socket.name),
    )
    for link in links:
        _hash_text(
            digest,
            f"{label}.link",
            f"{link.from_node.name}:{link.from_socket.name}>{link.to_node.name}:{link.to_socket.name}",
        )


def mesh_content_signature(root: Any) -> str:
    """Fingerprint asset-space content while deliberately excluding the Director root transform.

    The value is persisted in the .blend and compared by the return exporter. It
    includes child transforms, topology, UVs, shape keys, materials, armatures,
    and descendant actions, so an untouched round trip stays empty while actual
    Blender refinements still publish a replacement asset.
    """
    digest = hashlib.sha256()
    for index, item in enumerate([root, *list(root.children_recursive)]):
        label = f"object.{index}.{item.type}"
        _hash_text(digest, f"{label}.type", item.type)
        if item is not root:
            _hash_numbers(digest, f"{label}.matrix_local", (value for row in item.matrix_local for value in row))
            _hash_action(digest, item, label)
        if item.type == "MESH":
            mesh = item.data
            mesh.update()
            _hash_collection(digest, f"{label}.vertices", mesh.vertices, "co", 3, "f")
            _hash_collection(digest, f"{label}.edges", mesh.edges, "vertices", 2, "i")
            _hash_collection(digest, f"{label}.loops", mesh.loops, "vertex_index", 1, "i")
            _hash_collection(digest, f"{label}.polygons.start", mesh.polygons, "loop_start", 1, "i")
            _hash_collection(digest, f"{label}.polygons.total", mesh.polygons, "loop_total", 1, "i")
            _hash_collection(digest, f"{label}.polygons.material", mesh.polygons, "material_index", 1, "i")
            for layer_index, layer in enumerate(mesh.uv_layers):
                _hash_collection(digest, f"{label}.uv.{layer_index}", layer.data, "uv", 2, "f")
            shape_keys = getattr(mesh, "shape_keys", None)
            for key_index, key in enumerate(getattr(shape_keys, "key_blocks", [])):
                _hash_collection(digest, f"{label}.shape.{key_index}", key.data, "co", 3, "f")
            for material_index, material in enumerate(mesh.materials):
                _hash_material(digest, material, f"{label}.material.{material_index}")
        elif item.type == "ARMATURE":
            for bone in sorted(item.data.bones, key=lambda candidate: candidate.name):
                _hash_text(digest, f"{label}.bone.name", bone.name)
                _hash_text(digest, f"{label}.bone.parent", bone.parent.name if bone.parent else "")
                _hash_numbers(digest, f"{label}.bone.matrix", (value for row in bone.matrix_local for value in row))
    return digest.hexdigest()


def armature_pose_fingerprint(root: Any) -> str | None:
    """Fingerprint the current pose-bone basis matrices under a Director root.

    ``mesh_content_signature`` hashes rest bones; this fingerprint tracks the
    live pose instead so the return exporter can detect direct pose-bone edits
    and warn honestly that they are not reconciled (only the portable
    ``director_pose.*`` control values round-trip). Returns ``None`` when the
    root has no armature descendants.
    """
    armatures = sorted(
        (item for item in [root, *list(root.children_recursive)] if item.type == "ARMATURE"),
        key=lambda item: item.name,
    )
    if not armatures:
        return None
    digest = hashlib.sha256()
    for armature in armatures:
        _hash_text(digest, "armature.name", armature.name)
        pose = getattr(armature, "pose", None)
        for bone in sorted(getattr(pose, "bones", []), key=lambda candidate: candidate.name):
            _hash_text(digest, "pose.bone.name", bone.name)
            _hash_numbers(digest, "pose.bone.matrix_basis", (value for row in bone.matrix_basis for value in row))
    return digest.hexdigest()
