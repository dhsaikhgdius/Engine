# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Typed Director operations on Blender's non-destructive modifier stack.

Deliberately excludes NODES (geometry-node graphs have their own typed
operations in semantic_geometry) and all physics/simulation modifier types.
"""

from __future__ import annotations

from typing import Any

import bpy

from . import blockout, kernel_policy


MODIFIER_TYPES = {
    "SOLIDIFY",
    "BEVEL",
    "ARRAY",
    "MIRROR",
    "BOOLEAN",
    "SUBSURF",
    "DECIMATE",
    "DISPLACE",
    "TRIANGULATE",
    "WELD",
    "WIREFRAME",
    "SCREW",
    "SIMPLE_DEFORM",
    "SMOOTH",
    "CAST",
    "SHRINKWRAP",
}


def _object(identifier: str) -> bpy.types.Object:
    obj = blockout.find_object(identifier)
    if obj is None:
        raise ValueError(f"Unknown WorldEngine object: {identifier}")
    return obj


def _modifier(obj: bpy.types.Object, name: str) -> bpy.types.Modifier:
    modifier = obj.modifiers.get(name)
    if modifier is None:
        raise ValueError(f"Unknown Blender modifier: {name}")
    return modifier


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


def _modifier_properties(modifier: bpy.types.Modifier) -> dict[str, Any]:
    """JSON-safe dump of the writable modifier properties.

    Object pointers are reported as stable WorldEngine IDs so agents can round
    trip them; other pointer and collection properties are omitted.
    """
    result: dict[str, Any] = {}
    for prop in modifier.bl_rna.properties:
        if prop.identifier == "rna_type" or prop.is_readonly or prop.is_hidden:
            continue
        if prop.type == 'POINTER':
            pointer_type = getattr(bpy.types, prop.fixed_type.identifier, None)
            if pointer_type is None or not issubclass(pointer_type, bpy.types.Object):
                continue
            value = getattr(modifier, prop.identifier)
            result[prop.identifier] = blockout.ensure_stable_id(value) if value is not None else None
            continue
        if prop.type == 'COLLECTION':
            continue
        try:
            result[prop.identifier] = _json_value(getattr(modifier, prop.identifier))
        except (AttributeError, TypeError, ValueError):
            continue
    return result


def _resolved_pointer_value(modifier: bpy.types.Modifier, prop, value: Any) -> bpy.types.Object:
    field = f"{modifier.type}.{prop.identifier}"
    pointer_type = getattr(bpy.types, prop.fixed_type.identifier, None)
    if pointer_type is None or not issubclass(pointer_type, bpy.types.Object):
        raise ValueError(f"Unsupported Blender modifier pointer property: {field}")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Blender modifier property requires a stable object ID: {field}")
    target = blockout.find_object(value.strip())
    if target is None:
        raise ValueError(f"Unknown WorldEngine object: {value.strip()}")
    return target


def _coerced_property_value(modifier: bpy.types.Modifier, prop, value: Any) -> Any:
    field = f"{modifier.type}.{prop.identifier}"
    if prop.type == 'ENUM':
        if not isinstance(value, str):
            raise ValueError(f"Blender modifier property requires an enum string: {field}")
        identifiers = {item.identifier for item in prop.enum_items}
        if identifiers and value not in identifiers:
            raise ValueError(f"Unsupported Blender modifier enum value: {field}={value}")
        return value
    if getattr(prop, "is_array", False) and prop.type in {'BOOLEAN', 'INT', 'FLOAT'}:
        length = int(prop.array_length)
        if not isinstance(value, (list, tuple)) or len(value) != length:
            raise ValueError(f"Blender modifier property requires {length} numbers: {field}")
        if any(not isinstance(item, (bool, int, float)) for item in value):
            raise ValueError(f"Blender modifier property requires {length} numbers: {field}")
        cast = {'BOOLEAN': bool, 'INT': int, 'FLOAT': float}[prop.type]
        return [cast(item) for item in value]
    if prop.type == 'BOOLEAN':
        if not isinstance(value, bool):
            raise ValueError(f"Blender modifier property requires a boolean: {field}")
        return value
    if prop.type == 'INT':
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"Blender modifier property requires an integer: {field}")
        return value
    if prop.type == 'FLOAT':
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Blender modifier property requires a number: {field}")
        return float(value)
    raise ValueError(f"Unsupported Blender modifier property type: {field}")


def _apply_properties(modifier: bpy.types.Modifier, properties: dict[str, Any]) -> None:
    for key, value in properties.items():
        if kernel_policy._RNA_PATH_DENY.match(key):
            raise ValueError(
                f"Blender modifier property is outside the Director modeling kernel: {modifier.type}.{key}"
            )
        prop = modifier.bl_rna.properties.get(key)
        if prop is None:
            raise ValueError(f"Unknown Blender modifier property: {modifier.type}.{key}")
        if prop.is_readonly:
            raise ValueError(f"Blender modifier property is read-only: {modifier.type}.{key}")
        if prop.type == 'POINTER':
            resolved = _resolved_pointer_value(modifier, prop, value)
        else:
            resolved = _coerced_property_value(modifier, prop, value)
        setattr(modifier, key, resolved)


def _stack_summary(obj: bpy.types.Object) -> list[dict[str, Any]]:
    return [
        {"name": modifier.name, "type": modifier.type, "index": index}
        for index, modifier in enumerate(obj.modifiers)
    ]


def _result(obj: bpy.types.Object, **extra: Any) -> dict[str, Any]:
    object_id = blockout.ensure_stable_id(obj)
    return {
        "objectId": object_id,
        "dirtyObjectIds": [object_id],
        "modifiers": _stack_summary(obj),
        **extra,
    }


def _modifier_summary(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> dict[str, Any]:
    return {
        "name": modifier.name,
        "type": modifier.type,
        "index": obj.modifiers.find(modifier.name),
        "properties": _modifier_properties(modifier),
    }


def add_modifier(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    name = operation["modifierName"]
    modifier_type = operation["modifierType"]
    if modifier_type not in MODIFIER_TYPES:
        raise ValueError(f"Unsupported Blender modifier type: {modifier_type}")
    if obj.modifiers.get(name) is not None:
        raise ValueError(f"Blender modifier already exists: {name}")
    # modifiers.new returns None instead of raising on some Blender versions.
    modifier = obj.modifiers.new(name=name, type=modifier_type)
    if modifier is None:
        raise ValueError(f"Blender could not create a {modifier_type} modifier on {blockout.object_display_name(obj)}")
    _apply_properties(modifier, operation.get("properties") or {})
    return _result(obj, modifier=_modifier_summary(obj, modifier))


def set_modifier(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier = _modifier(obj, operation["modifierName"])
    _apply_properties(modifier, operation["properties"])
    return _result(obj, modifier=_modifier_summary(obj, modifier))


def remove_modifier(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier = _modifier(obj, operation["modifierName"])
    name = modifier.name
    obj.modifiers.remove(modifier)
    return _result(obj, removedModifier=name)


def reorder_modifier(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier = _modifier(obj, operation["modifierName"])
    index = operation["index"]
    count = len(obj.modifiers)
    if index >= count:
        raise ValueError(f"Blender modifier index is out of range: {index} (stack has {count})")
    name = modifier.name
    obj.modifiers.move(obj.modifiers.find(name), index)
    return _result(obj, modifier={"name": name, "index": obj.modifiers.find(name)})


def _activate_in_object_mode(obj: bpy.types.Object) -> None:
    active = bpy.context.view_layer.objects.active
    if active is not None and active.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for candidate in bpy.context.selected_objects:
        candidate.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(operation: dict[str, Any]) -> dict[str, Any]:
    obj = _object(operation["id"])
    modifier = _modifier(obj, operation["modifierName"])
    if obj.type != 'MESH':
        raise ValueError(f"Blender modifier apply requires a mesh object: {operation['id']}")
    name = modifier.name
    _activate_in_object_mode(obj)
    from . import modeling

    with modeling.operator_context():
        if not bpy.ops.object.modifier_apply.poll():
            raise ValueError("Blender modifier apply is unavailable in the current context")
        try:
            # The surrounding WorldEngine batch owns the undo boundary.
            outcome = bpy.ops.object.modifier_apply('EXEC_DEFAULT', False, modifier=name)
        except RuntimeError as error:
            raise ValueError(str(error)) from error
    if 'FINISHED' not in outcome:
        raise RuntimeError(
            f"Blender modifier apply did not finish: {name} ({', '.join(sorted(outcome))})"
        )
    mesh = obj.data
    return _result(
        obj,
        appliedModifier=name,
        mesh={"vertices": len(mesh.vertices), "faces": len(mesh.polygons)},
    )


__all__ = (
    "MODIFIER_TYPES",
    "add_modifier",
    "set_modifier",
    "remove_modifier",
    "reorder_modifier",
    "apply_modifier",
)
