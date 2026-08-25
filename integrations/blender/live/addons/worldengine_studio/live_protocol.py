# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Small wire-format parser for the Director/Blender live session.

The gateway already validates this contract.  Blender repeats only the
checks needed to turn JSON into predictable Blender operator arguments.
"""

from __future__ import annotations

import json
import math
from typing import Any

try:
    from .operation_manifest import (
        CONTRACT,
        PROJECT_LIFECYCLE_OPERATIONS,
        READ_ONLY_LIVE_OPERATIONS,
        SUPPORTED_OPERATIONS,
    )
except ImportError:  # Standalone protocol tests import this module directly.
    from operation_manifest import (
        CONTRACT,
        PROJECT_LIFECYCLE_OPERATIONS,
        READ_ONLY_LIVE_OPERATIONS,
        SUPPORTED_OPERATIONS,
    )

MATERIAL_NODE_TYPES = {
    "PRINCIPLED_BSDF",
    "MATERIAL_OUTPUT",
    "MIX_COLOR",
    "NORMAL_MAP",
    "BUMP",
    "TEX_COORD",
    "MAPPING",
    "NOISE_TEXTURE",
}

# Snapshot entry fields that only move an existing datablock. Everything else
# (names, visibility, parenting, dimensions, modifier counts, light energy…)
# counts as a visible-content change and must invalidate cached preview GLBs.
_TRANSFORM_ONLY_SNAPSHOT_FIELDS = {"position", "rotation", "scale", "localTransform"}


def _snapshot_entries_by_id(entries: Any) -> dict[str, dict[str, Any]] | None:
    if not isinstance(entries, list):
        return None
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        identifier = entry.get("id")
        if not isinstance(identifier, str) or identifier in result:
            return None
        result[identifier] = entry
    return result


def _entries_equal_except_transforms(before: dict[str, Any], after: dict[str, Any]) -> bool:
    for key in before.keys() | after.keys():
        if key in _TRANSFORM_ONLY_SNAPSHOT_FIELDS:
            continue
        if before.get(key) != after.get(key):
            return False
    return True


def snapshots_differ_only_by_transforms(before: Any, after: Any) -> bool:
    """True when two scene snapshots describe the same visible content and
    differ at most in object/camera/light transforms.

    The session uses this to keep the published ``contentRevision`` behind the
    scene ``revision`` for pure moves (e.g. viewport drags), letting browser
    clients update mounted node transforms instead of re-downloading and
    re-parsing the whole preview GLB. Any uncertainty — malformed collections,
    duplicate ids, membership changes — reports False, which forces the
    conservative full reload.
    """
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    for collection in ("objects", "cameras", "lights"):
        before_entries = _snapshot_entries_by_id(before.get(collection))
        after_entries = _snapshot_entries_by_id(after.get(collection))
        if before_entries is None or after_entries is None:
            return False
        if before_entries.keys() != after_entries.keys():
            return False
        for identifier, entry in after_entries.items():
            if not _entries_equal_except_transforms(before_entries[identifier], entry):
                return False
    return True

GEOMETRY_NODE_TYPES = {
    "GROUP_INPUT",
    "GROUP_OUTPUT",
    "TRANSFORM_GEOMETRY",
    "SET_POSITION",
    "SUBDIVISION_SURFACE",
    "JOIN_GEOMETRY",
    "MESH_CUBE",
    "MESH_CYLINDER",
    "MESH_UV_SPHERE",
    "MESH_ICO_SPHERE",
    "MESH_CONE",
    "MESH_GRID",
    "MESH_CIRCLE",
    "CURVE_CIRCLE",
    "CURVE_QUADRILATERAL",
    "CURVE_TO_MESH",
    "FILL_CURVE",
    "INSTANCE_ON_POINTS",
    "REALIZE_INSTANCES",
    "EXTRUDE_MESH",
    "MESH_BOOLEAN",
    "DUPLICATE_ELEMENTS",
    "TRANSLATE_INSTANCES",
    "SET_MATERIAL",
    "SET_SHADE_SMOOTH",
    "INPUT_POSITION",
    "INPUT_NORMAL",
    "INPUT_INDEX",
    "MATH",
    "VECTOR_MATH",
    "COMBINE_XYZ",
    "SEPARATE_XYZ",
    "MAP_RANGE",
    "NOISE_TEXTURE",
    "RANDOM_VALUE",
    "VALUE",
}


class LiveProtocolError(ValueError):
    pass


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LiveProtocolError(f"{field} must be a finite number")
    return float(value)


def _vec3(value: Any, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        raise LiveProtocolError(f"{field} must contain three numbers")
    return [_number(component, field) for component in value]


def _vec2(value: Any, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 2:
        raise LiveProtocolError(f"{field} must contain two numbers")
    return [_number(component, field) for component in value]


def _vec4(value: Any, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise LiveProtocolError(f"{field} must contain four numbers")
    return [_number(component, field) for component in value]


def _integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LiveProtocolError(f"{field} must be an integer")
    if value < -1_048_574 or value > 1_048_574:
        raise LiveProtocolError(f"{field} is outside Blender's scene frame range")
    return value


def _text_array(value: Any, field: str, *, allow_empty: bool) -> list[str]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "an array" if allow_empty else "a non-empty array"
        raise LiveProtocolError(f"{field} must be {qualifier}")
    return [_text(item, field) for item in value]


def _material_node_value(value: Any, field: str):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return _number(value, field)
    if isinstance(value, list) and len(value) in {2, 3, 4}:
        return [_number(component, field) for component in value]
    raise LiveProtocolError(f"{field} must be a number, boolean, or 2-4 component value")


def _material_node_endpoint(value: Any, field: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise LiveProtocolError(f"{field} must be an object")
    return {
        "nodeRef": _text(value.get("nodeRef"), f"{field}.nodeRef"),
        "socketRef": _text(value.get("socketRef"), f"{field}.socketRef"),
    }


def _curve_points(value: Any, field: str) -> list[list[float]]:
    if not isinstance(value, list) or len(value) < 2 or len(value) > 4_096:
        raise LiveProtocolError(f"{field} must contain 2-4096 points")
    return [_vec3(point, field) for point in value]


def _unit_interval(value: Any, field: str) -> float:
    number = _number(value, field)
    if number < 0.0 or number > 1.0:
        raise LiveProtocolError(f"{field} must be between 0 and 1")
    return number


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LiveProtocolError(f"{field} must be a non-empty string")
    return value.strip()


def _operation(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise LiveProtocolError(f"operations[{index}] must be an object")
    op = _text(value.get("op"), f"operations[{index}].op")
    if op not in SUPPORTED_OPERATIONS:
        raise LiveProtocolError(f"unsupported operation: {op}")
    normalized = dict(value)
    normalized["op"] = op
    if op in {
        "import_asset",
        "create_primitive",
        "create_curve",
        "set_curve_data",
        "create_text",
        "set_text_data",
        "update_transform",
        "set_object_name",
        "set_object_visibility",
        "delete_object",
        "duplicate_object",
        "create_camera",
        "set_camera_data",
        "create_light",
        "set_light_data",
        "create_opening",
        "set_active_camera",
        "set_parent",
        "add_constraint",
        "remove_constraint",
        "inspect_object",
        "select_mesh_elements",
        "assign_material",
        "project_uv",
        "create_material_node",
        "delete_material_node",
        "set_material_node_input",
        "connect_material_nodes",
        "disconnect_material_node_input",
        "ensure_geometry_nodes",
        "create_geometry_node",
        "delete_geometry_node",
        "set_geometry_node_input",
        "connect_geometry_nodes",
        "disconnect_geometry_node_input",
        "select_pose_bones",
        "set_pose_bone_transform",
        "apply_pose_offsets",
        "create_action",
        "set_active_action",
        "insert_pose_keyframes",
        "delete_pose_keyframes",
        "import_mixamo_action",
        "create_nla_track",
        "add_nla_strip",
        "update_nla_strip",
        "remove_nla_strip",
        "capture_render",
    }:
        if op != "capture_render":
            normalized["id"] = _text(value.get("id"), f"operations[{index}].id")
    if op == "import_asset":
        normalized["directorId"] = _text(
            value.get("directorId"), f"operations[{index}].directorId"
        )
        normalized["assetId"] = _text(
            value.get("assetId"), f"operations[{index}].assetId"
        )
        normalized["sourceUrl"] = _text(
            value.get("sourceUrl"), f"operations[{index}].sourceUrl"
        )
        normalized["fileName"] = _text(
            value.get("fileName"), f"operations[{index}].fileName"
        )
        normalized["name"] = _text(
            value.get("name"), f"operations[{index}].name"
        )
        kind = value.get("kind")
        if kind not in {"prop", "character", "scene"}:
            raise LiveProtocolError(f"operations[{index}].kind is not supported")
        normalized["kind"] = kind
        normalization = value.get("normalization", "auto")
        if normalization not in {"auto", "preserve"}:
            raise LiveProtocolError(
                f"operations[{index}].normalization must be auto or preserve"
            )
        normalized["normalization"] = normalization
        grounded = value.get("grounded", False)
        if not isinstance(grounded, bool):
            raise LiveProtocolError(f"operations[{index}].grounded must be a boolean")
        normalized["grounded"] = grounded
        if value.get("targetHeightM") is not None:
            target_height = _number(
                value.get("targetHeightM"), f"operations[{index}].targetHeightM"
            )
            if target_height <= 0:
                raise LiveProtocolError(
                    f"operations[{index}].targetHeightM must be positive"
                )
            normalized["targetHeightM"] = target_height
    if op == "set_object_name":
        normalized["name"] = _text(value.get("name"), f"operations[{index}].name")
    if op == "set_object_visibility":
        if not isinstance(value.get("visible"), bool):
            raise LiveProtocolError(f"operations[{index}].visible must be a boolean")
        normalized["visible"] = value["visible"]
    if op == "set_world_environment":
        normalized["color"] = [
            _unit_interval(component, f"operations[{index}].color")
            for component in _vec3(
                value.get("color", [0.05, 0.05, 0.05]),
                f"operations[{index}].color",
            )
        ]
        strength = _number(value.get("strength", 1.0), f"operations[{index}].strength")
        if strength < 0.0 or strength > 1_000.0:
            raise LiveProtocolError(f"operations[{index}].strength must be between 0 and 1000")
        normalized["strength"] = strength
    if op == "set_camera_data":
        projection_type = value.get("projectionType")
        if projection_type not in {"PERSPECTIVE", "ORTHOGRAPHIC"}:
            raise LiveProtocolError(
                f"operations[{index}].projectionType is not supported"
            )
        sensor_fit = value.get("sensorFit")
        if sensor_fit not in {"AUTO", "HORIZONTAL", "VERTICAL"}:
            raise LiveProtocolError(f"operations[{index}].sensorFit is not supported")
        normalized["projectionType"] = projection_type
        normalized["sensorFit"] = sensor_fit
        for field in (
            "focalLengthMm",
            "sensorWidthMm",
            "sensorHeightMm",
            "clipStart",
            "clipEnd",
            "orthographicScale",
        ):
            number = _number(value.get(field), f"operations[{index}].{field}")
            if number <= 0:
                raise LiveProtocolError(f"operations[{index}].{field} must be positive")
            normalized[field] = number
        if normalized["clipEnd"] <= normalized["clipStart"]:
            raise LiveProtocolError(
                f"operations[{index}].clipEnd must be greater than clipStart"
            )
        normalized["shiftX"] = _number(
            value.get("shiftX"), f"operations[{index}].shiftX"
        )
        normalized["shiftY"] = _number(
            value.get("shiftY"), f"operations[{index}].shiftY"
        )
    if op == "set_light_data":
        kind = value.get("kind")
        if kind not in {"area", "point", "spot", "sun"}:
            raise LiveProtocolError(f"operations[{index}].kind is not supported")
        normalized["kind"] = kind
        normalized["color"] = [
            _unit_interval(component, f"operations[{index}].color")
            for component in _vec3(value.get("color"), f"operations[{index}].color")
        ]
        for field in ("energy", "size"):
            number = _number(value.get(field), f"operations[{index}].{field}")
            if number < 0:
                raise LiveProtocolError(f"operations[{index}].{field} must be non-negative")
            normalized[field] = number
    if op == "bind_director_project":
        normalized["projectId"] = _text(
            value.get("projectId"), f"operations[{index}].projectId"
        )
    if op == "capture_render" and value.get("cameraId") is not None:
        normalized["cameraId"] = _text(
            value.get("cameraId"), f"operations[{index}].cameraId"
        )
    if op in {"describe_operator", "invoke_operator"}:
        normalized["operator"] = _text(
            value.get("operator"), f"operations[{index}].operator"
        )
    if op == "duplicate_object":
        normalized["newId"] = _text(value.get("newId"), f"operations[{index}].newId")
    if op == "create_blockout":
        normalized["idPrefix"] = _text(value.get("idPrefix"), f"operations[{index}].idPrefix")
    if op == "create_opening":
        normalized["targetId"] = _text(value.get("targetId"), f"operations[{index}].targetId")
    if op == "set_parent" and value.get("parentId") is not None:
        normalized["parentId"] = _text(value.get("parentId"), f"operations[{index}].parentId")
    if op == "add_constraint":
        normalized["targetId"] = _text(value.get("targetId"), f"operations[{index}].targetId")
    if op == "remove_constraint":
        normalized["constraintName"] = _text(
            value.get("constraintName"), f"operations[{index}].constraintName"
        )
    if op == "move_to_collection":
        identifiers = value.get("ids")
        if not isinstance(identifiers, list) or not identifiers:
            raise LiveProtocolError(f"operations[{index}].ids must be a non-empty array")
        normalized["ids"] = [
            _text(identifier, f"operations[{index}].ids") for identifier in identifiers
        ]
        normalized["collection"] = _text(
            value.get("collection"), f"operations[{index}].collection"
        )
    if op == "set_selection":
        identifiers = value.get("selectedIds", [])
        if not isinstance(identifiers, list):
            raise LiveProtocolError(f"operations[{index}].selectedIds must be an array")
        normalized["selectedIds"] = [
            _text(identifier, f"operations[{index}].selectedIds") for identifier in identifiers
        ]
        if value.get("activeId") is not None:
            normalized["activeId"] = _text(
                value.get("activeId"), f"operations[{index}].activeId"
            )
    if op in {
        "assign_material",
        "create_material_node",
        "delete_material_node",
        "set_material_node_input",
        "connect_material_nodes",
        "disconnect_material_node_input",
    }:
        normalized["materialName"] = _text(
            value.get("materialName"), f"operations[{index}].materialName"
        )
    if op in {
        "ensure_geometry_nodes",
        "create_geometry_node",
        "delete_geometry_node",
        "set_geometry_node_input",
        "connect_geometry_nodes",
        "disconnect_geometry_node_input",
    }:
        normalized["modifierName"] = _text(
            value.get("modifierName", "WorldEngine Geometry"),
            f"operations[{index}].modifierName",
        )
    if op in {"create_curve", "set_curve_data"}:
        curve_type = value.get("curveType", "POLY")
        if curve_type not in {"POLY", "BEZIER"}:
            raise LiveProtocolError(f"operations[{index}].curveType is not supported")
        normalized["curveType"] = curve_type
        normalized["points"] = _curve_points(
            value.get("points"), f"operations[{index}].points"
        )
        if op == "create_curve":
            normalized["cyclic"] = bool(value.get("cyclic", False))
            normalized["bevelDepth"] = _number(
                value.get("bevelDepth", 0), f"operations[{index}].bevelDepth"
            )
            normalized["bevelResolution"] = int(value.get("bevelResolution", 0))
        else:
            if "cyclic" in value:
                if not isinstance(value["cyclic"], bool):
                    raise LiveProtocolError(f"operations[{index}].cyclic must be a boolean")
                normalized["cyclic"] = value["cyclic"]
            for field in ("bevelDepth", "bevelResolution"):
                if field in value:
                    normalized[field] = (
                        _number(value[field], f"operations[{index}].{field}")
                        if field == "bevelDepth"
                        else int(value[field])
                    )
    if op in {"create_text", "set_text_data"}:
        text = value.get("text")
        if not isinstance(text, str):
            raise LiveProtocolError(f"operations[{index}].text must be a string")
        normalized["text"] = text
        defaults = {
            "size": 1.0,
            "extrude": 0.0,
            "bevelDepth": 0.0,
            "alignX": "LEFT",
            "alignY": "TOP_BASELINE",
        }
        for field, default in defaults.items():
            if op == "create_text" or field in value:
                item = value.get(field, default)
                if field in {"alignX", "alignY"}:
                    allowed = {"LEFT", "CENTER", "RIGHT"} if field == "alignX" else {"TOP_BASELINE", "CENTER", "BOTTOM"}
                    if item not in allowed:
                        raise LiveProtocolError(f"operations[{index}].{field} is not supported")
                    normalized[field] = item
                else:
                    normalized[field] = _number(item, f"operations[{index}].{field}")
    if op == "assign_material":
        create_if_missing = value.get("createIfMissing", True)
        if not isinstance(create_if_missing, bool):
            raise LiveProtocolError(
                f"operations[{index}].createIfMissing must be a boolean"
            )
        normalized["createIfMissing"] = create_if_missing
        face_scope = value.get("faceScope", "ALL")
        if face_scope not in {"PRESERVE", "ALL", "SELECTED"}:
            raise LiveProtocolError(
                f"operations[{index}].faceScope must be PRESERVE, ALL, or SELECTED"
            )
        normalized["faceScope"] = face_scope
        parameters = value.get("parameters", {})
        if not isinstance(parameters, dict):
            raise LiveProtocolError(f"operations[{index}].parameters must be an object")
        normalized_parameters = dict(parameters)
        if "baseColor" in parameters:
            base_color = _vec3(
                parameters["baseColor"], f"operations[{index}].parameters.baseColor"
            )
            normalized_parameters["baseColor"] = [
                _unit_interval(
                    component,
                    f"operations[{index}].parameters.baseColor",
                )
                for component in base_color
            ]
        for field in ("roughness", "metallic", "alpha"):
            if field in parameters:
                normalized_parameters[field] = _unit_interval(
                    parameters[field], f"operations[{index}].parameters.{field}"
                )
        normalized["parameters"] = normalized_parameters
    if op == "project_uv":
        method = value.get("method", "SMART")
        if method not in {"SMART", "UNWRAP", "CUBE"}:
            raise LiveProtocolError(
                f"operations[{index}].method must be SMART, UNWRAP, or CUBE"
            )
        normalized["method"] = method
        normalized["uvLayerName"] = _text(
            value.get("uvLayerName", "UVMap"), f"operations[{index}].uvLayerName"
        )
        replace_existing = value.get("replaceExisting", False)
        if not isinstance(replace_existing, bool):
            raise LiveProtocolError(
                f"operations[{index}].replaceExisting must be a boolean"
            )
        normalized["replaceExisting"] = replace_existing
    if op in {
        "create_material_node",
        "delete_material_node",
        "set_material_node_input",
        "disconnect_material_node_input",
    }:
        normalized["nodeRef"] = _text(
            value.get("nodeRef"), f"operations[{index}].nodeRef"
        )
    if op in {
        "create_geometry_node",
        "delete_geometry_node",
        "set_geometry_node_input",
        "disconnect_geometry_node_input",
    }:
        normalized["nodeRef"] = _text(
            value.get("nodeRef"), f"operations[{index}].nodeRef"
        )
    if op == "create_material_node":
        node_type = value.get("nodeType")
        if node_type not in MATERIAL_NODE_TYPES:
            raise LiveProtocolError(
                f"operations[{index}].nodeType is not a supported material node"
            )
        normalized["nodeType"] = node_type
        if "location" in value:
            normalized["location"] = _vec2(
                value["location"], f"operations[{index}].location"
            )
        if "label" in value:
            label = value["label"]
            if not isinstance(label, str):
                raise LiveProtocolError(f"operations[{index}].label must be a string")
            normalized["label"] = label.strip()
    if op == "create_geometry_node":
        node_type = value.get("nodeType")
        if node_type not in GEOMETRY_NODE_TYPES:
            raise LiveProtocolError(
                f"operations[{index}].nodeType is not a supported geometry node"
            )
        normalized["nodeType"] = node_type
        if "location" in value:
            normalized["location"] = _vec2(
                value["location"], f"operations[{index}].location"
            )
        if "label" in value:
            if not isinstance(value["label"], str):
                raise LiveProtocolError(f"operations[{index}].label must be a string")
            normalized["label"] = value["label"].strip()
        node_properties = value.get("nodeProperties")
        if node_properties is not None:
            if not isinstance(node_properties, dict):
                raise LiveProtocolError(
                    f"operations[{index}].nodeProperties must be an object"
                )
            normalized_node_properties = {}
            for key, item in node_properties.items():
                if not isinstance(key, str) or not key.strip():
                    raise LiveProtocolError(
                        f"operations[{index}].nodeProperties keys must be non-empty strings"
                    )
                if not isinstance(item, (str, bool)) and (
                    not isinstance(item, (int, float)) or not math.isfinite(item)
                ):
                    raise LiveProtocolError(
                        f"operations[{index}].nodeProperties.{key} must be a string, "
                        "boolean, or finite number"
                    )
                normalized_node_properties[key.strip()] = item
            normalized["nodeProperties"] = normalized_node_properties
    if op == "set_material_node_input":
        normalized["inputSocketRef"] = _text(
            value.get("inputSocketRef"), f"operations[{index}].inputSocketRef"
        )
        normalized["value"] = _material_node_value(
            value.get("value"), f"operations[{index}].value"
        )
    if op == "set_geometry_node_input":
        normalized["inputSocketRef"] = _text(
            value.get("inputSocketRef"), f"operations[{index}].inputSocketRef"
        )
        normalized["value"] = _material_node_value(
            value.get("value"), f"operations[{index}].value"
        )
    if op == "connect_material_nodes":
        normalized["from"] = _material_node_endpoint(
            value.get("from"), f"operations[{index}].from"
        )
        normalized["to"] = _material_node_endpoint(
            value.get("to"), f"operations[{index}].to"
        )
    if op == "connect_geometry_nodes":
        normalized["from"] = _material_node_endpoint(
            value.get("from"), f"operations[{index}].from"
        )
        normalized["to"] = _material_node_endpoint(
            value.get("to"), f"operations[{index}].to"
        )
    if op == "disconnect_material_node_input":
        normalized["inputSocketRef"] = _text(
            value.get("inputSocketRef"), f"operations[{index}].inputSocketRef"
        )
    if op == "disconnect_geometry_node_input":
        normalized["inputSocketRef"] = _text(
            value.get("inputSocketRef"), f"operations[{index}].inputSocketRef"
        )
    if op == "select_pose_bones":
        normalized["boneRefs"] = _text_array(
            value.get("boneRefs", []),
            f"operations[{index}].boneRefs",
            allow_empty=True,
        )
        if value.get("activeBoneRef") is not None:
            normalized["activeBoneRef"] = _text(
                value.get("activeBoneRef"), f"operations[{index}].activeBoneRef"
            )
        action = value.get("action", "SET")
        if action not in {"SET", "ADD", "SUBTRACT", "ALL", "NONE"}:
            raise LiveProtocolError(f"operations[{index}].action is not supported")
        normalized["action"] = action
    if op == "set_pose_bone_transform":
        normalized["boneRef"] = _text(
            value.get("boneRef"), f"operations[{index}].boneRef"
        )
        local = value.get("local")
        if not isinstance(local, dict) or not any(
            field in local for field in ("location", "rotationQuaternion", "scale")
        ):
            raise LiveProtocolError(
                f"operations[{index}].local must include a pose transform channel"
            )
        normalized_local = {}
        for field in ("location", "scale"):
            if field in local:
                normalized_local[field] = _vec3(
                    local[field], f"operations[{index}].local.{field}"
                )
        if "rotationQuaternion" in local:
            normalized_local["rotationQuaternion"] = _vec4(
                local["rotationQuaternion"],
                f"operations[{index}].local.rotationQuaternion",
            )
        normalized["local"] = normalized_local
    if op == "apply_pose_offsets":
        normalized["stateToken"] = _text(
            value.get("stateToken"), f"operations[{index}].stateToken"
        )
        reset_pose = value.get("resetPose", False)
        if not isinstance(reset_pose, bool):
            raise LiveProtocolError(
                f"operations[{index}].resetPose must be a boolean"
            )
        bones = value.get("bones")
        if not isinstance(bones, list) or not bones:
            raise LiveProtocolError(
                f"operations[{index}].bones must be a non-empty array"
            )
        normalized_bones = []
        for bone_index, bone in enumerate(bones):
            if not isinstance(bone, dict):
                raise LiveProtocolError(
                    f"operations[{index}].bones[{bone_index}] must be an object"
                )
            normalized_bone = {
                "boneRef": _text(
                    bone.get("boneRef"),
                    f"operations[{index}].bones[{bone_index}].boneRef",
                ),
                "rotationOffsetQuaternion": _vec4(
                    bone.get("rotationOffsetQuaternion"),
                    f"operations[{index}].bones[{bone_index}].rotationOffsetQuaternion",
                ),
            }
            if "locationOffset" in bone:
                normalized_bone["locationOffset"] = _vec3(
                    bone["locationOffset"],
                    f"operations[{index}].bones[{bone_index}].locationOffset",
                )
            normalized_bones.append(normalized_bone)
        normalized["resetPose"] = reset_pose
        normalized["bones"] = normalized_bones
    if op in {
        "create_action",
        "set_active_action",
        "insert_pose_keyframes",
        "delete_pose_keyframes",
    }:
        normalized["actionName"] = _text(
            value.get("actionName"), f"operations[{index}].actionName"
        )
    if op in {"set_scene_frame", "insert_pose_keyframes", "delete_pose_keyframes"}:
        normalized["frame"] = _integer(
            value.get("frame"), f"operations[{index}].frame"
        )
    if op in {"insert_pose_keyframes", "delete_pose_keyframes"}:
        normalized["boneRefs"] = _text_array(
            value.get("boneRefs"),
            f"operations[{index}].boneRefs",
            allow_empty=False,
        )
        channels = value.get("channels")
        if not isinstance(channels, list) or not channels:
            raise LiveProtocolError(
                f"operations[{index}].channels must be a non-empty array"
            )
        if any(channel not in {"LOCATION", "ROTATION", "SCALE"} for channel in channels):
            raise LiveProtocolError(f"operations[{index}].channels contains an unsupported channel")
        normalized["channels"] = list(channels)
    if op == "insert_pose_keyframes":
        interpolation = value.get("interpolation", "BEZIER")
        if interpolation not in {"CONSTANT", "LINEAR", "BEZIER"}:
            raise LiveProtocolError(f"operations[{index}].interpolation is not supported")
        normalized["interpolation"] = interpolation
    if op == "import_mixamo_action":
        normalized["motionId"] = _text(
            value.get("motionId"), f"operations[{index}].motionId"
        )
        if value.get("actionName") is not None:
            normalized["actionName"] = _text(
                value.get("actionName"), f"operations[{index}].actionName"
            )
        root_motion = value.get("rootMotion", "IN_PLACE")
        if root_motion not in {"IN_PLACE", "AUTHORED"}:
            raise LiveProtocolError(
                f"operations[{index}].rootMotion is not supported"
            )
        normalized["rootMotion"] = root_motion
        replace_existing = value.get("replaceExisting", False)
        if not isinstance(replace_existing, bool):
            raise LiveProtocolError(
                f"operations[{index}].replaceExisting must be a boolean"
            )
        normalized["replaceExisting"] = replace_existing
    if op in {"create_nla_track", "add_nla_strip", "update_nla_strip", "remove_nla_strip"}:
        normalized["trackName"] = _text(
            value.get("trackName"), f"operations[{index}].trackName"
        )
    if op in {"add_nla_strip", "update_nla_strip", "remove_nla_strip"}:
        normalized["stripName"] = _text(
            value.get("stripName"), f"operations[{index}].stripName"
        )
    if op == "add_nla_strip":
        normalized["actionName"] = _text(
            value.get("actionName"), f"operations[{index}].actionName"
        )
        normalized["startFrame"] = _integer(
            value.get("startFrame"), f"operations[{index}].startFrame"
        )
    if op in {"add_nla_strip", "update_nla_strip"}:
        if op == "add_nla_strip" or "blendMode" in value:
            blend_mode = value.get("blendMode", "REPLACE")
            if blend_mode not in {"REPLACE", "ADD", "COMBINE"}:
                raise LiveProtocolError(
                    f"operations[{index}].blendMode is not supported"
                )
            normalized["blendMode"] = blend_mode
        if op == "add_nla_strip" or "influence" in value:
            normalized["influence"] = _unit_interval(
                value.get("influence", 1), f"operations[{index}].influence"
            )
        if op == "add_nla_strip" or "repeat" in value:
            repeat = _number(value.get("repeat", 1), f"operations[{index}].repeat")
            if repeat <= 0 or repeat > 1_000:
                raise LiveProtocolError(
                    f"operations[{index}].repeat must be between 0 and 1000"
                )
            normalized["repeat"] = repeat
        if op == "add_nla_strip" or "scale" in value:
            scale = _number(value.get("scale", 1), f"operations[{index}].scale")
            if scale <= 0 or scale > 10:
                raise LiveProtocolError(
                    f"operations[{index}].scale must be between 0 and 10"
                )
            normalized["scale"] = scale
    if op == "invoke_operator" and value.get("context") is not None:
        context = value["context"]
        if not isinstance(context, dict):
            raise LiveProtocolError(f"operations[{index}].context must be an object")
        normalized_context = dict(context)
        if context.get("activeId") is not None:
            normalized_context["activeId"] = _text(
                context.get("activeId"), f"operations[{index}].context.activeId"
            )
        selected = context.get("selectedIds", [])
        if not isinstance(selected, list):
            raise LiveProtocolError(f"operations[{index}].context.selectedIds must be an array")
        normalized_context["selectedIds"] = [
            _text(identifier, f"operations[{index}].context.selectedIds")
            for identifier in selected
        ]
        normalized["context"] = normalized_context
    if op == "set_rna_property":
        target = value.get("target")
        path = value.get("path")
        if not isinstance(target, dict):
            raise LiveProtocolError(f"operations[{index}].target must be an object")
        if not isinstance(path, list) or not path:
            raise LiveProtocolError(f"operations[{index}].path must be a non-empty array")
        normalized["target"] = dict(target)
        normalized["path"] = list(path)
    if op == "execute_code":
        code = value.get("code")
        if not isinstance(code, str) or not code.strip():
            raise LiveProtocolError(
                f"operations[{index}].code must be a non-empty string"
            )
        if len(code) > 100_000:
            raise LiveProtocolError(
                f"operations[{index}].code must be at most 100000 characters"
            )
        normalized["code"] = code
    if op == "polyhaven_search":
        asset_type = value.get("assetType", "models")
        if asset_type not in {"hdris", "textures", "models", "all"}:
            raise LiveProtocolError(
                f"operations[{index}].assetType is not supported"
            )
        query = value.get("query", "")
        if query is None:
            query = ""
        if not isinstance(query, str) or len(query) > 240:
            raise LiveProtocolError(
                f"operations[{index}].query must be a string of at most 240 characters"
            )
        limit = _integer(value.get("limit", 20), f"operations[{index}].limit")
        if limit < 1 or limit > 50:
            raise LiveProtocolError(
                f"operations[{index}].limit must be between 1 and 50"
            )
        normalized["assetType"] = asset_type
        normalized["query"] = query.strip()
        normalized["limit"] = limit
        if value.get("categories") is not None:
            categories = _text(value.get("categories"), f"operations[{index}].categories")
            if len(categories) > 240:
                raise LiveProtocolError(
                    f"operations[{index}].categories must be at most 240 characters"
                )
            normalized["categories"] = categories
    if op == "polyhaven_import":
        normalized["assetId"] = _text(value.get("assetId"), f"operations[{index}].assetId")
        asset_type = value.get("assetType")
        if asset_type not in {"hdris", "textures", "models"}:
            raise LiveProtocolError(
                f"operations[{index}].assetType is not supported"
            )
        normalized["assetType"] = asset_type
        resolution = value.get("resolution", "1k")
        if resolution not in {"1k", "2k", "4k"}:
            raise LiveProtocolError(
                f"operations[{index}].resolution is not supported"
            )
        normalized["resolution"] = resolution
        if value.get("fileFormat") is not None:
            file_format = _text(value.get("fileFormat"), f"operations[{index}].fileFormat")
            if len(file_format) > 40:
                raise LiveProtocolError(
                    f"operations[{index}].fileFormat must be at most 40 characters"
                )
            normalized["fileFormat"] = file_format
        if value.get("objectId") is not None:
            normalized["objectId"] = _text(
                value.get("objectId"), f"operations[{index}].objectId"
            )
        if value.get("targetHeightM") is not None:
            target_height = _number(
                value.get("targetHeightM"), f"operations[{index}].targetHeightM"
            )
            if target_height <= 0:
                raise LiveProtocolError(
                    f"operations[{index}].targetHeightM must be positive"
                )
            normalized["targetHeightM"] = target_height
    if op == "sketchfab_search":
        query = _text(value.get("query"), f"operations[{index}].query")
        if len(query) > 240:
            raise LiveProtocolError(
                f"operations[{index}].query must be at most 240 characters"
            )
        count = _integer(value.get("count", 5), f"operations[{index}].count")
        if count < 1 or count > 24:
            raise LiveProtocolError(
                f"operations[{index}].count must be between 1 and 24"
            )
        normalized["query"] = query
        normalized["count"] = count
    if op == "sketchfab_import":
        uid = _text(value.get("uid"), f"operations[{index}].uid")
        if len(uid) < 8 or len(uid) > 64 or not all(
            character.isalnum() or character in "-_" for character in uid
        ):
            raise LiveProtocolError(
                f"operations[{index}].uid must be a Sketchfab model id"
            )
        normalized["uid"] = uid
        if value.get("objectId") is not None:
            normalized["objectId"] = _text(
                value.get("objectId"), f"operations[{index}].objectId"
            )
        target_size = _number(value.get("targetSizeM", 1), f"operations[{index}].targetSizeM")
        if target_size <= 0 or target_size > 50:
            raise LiveProtocolError(
                f"operations[{index}].targetSizeM must be between 0 and 50"
            )
        normalized["targetSizeM"] = target_size
    if op in {
        "add_modifier",
        "set_modifier",
        "remove_modifier",
        "reorder_modifier",
        "apply_modifier",
    }:
        normalized["id"] = _text(value.get("id"), f"operations[{index}].id")
        modifier_name = _text(
            value.get("modifierName"), f"operations[{index}].modifierName"
        )
        if len(modifier_name) > 240:
            raise LiveProtocolError(
                f"operations[{index}].modifierName must be at most 240 characters"
            )
        normalized["modifierName"] = modifier_name
        if op == "add_modifier":
            modifier_type = value.get("modifierType")
            if modifier_type not in {
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
            }:
                raise LiveProtocolError(
                    f"operations[{index}].modifierType is not a supported modifier type"
                )
            normalized["modifierType"] = modifier_type
        if op in {"add_modifier", "set_modifier"}:
            properties = value.get("properties", {}) if op == "add_modifier" else value.get("properties")
            if not isinstance(properties, dict):
                raise LiveProtocolError(f"operations[{index}].properties must be an object")
            if op == "set_modifier" and not properties:
                raise LiveProtocolError(
                    f"operations[{index}].properties must be a non-empty object"
                )
            for key in properties:
                if not isinstance(key, str) or not key.strip():
                    raise LiveProtocolError(
                        f"operations[{index}].properties keys must be non-empty strings"
                    )
            normalized["properties"] = dict(properties)
        if op == "reorder_modifier":
            stack_index = _integer(value.get("index"), f"operations[{index}].index")
            if stack_index < 0 or stack_index > 127:
                raise LiveProtocolError(
                    f"operations[{index}].index must be between 0 and 127"
                )
            normalized["index"] = stack_index
    if op == "query_spatial":
        queries = value.get("queries")
        if not isinstance(queries, list) or not 1 <= len(queries) <= 32:
            raise LiveProtocolError(
                f"operations[{index}].queries must contain 1-32 queries"
            )
        normalized_queries = []
        for query_index, query in enumerate(queries):
            prefix = f"operations[{index}].queries[{query_index}]"
            if not isinstance(query, dict):
                raise LiveProtocolError(f"{prefix} must be an object")
            kind = query.get("kind")
            if kind not in {"RAYCAST", "CLOSEST_POINT", "OVERLAP", "GROUND", "NAME"}:
                raise LiveProtocolError(f"{prefix}.kind is not supported")
            normalized_query: dict[str, Any] = {"kind": kind}
            if kind in {"RAYCAST", "GROUND"} and query.get("excludeIds") is not None:
                exclude_ids = query["excludeIds"]
                if not isinstance(exclude_ids, list) or len(exclude_ids) > 64:
                    raise LiveProtocolError(
                        f"{prefix}.excludeIds must be an array of at most 64 ids"
                    )
                normalized_query["excludeIds"] = [
                    _text(identifier, f"{prefix}.excludeIds")
                    for identifier in exclude_ids
                ]
            if kind == "RAYCAST":
                normalized_query["origin"] = _vec3(query.get("origin"), f"{prefix}.origin")
                direction = _vec3(query.get("direction"), f"{prefix}.direction")
                if all(component == 0.0 for component in direction):
                    raise LiveProtocolError(f"{prefix}.direction must be a non-zero vector")
                normalized_query["direction"] = direction
                max_distance = _number(
                    query.get("maxDistance", 1000), f"{prefix}.maxDistance"
                )
                if max_distance <= 0 or max_distance > 100_000:
                    raise LiveProtocolError(
                        f"{prefix}.maxDistance must be positive and at most 100000"
                    )
                normalized_query["maxDistance"] = max_distance
            elif kind == "CLOSEST_POINT":
                normalized_query["point"] = _vec3(query.get("point"), f"{prefix}.point")
                normalized_query["targetId"] = _text(query.get("targetId"), f"{prefix}.targetId")
            elif kind == "OVERLAP":
                normalized_query["idA"] = _text(query.get("idA"), f"{prefix}.idA")
                normalized_query["idB"] = _text(query.get("idB"), f"{prefix}.idB")
            elif kind == "NAME":
                name_pattern = query.get("namePattern", query.get("name_pattern", query.get("query")))
                normalized_query["namePattern"] = _text(name_pattern, f"{prefix}.namePattern")
                max_results = _integer(query.get("maxResults", 50), f"{prefix}.maxResults")
                if max_results < 1 or max_results > 200:
                    raise LiveProtocolError(f"{prefix}.maxResults must be between 1 and 200")
                normalized_query["maxResults"] = max_results
            else:
                normalized_query["id"] = _text(query.get("id"), f"{prefix}.id")
            normalized_queries.append(normalized_query)
        normalized["queries"] = normalized_queries
    if op == "create_primitive":
        primitive = value.get("primitive")
        if isinstance(value.get("transform"), dict) and "scale" in value["transform"]:
            raise LiveProtocolError(
                f"operations[{index}].transform.scale is not valid for create_primitive; use dimensions for metric size"
            )
        if value.get("directorId") is not None:
            normalized["directorId"] = _text(
                value.get("directorId"), f"operations[{index}].directorId"
            )
        grounded = value.get("grounded", False)
        if not isinstance(grounded, bool):
            raise LiveProtocolError(f"operations[{index}].grounded must be a boolean")
        normalized["grounded"] = grounded
        if value.get("segments") is not None:
            segments = value["segments"]
            if isinstance(segments, bool) or not isinstance(segments, int):
                raise LiveProtocolError(f"operations[{index}].segments must be an integer")
            if primitive == "ico_sphere":
                if segments < 1 or segments > 6:
                    raise LiveProtocolError(
                        f"operations[{index}].segments selects ico_sphere subdivisions "
                        "and must be between 1 and 6"
                    )
            elif primitive in {"sphere", "uv_sphere", "cylinder", "cone"}:
                if segments < 3 or segments > 256:
                    raise LiveProtocolError(
                        f"operations[{index}].segments must be between 3 and 256"
                    )
            else:
                raise LiveProtocolError(
                    f"operations[{index}].segments is not supported for primitive: {primitive}"
                )
            normalized["segments"] = segments
        if value.get("rings") is not None:
            rings = value["rings"]
            if isinstance(rings, bool) or not isinstance(rings, int):
                raise LiveProtocolError(f"operations[{index}].rings must be an integer")
            if primitive not in {"sphere", "uv_sphere"}:
                raise LiveProtocolError(
                    f"operations[{index}].rings is only supported for sphere and uv_sphere"
                )
            if rings < 3 or rings > 128:
                raise LiveProtocolError(f"operations[{index}].rings must be between 3 and 128")
            normalized["rings"] = rings
    if op in {"set_geometry_modifier_input", "assign_geometry_node_group"}:
        normalized["id"] = _text(value.get("id"), f"operations[{index}].id")
        normalized["modifierName"] = _text(
            value.get("modifierName", "WorldEngine Geometry"),
            f"operations[{index}].modifierName",
        )
    if op == "set_geometry_modifier_input":
        normalized["inputRef"] = _text(value.get("inputRef"), f"operations[{index}].inputRef")
        input_value = value.get("value")
        if not isinstance(input_value, bool) and (
            not isinstance(input_value, (int, float)) or not math.isfinite(input_value)
        ):
            raise LiveProtocolError(
                f"operations[{index}].value must be a finite number or boolean"
            )
        normalized["value"] = input_value
    if op == "assign_geometry_node_group":
        normalized["nodeGroupName"] = _text(
            value.get("nodeGroupName"), f"operations[{index}].nodeGroupName"
        )
    for field in ("position", "origin", "dimensions", "color"):
        if field in value:
            normalized[field] = _vec3(value[field], f"operations[{index}].{field}")
    if op in {"create_camera", "create_light"} and "target" in value:
        normalized["target"] = _vec3(value["target"], f"operations[{index}].target")
    transform = value.get("transform")
    if transform is not None:
        if not isinstance(transform, dict):
            raise LiveProtocolError(f"operations[{index}].transform must be an object")
        normalized["transform"] = {
            field: _vec3(component, f"operations[{index}].transform.{field}")
            for field, component in transform.items()
            if field in {"position", "rotation", "scale"}
        }
    return normalized


def parse_live_batch(body: bytes | str) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise LiveProtocolError("command body must be valid JSON") from error
    if not isinstance(payload, dict) or payload.get("contract") != CONTRACT:
        raise LiveProtocolError(f"contract must be {CONTRACT}")
    request_id = _text(payload.get("requestId"), "requestId")
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise LiveProtocolError("operations must be a non-empty array")
    normalized_operations = [_operation(value, index) for index, value in enumerate(operations)]
    expected_scene_epoch = payload.get("expectedSceneEpoch")
    scene_bound = any(
        operation["op"] not in READ_ONLY_LIVE_OPERATIONS
        and operation["op"] not in PROJECT_LIFECYCLE_OPERATIONS
        for operation in normalized_operations
    )
    if expected_scene_epoch is not None:
        expected_scene_epoch = _text(expected_scene_epoch, "expectedSceneEpoch")
    elif scene_bound:
        raise LiveProtocolError("expectedSceneEpoch is required for scene-bound command batches")
    expected_revision = payload.get("expectedRevision")
    if expected_revision is not None and (not isinstance(expected_revision, int) or expected_revision < 0):
        raise LiveProtocolError("expectedRevision must be a non-negative integer")
    return {
        "contract": CONTRACT,
        "request_id": request_id,
        "job_id": request_id,
        "expected_scene_epoch": expected_scene_epoch,
        "expected_revision": expected_revision,
        "operations": normalized_operations,
    }


__all__ = ("CONTRACT", "LiveProtocolError", "SUPPORTED_OPERATIONS", "parse_live_batch")
