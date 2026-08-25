# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

import json
import pathlib
import sys
import unittest


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import live_protocol  # noqa: E402
import operation_manifest  # noqa: E402


SCENE_EPOCH = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420"


class LiveProtocolTestCase(unittest.TestCase):
    def test_uses_the_packaged_operation_manifest(self):
        self.assertEqual(live_protocol.SUPPORTED_OPERATIONS, operation_manifest.SUPPORTED_OPERATIONS)
        self.assertEqual(len(operation_manifest.SUPPORTED_OPERATIONS), 74)
        self.assertEqual(operation_manifest.OPERATION_EFFECTS["update_transform"], "transform")
        self.assertEqual(operation_manifest.PROJECT_LIFECYCLE_OPERATIONS, {"bind_director_project"})

    def test_parses_execute_code(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "73a521f0-7fe3-4fd7-8e06-8457e806c6b4",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {
                            "op": "execute_code",
                            "code": "import bpy\nprint(len(bpy.data.objects))\n",
                        }
                    ],
                }
            )
        )
        self.assertEqual(parsed["operations"][0]["op"], "execute_code")
        self.assertIn("print", parsed["operations"][0]["code"])
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": "83a521f0-7fe3-4fd7-8e06-8457e806c6b4",
                        "expectedSceneEpoch": SCENE_EPOCH,
                        "operations": [{"op": "execute_code", "code": "   "}],
                    }
                )
            )

    def test_parses_name_spatial_query_without_a_scene_epoch(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "93a521f0-7fe3-4fd7-8e06-8457e806c6b4",
                    "operations": [
                        {
                            "op": "query_spatial",
                            "queries": [{"kind": "NAME", "namePattern": "清华"}],
                        }
                    ],
                }
            )
        )
        self.assertEqual(parsed["operations"][0]["queries"][0]["kind"], "NAME")
        self.assertEqual(parsed["operations"][0]["queries"][0]["namePattern"], "清华")
        self.assertEqual(parsed["operations"][0]["queries"][0]["maxResults"], 50)

    def test_parses_polyhaven_search_without_a_scene_epoch(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "83a521f0-7fe3-4fd7-8e06-8457e806c6b4",
                    "operations": [
                        {
                            "op": "polyhaven_search",
                            "assetType": "models",
                            "query": "chair",
                            "limit": 8,
                        }
                    ],
                }
            )
        )
        self.assertEqual(parsed["expected_scene_epoch"], None)
        self.assertEqual(
            parsed["operations"][0],
            {
                "op": "polyhaven_search",
                "assetType": "models",
                "query": "chair",
                "limit": 8,
            },
        )
        parsed_import = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "93a521f0-7fe3-4fd7-8e06-8457e806c6b5",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {
                            "op": "polyhaven_import",
                            "assetId": "modern_chair",
                            "assetType": "models",
                            "resolution": "1k",
                        },
                        {
                            "op": "sketchfab_import",
                            "uid": "abcdef12ghijkl34mnop56qrstuv78wx",
                            "targetSizeM": 2,
                        },
                    ],
                }
            )
        )
        self.assertEqual(parsed_import["operations"][0]["op"], "polyhaven_import")
        self.assertEqual(parsed_import["operations"][1]["targetSizeM"], 2)
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": "a3a521f0-7fe3-4fd7-8e06-8457e806c6b6",
                        "operations": [
                            {"op": "polyhaven_import", "assetId": "chair", "assetType": "models"}
                        ],
                    }
                )
            )

    def test_parses_a_director_blockout_batch(self):
        payload = {
            "contract": live_protocol.CONTRACT,
            "requestId": "63a521f0-7fe3-4fd7-8e06-8457e806c6b3",
            "expectedSceneEpoch": SCENE_EPOCH,
            "expectedRevision": 2,
            "operations": [
                {
                    "op": "create_blockout",
                    "preset": "room",
                    "idPrefix": "room-a",
                    "origin": [0, 0, 0],
                    "width": 8,
                    "depth": 6,
                    "height": 3,
                    "wallThickness": 0.18,
                    "stepCount": 12,
                }
            ],
        }
        parsed = live_protocol.parse_live_batch(json.dumps(payload))
        self.assertEqual(parsed["expected_scene_epoch"], SCENE_EPOCH)
        self.assertEqual(parsed["expected_revision"], 2)
        self.assertEqual(parsed["operations"][0]["idPrefix"], "room-a")

    def test_rejects_unknown_operations(self):
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": "request-a",
                        "operations": [{"op": "run_python", "id": "object-a"}],
                    }
                )
            )

    def test_parses_typed_world_environment(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "world-environment",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {
                            "op": "set_world_environment",
                            "color": [0.12, 0.18, 0.3],
                            "strength": 0.8,
                        }
                    ],
                }
            )
        )

        self.assertEqual(parsed["operations"][0]["color"], [0.12, 0.18, 0.3])
        self.assertEqual(parsed["operations"][0]["strength"], 0.8)

    def test_parses_scene_preview_as_a_parameterless_read_only_operation(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "scene-preview-a",
                    "operations": [{"op": "export_scene_preview"}],
                }
            )
        )

        self.assertEqual(parsed["operations"], [{"op": "export_scene_preview"}])
        self.assertIsNone(parsed["expected_scene_epoch"])

    def test_parses_director_project_binding_and_object_properties(self):
        binding = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "bind-director-project",
                    "operations": [
                        {"op": "bind_director_project", "projectId": "director-project-a"}
                    ],
                }
            )
        )
        self.assertIsNone(binding["expected_scene_epoch"])
        self.assertEqual(binding["operations"][0]["projectId"], "director-project-a")

        update = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "update-director-object",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {"op": "set_object_name", "id": "asset-root", "name": "Lobby set"},
                        {"op": "set_object_visibility", "id": "asset-root", "visible": False},
                    ],
                }
            )
        )
        self.assertEqual(update["operations"][0]["name"], "Lobby set")
        self.assertFalse(update["operations"][1]["visible"])

    def test_parses_director_asset_import(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "import-director-asset",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {
                            "op": "import_asset",
                            "id": "prop-chair-a",
                            "directorId": "prop-chair-a",
                            "assetId": "asset-chair",
                            "sourceUrl": "http://127.0.0.1:8787/native-models/model/chair.glb",
                            "fileName": "chair.glb",
                            "name": "Hero chair",
                            "kind": "prop",
                            "transform": {
                                "position": [2, 0, -1],
                                "rotation": [0, 0.5, 0],
                                "scale": [1.2, 1.2, 1.2],
                            },
                        }
                    ],
                }
            )
        )

        operation = parsed["operations"][0]
        self.assertEqual(operation["directorId"], "prop-chair-a")
        self.assertEqual(operation["normalization"], "auto")
        self.assertFalse(operation["grounded"])
        self.assertEqual(operation["transform"]["position"], [2.0, 0.0, -1.0])

    def test_parses_director_linked_grounded_primitive(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "director-grounded-primitive",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "operations": [
                        {
                            "op": "create_primitive",
                            "id": "native-wall-a",
                            "directorId": "director-wall-a",
                            "primitive": "cube",
                            "grounded": True,
                        }
                    ],
                }
            )
        )

        operation = parsed["operations"][0]
        self.assertEqual(operation["directorId"], "director-wall-a")
        self.assertTrue(operation["grounded"])

    def test_rejects_primitive_scale_that_would_override_metric_dimensions(self):
        with self.assertRaisesRegex(live_protocol.LiveProtocolError, "use dimensions for metric size"):
            live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": "ambiguous-primitive-scale",
                        "expectedSceneEpoch": SCENE_EPOCH,
                        "operations": [
                            {
                                "op": "create_primitive",
                                "id": "wall-a",
                                "primitive": "cube",
                                "dimensions": [4, 3, 0.2],
                                "transform": {
                                    "position": [0, 0, 0],
                                    "scale": [4, 3, 0.2],
                                },
                            }
                        ],
                    }
                )
            )

    def test_parses_typed_pose_action_and_frame_operations(self):
        parsed = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "rig-operations",
                    "expectedSceneEpoch": SCENE_EPOCH,
                    "expectedRevision": 7,
                    "operations": [
                        {
                            "op": "select_pose_bones",
                            "id": "rig-a",
                            "boneRefs": ["hips", "spine"],
                            "activeBoneRef": "hips",
                        },
                        {
                            "op": "set_pose_bone_transform",
                            "id": "rig-a",
                            "boneRef": "hips",
                            "local": {
                                "location": [0, 0.2, 0],
                                "rotationQuaternion": [1, 0, 0, 0],
                            },
                        },
                        {
                            "op": "apply_pose_offsets",
                            "id": "rig-a",
                            "stateToken": "director-state-1",
                            "resetPose": True,
                            "bones": [
                                {
                                    "boneRef": "head",
                                    "rotationOffsetQuaternion": [1, 0, 0, 0],
                                }
                            ],
                        },
                        {"op": "create_action", "id": "rig-a", "actionName": "Walk"},
                        {"op": "set_active_action", "id": "rig-a", "actionName": "Walk"},
                        {"op": "set_scene_frame", "frame": 12},
                        {
                            "op": "insert_pose_keyframes",
                            "id": "rig-a",
                            "actionName": "Walk",
                            "frame": 12,
                            "boneRefs": ["hips"],
                            "channels": ["LOCATION", "ROTATION"],
                        },
                        {
                            "op": "delete_pose_keyframes",
                            "id": "rig-a",
                            "actionName": "Walk",
                            "frame": 1,
                            "boneRefs": ["hips"],
                            "channels": ["ROTATION"],
                        },
                    ],
                }
            )
        )

        operations = parsed["operations"]
        self.assertEqual(operations[0]["action"], "SET")
        self.assertEqual(operations[1]["local"]["rotationQuaternion"], [1.0, 0.0, 0.0, 0.0])
        self.assertEqual(operations[2]["stateToken"], "director-state-1")
        self.assertTrue(operations[2]["resetPose"])
        self.assertEqual(operations[5]["frame"], 12)
        self.assertEqual(operations[6]["interpolation"], "BEZIER")

    def test_rejects_invalid_pose_channels_and_empty_pose_transforms(self):
        for operation in (
            {
                "op": "set_pose_bone_transform",
                "id": "rig-a",
                "boneRef": "hips",
                "local": {},
            },
            {
                "op": "insert_pose_keyframes",
                "id": "rig-a",
                "actionName": "Walk",
                "frame": 1,
                "boneRefs": ["hips"],
                "channels": ["CUSTOM"],
            },
        ):
            with self.assertRaises(live_protocol.LiveProtocolError):
                live_protocol.parse_live_batch(
                    json.dumps(
                        {
                            "contract": live_protocol.CONTRACT,
                            "requestId": "invalid-rig-operation",
                            "expectedSceneEpoch": SCENE_EPOCH,
                            "operations": [operation],
                        }
                    )
                )

    def test_requires_scene_epoch_for_scene_bound_batches(self):
        with self.assertRaisesRegex(live_protocol.LiveProtocolError, "expectedSceneEpoch"):
            live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": "scene-edit-without-epoch",
                        "operations": [
                            {"op": "create_primitive", "id": "cube-a", "primitive": "cube"}
                        ],
                    }
                )
            )

    def test_parses_native_authoring_operations(self):
        payload = {
            "contract": live_protocol.CONTRACT,
            "requestId": "native-authoring-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                {
                    "op": "create_light",
                    "id": "light-a",
                    "kind": "area",
                    "position": [4, 6, 4],
                    "target": [0, 1.5, 0],
                    "color": [1, 0.94, 0.86],
                },
                {
                    "op": "create_opening",
                    "id": "opening-a",
                    "targetId": "wall-a",
                    "kind": "door",
                },
                {
                    "op": "move_to_collection",
                    "ids": ["opening-a"],
                    "collection": "Architecture",
                },
                {
                    "op": "set_parent",
                    "id": "opening-a",
                    "parentId": "wall-a",
                    "keepWorldTransform": True,
                },
                {
                    "op": "add_constraint",
                    "id": "opening-a",
                    "targetId": "wall-a",
                    "kind": "copy_rotation",
                    "influence": 0.75,
                },
                {
                    "op": "remove_constraint",
                    "id": "opening-a",
                    "constraintName": "WorldEngine Copy Rotation",
                },
            ],
        }
        parsed = live_protocol.parse_live_batch(json.dumps(payload))
        self.assertEqual(parsed["expected_scene_epoch"], SCENE_EPOCH)
        self.assertEqual(parsed["operations"][0]["color"], [1.0, 0.94, 0.86])
        self.assertEqual(parsed["operations"][1]["targetId"], "wall-a")
        self.assertEqual(parsed["operations"][2]["collection"], "Architecture")
        self.assertEqual(parsed["operations"][3]["parentId"], "wall-a")
        self.assertEqual(parsed["operations"][4]["targetId"], "wall-a")
        self.assertEqual(parsed["operations"][5]["constraintName"], "WorldEngine Copy Rotation")

    def test_parses_camera_and_light_data_updates(self):
        camera = {
            "op": "set_camera_data",
            "id": "camera-a",
            "projectionType": "ORTHOGRAPHIC",
            "focalLengthMm": 50,
            "sensorFit": "HORIZONTAL",
            "sensorWidthMm": 36,
            "sensorHeightMm": 24,
            "shiftX": 0.1,
            "shiftY": -0.05,
            "clipStart": 0.1,
            "clipEnd": 2000,
            "orthographicScale": 12,
        }
        payload = {
            "contract": live_protocol.CONTRACT,
            "requestId": "native-data-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                camera,
                {
                    "op": "set_light_data",
                    "id": "light-a",
                    "kind": "spot",
                    "color": [0.8, 0.6, 0.4],
                    "energy": 1500,
                    "size": 0.25,
                },
            ],
        }
        parsed = live_protocol.parse_live_batch(json.dumps(payload))
        self.assertEqual(parsed["operations"][0]["projectionType"], "ORTHOGRAPHIC")
        self.assertEqual(parsed["operations"][1]["color"], [0.8, 0.6, 0.4])

        camera["clipEnd"] = 0.05
        with self.assertRaisesRegex(live_protocol.LiveProtocolError, "clipEnd"):
            live_protocol.parse_live_batch(json.dumps(payload))

    def test_parses_agent_native_modeling_operations(self):
        payload = {
            "contract": live_protocol.CONTRACT,
            "requestId": "agent-modeling-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                {
                    "op": "discover_operators",
                    "query": "subdivide",
                    "category": "mesh",
                    "scope": "modeling",
                    "availableOnly": False,
                    "limit": 20,
                },
                {"op": "describe_operator", "operator": "mesh.subdivide"},
                {
                    "op": "set_selection",
                    "selectedIds": ["cube-a"],
                    "activeId": "cube-a",
                    "mode": "OBJECT",
                },
                {
                    "op": "select_mesh_elements",
                    "id": "cube-a",
                    "domain": "EDGE",
                    "action": "ALL",
                    "indices": [],
                },
                {
                    "op": "assign_material",
                    "id": "cube-a",
                    "materialName": "Agent Clay",
                    "parameters": {
                        "baseColor": [0.3, 0.4, 0.5],
                        "roughness": 0.7,
                        "metallic": 0.1,
                        "alpha": 0.8,
                    },
                },
                {
                    "op": "project_uv",
                    "id": "cube-a",
                    "method": "CUBE",
                    "uvLayerName": "AgentUV",
                },
                {
                    "op": "invoke_operator",
                    "operator": "mesh.subdivide",
                    "properties": {"number_cuts": 2},
                    "context": {
                        "selectedIds": ["cube-a"],
                        "activeId": "cube-a",
                        "mode": "EDIT",
                    },
                },
                {"op": "inspect_object", "id": "cube-a"},
                {
                    "op": "set_rna_property",
                    "target": {
                        "kind": "modifier",
                        "objectId": "cube-a",
                        "name": "Bevel",
                    },
                    "path": ["width"],
                    "value": 0.125,
                },
            ],
        }

        parsed = live_protocol.parse_live_batch(json.dumps(payload))
        self.assertEqual(parsed["expected_scene_epoch"], SCENE_EPOCH)
        operations = parsed["operations"]
        self.assertEqual(operations[0]["query"], "subdivide")
        self.assertEqual(operations[1]["operator"], "mesh.subdivide")
        self.assertEqual(operations[2]["selectedIds"], ["cube-a"])
        self.assertEqual(operations[3]["domain"], "EDGE")
        self.assertEqual(operations[4]["materialName"], "Agent Clay")
        self.assertEqual(operations[4]["parameters"]["baseColor"], [0.3, 0.4, 0.5])
        self.assertTrue(operations[4]["createIfMissing"])
        self.assertEqual(operations[4]["faceScope"], "ALL")
        self.assertEqual(operations[5]["method"], "CUBE")
        self.assertEqual(operations[5]["uvLayerName"], "AgentUV")
        self.assertFalse(operations[5]["replaceExisting"])
        self.assertEqual(operations[6]["properties"], {"number_cuts": 2})
        self.assertEqual(operations[6]["context"]["activeId"], "cube-a")
        self.assertEqual(operations[7]["id"], "cube-a")
        self.assertEqual(operations[8]["target"]["kind"], "modifier")
        self.assertEqual(operations[8]["path"], ["width"])

    def test_rejects_invalid_material_and_uv_parameters(self):
        base = {
            "contract": live_protocol.CONTRACT,
            "requestId": "invalid-material-or-uv",
            "expectedSceneEpoch": SCENE_EPOCH,
        }
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "assign_material",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "parameters": {"roughness": 1.5},
                }],
            }))
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "project_uv",
                    "id": "cube-a",
                    "method": "SPHERE",
                }],
            }))
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "assign_material",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "faceScope": "VISIBLE",
                }],
            }))
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "project_uv",
                    "id": "cube-a",
                    "replaceExisting": "yes",
                }],
            }))

    def test_parses_semantic_material_node_operations(self):
        payload = {
            "contract": live_protocol.CONTRACT,
            "requestId": "material-nodes-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                {
                    "op": "create_material_node",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "mix-color",
                    "nodeType": "MIX_COLOR",
                    "location": [-240, 80],
                    "label": "  Wall tint  ",
                },
                {
                    "op": "set_material_node_input",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "mix-color",
                    "inputSocketRef": "Color1",
                    "value": [0.2, 0.3, 0.4, 1],
                },
                {
                    "op": "connect_material_nodes",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "from": {"nodeRef": "principled", "socketRef": "BSDF"},
                    "to": {"nodeRef": "material-output", "socketRef": "Surface"},
                },
                {
                    "op": "disconnect_material_node_input",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "material-output",
                    "inputSocketRef": "Surface",
                },
                {
                    "op": "delete_material_node",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "mix-color",
                },
            ],
        }

        operations = live_protocol.parse_live_batch(json.dumps(payload))["operations"]
        self.assertEqual(operations[0]["nodeType"], "MIX_COLOR")
        self.assertEqual(operations[0]["location"], [-240.0, 80.0])
        self.assertEqual(operations[0]["label"], "Wall tint")
        self.assertEqual(operations[1]["value"], [0.2, 0.3, 0.4, 1.0])
        self.assertEqual(operations[2]["from"]["socketRef"], "BSDF")
        self.assertEqual(operations[3]["inputSocketRef"], "Surface")
        self.assertEqual(operations[4]["nodeRef"], "mix-color")

    def test_rejects_arbitrary_material_nodes_and_invalid_socket_values(self):
        base = {
            "contract": live_protocol.CONTRACT,
            "requestId": "invalid-material-node",
            "expectedSceneEpoch": SCENE_EPOCH,
        }
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "create_material_node",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "script",
                    "nodeType": "ShaderNodeScript",
                }],
            }))
        with self.assertRaises(live_protocol.LiveProtocolError):
            live_protocol.parse_live_batch(json.dumps({
                **base,
                "operations": [{
                    "op": "set_material_node_input",
                    "id": "cube-a",
                    "materialName": "Clay",
                    "nodeRef": "principled",
                    "inputSocketRef": "Base Color",
                    "value": "blue",
                }],
            }))

    def test_parses_curve_text_geometry_nodes_and_procedural_texture(self):
        parsed = live_protocol.parse_live_batch(json.dumps({
            "contract": live_protocol.CONTRACT,
            "requestId": "semantic-geometry-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                {
                    "op": "create_curve",
                    "id": "path-a",
                    "points": [[0, 0, 0], [2, 0, -1]],
                },
                {
                    "op": "set_curve_data",
                    "id": "path-a",
                    "points": [[0, 0, 0], [3, 1, -2]],
                    "cyclic": True,
                    "bevelDepth": 0.08,
                },
                {"op": "create_text", "id": "title-a", "text": "Warehouse"},
                {
                    "op": "set_text_data",
                    "id": "title-a",
                    "text": "Warehouse 12",
                    "alignX": "CENTER",
                },
                {"op": "ensure_geometry_nodes", "id": "path-a"},
                {
                    "op": "create_geometry_node",
                    "id": "path-a",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "transform",
                    "nodeType": "TRANSFORM_GEOMETRY",
                },
                {
                    "op": "set_geometry_node_input",
                    "id": "path-a",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "transform",
                    "inputSocketRef": "Translation",
                    "value": [0, 0, 1],
                },
                {
                    "op": "connect_geometry_nodes",
                    "id": "path-a",
                    "modifierName": "WorldEngine Geometry",
                    "from": {"nodeRef": "group-input", "socketRef": "Socket_0"},
                    "to": {"nodeRef": "transform", "socketRef": "Geometry"},
                },
                {
                    "op": "disconnect_geometry_node_input",
                    "id": "path-a",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "group-output",
                    "inputSocketRef": "Socket_1",
                },
                {
                    "op": "delete_geometry_node",
                    "id": "path-a",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "transform",
                },
                {
                    "op": "create_material_node",
                    "id": "path-a",
                    "materialName": "Clay",
                    "nodeRef": "noise",
                    "nodeType": "NOISE_TEXTURE",
                },
            ],
        }))

        operations = parsed["operations"]
        self.assertEqual(operations[0]["curveType"], "POLY")
        self.assertEqual(operations[0]["bevelDepth"], 0.0)
        self.assertEqual(operations[2]["alignX"], "LEFT")
        self.assertEqual(operations[4]["modifierName"], "WorldEngine Geometry")
        self.assertEqual(operations[5]["nodeType"], "TRANSFORM_GEOMETRY")
        self.assertEqual(operations[6]["value"], [0.0, 0.0, 1.0])
        self.assertEqual(operations[10]["nodeType"], "NOISE_TEXTURE")

    def test_parses_catalog_mixamo_import_and_nla_operations(self):
        parsed = live_protocol.parse_live_batch(json.dumps({
            "contract": live_protocol.CONTRACT,
            "requestId": "mixamo-nla-a",
            "expectedSceneEpoch": SCENE_EPOCH,
            "operations": [
                {
                    "op": "import_mixamo_action",
                    "id": "rig-a",
                    "motionId": "walk",
                },
                {"op": "create_nla_track", "id": "rig-a", "trackName": "Locomotion"},
                {
                    "op": "add_nla_strip",
                    "id": "rig-a",
                    "trackName": "Locomotion",
                    "stripName": "Walk Base",
                    "actionName": "Mixamo Walk Forward",
                    "startFrame": 1,
                },
                {
                    "op": "update_nla_strip",
                    "id": "rig-a",
                    "trackName": "Locomotion",
                    "stripName": "Walk Base",
                    "blendMode": "ADD",
                    "influence": 0.5,
                },
                {
                    "op": "remove_nla_strip",
                    "id": "rig-a",
                    "trackName": "Locomotion",
                    "stripName": "Walk Base",
                },
            ],
        }))

        operations = parsed["operations"]
        self.assertEqual(operations[0]["motionId"], "walk")
        self.assertEqual(operations[0]["rootMotion"], "IN_PLACE")
        self.assertFalse(operations[0]["replaceExisting"])
        self.assertEqual(operations[2]["blendMode"], "REPLACE")
        self.assertEqual(operations[2]["influence"], 1.0)
        self.assertEqual(operations[2]["repeat"], 1.0)
        self.assertEqual(operations[2]["scale"], 1.0)
        self.assertEqual(operations[3]["blendMode"], "ADD")
        self.assertEqual(operations[3]["influence"], 0.5)

    def _transform_diff_snapshot(self):
        return {
            "objects": [
                {
                    "id": "cube-a",
                    "name": "Cube",
                    "type": "MESH",
                    "visible": True,
                    "parentId": None,
                    "dimensions": [1.0, 1.0, 1.0],
                    "position": [0.0, 0.0, 0.0],
                    "rotation": [0.0, 0.0, 0.0],
                    "scale": [1.0, 1.0, 1.0],
                    "localTransform": {
                        "position": [0.0, 0.0, 0.0],
                        "rotation": [0.0, 0.0, 0.0],
                        "scale": [1.0, 1.0, 1.0],
                    },
                },
            ],
            "cameras": [
                {"id": "cam-a", "name": "Camera", "position": [4.0, 2.0, 4.0], "rotation": [0.0, 0.8, 0.0]},
            ],
            "lights": [
                {"id": "light-a", "name": "Key", "energy": 1000.0, "position": [1.0, 3.0, 1.0], "rotation": [0.0, 0.0, 0.0]},
            ],
        }

    def test_snapshot_diff_accepts_pure_transform_moves(self):
        before = self._transform_diff_snapshot()
        after = json.loads(json.dumps(before))
        after["objects"][0]["position"] = [3.0, 0.0, 0.0]
        after["objects"][0]["localTransform"]["position"] = [3.0, 0.0, 0.0]
        after["cameras"][0]["rotation"] = [0.1, 0.9, 0.0]
        after["lights"][0]["position"] = [2.0, 3.0, 1.0]

        self.assertTrue(live_protocol.snapshots_differ_only_by_transforms(before, after))
        self.assertTrue(live_protocol.snapshots_differ_only_by_transforms(before, json.loads(json.dumps(before))))

    def test_snapshot_diff_rejects_content_membership_and_state_changes(self):
        before = self._transform_diff_snapshot()

        renamed = json.loads(json.dumps(before))
        renamed["objects"][0]["name"] = "Cube Renamed"
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, renamed))

        hidden = json.loads(json.dumps(before))
        hidden["objects"][0]["visible"] = False
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, hidden))

        reparented = json.loads(json.dumps(before))
        reparented["objects"][0]["parentId"] = "other"
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, reparented))

        resized = json.loads(json.dumps(before))
        resized["objects"][0]["dimensions"] = [2.0, 1.0, 1.0]
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, resized))

        added = json.loads(json.dumps(before))
        added["objects"].append({**json.loads(json.dumps(before["objects"][0])), "id": "cube-b"})
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, added))

        dimmed = json.loads(json.dumps(before))
        dimmed["lights"][0]["energy"] = 10.0
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(before, dimmed))

    def test_snapshot_diff_is_conservative_for_malformed_input(self):
        snapshot = self._transform_diff_snapshot()
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(None, snapshot))
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(snapshot, None))
        missing_collection = {"objects": snapshot["objects"], "cameras": snapshot["cameras"]}
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(snapshot, missing_collection))
        duplicate_ids = json.loads(json.dumps(snapshot))
        duplicate_ids["objects"].append(json.loads(json.dumps(snapshot["objects"][0])))
        self.assertFalse(live_protocol.snapshots_differ_only_by_transforms(snapshot, duplicate_ids))


if __name__ == "__main__":
    unittest.main()
