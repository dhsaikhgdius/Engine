# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Run with: blender --background --factory-startup --python blender_geometry_smoke.py"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy


ADDONS_CORE = Path(__file__).resolve().parents[2]
if str(ADDONS_CORE) not in sys.path:
    sys.path.insert(0, str(ADDONS_CORE))

import worldengine_studio  # noqa: E402
from worldengine_studio import blockout, live_protocol, native_session, operators  # noqa: E402


_request_index = 0


def parse(operation):
    global _request_index
    _request_index += 1
    return live_protocol.parse_live_batch(
        json.dumps(
            {
                "contract": live_protocol.CONTRACT,
                "requestId": f"geometry-smoke-{_request_index}",
                "expectedSceneEpoch": native_session.scene_epoch_value(),
                "operations": [operation],
            }
        )
    )


def execute(operation):
    return operators.execute_live_operation(parse(operation)["operations"][0])


def expect_protocol_error(operation, needle):
    try:
        parse(operation)
    except live_protocol.LiveProtocolError as error:
        assert needle in str(error), (needle, str(error))
    else:
        raise AssertionError(f"protocol must reject: {needle}")


def expect_value_error(operation, needle):
    try:
        execute(operation)
    except ValueError as error:
        assert needle in str(error), (needle, str(error))
    else:
        raise AssertionError(f"kernel must reject: {needle}")


def evaluated_counts(identifier):
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = blockout.find_object(identifier).evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    counts = (len(mesh.vertices), len(mesh.polygons))
    evaluated.to_mesh_clear()
    return counts


def evaluated_center(identifier):
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = blockout.find_object(identifier).evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    center = tuple(
        (max(v.co[i] for v in mesh.vertices) + min(v.co[i] for v in mesh.vertices)) / 2
        for i in range(3)
    )
    evaluated.to_mesh_clear()
    return center


def check_protocol_validation():
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "cube", "segments": 12},
        "segments is not supported for primitive: cube",
    )
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "plane", "segments": 12},
        "segments is not supported for primitive: plane",
    )
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "cylinder", "rings": 8},
        "rings is only supported for sphere and uv_sphere",
    )
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "cylinder", "segments": 2},
        "segments must be between 3 and 256",
    )
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "ico_sphere", "segments": 8},
        "must be between 1 and 6",
    )
    expect_protocol_error(
        {"op": "create_primitive", "id": "px", "primitive": "uv_sphere", "rings": 129},
        "rings must be between 3 and 128",
    )
    expect_protocol_error(
        {
            "op": "create_geometry_node",
            "id": "px",
            "nodeRef": "node",
            "nodeType": "MESH_TORUS",
        },
        "not a supported geometry node",
    )
    expect_protocol_error(
        {
            "op": "create_geometry_node",
            "id": "px",
            "nodeRef": "node",
            "nodeType": "MATH",
            "nodeProperties": {" ": "MULTIPLY"},
        },
        "nodeProperties keys must be non-empty strings",
    )
    expect_protocol_error(
        {
            "op": "create_geometry_node",
            "id": "px",
            "nodeRef": "node",
            "nodeType": "MATH",
            "nodeProperties": {"operation": [1, 2]},
        },
        "must be a string, boolean, or finite number",
    )
    expect_protocol_error(
        {"op": "set_geometry_modifier_input", "id": "px", "inputRef": "Level", "value": "two"},
        "value must be a finite number or boolean",
    )
    expect_protocol_error(
        {"op": "assign_geometry_node_group", "id": "px", "nodeGroupName": "   "},
        "nodeGroupName",
    )
    defaults = parse(
        {"op": "set_geometry_modifier_input", "id": "px", "inputRef": "Level", "value": 2}
    )["operations"][0]
    assert defaults["modifierName"] == "WorldEngine Geometry"


def check_parameterized_primitives():
    execute(
        {
            "op": "create_primitive",
            "id": "geo-director-grounded",
            "directorId": "director-wall-a",
            "primitive": "cube",
            "dimensions": [2, 3, 0.4],
            "grounded": True,
            "transform": {"position": [4, 0, -2]},
        }
    )
    grounded = blockout.find_object("geo-director-grounded")
    assert grounded.get(blockout.DIRECTOR_ID_PROPERTY) == "director-wall-a"
    local_minimum_z = min(vertex.co.z for vertex in grounded.data.vertices)
    assert abs(local_minimum_z) < 1e-6
    grounded_transform = blockout.object_world_transform(grounded)
    assert grounded_transform["position"] == [4.0, 0.0, -2.0]
    for actual, expected in zip(grounded_transform["scale"], [2.0, 3.0, 0.4]):
        assert abs(actual - expected) < 1e-6
    grounded_snapshot = next(
        item for item in blockout.snapshot_live_scene(bpy.context.scene)["objects"]
        if item["id"] == "geo-director-grounded"
    )
    for actual, expected in zip(grounded_snapshot["localBounds"]["min"], [-0.5, 0.0, -0.5]):
        assert abs(actual - expected) < 1e-6
    for actual, expected in zip(grounded_snapshot["localBounds"]["max"], [0.5, 1.0, 0.5]):
        assert abs(actual - expected) < 1e-6

    sphere = execute(
        {
            "op": "create_primitive",
            "id": "geo-uv-sphere",
            "primitive": "uv_sphere",
            "segments": 12,
            "rings": 6,
        }
    )
    assert sphere["object_id"] == "geo-uv-sphere"
    obj = blockout.find_object("geo-uv-sphere")
    # 12 segments x 6 rings: 12 * (6 - 1) + 2 poles = 62 (verified empirically).
    assert len(obj.data.vertices) == 12 * (6 - 1) + 2 == 62
    assert obj.get("worldengine_kind") == "uv_sphere"
    assert any(c.name == blockout.BLOCKOUT_COLLECTION for c in obj.users_collection)
    assert obj.data.materials[0].name == blockout.NEUTRAL_MATERIAL
    assert obj.select_get() and bpy.context.view_layer.objects.active is obj
    bpy.context.view_layer.update()
    assert all(abs(value - 1.0) < 1e-5 for value in obj.dimensions)

    execute({"op": "create_primitive", "id": "geo-sphere-default", "primitive": "sphere"})
    default_sphere = blockout.find_object("geo-sphere-default")
    # Blender default UV sphere: 32 segments x 16 rings -> 482 vertices.
    assert len(default_sphere.data.vertices) == 32 * (16 - 1) + 2 == 482

    execute(
        {
            "op": "create_primitive",
            "id": "geo-cylinder-8",
            "primitive": "cylinder",
            "segments": 8,
        }
    )
    cylinder = blockout.find_object("geo-cylinder-8")
    assert len(cylinder.data.vertices) == 16
    bpy.context.view_layer.update()
    assert all(abs(value - 1.0) < 1e-5 for value in cylinder.dimensions)

    execute(
        {
            "op": "create_primitive",
            "id": "geo-cone-default",
            "primitive": "cone",
        }
    )
    assert len(blockout.find_object("geo-cone-default").data.vertices) == 33

    execute(
        {
            "op": "create_primitive",
            "id": "geo-ico-1",
            "primitive": "ico_sphere",
            "segments": 1,
        }
    )
    ico = blockout.find_object("geo-ico-1")
    assert len(ico.data.vertices) == 12
    bpy.context.view_layer.update()
    assert all(abs(value - 1.0) < 1e-5 for value in ico.dimensions)

    execute(
        {
            "op": "create_primitive",
            "id": "geo-plane",
            "primitive": "plane",
            "dimensions": [3, 0, 2],
        }
    )
    plane = blockout.find_object("geo-plane")
    assert len(plane.data.vertices) == 4
    assert tuple(round(value, 6) for value in plane.scale) == (1.5, 1.0, 1.0)
    bpy.context.view_layer.update()
    assert abs(plane.dimensions.x - 3.0) < 1e-5
    assert abs(plane.dimensions.y - 2.0) < 1e-5

    # blockout mirrors the protocol restrictions for direct callers.
    try:
        blockout.create_primitive(bpy.context.scene, "cube", segments=12)
    except ValueError as error:
        assert "segments is not supported" in str(error)
    else:
        raise AssertionError("blockout must reject segments on cube")


def check_node_vocabulary_and_properties():
    execute(
        {
            "op": "create_primitive",
            "id": "geo-cube",
            "primitive": "cube",
            "dimensions": [2, 2, 2],
        }
    )
    execute({"op": "ensure_geometry_nodes", "id": "geo-cube"})
    assert evaluated_counts("geo-cube") == (8, 6)

    math_node = execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "math",
            "nodeType": "MATH",
            "nodeProperties": {"operation": "MULTIPLY", "use_clamp": True},
        }
    )
    assert math_node["node"]["blenderType"] == "ShaderNodeMath"
    assert math_node["node"]["properties"]["operation"] == "MULTIPLY"
    assert math_node["node"]["properties"]["use_clamp"] is True
    tree = blockout.find_object("geo-cube").modifiers["WorldEngine Geometry"].node_group
    assert tree.nodes["math"].operation == "MULTIPLY"
    assert tree.nodes["math"].use_clamp is True

    boolean_node = execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "bool",
            "nodeType": "MESH_BOOLEAN",
            "nodeProperties": {"operation": "UNION"},
        }
    )
    assert boolean_node["node"]["properties"]["operation"] == "UNION"
    execute({"op": "delete_geometry_node", "id": "geo-cube", "nodeRef": "bool"})

    expect_value_error(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "bad-deny",
            "nodeType": "MATH",
            "nodeProperties": {"filepath": "/tmp/agent.blend"},
        },
        "outside the Director modeling kernel",
    )
    expect_value_error(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "bad-unknown",
            "nodeType": "MATH",
            "nodeProperties": {"not_a_property": 1},
        },
        "Unknown geometry node property",
    )
    expect_value_error(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "bad-enum",
            "nodeType": "MATH",
            "nodeProperties": {"operation": "NOT_AN_OPERATION"},
        },
        "Invalid value for geometry node property",
    )
    # Failed property application must remove the node so the ref stays free.
    assert tree.nodes.get("bad-enum") is None
    retried = execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "bad-enum",
            "nodeType": "MATH",
            "nodeProperties": {"operation": "ADD"},
        }
    )
    assert retried["node"]["properties"]["operation"] == "ADD"
    execute({"op": "delete_geometry_node", "id": "geo-cube", "nodeRef": "bad-enum"})

    # Exercise one node of each new family to prove the enum maps to 5.1.2.
    for node_type, node_ref in (
        ("MESH_UV_SPHERE", "vocab-sphere"),
        ("CURVE_CIRCLE", "vocab-curve"),
        ("INSTANCE_ON_POINTS", "vocab-instance"),
        ("SET_MATERIAL", "vocab-material"),
        ("RANDOM_VALUE", "vocab-random"),
    ):
        created = execute(
            {
                "op": "create_geometry_node",
                "id": "geo-cube",
                "nodeRef": node_ref,
                "nodeType": node_type,
            }
        )
        assert created["node"]["nodeType"] == node_type
        execute({"op": "delete_geometry_node", "id": "geo-cube", "nodeRef": node_ref})


def check_graph_and_modifier_inputs():
    execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "cube-src",
            "nodeType": "MESH_CUBE",
            "location": [-400, -200],
        }
    )
    execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "subdiv",
            "nodeType": "SUBDIVISION_SURFACE",
            "location": [-200, -200],
        }
    )
    execute(
        {
            "op": "create_geometry_node",
            "id": "geo-cube",
            "nodeRef": "xform",
            "nodeType": "TRANSFORM_GEOMETRY",
            "location": [0, -200],
        }
    )
    execute(
        {
            "op": "disconnect_geometry_node_input",
            "id": "geo-cube",
            "nodeRef": "group-output",
            "inputSocketRef": "Socket_1",
        }
    )
    execute(
        {
            "op": "connect_geometry_nodes",
            "id": "geo-cube",
            "from": {"nodeRef": "cube-src", "socketRef": "Mesh"},
            "to": {"nodeRef": "subdiv", "socketRef": "Mesh"},
        }
    )
    execute(
        {
            "op": "connect_geometry_nodes",
            "id": "geo-cube",
            "from": {"nodeRef": "subdiv", "socketRef": "Mesh"},
            "to": {"nodeRef": "xform", "socketRef": "Geometry"},
        }
    )
    execute(
        {
            "op": "connect_geometry_nodes",
            "id": "geo-cube",
            "from": {"nodeRef": "xform", "socketRef": "Geometry"},
            "to": {"nodeRef": "group-output", "socketRef": "Socket_1"},
        }
    )
    # Generated cube through subdivision level 1: 26 verts, 24 faces != base cube.
    assert evaluated_counts("geo-cube") == (26, 24)
    assert all(abs(value) < 1e-6 for value in evaluated_center("geo-cube"))

    moved = execute(
        {
            "op": "set_geometry_node_input",
            "id": "geo-cube",
            "nodeRef": "xform",
            "inputSocketRef": "Translation",
            "value": [0, 3, 0],
        }
    )
    assert moved["input"]["defaultValue"] == [0.0, 3.0, 0.0]
    center_after = evaluated_center("geo-cube")
    assert max(abs(value) for value in center_after) > 2.9

    obj = blockout.find_object("geo-cube")
    tree = obj.modifiers["WorldEngine Geometry"].node_group
    level_item = tree.interface.new_socket(
        name="Level", in_out="INPUT", socket_type="NodeSocketInt"
    )
    level_item.default_value = 1
    bpy.context.view_layer.update()
    execute(
        {
            "op": "connect_geometry_nodes",
            "id": "geo-cube",
            "from": {"nodeRef": "group-input", "socketRef": level_item.identifier},
            "to": {"nodeRef": "subdiv", "socketRef": "Level"},
        }
    )

    inspection = execute({"op": "inspect_object", "id": "geo-cube"})
    graph = inspection["geometryGraphs"][0]
    level_input = next(
        item for item in graph["modifierInputs"] if item["identifier"] == level_item.identifier
    )
    assert level_input["name"] == "Level"
    assert level_input["socketType"] == "NodeSocketInt"
    # In 5.1.2 the subdivision node's options are input sockets, so its
    # configurable-property surface is empty (but consistently present).
    subdiv_inspection = next(node for node in graph["nodes"] if node["nodeRef"] == "subdiv")
    assert subdiv_inspection["properties"] == {}
    math_inspection = next(node for node in graph["nodes"] if node["nodeRef"] == "math")
    assert math_inspection["properties"]["operation"] == "MULTIPLY"

    raised = execute(
        {
            "op": "set_geometry_modifier_input",
            "id": "geo-cube",
            "inputRef": "Level",
            "value": 2,
        }
    )
    assert raised["input"] == {
        "identifier": level_item.identifier,
        "name": "Level",
        "socketType": "NodeSocketInt",
        "value": 2,
    }
    assert evaluated_counts("geo-cube") == (98, 96)

    lowered = execute(
        {
            "op": "set_geometry_modifier_input",
            "id": "geo-cube",
            "inputRef": level_item.identifier,
            "value": 0,
        }
    )
    assert lowered["input"]["value"] == 0
    assert evaluated_counts("geo-cube") == (8, 6)
    reinspected = execute({"op": "inspect_object", "id": "geo-cube"})
    assert next(
        item
        for item in reinspected["geometryGraphs"][0]["modifierInputs"]
        if item["identifier"] == level_item.identifier
    )["value"] == 0

    tree.interface.new_socket(name="Dup", in_out="INPUT", socket_type="NodeSocketFloat")
    tree.interface.new_socket(name="Dup", in_out="INPUT", socket_type="NodeSocketFloat")
    expect_value_error(
        {"op": "set_geometry_modifier_input", "id": "geo-cube", "inputRef": "Dup", "value": 1},
        "Ambiguous geometry group input name",
    )
    tree.interface.new_socket(name="Offset Vec", in_out="INPUT", socket_type="NodeSocketVector")
    expect_value_error(
        {
            "op": "set_geometry_modifier_input",
            "id": "geo-cube",
            "inputRef": "Offset Vec",
            "value": 1,
        },
        "only float/int/bool group inputs are supported",
    )
    expect_value_error(
        {
            "op": "set_geometry_modifier_input",
            "id": "geo-cube",
            "inputRef": "Missing Input",
            "value": 1,
        },
        "Unknown geometry group input",
    )


def check_node_group_reuse():
    shared = bpy.data.node_groups.new("Agent Shared Cone", "GeometryNodeTree")
    shared.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    shared.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = shared.nodes.new("NodeGroupInput")
    group_output = shared.nodes.new("NodeGroupOutput")
    group_output.is_active_output = True
    cone = shared.nodes.new("GeometryNodeMeshCone")
    shared.links.new(cone.outputs["Mesh"], group_output.inputs[0])
    assert group_input is not None

    execute({"op": "create_primitive", "id": "share-a", "primitive": "cube"})
    execute({"op": "create_primitive", "id": "share-b", "primitive": "cube"})
    for identifier in ("share-a", "share-b"):
        assigned = execute(
            {
                "op": "assign_geometry_node_group",
                "id": identifier,
                "nodeGroupName": "Agent Shared Cone",
            }
        )
        assert assigned["objectId"] == identifier
        assert assigned["graph"]["nodeGroupName"] == "Agent Shared Cone"

    modifier_a = blockout.find_object("share-a").modifiers["WorldEngine Geometry"]
    modifier_b = blockout.find_object("share-b").modifiers["WorldEngine Geometry"]
    assert modifier_a.node_group is shared
    assert modifier_b.node_group is shared
    counts_a = evaluated_counts("share-a")
    counts_b = evaluated_counts("share-b")
    assert counts_a == counts_b
    assert counts_a != (8, 6)

    expect_value_error(
        {"op": "assign_geometry_node_group", "id": "share-a", "nodeGroupName": "Missing Tree"},
        "Unknown geometry node group",
    )
    bpy.data.node_groups.new("Agent Shader Group", "ShaderNodeTree")
    expect_value_error(
        {
            "op": "assign_geometry_node_group",
            "id": "share-a",
            "nodeGroupName": "Agent Shader Group",
        },
        "not a Geometry Nodes tree",
    )


def main():
    worldengine_studio.register()
    try:
        check_protocol_validation()
        check_parameterized_primitives()
        check_node_vocabulary_and_properties()
        check_graph_and_modifier_inputs()
        check_node_group_reuse()
        print("WORLDENGINE_STUDIO_GEOMETRY_SMOKE_OK")
    finally:
        worldengine_studio.unregister()


main()
