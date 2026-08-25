# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Run with: blender --background --factory-startup --python blender_modeling_smoke.py"""

from __future__ import annotations

import base64
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import sys
import tempfile
import threading
from pathlib import Path

import bmesh
import bpy


ADDONS_CORE = Path(__file__).resolve().parents[2]
if str(ADDONS_CORE) not in sys.path:
    sys.path.insert(0, str(ADDONS_CORE))

import worldengine_studio  # noqa: E402
from worldengine_studio import asset_import, blockout, director_project, live_protocol, mixamo_actions, native_session, operators, rig as rig_tools  # noqa: E402


_request_index = 0


class WORLDENGINE_OT_cancelled_smoke(bpy.types.Operator):
    """Mutate the active object, then report a cancelled Blender operation."""

    bl_idname = "worldengine.cancelled_smoke"
    bl_label = "WorldEngine Cancelled Smoke"
    bl_options = {'UNDO'}

    def execute(self, context):
        context.active_object.location.x += 7.0
        return {'CANCELLED'}


def execute(operation):
    """Parse one wire operation, then execute it through the shared dispatcher."""
    global _request_index
    _request_index += 1
    batch = live_protocol.parse_live_batch(
        json.dumps(
            {
                "contract": live_protocol.CONTRACT,
                "requestId": f"modeling-smoke-{_request_index}",
                "expectedSceneEpoch": native_session.scene_epoch_value(),
                "operations": [operation],
            }
        )
    )
    return operators.execute_live_operation(batch["operations"][0])


def decode_glb_json(data: bytes):
    magic, version, byte_length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF"
    assert version == 2
    assert byte_length == len(data)
    json_length, json_type = struct.unpack_from("<I4s", data, 12)
    assert json_type == b"JSON"
    return json.loads(data[20:20 + json_length].decode("utf-8").rstrip(" \x00"))


class SilentAssetHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


def verify_director_asset_import(source_object):
    with tempfile.TemporaryDirectory(prefix="director-asset-smoke-") as directory:
        source_path = Path(directory) / "fixture.glb"
        blockout._select_only(source_object)
        bpy.ops.export_scene.gltf(
            filepath=str(source_path),
            export_format='GLB',
            export_extras=True,
            use_selection=True,
        )
        handler = functools.partial(SilentAssetHandler, directory=directory)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            root_id = "director-imported-asset"
            other_scene = bpy.data.scenes.new("Other Director Scene")
            other_root = bpy.data.objects.new("Other Director Asset", None)
            other_root[blockout.ID_PROPERTY] = root_id
            other_scene.collection.objects.link(other_root)
            operation = {
                "op": "import_asset",
                "id": root_id,
                "directorId": "director-prop-a",
                "assetId": "asset-fixture",
                "sourceUrl": f"http://127.0.0.1:{server.server_port}/fixture.glb",
                "fileName": "fixture.glb",
                "name": "Director Imported Asset",
                "kind": "prop",
                "grounded": True,
                "transform": {
                    "position": [3, 0, -2],
                    "rotation": [0, 0.25, 0],
                    "scale": [1.5, 1.5, 1.5],
                },
            }
            imported = execute(operation)
            assert imported["created"]
            root = blockout.find_object(root_id)
            assert root is not other_root
            assert other_scene.objects.get(other_root.name) is other_root
            assert blockout.object_display_name(root) == "Director Imported Asset"
            assert root.get(blockout.DIRECTOR_ID_PROPERTY) == "director-prop-a"
            subtree = asset_import.asset_subtree(root)
            assert any(item.type == 'MESH' for item in subtree)
            assert len({blockout.ensure_stable_id(item) for item in subtree}) == len(subtree)
            subtree_names = [item.name for item in subtree]
            subtree_mesh_names = [item.data.name for item in subtree if item.type == 'MESH']
            assert not execute(operation)["created"]

            execute({"op": "set_object_visibility", "id": root_id, "visible": False})
            assert all(item.hide_viewport for item in [root, *subtree])
            execute({"op": "delete_object", "id": root_id})
            assert blockout.find_object(root_id) is None
            assert all(name not in bpy.data.objects for name in subtree_names)
            assert all(name not in bpy.data.meshes for name in subtree_mesh_names)
            bpy.data.objects.remove(other_root, do_unlink=True)
            bpy.data.scenes.remove(other_scene)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def main():
    worldengine_studio.register()
    bpy.utils.register_class(WORLDENGINE_OT_cancelled_smoke)
    try:
        previous_store_path = director_project._store_path
        previous_save_due_at = director_project._save_due_at
        original_save_store = director_project.save_store
        save_calls = []
        with tempfile.TemporaryDirectory(prefix="director-save-debounce-") as directory:
            director_project.configure_store(Path(directory) / "director-native.blend")
            director_project.save_store = lambda: save_calls.append(True) or True
            try:
                assert director_project.request_save()
                assert director_project.request_save()
                assert director_project.has_pending_save()
                assert not director_project.flush_pending_save()
                assert director_project.flush_pending_save(force=True)
                assert len(save_calls) == 1
                assert not director_project.has_pending_save()
            finally:
                director_project.save_store = original_save_store
                director_project._store_path = previous_store_path
                director_project._save_due_at = previous_save_due_at

        duplicate_project_id = "director-deduplicate-smoke"
        older_scene = bpy.data.scenes.new("Duplicate Director Scene")
        newer_scene = bpy.data.scenes.new("Duplicate Director Scene")
        older_scene_name = older_scene.name
        newer_scene_name = newer_scene.name
        older_scene[director_project.PROJECT_ID_PROPERTY] = duplicate_project_id
        newer_scene[director_project.PROJECT_ID_PROPERTY] = duplicate_project_id
        assert director_project.deduplicate_managed_scenes() == 1
        assert older_scene_name not in bpy.data.scenes
        assert newer_scene_name in bpy.data.scenes
        bpy.data.scenes.remove(newer_scene)

        keep_id = "director-keep-populated-smoke"
        populated = bpy.data.scenes.new("Populated Keep")
        empty = bpy.data.scenes.new("Empty Drop")
        populated_name = populated.name
        empty_name = empty.name
        populated[director_project.PROJECT_ID_PROPERTY] = keep_id
        empty[director_project.PROJECT_ID_PROPERTY] = keep_id
        keep_mesh = bpy.data.meshes.new("KeepMesh")
        keep_object = bpy.data.objects.new("KeepObject", keep_mesh)
        populated.collection.objects.link(keep_object)
        bpy.context.window.scene = empty
        assert director_project.deduplicate_managed_scenes() == 1
        assert populated_name in bpy.data.scenes
        assert empty_name not in bpy.data.scenes
        assert bpy.context.scene.name == populated_name
        bpy.data.objects.remove(keep_object, do_unlink=True)
        bpy.data.meshes.remove(keep_mesh)
        bpy.data.scenes.remove(bpy.data.scenes[populated_name])

        catalog = execute(
            {
                "op": "discover_operators",
                "query": "subdivide",
                "category": "mesh",
                "scope": "modeling",
                "limit": 20,
            }
        )
        assert any(item["id"] == "mesh.subdivide" for item in catalog["operators"])

        description = execute(
            {"op": "describe_operator", "operator": "mesh.subdivide"}
        )
        properties = {item["id"]: item for item in description["properties"]}
        assert description["id"] == "mesh.subdivide"
        assert properties["number_cuts"]["type"] == "INT"
        assert properties["number_cuts"]["min"] <= 1

        cube_id = "modeling-smoke-cube"
        created = execute(
            {
                "op": "create_primitive",
                "id": cube_id,
                "name": "Agent Modeling Cube",
                "primitive": "cube",
                "dimensions": [2, 2, 2],
            }
        )
        assert created["object_id"] == cube_id
        verify_director_asset_import(blockout.find_object(cube_id))

        selection = execute(
            {
                "op": "set_selection",
                "selectedIds": [cube_id],
                "activeId": cube_id,
                "mode": "OBJECT",
            }
        )
        assert selection["activeObjectId"] == cube_id
        assert selection["selectedObjectIds"] == [cube_id]

        before = execute({"op": "inspect_object", "id": cube_id})
        assert before["mesh"]["vertices"] == 8
        assert before["mesh"]["edges"] == 12
        assert before["mesh"]["faces"] == 6
        assert before["mesh"]["triangles"] == 12
        assert before["mesh"]["looseVertices"] == 0
        assert before["evaluatedBounds"]["size"] == [2.0, 2.0, 2.0]
        assert before["selection"] == {"selected": True, "active": True}
        assert before["animation"]["action"] is None

        vertex_selection = execute(
            {
                "op": "select_mesh_elements",
                "id": cube_id,
                "domain": "VERTEX",
                "action": "SET",
                "indices": [0, 3],
            }
        )
        assert vertex_selection["objectId"] == cube_id
        assert vertex_selection["domain"] == "VERTEX"
        assert vertex_selection["action"] == "SET"
        assert vertex_selection["indices"] == [0, 3]
        assert vertex_selection["mode"] == "EDIT"
        assert vertex_selection["activeObjectId"] == cube_id
        assert vertex_selection["selectedObjectIds"] == [cube_id]
        vertex_cube = blockout.find_object(cube_id)
        assert vertex_cube.mode == "EDIT"
        vertex_cube.update_from_editmode()
        assert [
            vertex.index for vertex in vertex_cube.data.vertices if vertex.select
        ] == [0, 3]

        element_selection = execute(
            {
                "op": "select_mesh_elements",
                "id": cube_id,
                "domain": "EDGE",
                "action": "ALL",
                "indices": [],
            }
        )
        assert element_selection["objectId"] == cube_id
        assert element_selection["domain"] == "EDGE"
        assert element_selection["mode"] == "EDIT"
        assert element_selection["activeObjectId"] == cube_id
        assert element_selection["selectedObjectIds"] == [cube_id]
        assert blockout.find_object(cube_id).mode == "EDIT"

        subdivided = execute(
            {
                "op": "invoke_operator",
                "operator": "mesh.subdivide",
                "properties": {"number_cuts": 2},
                "context": {
                    "selectedIds": [cube_id],
                    "activeId": cube_id,
                    "mode": "EDIT",
                },
            }
        )
        assert "FINISHED" in subdivided["outcome"]
        assert subdivided["mode"] == "EDIT"
        assert subdivided["activeObjectId"] == cube_id
        assert subdivided["selectedObjectIds"] == [cube_id]

        scripted = execute(
            {
                "op": "execute_code",
                "code": (
                    "import bpy\n"
                    "before = {obj.name for obj in bpy.data.objects}\n"
                    "bpy.ops.mesh.primitive_uv_sphere_add(location=(8.0, 0.0, 1.0))\n"
                    "created = next(obj.name for obj in bpy.data.objects if obj.name not in before)\n"
                    "print('created', created)\n"
                    "result = created\n"
                ),
            }
        )
        assert scripted["createdObjectIds"]
        assert "created" in scripted["stdout"]
        assert scripted["result"]

        shimmed = execute(
            {
                "op": "execute_code",
                "code": (
                    "import bpy\n"
                    "import bmesh\n"
                    "bpy.data.objects.remove(bpy.data.objects['missing_roof_base'], do_unlink=True)\n"
                    "bm = bmesh.new()\n"
                    "bmesh.ops.create_grid(bm, x_segments=2, y_segments=2, size=1.0)\n"
                    "geom = bmesh.ops.extrude_face_region(bm, geom=list(bm.faces))\n"
                    "count = sum(1 for g in geom['geom'] if isinstance(g, bmesh.types.BMeshVert))\n"
                    "mesh = bpy.data.meshes.new('shim_roof_mesh')\n"
                    "bm.to_mesh(mesh)\n"
                    "bm.free()\n"
                    "obj = bpy.data.objects.new('shim_roof', mesh)\n"
                    "bpy.context.collection.objects.link(obj)\n"
                    "result = {'verts': count, 'name': obj.name}\n"
                ),
            }
        )
        assert shimmed["result"]["verts"] > 0
        assert shimmed["createdObjectIds"]
        assert bpy.data.objects.get("shim_roof") is not None

        after = execute({"op": "inspect_object", "id": cube_id})
        assert after["mesh"]["vertices"] > before["mesh"]["vertices"]
        assert after["mesh"]["edges"] > before["mesh"]["edges"]
        assert after["mesh"]["faces"] > before["mesh"]["faces"]
        assert after["mesh"]["selection"]["edges"]["count"] > 0
        assert len(after["mesh"]["selection"]["edges"]["sample"]) <= 64
        assert "selectedEdges" not in after["mesh"]

        modifier_result = execute(
            {
                "op": "invoke_operator",
                "operator": "object.modifier_add",
                "properties": {"type": "BEVEL"},
                "context": {
                    "selectedIds": [cube_id],
                    "activeId": cube_id,
                    "mode": "OBJECT",
                },
            }
        )
        assert "FINISHED" in modifier_result["outcome"]
        inspected = execute({"op": "inspect_object", "id": cube_id})
        bevel = next(item for item in inspected["modifiers"] if item["type"] == "BEVEL")

        rna_result = execute(
            {
                "op": "set_rna_property",
                "target": {
                    "kind": "modifier",
                    "objectId": cube_id,
                    "name": bevel["name"],
                },
                "path": ["width"],
                "value": 0.125,
            }
        )
        assert abs(rna_result["value"] - 0.125) < 1e-6
        cube = blockout.find_object(cube_id)
        assert abs(cube.modifiers[bevel["name"]].width - 0.125) < 1e-6

        modifier_cube_id = "modifier-smoke-cube"
        modifier_cutter_id = "modifier-smoke-cutter"
        modifier_cube_created = execute(
            {
                "op": "create_primitive",
                "id": modifier_cube_id,
                "name": "Agent Modifier Cube",
                "primitive": "cube",
                "dimensions": [1, 1, 1],
            }
        )
        assert modifier_cube_created["object_id"] == modifier_cube_id
        execute(
            {
                "op": "create_primitive",
                "id": modifier_cutter_id,
                "name": "Agent Modifier Cutter",
                "primitive": "cube",
                "dimensions": [0.5, 0.5, 0.5],
            }
        )
        modifier_cube = blockout.find_object(modifier_cube_id)
        base_vertex_count = len(modifier_cube.data.vertices)

        solidify_added = execute(
            {
                "op": "add_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Solidify",
                "modifierType": "SOLIDIFY",
                "properties": {"thickness": 0.12},
            }
        )
        assert solidify_added["objectId"] == modifier_cube_id
        assert solidify_added["dirtyObjectIds"] == [modifier_cube_id]
        assert solidify_added["modifier"]["name"] == "Agent Solidify"
        assert solidify_added["modifier"]["type"] == "SOLIDIFY"
        assert solidify_added["modifier"]["index"] == 0
        assert abs(solidify_added["modifier"]["properties"]["thickness"] - 0.12) < 1e-6
        assert solidify_added["modifiers"] == [
            {"name": "Agent Solidify", "type": "SOLIDIFY", "index": 0}
        ]

        try:
            execute(
                {
                    "op": "add_modifier",
                    "id": modifier_cube_id,
                    "modifierName": "Agent Solidify",
                    "modifierType": "BEVEL",
                }
            )
        except ValueError as error:
            assert "already exists" in str(error)
        else:
            raise AssertionError("add_modifier must reject duplicate modifier names")

        bevel_added = execute(
            {
                "op": "add_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Stack Bevel",
                "modifierType": "BEVEL",
            }
        )
        assert bevel_added["modifier"]["index"] == 1

        solidify_updated = execute(
            {
                "op": "set_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Solidify",
                "properties": {"thickness": 0.2},
            }
        )
        assert abs(solidify_updated["modifier"]["properties"]["thickness"] - 0.2) < 1e-6
        assert abs(modifier_cube.modifiers["Agent Solidify"].thickness - 0.2) < 1e-6

        reordered = execute(
            {
                "op": "reorder_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Stack Bevel",
                "index": 0,
            }
        )
        assert reordered["modifier"] == {"name": "Agent Stack Bevel", "index": 0}
        assert [item["name"] for item in reordered["modifiers"]] == [
            "Agent Stack Bevel",
            "Agent Solidify",
        ]

        try:
            execute(
                {
                    "op": "reorder_modifier",
                    "id": modifier_cube_id,
                    "modifierName": "Agent Stack Bevel",
                    "index": 5,
                }
            )
        except ValueError as error:
            assert "out of range" in str(error)
        else:
            raise AssertionError("reorder_modifier must reject an index beyond the stack")

        boolean_added = execute(
            {
                "op": "add_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Boolean",
                "modifierType": "BOOLEAN",
                "properties": {"object": modifier_cutter_id, "operation": "DIFFERENCE"},
            }
        )
        assert boolean_added["modifier"]["properties"]["object"] == modifier_cutter_id
        assert boolean_added["modifier"]["properties"]["operation"] == "DIFFERENCE"
        assert (
            modifier_cube.modifiers["Agent Boolean"].object
            is blockout.find_object(modifier_cutter_id)
        )

        try:
            execute(
                {
                    "op": "set_modifier",
                    "id": modifier_cube_id,
                    "modifierName": "Missing Modifier",
                    "properties": {"thickness": 0.5},
                }
            )
        except ValueError as error:
            assert "Unknown Blender modifier" in str(error)
        else:
            raise AssertionError("set_modifier must reject an unknown modifier name")

        try:
            execute(
                {
                    "op": "set_modifier",
                    "id": modifier_cube_id,
                    "modifierName": "Agent Solidify",
                    "properties": {"filepath": "/tmp/agent.blend"},
                }
            )
        except ValueError as error:
            message = str(error)
            assert "Unknown Blender modifier property" in message or "outside the Director modeling kernel" in message
        else:
            raise AssertionError("set_modifier must reject unknown or denied path-like properties")

        try:
            execute(
                {
                    "op": "set_modifier",
                    "id": modifier_cube_id,
                    "modifierName": "Agent Boolean",
                    "properties": {"object": "missing-cutter"},
                }
            )
        except ValueError as error:
            assert "Unknown WorldEngine object" in str(error)
        else:
            raise AssertionError("set_modifier must reject unknown pointer ids")

        applied = execute(
            {
                "op": "apply_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Solidify",
            }
        )
        assert applied["appliedModifier"] == "Agent Solidify"
        assert applied["mesh"]["vertices"] == base_vertex_count * 2
        assert applied["mesh"]["vertices"] > base_vertex_count
        assert applied["mesh"]["faces"] > 0
        assert [item["name"] for item in applied["modifiers"]] == [
            "Agent Stack Bevel",
            "Agent Boolean",
        ]
        modifier_cube = blockout.find_object(modifier_cube_id)
        assert len(modifier_cube.data.vertices) == base_vertex_count * 2

        removed = execute(
            {
                "op": "remove_modifier",
                "id": modifier_cube_id,
                "modifierName": "Agent Boolean",
            }
        )
        assert removed["removedModifier"] == "Agent Boolean"
        assert [item["name"] for item in removed["modifiers"]] == ["Agent Stack Bevel"]

        material_result = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Agent Modeling Clay",
            "createIfMissing": True,
            "faceScope": "ALL",
            "parameters": {
                "baseColor": [0.24, 0.36, 0.52],
                "roughness": 0.68,
                "metallic": 0.12,
                "alpha": 0.84,
            },
        })
        assert material_result["objectId"] == cube_id
        assert material_result["material"]["created"] is True
        material_slot_index = material_result["material"]["slotIndex"]
        assert material_slot_index >= 0
        assert cube.active_material_index == material_slot_index
        assert all(
            abs(actual - expected) < 1e-6
            for actual, expected in zip(
                material_result["material"]["baseColor"],
                [0.24, 0.36, 0.52],
            )
        )
        assert abs(material_result["material"]["roughness"] - 0.68) < 1e-6
        assert abs(material_result["material"]["metallic"] - 0.12) < 1e-6
        assert abs(material_result["material"]["alpha"] - 0.84) < 1e-6
        material = bpy.data.materials["Agent Modeling Clay"]
        reused_material = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": material.name,
            "createIfMissing": False,
            "parameters": {"roughness": 0.7},
        })
        assert reused_material["material"]["created"] is False
        assert reused_material["material"]["slotIndex"] == material_slot_index
        default_created = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Default Created Clay",
            "faceScope": "PRESERVE",
        })
        assert default_created["material"]["created"] is True
        assert bpy.data.materials.get("Default Created Clay") is not None
        bpy.data.materials.new("Gold Plaque")
        aliased = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "gold_plaque",
            "createIfMissing": False,
            "faceScope": "PRESERVE",
        })
        assert aliased.get("skipped") is not True
        assert aliased["material"]["name"] == "Gold Plaque"
        assert aliased["material"]["created"] is False
        assert aliased["material"]["resolvedKind"] == "normalized"
        hinted = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "finial_gold",
            "faceScope": "PRESERVE",
        })
        assert hinted["material"]["created"] is True
        assert hinted["material"]["metallic"] > 0.5
        skipped_missing = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Definitely Missing Material",
            "createIfMissing": False,
        })
        assert skipped_missing["skipped"] is True
        assert bpy.data.materials.get("Definitely Missing Material") is None
        bpy.data.materials.new("ground_grey")
        bpy.data.materials.new("roof_tile")
        bpy.data.materials.new("gold_leaf")
        for index in range(1, 12):
            bpy.data.materials.new(f"Beta_HighLimbsGeoSG3.{index:03d}")
        nearby = blockout.nearby_material_names("gold_plaque")
        assert "gold_leaf" in nearby
        assert "Gold Plaque" in nearby
        assert "ground_grey" not in nearby
        assert "roof_tile" not in nearby
        listed = blockout.list_scene_material_names()
        limb_names = [name for name in listed if name.startswith("Beta_HighLimbsGeoSG3")]
        assert len(limb_names) == 1
        material_inspection = execute({"op": "inspect_object", "id": cube_id})
        assert material.name in material_inspection["sceneMaterials"]
        assert "Gold Plaque" in material_inspection["sceneMaterials"]
        node_summary = next(
            item for item in material_inspection["materialNodes"]
            if item["material"] == material.name
        )
        assert node_summary["material"] == material.name
        assert node_summary["useNodes"] is True
        assert node_summary["nodeCount"] >= 2
        assert node_summary["nodeTypes"]["BSDF_PRINCIPLED"] == 1
        assert all(
            abs(actual - expected) < 1e-6
            for actual, expected in zip(
                node_summary["principled"]["baseColor"],
                [0.24, 0.36, 0.52],
            )
        )
        assert abs(node_summary["principled"]["roughness"] - 0.7) < 1e-6
        assert abs(node_summary["principled"]["alpha"] - 0.84) < 1e-6

        original_face_indices = [polygon.material_index for polygon in cube.data.polygons]
        assert original_face_indices == [material_slot_index] * len(cube.data.polygons)
        accent_result = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Agent Face Accent",
            "createIfMissing": True,
            "faceScope": "PRESERVE",
        })
        accent_slot_index = accent_result["material"]["slotIndex"]
        assert accent_result["faceScope"] == "PRESERVE"
        assert accent_result["assignedFaceIndices"] == []
        assert [polygon.material_index for polygon in cube.data.polygons] == original_face_indices

        object_selected_faces = [0, len(cube.data.polygons) - 1]
        for polygon in cube.data.polygons:
            polygon.select = polygon.index in object_selected_faces
        object_face_result = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Agent Face Accent",
            "createIfMissing": False,
            "faceScope": "SELECTED",
        })
        assert object_face_result["assignedFaceIndices"] == object_selected_faces
        assert [
            polygon.index
            for polygon in cube.data.polygons
            if polygon.material_index == accent_slot_index
        ] == object_selected_faces

        all_faces_result = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": "Agent Face Accent",
            "createIfMissing": False,
            "faceScope": "ALL",
        })
        assert all_faces_result["assignedFaceIndices"] == list(range(len(cube.data.polygons)))
        assert all(
            polygon.material_index == accent_slot_index for polygon in cube.data.polygons
        )

        edit_selected_faces = [1, 2]
        for polygon in cube.data.polygons:
            polygon.select = polygon.index in edit_selected_faces
        bpy.context.view_layer.objects.active = cube
        cube.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        edit_mesh = bmesh.from_edit_mesh(cube.data)
        for face in edit_mesh.faces:
            face.select = face.index in edit_selected_faces
        bmesh.update_edit_mesh(cube.data, loop_triangles=False, destructive=False)
        edit_face_result = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": material.name,
            "createIfMissing": False,
            "faceScope": "SELECTED",
        })
        assert edit_face_result["mode"] == "EDIT"
        assert edit_face_result["assignedFaceIndices"] == edit_selected_faces
        bpy.ops.object.mode_set(mode='OBJECT')
        assert [
            polygon.index
            for polygon in cube.data.polygons
            if polygon.material_index == material_slot_index
        ] == edit_selected_faces
        execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": material.name,
            "createIfMissing": False,
            "faceScope": "ALL",
        })
        assert all(
            polygon.material_index == material_slot_index for polygon in cube.data.polygons
        )

        material_graph = next(
            item for item in material_inspection["materialGraphs"]
            if item["materialName"] == material.name
        )
        assert material_graph["activeOutputNodeRef"] == "material-output"
        assert {node["nodeRef"] for node in material_graph["nodes"]} >= {
            "principled",
            "material-output",
        }
        assert material_graph["links"] == [{
            "from": {"nodeRef": "principled", "socketRef": "BSDF"},
            "to": {"nodeRef": "material-output", "socketRef": "Surface"},
        }]

        duplicate = material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        duplicate.name = "principled"
        assert duplicate.name != "principled"
        duplicate_graph = execute({"op": "inspect_object", "id": cube_id})
        duplicate_refs = [
            node["nodeRef"]
            for graph in duplicate_graph["materialGraphs"]
            if graph["materialName"] == material.name
            for node in graph["nodes"]
        ]
        assert len(duplicate_refs) == len(set(duplicate_refs))
        material.node_tree.nodes.remove(duplicate)

        mix_created = execute({
            "op": "create_material_node",
            "id": cube_id,
            "materialName": material.name,
            "nodeRef": "agent-mix",
            "nodeType": "MIX_COLOR",
            "location": [-260, 80],
            "label": "Agent tint",
        })
        assert mix_created["node"]["nodeRef"] == "agent-mix"
        assert mix_created["node"]["blenderType"] == "ShaderNodeMixRGB"
        mix_input = execute({
            "op": "set_material_node_input",
            "id": cube_id,
            "materialName": material.name,
            "nodeRef": "agent-mix",
            "inputSocketRef": "Color1",
            "value": [0.1, 0.2, 0.3, 1.0],
        })
        assert mix_input["input"]["socketRef"] == "Color1"
        assert all(
            abs(actual - expected) < 1e-6
            for actual, expected in zip(
                mix_input["input"]["defaultValue"],
                [0.1, 0.2, 0.3, 1.0],
            )
        )
        disconnected = execute({
            "op": "disconnect_material_node_input",
            "id": cube_id,
            "materialName": material.name,
            "nodeRef": "material-output",
            "inputSocketRef": "Surface",
        })
        assert disconnected["disconnectedLinks"] == material_graph["links"]
        connected = execute({
            "op": "connect_material_nodes",
            "id": cube_id,
            "materialName": material.name,
            "from": {"nodeRef": "principled", "socketRef": "BSDF"},
            "to": {"nodeRef": "material-output", "socketRef": "Surface"},
        })
        assert connected["link"] == material_graph["links"][0]
        deleted_mix = execute({
            "op": "delete_material_node",
            "id": cube_id,
            "materialName": material.name,
            "nodeRef": "agent-mix",
        })
        assert deleted_mix["deletedNode"]["nodeRef"] == "agent-mix"

        custom_material = bpy.data.materials.new("Existing Custom Graph")
        custom_material.use_nodes = True
        custom_tree = custom_material.node_tree
        custom_tree.nodes.clear()
        custom_shader = custom_tree.nodes.new("ShaderNodeBsdfDiffuse")
        custom_shader.name = "custom-shader"
        custom_output = custom_tree.nodes.new("ShaderNodeOutputMaterial")
        custom_output.name = "custom-output"
        custom_output.is_active_output = True
        custom_tree.links.new(custom_shader.outputs["BSDF"], custom_output.inputs["Surface"])
        custom_link_before = (
            custom_tree.links[0].from_node.name,
            custom_tree.links[0].to_node.name,
        )
        custom_assigned = execute({
            "op": "assign_material",
            "id": cube_id,
            "materialName": custom_material.name,
            "createIfMissing": False,
        })
        assert custom_assigned["material"]["principled"] is None
        assert not any(node.type == 'BSDF_PRINCIPLED' for node in custom_tree.nodes)
        assert len(custom_tree.links) == 1
        assert (
            custom_tree.links[0].from_node.name,
            custom_tree.links[0].to_node.name,
        ) == custom_link_before
        multi_material_inspection = execute({"op": "inspect_object", "id": cube_id})
        assert {graph["materialName"] for graph in multi_material_inspection["materialGraphs"]} >= {
            material.name,
            custom_material.name,
        }

        for method in ("SMART", "UNWRAP", "CUBE"):
            uv_layer_name = f"Agent {method} UV"
            if method == "UNWRAP":
                for edge in cube.data.edges:
                    edge.use_seam = True
            projected = execute({
                "op": "project_uv",
                "id": cube_id,
                "method": method,
                "uvLayerName": uv_layer_name,
            })
            assert projected["objectId"] == cube_id
            assert projected["method"] == method
            assert projected["replaceExisting"] is False
            assert projected["replaced"] is False
            assert "FINISHED" in projected["outcome"]
            assert projected["uvLayer"]["name"] == uv_layer_name
            assert projected["uvLayer"]["active"] is True
            assert projected["uvLayer"]["activeRender"] is True
            assert projected["uvLayer"]["loopCount"] == len(cube.data.loops)
            projected_layer = cube.data.uv_layers[uv_layer_name]
            projected_coordinates = [tuple(item.uv) for item in projected_layer.data]
            assert max(value[0] for value in projected_coordinates) - min(
                value[0] for value in projected_coordinates
            ) > 1e-4
            assert max(value[1] for value in projected_coordinates) - min(
                value[1] for value in projected_coordinates
            ) > 1e-4
        cube_uv = cube.data.uv_layers["Agent CUBE UV"]
        cube_uv_coordinates = [tuple(item.uv) for item in cube_uv.data]
        try:
            execute({
                "op": "project_uv",
                "id": cube_id,
                "method": "SMART",
                "uvLayerName": "Agent CUBE UV",
            })
        except ValueError as error:
            assert "UV layer already exists" in str(error)
        else:
            raise AssertionError("project_uv must not overwrite an existing layer by default")
        assert [tuple(item.uv) for item in cube_uv.data] == cube_uv_coordinates
        replaced_uv = execute({
            "op": "project_uv",
            "id": cube_id,
            "method": "SMART",
            "uvLayerName": "Agent CUBE UV",
            "replaceExisting": True,
        })
        assert replaced_uv["replaceExisting"] is True
        assert replaced_uv["replaced"] is True
        uv_inspection = execute({"op": "inspect_object", "id": cube_id})
        assert uv_inspection["mesh"]["uvLayers"][-3:] == [
            "Agent SMART UV",
            "Agent UNWRAP UV",
            "Agent CUBE UV",
        ]
        assert uv_inspection["mesh"]["uvLayerDetails"][-1]["active"] is True

        override_material = bpy.data.materials.new("Agent Modeling Override")
        override_material.use_nodes = True
        material_slot_index = next(
            index
            for index, slot in enumerate(cube.material_slots)
            if slot.material == material
        )
        cube.material_slots[material_slot_index].link = 'OBJECT'
        cube.material_slots[material_slot_index].material = override_material
        for polygon in cube.data.polygons:
            polygon.material_index = material_slot_index
        slot_inspection = execute({"op": "inspect_object", "id": cube_id})
        slot_summary = slot_inspection["materialSlots"][material_slot_index]
        assert slot_summary["index"] == material_slot_index
        assert slot_summary["link"] == "OBJECT"
        assert slot_summary["resolvedMaterial"] == override_material.name
        assert slot_summary["dataMaterial"] == material.name

        cube.keyframe_insert(data_path="location", frame=1, index=0)
        cube.location.x += 1.0
        cube.keyframe_insert(data_path="location", frame=10, index=0)
        animation_inspection = execute({"op": "inspect_object", "id": cube_id})
        assert animation_inspection["animation"]["fCurveCount"] == 1
        assert animation_inspection["animation"]["keyframeCount"] == 2

        armature = bpy.data.armatures.new("Agent Modeling Armature")
        rig = bpy.data.objects.new("Agent Modeling Rig", armature)
        bpy.context.scene.collection.objects.link(rig)
        rig_id = "modeling-smoke-rig"
        rig[blockout.ID_PROPERTY] = rig_id
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.select_all(action='DESELECT')
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode='EDIT')
        root_bone = armature.edit_bones.new("Agent Root")
        root_bone.head = (0.0, 0.0, 0.0)
        root_bone.tail = (0.0, 0.0, 1.0)
        child_bone = armature.edit_bones.new("Agent Child")
        child_bone.head = root_bone.tail
        child_bone.tail = (0.0, 0.0, 2.0)
        child_bone.parent = root_bone
        child_bone.use_connect = True
        rig_inspection = execute({"op": "inspect_object", "id": rig_id})
        assert rig_inspection["rig"]["boneCount"] == 2
        assert rig_inspection["rig"]["deformBoneCount"] == 2
        assert rig_inspection["armature"]["bones"] == ["Agent Root", "Agent Child"]
        inspected_child = next(
            bone for bone in rig_inspection["rig"]["bones"]
            if bone["boneRef"] == "Agent Child"
        )
        assert inspected_child["parentRef"] == "Agent Root"
        assert inspected_child["local"]["rotationQuaternion"] == [1.0, 0.0, 0.0, 0.0]
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.select_all(action='DESELECT')
        cube.select_set(True)
        bpy.context.view_layer.objects.active = cube

        main_scene = bpy.context.scene
        peer_scene = bpy.data.scenes.new("Other Director Project")
        bpy.context.window.scene = peer_scene
        peer_cube = blockout.create_primitive(
            peer_scene,
            "cube",
            name="Agent Modeling Cube",
        )
        bpy.context.window.scene = main_scene
        assert peer_cube.name != cube.name
        assert blockout.object_display_name(peer_cube) == blockout.object_display_name(cube)
        assert blockout.ensure_collection(peer_scene) is not blockout.ensure_collection(main_scene)
        assert main_scene.objects.get(peer_cube.name) is None
        bpy.data.objects.remove(peer_cube, do_unlink=True)
        bpy.data.scenes.remove(peer_scene)

        camera = blockout.create_camera(bpy.context.scene, name="Manual Camera")
        light = blockout.create_light(bpy.context.scene, name="Manual Light")
        world_result = execute(
            {"op": "set_world_environment", "color": [0.12, 0.18, 0.3], "strength": 0.8}
        )
        assert world_result["world"] == {"color": [0.12, 0.18, 0.3], "strength": 0.8}
        background = next(
            node for node in bpy.context.scene.world.node_tree.nodes if node.type == 'BACKGROUND'
        )
        assert tuple(round(value, 2) for value in background.inputs["Color"].default_value[:3]) == (
            0.12,
            0.18,
            0.3,
        )
        assert abs(background.inputs["Strength"].default_value - 0.8) < 1e-6
        preview_child = blockout.create_primitive(
            bpy.context.scene,
            "cube",
            name="Preview Hierarchy Child",
            dimensions=(0.25, 0.25, 0.25),
        )
        preview_child.parent = cube

        preview_revision = bpy.context.scene.worldengine_studio.scene_revision
        preview_object_count = len(bpy.context.scene.objects)
        preview_active = bpy.context.view_layer.objects.active
        preview_selected = set(bpy.context.selected_objects)
        preview_temp_before = set(
            Path(tempfile.gettempdir()).glob("worldengine-preview-*.glb")
        )
        preview = execute({"op": "export_scene_preview"})
        preview_bytes = base64.b64decode(preview["dataBase64"], validate=True)
        assert preview["contract"] == live_protocol.CONTRACT
        assert preview["sceneEpoch"] == native_session.scene_epoch_value()
        assert preview["revision"] == preview_revision
        assert preview["mimeType"] == "model/gltf-binary"
        assert preview["byteLength"] == len(preview_bytes)
        assert len(bpy.context.scene.objects) == preview_object_count
        assert bpy.context.view_layer.objects.active == preview_active
        assert set(bpy.context.selected_objects) == preview_selected
        assert set(
            Path(tempfile.gettempdir()).glob("worldengine-preview-*.glb")
        ) == preview_temp_before
        preview_document = decode_glb_json(preview_bytes)
        node_names = {node.get("name") for node in preview_document.get("nodes", [])}
        material_names = {
            item.get("name") for item in preview_document.get("materials", [])
        }
        assert "Agent Modeling Cube" in node_names
        assert "Manual Camera" not in node_names
        assert "Manual Light" not in node_names
        assert "cameras" not in preview_document
        assert "KHR_lights_punctual" not in preview_document.get("extensionsUsed", [])
        assert material.name in material_names
        preview_nodes = preview_document["nodes"]
        cube_node_index = next(
            index
            for index, node in enumerate(preview_nodes)
            if node.get("name") == cube.name
        )
        child_node_index = next(
            index
            for index, node in enumerate(preview_nodes)
            if node.get("name") == preview_child.name
        )
        assert child_node_index in preview_nodes[cube_node_index]["children"]
        cube_mesh = preview_document["meshes"][
            preview_nodes[cube_node_index]["mesh"]
        ]
        position_accessor = cube_mesh["primitives"][0]["attributes"]["POSITION"]
        assert (
            preview_document["accessors"][position_accessor]["count"]
            >= slot_inspection["mesh"]["vertices"]
        )

        epoch_before_start = native_session.scene_epoch_value()
        native_session.start(0)
        started_epoch = native_session.scene_epoch_value()
        assert started_epoch != epoch_before_start
        assert native_session.current_snapshot()["sceneEpoch"] == started_epoch
        native_session._on_load_post("")
        loaded_epoch = native_session.scene_epoch_value()
        assert loaded_epoch != started_epoch
        assert native_session.current_snapshot()["sceneEpoch"] == loaded_epoch

        def flush_scheduled_snapshot():
            if bpy.app.timers.is_registered(native_session._refresh_manual_snapshot):
                bpy.app.timers.unregister(native_session._refresh_manual_snapshot)
            assert native_session._manual_change_pending is True
            native_session._refresh_manual_snapshot()

        revision_before_manual_edit = bpy.context.scene.worldengine_studio.scene_revision
        cube.location.x += 0.5
        bpy.context.view_layer.update()
        flush_scheduled_snapshot()
        assert (
            bpy.context.scene.worldengine_studio.scene_revision
            == revision_before_manual_edit + 1
        )
        snapshot = native_session.current_snapshot()
        snapshot_cube = next(item for item in snapshot["objects"] if item["id"] == cube_id)
        assert abs(snapshot_cube["position"][0] - cube.location.x) < 1e-6

        def flush_external_change(change, *, revision_delta=1):
            revision = native_session._revision_value(bpy.context.scene)
            change()
            bpy.context.view_layer.update()
            flush_scheduled_snapshot()
            assert (
                native_session._revision_value(bpy.context.scene)
                == revision + revision_delta
            )

        flush_external_change(lambda: setattr(camera.data, "lens", 52.0))
        flush_external_change(lambda: setattr(light.data, "energy", 725.0))
        flush_external_change(
            lambda: setattr(material, "diffuse_color", (0.24, 0.36, 0.48, 1.0))
        )
        flush_external_change(lambda: setattr(cube.data.vertices[0].co, "x", 1.25))
        flush_external_change(lambda: bpy.context.scene.frame_set(3), revision_delta=0)
        external_snapshot = native_session.current_snapshot()
        snapshot_camera = next(
            item
            for item in external_snapshot["cameras"]
            if item["id"] == camera[blockout.ID_PROPERTY]
        )
        snapshot_light = next(
            item
            for item in external_snapshot["lights"]
            if item["id"] == light[blockout.ID_PROPERTY]
        )
        assert snapshot_camera["focalLengthMm"] == 52.0
        assert snapshot_light["energy"] == 725.0
        assert external_snapshot["frame"] == 3

        def submit(request_id, operations):
            revision = native_session._revision_value(bpy.context.scene)
            batch = live_protocol.parse_live_batch(
                json.dumps(
                    {
                        "contract": live_protocol.CONTRACT,
                        "requestId": request_id,
                        "expectedSceneEpoch": native_session.scene_epoch_value(),
                        "expectedRevision": revision,
                        "operations": operations,
                    }
                )
            )
            assert native_session._queue_command(batch) is None
            assert native_session.drain_pending() == 1
            return native_session.command_record(request_id)

        bulk_delete_meshes = []
        for identifier in ("bulk-delete-a", "bulk-delete-b"):
            created = execute({"op": "create_primitive", "id": identifier, "primitive": "cube"})
            bulk_delete_meshes.append(blockout.find_object(created["object_id"]).data.name)
        bulk_delete = submit(
            "bulk-delete-batch",
            [
                {"op": "delete_object", "id": "bulk-delete-a"},
                {"op": "delete_object", "id": "bulk-delete-b"},
            ],
        )
        assert bulk_delete["status"] == "succeeded"
        assert [item["object_id"] for item in bulk_delete["result"]["operations"]] == [
            "bulk-delete-a",
            "bulk-delete-b",
        ]
        assert blockout.find_object("bulk-delete-a") is None
        assert blockout.find_object("bulk-delete-b") is None
        assert all(name not in bpy.data.meshes for name in bulk_delete_meshes)

        cancelled_revision = native_session._revision_value(bpy.context.scene)
        cancelled_location = tuple(blockout.find_object(cube_id).location)
        cancelled_snapshot_position = next(
            item["position"]
            for item in native_session.current_snapshot()["objects"]
            if item["id"] == cube_id
        )
        cancelled = submit(
            "cancelled-operator-rolls-back",
            [
                {
                    "op": "invoke_operator",
                    "operator": "worldengine.cancelled_smoke",
                    "context": {
                        "selectedIds": [cube_id],
                        "activeId": cube_id,
                        "mode": "OBJECT",
                    },
                    "properties": {},
                }
            ],
        )
        assert cancelled["status"] == "failed"
        assert cancelled["revision"] == cancelled_revision
        assert "did not finish" in cancelled["error"]
        assert "CANCELLED" in cancelled["error"]
        cube = blockout.find_object(cube_id)
        assert tuple(cube.location) == cancelled_location
        cancelled_snapshot = native_session.current_snapshot()
        assert cancelled_snapshot["revision"] == cancelled_revision
        assert next(
            item["position"]
            for item in cancelled_snapshot["objects"]
            if item["id"] == cube_id
        ) == cancelled_snapshot_position

        native_preview_revision = native_session._revision_value(bpy.context.scene)
        native_preview = submit(
            "read-only-scene-preview",
            [{"op": "export_scene_preview"}],
        )
        native_preview_metadata = native_preview["result"]["operations"][0]
        assert "dataBase64" not in native_preview_metadata
        assert native_preview_metadata["sceneEpoch"] == loaded_epoch
        native_preview = native_session.command_record(
            "read-only-scene-preview", consume=True
        )
        native_preview_result = native_preview["result"]["operations"][0]
        assert native_preview["status"] == "succeeded"
        assert native_preview["revision"] == native_preview_revision
        assert native_preview["result"]["revisionBefore"] == native_preview_revision
        assert native_preview["result"]["revisionAfter"] == native_preview_revision
        assert "snapshotBefore" not in native_preview["result"]
        assert "snapshotAfter" not in native_preview["result"]
        assert native_preview_result["revision"] == native_preview_revision
        assert native_preview_result["sceneEpoch"] == loaded_epoch
        assert native_preview_result["byteLength"] == len(
            base64.b64decode(native_preview_result["dataBase64"], validate=True)
        )
        assert native_session.command_record("read-only-scene-preview") is None
        selection_revision = native_session._revision_value(bpy.context.scene)
        selected = submit(
            "selection-does-not-revise",
            [
                {
                    "op": "set_selection",
                    "selectedIds": [cube_id],
                    "activeId": cube_id,
                    "mode": "OBJECT",
                }
            ],
        )
        assert selected["status"] == "succeeded"
        assert selected["revision"] == selection_revision
        assert selected["result"]["revisionBefore"] == selection_revision
        assert selected["result"]["revisionAfter"] == selection_revision
        bpy.context.view_layer.update()
        if native_session._manual_change_pending:
            flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision

        element_selected = submit(
            "element-selection-does-not-revise",
            [
                {
                    "op": "select_mesh_elements",
                    "id": cube_id,
                    "domain": "EDGE",
                    "action": "SET",
                    "indices": [0],
                }
            ],
        )
        assert element_selected["revision"] == selection_revision
        bpy.context.view_layer.update()
        if native_session._manual_change_pending:
            flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision

        exited_edit = submit(
            "exit-edit-does-not-revise",
            [
                {
                    "op": "set_selection",
                    "selectedIds": [cube_id],
                    "activeId": cube_id,
                    "mode": "OBJECT",
                }
            ],
        )
        assert exited_edit["revision"] == selection_revision
        bpy.context.view_layer.update()
        if native_session._manual_change_pending:
            flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision

        cube.select_set(True)
        bpy.context.view_layer.objects.active = cube
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.context.view_layer.update()
        flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.context.view_layer.update()
        flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.update()
        flush_scheduled_snapshot()
        assert native_session._revision_value(bpy.context.scene) == selection_revision

        epoch_conflict_revision = native_session._revision_value(bpy.context.scene)
        epoch_conflict = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "stale-scene-epoch",
                    "expectedSceneEpoch": started_epoch,
                    "expectedRevision": epoch_conflict_revision,
                    "operations": [
                        {
                            "op": "create_primitive",
                            "id": "stale-scene-epoch-leak",
                            "primitive": "cube",
                        }
                    ],
                }
            )
        )
        assert native_session._queue_command(epoch_conflict) is None
        assert native_session.drain_pending() == 1
        epoch_conflict_record = native_session.command_record("stale-scene-epoch")
        assert epoch_conflict_record["status"] == "failed"
        assert epoch_conflict_record["code"] == "scene_epoch_conflict"
        assert native_session._revision_value(bpy.context.scene) == epoch_conflict_revision
        assert blockout.find_object("stale-scene-epoch-leak") is None

        created = submit(
            "atomic-create",
            [{"op": "create_primitive", "id": "atomic-undoable", "primitive": "cube"}],
        )
        assert created["status"] == "succeeded"
        assert created["result"]["revisionBefore"] == selection_revision
        assert created["result"]["revisionAfter"] == created["revision"]
        assert "snapshotBefore" not in created["result"]
        assert "snapshotAfter" not in created["result"]
        current_snapshot = native_session.current_snapshot()
        assert current_snapshot["revision"] == created["revision"]
        assert any(
            item["id"] == "atomic-undoable"
            for item in current_snapshot["objects"]
        )
        assert blockout.find_object("atomic-undoable") is not None

        undone = submit("atomic-undo", [{"op": "undo_scene"}])
        assert undone["status"] == "succeeded"
        assert undone["revision"] == created["revision"] + 1
        assert blockout.find_object("atomic-undoable") is None

        redone = submit("atomic-redo", [{"op": "redo_scene"}])
        assert redone["status"] == "succeeded"
        assert redone["revision"] == undone["revision"] + 1
        assert blockout.find_object("atomic-undoable") is not None
        assert bpy.context.scene.worldengine_studio.scene_revision == redone["revision"]

        cube = blockout.find_object(cube_id)
        unknown_material_revision = native_session._revision_value(bpy.context.scene)
        unknown_material_slots = [
            slot.material.name if slot.material is not None else None
            for slot in cube.material_slots
        ]
        unknown_material_faces = [
            polygon.material_index for polygon in cube.data.polygons
        ]
        unknown_material = submit(
            "unknown-material-does-not-create",
            [
                {
                    "op": "assign_material",
                    "id": cube_id,
                    "materialName": "Must Already Exist",
                    "createIfMissing": False,
                    "faceScope": "ALL",
                }
            ],
        )
        assert unknown_material["status"] == "succeeded"
        assert unknown_material["result"]["operations"][0]["skipped"] is True
        assert unknown_material["revision"] == unknown_material_revision
        assert bpy.data.materials.get("Must Already Exist") is None
        cube = blockout.find_object(cube_id)
        assert [
            slot.material.name if slot.material is not None else None
            for slot in cube.material_slots
        ] == unknown_material_slots
        assert [
            polygon.material_index for polygon in cube.data.polygons
        ] == unknown_material_faces

        mixed_material_revision = native_session._revision_value(bpy.context.scene)
        mixed_material = submit(
            "unknown-material-skips-rest-of-batch",
            [
                {
                    "op": "assign_material",
                    "id": cube_id,
                    "materialName": "Agent Modeling Clay",
                    "createIfMissing": False,
                    "faceScope": "ALL",
                },
                {
                    "op": "assign_material",
                    "id": cube_id,
                    "materialName": "Must Already Exist",
                    "createIfMissing": False,
                    "faceScope": "ALL",
                },
            ],
        )
        assert mixed_material["status"] == "succeeded"
        assert mixed_material["result"]["operations"][0].get("skipped") is not True
        assert mixed_material["result"]["operations"][1]["skipped"] is True
        assert mixed_material["revision"] == mixed_material_revision + 1
        assert bpy.data.materials.get("Must Already Exist") is None
        assert cube.data.materials.get("Agent Modeling Clay") is not None

        material_uv_before = native_session._revision_value(bpy.context.scene)
        material_uv = submit(
            "material-and-uv-one-transaction",
            [
                {
                    "op": "assign_material",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "createIfMissing": True,
                    "faceScope": "ALL",
                    "parameters": {
                        "baseColor": [0.18, 0.28, 0.42],
                        "roughness": 0.76,
                        "metallic": 0.04,
                        "alpha": 0.92,
                    },
                },
                {
                    "op": "project_uv",
                    "id": cube_id,
                    "method": "SMART",
                    "uvLayerName": "TransactionalUV",
                },
            ],
        )
        assert material_uv["status"] == "succeeded"
        assert material_uv["revision"] == material_uv_before + 1
        assert material_uv["result"]["revisionBefore"] == material_uv_before
        assert material_uv["result"]["revisionAfter"] == material_uv["revision"]
        assert material_uv["result"]["operations"][0]["material"]["name"] == "Transactional Clay"
        assert material_uv["result"]["operations"][1]["uvLayer"]["name"] == "TransactionalUV"
        assert cube.data.materials.get("Transactional Clay") is not None
        assert cube.data.uv_layers.get("TransactionalUV") is not None

        material_uv_undo = submit("material-and-uv-undo", [{"op": "undo_scene"}])
        assert material_uv_undo["status"] == "succeeded"
        cube = blockout.find_object(cube_id)
        assert cube.data.materials.get("Transactional Clay") is None
        assert cube.data.uv_layers.get("TransactionalUV") is None

        material_uv_redo = submit("material-and-uv-redo", [{"op": "redo_scene"}])
        assert material_uv_redo["status"] == "succeeded"
        cube = blockout.find_object(cube_id)
        assert cube.data.materials.get("Transactional Clay") is not None
        assert cube.data.uv_layers.get("TransactionalUV") is not None

        uv_replace_revision = native_session._revision_value(bpy.context.scene)
        transactional_uv = cube.data.uv_layers["TransactionalUV"]
        transactional_uv_coordinates = [tuple(item.uv) for item in transactional_uv.data]
        transactional_slots = [
            slot.material.name if slot.material is not None else None
            for slot in cube.material_slots
        ]
        transactional_faces = [polygon.material_index for polygon in cube.data.polygons]
        uv_replace_rejected = submit(
            "existing-uv-rolls-back-material",
            [
                {
                    "op": "assign_material",
                    "id": cube_id,
                    "materialName": "Must Roll Back With UV",
                    "createIfMissing": True,
                    "faceScope": "ALL",
                },
                {
                    "op": "project_uv",
                    "id": cube_id,
                    "method": "CUBE",
                    "uvLayerName": "TransactionalUV",
                },
            ],
        )
        assert uv_replace_rejected["status"] == "failed"
        assert uv_replace_rejected["revision"] == uv_replace_revision
        assert bpy.data.materials.get("Must Roll Back With UV") is None
        cube = blockout.find_object(cube_id)
        assert [
            slot.material.name if slot.material is not None else None
            for slot in cube.material_slots
        ] == transactional_slots
        assert [polygon.material_index for polygon in cube.data.polygons] == transactional_faces
        assert [
            tuple(item.uv) for item in cube.data.uv_layers["TransactionalUV"].data
        ] == transactional_uv_coordinates

        uv_replace = submit(
            "replace-existing-uv",
            [
                {
                    "op": "project_uv",
                    "id": cube_id,
                    "method": "CUBE",
                    "uvLayerName": "TransactionalUV",
                    "replaceExisting": True,
                }
            ],
        )
        assert uv_replace["status"] == "succeeded"
        assert uv_replace["revision"] == uv_replace_revision + 1
        assert uv_replace["result"]["operations"][0]["replaced"] is True
        assert uv_replace["result"]["operations"][0]["replaceExisting"] is True

        shared_id = "material-node-shared"
        shared_setup = submit(
            "material-node-shared-setup",
            [
                {
                    "op": "create_primitive",
                    "id": shared_id,
                    "primitive": "cube",
                    "name": "Material node shared cube",
                },
                {
                    "op": "assign_material",
                    "id": shared_id,
                    "materialName": "Transactional Clay",
                    "createIfMissing": False,
                },
            ],
        )
        assert shared_setup["status"] == "succeeded"

        material_node_revision = native_session._revision_value(bpy.context.scene)
        material_nodes_batch = submit(
            "material-nodes-one-transaction",
            [
                {
                    "op": "disconnect_material_node_input",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "material-output",
                    "inputSocketRef": "Surface",
                },
                {
                    "op": "delete_material_node",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "principled",
                },
                {
                    "op": "delete_material_node",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "material-output",
                },
                {
                    "op": "create_material_node",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "txn-principled",
                    "nodeType": "PRINCIPLED_BSDF",
                    "location": [-200, 0],
                },
                {
                    "op": "create_material_node",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "txn-output",
                    "nodeType": "MATERIAL_OUTPUT",
                    "location": [240, 0],
                },
                {
                    "op": "set_material_node_input",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "txn-principled",
                    "inputSocketRef": "Base Color",
                    "value": [0.12, 0.24, 0.48, 1.0],
                },
                {
                    "op": "connect_material_nodes",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "from": {"nodeRef": "txn-principled", "socketRef": "BSDF"},
                    "to": {"nodeRef": "txn-output", "socketRef": "Surface"},
                },
            ],
        )
        assert material_nodes_batch["status"] == "succeeded"
        assert material_nodes_batch["revision"] == material_node_revision + 1
        expected_material_users = sorted([cube_id, shared_id])
        for result in material_nodes_batch["result"]["operations"]:
            assert result["affectedObjectIds"] == expected_material_users
            assert result["dirtyObjectIds"] == expected_material_users
        graph = next(
            item for item in execute({"op": "inspect_object", "id": cube_id})["materialGraphs"]
            if item["materialName"] == "Transactional Clay"
        )
        assert graph["activeOutputNodeRef"] == "txn-output"
        assert {node["nodeRef"] for node in graph["nodes"]} == {
            "txn-principled",
            "txn-output",
        }
        assert graph["links"] == [{
            "from": {"nodeRef": "txn-principled", "socketRef": "BSDF"},
            "to": {"nodeRef": "txn-output", "socketRef": "Surface"},
        }]

        material_nodes_undo = submit("material-nodes-undo", [{"op": "undo_scene"}])
        assert material_nodes_undo["status"] == "succeeded"
        graph = next(
            item for item in execute({"op": "inspect_object", "id": cube_id})["materialGraphs"]
            if item["materialName"] == "Transactional Clay"
        )
        assert graph["activeOutputNodeRef"] == "material-output"
        assert {node["nodeRef"] for node in graph["nodes"]} >= {
            "principled",
            "material-output",
        }

        material_nodes_redo = submit("material-nodes-redo", [{"op": "redo_scene"}])
        assert material_nodes_redo["status"] == "succeeded"
        graph = next(
            item for item in execute({"op": "inspect_object", "id": cube_id})["materialGraphs"]
            if item["materialName"] == "Transactional Clay"
        )
        assert graph["activeOutputNodeRef"] == "txn-output"

        node_rollback_revision = native_session._revision_value(bpy.context.scene)
        node_rollback = submit(
            "material-node-rollback",
            [
                {
                    "op": "create_material_node",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "nodeRef": "rollback-leak",
                    "nodeType": "BUMP",
                },
                {
                    "op": "connect_material_nodes",
                    "id": cube_id,
                    "materialName": "Transactional Clay",
                    "from": {"nodeRef": "rollback-leak", "socketRef": "Missing"},
                    "to": {"nodeRef": "txn-output", "socketRef": "Surface"},
                },
            ],
        )
        assert node_rollback["status"] == "failed"
        assert node_rollback["revision"] == node_rollback_revision
        assert "Unknown material socket reference" in node_rollback["error"]
        graph = next(
            item for item in execute({"op": "inspect_object", "id": cube_id})["materialGraphs"]
            if item["materialName"] == "Transactional Clay"
        )
        assert "rollback-leak" not in {node["nodeRef"] for node in graph["nodes"]}
        assert graph["activeOutputNodeRef"] == "txn-output"

        semantic_revision = native_session._revision_value(bpy.context.scene)
        semantic_batch = submit(
            "curve-text-geometry-one-transaction",
            [
                {
                    "op": "create_curve",
                    "id": "semantic-path",
                    "name": "Agent Path",
                    "points": [[0, 0, 0], [2, 0, -1], [4, 1, -2]],
                    "bevelDepth": 0.05,
                },
                {
                    "op": "set_curve_data",
                    "id": "semantic-path",
                    "curveType": "BEZIER",
                    "points": [[0, 0, 0], [2, 0.5, -1], [4, 1, -2]],
                    "cyclic": True,
                    "bevelDepth": 0.08,
                },
                {
                    "op": "create_text",
                    "id": "semantic-title",
                    "text": "Warehouse",
                    "size": 1.2,
                },
                {
                    "op": "set_text_data",
                    "id": "semantic-title",
                    "text": "Warehouse 12",
                    "alignX": "CENTER",
                    "extrude": 0.04,
                },
                {"op": "ensure_geometry_nodes", "id": "semantic-path"},
                {
                    "op": "create_geometry_node",
                    "id": "semantic-path",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "transform",
                    "nodeType": "TRANSFORM_GEOMETRY",
                },
                {
                    "op": "disconnect_geometry_node_input",
                    "id": "semantic-path",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "group-output",
                    "inputSocketRef": "Socket_1",
                },
                {
                    "op": "connect_geometry_nodes",
                    "id": "semantic-path",
                    "modifierName": "WorldEngine Geometry",
                    "from": {"nodeRef": "group-input", "socketRef": "Socket_0"},
                    "to": {"nodeRef": "transform", "socketRef": "Geometry"},
                },
                {
                    "op": "connect_geometry_nodes",
                    "id": "semantic-path",
                    "modifierName": "WorldEngine Geometry",
                    "from": {"nodeRef": "transform", "socketRef": "Geometry"},
                    "to": {"nodeRef": "group-output", "socketRef": "Socket_1"},
                },
                {
                    "op": "set_geometry_node_input",
                    "id": "semantic-path",
                    "modifierName": "WorldEngine Geometry",
                    "nodeRef": "transform",
                    "inputSocketRef": "Translation",
                    "value": [0, 1, -2],
                },
                {
                    "op": "assign_material",
                    "id": "semantic-path",
                    "materialName": "Transactional Clay",
                },
                {
                    "op": "create_material_node",
                    "id": "semantic-path",
                    "materialName": "Transactional Clay",
                    "nodeRef": "noise",
                    "nodeType": "NOISE_TEXTURE",
                },
                {
                    "op": "set_material_node_input",
                    "id": "semantic-path",
                    "materialName": "Transactional Clay",
                    "nodeRef": "noise",
                    "inputSocketRef": "Scale",
                    "value": 6,
                },
            ],
        )
        assert semantic_batch["status"] == "succeeded", semantic_batch
        assert semantic_batch["revision"] == semantic_revision + 1
        path_inspection = execute({"op": "inspect_object", "id": "semantic-path"})
        assert path_inspection["curve"]["splines"][0]["type"] == "BEZIER"
        assert path_inspection["curve"]["splines"][0]["cyclic"] is True
        assert path_inspection["curve"]["splines"][0]["points"][1] == [2.0, 0.5, -1.0]
        geometry_graph = path_inspection["geometryGraphs"][0]
        assert geometry_graph["modifierName"] == "WorldEngine Geometry"
        assert {node["nodeRef"] for node in geometry_graph["nodes"]} == {
            "group-input", "group-output", "transform"
        }
        transform = next(node for node in geometry_graph["nodes"] if node["nodeRef"] == "transform")
        translation = next(item for item in transform["inputs"] if item["socketRef"] == "Translation")
        assert translation["defaultValue"] == [0.0, 1.0, -2.0]
        text_inspection = execute({"op": "inspect_object", "id": "semantic-title"})
        assert text_inspection["text"]["text"] == "Warehouse 12"
        assert text_inspection["text"]["alignX"] == "CENTER"
        material_graph = next(
            item for item in path_inspection["materialGraphs"]
            if item["materialName"] == "Transactional Clay"
        )
        assert next(node for node in material_graph["nodes"] if node["nodeRef"] == "noise")["nodeType"] == "NOISE_TEXTURE"

        semantic_undo = submit("curve-text-geometry-undo", [{"op": "undo_scene"}])
        assert semantic_undo["status"] == "succeeded"
        assert blockout.find_object("semantic-path") is None
        assert blockout.find_object("semantic-title") is None

        semantic_redo = submit("curve-text-geometry-redo", [{"op": "redo_scene"}])
        assert semantic_redo["status"] == "succeeded"
        assert blockout.find_object("semantic-path") is not None
        assert blockout.find_object("semantic-title") is not None

        pose_selection_revision = native_session._revision_value(bpy.context.scene)
        pose_selection = submit(
            "pose-selection-does-not-revise",
            [
                {
                    "op": "select_pose_bones",
                    "id": rig_id,
                    "boneRefs": ["Agent Root"],
                    "activeBoneRef": "Agent Root",
                    "action": "SET",
                }
            ],
        )
        assert pose_selection["status"] == "succeeded", pose_selection
        assert pose_selection["revision"] == pose_selection_revision
        pose_selection_result = pose_selection["result"]["operations"][0]
        assert pose_selection_result["dirtyObjectIds"] == []
        assert pose_selection_result["mode"] == "POSE"
        assert pose_selection_result["rigSelection"] == {
            "activeBoneRef": "Agent Root",
            "selectedBoneRefs": ["Agent Root"],
        }, pose_selection_result

        frame_revision = native_session._revision_value(bpy.context.scene)
        frame_only = submit(
            "frame-does-not-revise",
            [{"op": "set_scene_frame", "frame": 1}],
        )
        assert frame_only["status"] == "succeeded"
        assert frame_only["revision"] == frame_revision
        assert frame_only["result"]["operations"][0]["frame"] == 1
        assert native_session.current_snapshot()["frame"] == 1

        rig_transaction_revision = native_session._revision_value(bpy.context.scene)
        rig_transaction = submit(
            "rig-action-one-transaction",
            [
                {
                    "op": "create_action",
                    "id": rig_id,
                    "actionName": "Agent Confrontation",
                },
                {"op": "set_scene_frame", "frame": 1},
                {
                    "op": "set_pose_bone_transform",
                    "id": rig_id,
                    "boneRef": "Agent Root",
                    "local": {
                        "location": [0.1, 0.0, 0.0],
                        "rotationQuaternion": [1.0, 0.0, 0.0, 0.0],
                    },
                },
                {
                    "op": "insert_pose_keyframes",
                    "id": rig_id,
                    "actionName": "Agent Confrontation",
                    "frame": 1,
                    "boneRefs": ["Agent Root", "Agent Child"],
                    "channels": ["LOCATION", "ROTATION"],
                    "interpolation": "LINEAR",
                },
                {"op": "set_scene_frame", "frame": 24},
                {
                    "op": "set_pose_bone_transform",
                    "id": rig_id,
                    "boneRef": "Agent Root",
                    "local": {
                        "location": [0.6, 0.0, 0.0],
                        "rotationQuaternion": [0.980785, 0.0, 0.0, 0.19509],
                    },
                },
                {
                    "op": "insert_pose_keyframes",
                    "id": rig_id,
                    "actionName": "Agent Confrontation",
                    "frame": 24,
                    "boneRefs": ["Agent Root", "Agent Child"],
                    "channels": ["LOCATION", "ROTATION"],
                },
            ],
        )
        assert rig_transaction["status"] == "succeeded"
        assert rig_transaction["revision"] == rig_transaction_revision + 1
        assert rig_transaction["result"]["revisionBefore"] == rig_transaction_revision
        assert rig_transaction["result"]["revisionAfter"] == rig_transaction["revision"]
        for index, result in enumerate(rig_transaction["result"]["operations"]):
            if index in {1, 4}:
                assert result["dirtyObjectIds"] == []
            else:
                assert result["affectedObjectIds"] == [rig_id]
                assert result["dirtyObjectIds"] == [rig_id]
        rig_action_inspection = execute({"op": "inspect_object", "id": rig_id})
        root_inspection = next(
            bone for bone in rig_action_inspection["rig"]["bones"]
            if bone["boneRef"] == "Agent Root"
        )
        child_inspection = next(
            bone for bone in rig_action_inspection["rig"]["bones"]
            if bone["boneRef"] == "Agent Child"
        )
        assert child_inspection["parentRef"] == "Agent Root"
        assert abs(root_inspection["local"]["location"][0] - 0.6) < 1e-5
        assert rig_action_inspection["animation"]["activeAction"]["actionName"] == "Agent Confrontation"
        assert rig_action_inspection["animation"]["activeAction"]["keyedFrames"] == [1.0, 24.0]
        assert rig_action_inspection["animation"]["activeAction"]["fCurveCount"] == 14
        assert rig_action_inspection["animation"]["activeAction"]["keyframeCount"] == 28
        confrontation_action = bpy.data.actions["Agent Confrontation"]
        assert len(confrontation_action.slots) == 1
        assert (
            blockout.find_object(rig_id).animation_data.action_slot_handle
            == confrontation_action.slots[0].handle
        )

        rig_undo = submit("rig-action-undo", [{"op": "undo_scene"}])
        assert rig_undo["status"] == "succeeded"
        assert bpy.data.actions.get("Agent Confrontation") is None
        assert abs(blockout.find_object(rig_id).pose.bones["Agent Root"].location.x) < 1e-6

        rig_redo = submit("rig-action-redo", [{"op": "redo_scene"}])
        assert rig_redo["status"] == "succeeded"
        rig_action_inspection = execute({"op": "inspect_object", "id": rig_id})
        assert rig_action_inspection["animation"]["activeAction"]["keyedFrames"] == [1.0, 24.0]

        switch_action = submit(
            "create-and-switch-action",
            [
                {
                    "op": "create_action",
                    "id": rig_id,
                    "actionName": "Agent Alternate",
                },
                {
                    "op": "set_active_action",
                    "id": rig_id,
                    "actionName": "Agent Confrontation",
                },
            ],
        )
        assert switch_action["status"] == "succeeded"
        action_inspection = execute({"op": "inspect_object", "id": rig_id})["animation"]
        assert action_inspection["activeAction"]["actionName"] == "Agent Confrontation"
        assert {action["actionName"] for action in action_inspection["actions"]} >= {
            "Agent Alternate",
            "Agent Confrontation",
        }

        delete_key_revision = native_session._revision_value(bpy.context.scene)
        delete_keyframes = submit(
            "delete-pose-keyframes",
            [
                {
                    "op": "delete_pose_keyframes",
                    "id": rig_id,
                    "actionName": "Agent Confrontation",
                    "frame": 24,
                    "boneRefs": ["Agent Root", "Agent Child"],
                    "channels": ["LOCATION", "ROTATION"],
                }
            ],
        )
        assert delete_keyframes["status"] == "succeeded"
        assert delete_keyframes["revision"] == delete_key_revision + 1
        assert delete_keyframes["result"]["operations"][0]["action"]["keyedFrames"] == [1.0]
        delete_undo = submit("delete-pose-keyframes-undo", [{"op": "undo_scene"}])
        assert delete_undo["status"] == "succeeded"
        assert execute({"op": "inspect_object", "id": rig_id})["animation"]["activeAction"]["keyedFrames"] == [1.0, 24.0]

        unknown_bone_revision = native_session._revision_value(bpy.context.scene)
        unknown_bone_location = tuple(
            blockout.find_object(rig_id).pose.bones["Agent Root"].location
        )
        unknown_bone = submit(
            "unknown-bone-rolls-back",
            [
                {
                    "op": "set_pose_bone_transform",
                    "id": rig_id,
                    "boneRef": "Agent Root",
                    "local": {"location": [2.0, 0.0, 0.0]},
                },
                {
                    "op": "set_pose_bone_transform",
                    "id": rig_id,
                    "boneRef": "Missing Bone",
                    "local": {"location": [1.0, 0.0, 0.0]},
                },
            ],
        )
        assert unknown_bone["status"] == "failed"
        assert unknown_bone["revision"] == unknown_bone_revision
        assert "Unknown pose bone reference" in unknown_bone["error"]
        assert tuple(blockout.find_object(rig_id).pose.bones["Agent Root"].location) == unknown_bone_location

        unknown_action_revision = native_session._revision_value(bpy.context.scene)
        unknown_action_location = tuple(
            blockout.find_object(rig_id).pose.bones["Agent Root"].location
        )
        unknown_action = submit(
            "unknown-action-rolls-back",
            [
                {
                    "op": "set_pose_bone_transform",
                    "id": rig_id,
                    "boneRef": "Agent Root",
                    "local": {"location": [3.0, 0.0, 0.0]},
                },
                {
                    "op": "insert_pose_keyframes",
                    "id": rig_id,
                    "actionName": "Missing Action",
                    "frame": 12,
                    "boneRefs": ["Agent Root"],
                    "channels": ["LOCATION"],
                },
            ],
        )
        assert unknown_action["status"] == "failed"
        assert unknown_action["revision"] == unknown_action_revision
        assert "Unknown Blender action" in unknown_action["error"]
        assert tuple(blockout.find_object(rig_id).pose.bones["Agent Root"].location) == unknown_action_location

        # Packaged Mixamo clips are user-supplied (Adobe terms are local-only),
        # staged by `npm run assets:install`, and absent from a bare checkout.
        # Skip only the packaged-motion coverage when they are missing so the
        # rest of the kernel contract still runs everywhere.
        try:
            mixamo_actions._motion_entry("idle")
            mixamo_clips_installed = True
        except ValueError:
            mixamo_clips_installed = False
            print("SKIP packaged Mixamo motion coverage: clips are not installed (npm run assets:install)")
        if mixamo_clips_installed:
            active = bpy.context.view_layer.objects.active
            if active is not None and active.mode != 'OBJECT':
                bpy.ops.object.mode_set(mode='OBJECT')
            target_objects_before = set(bpy.data.objects)
            _, idle_path = mixamo_actions._motion_entry("idle")
            assert 'FINISHED' in bpy.ops.import_scene.gltf(filepath=str(idle_path))
            mixamo_target = next(
                obj
                for obj in set(bpy.data.objects) - target_objects_before
                if obj.type == 'ARMATURE'
                and obj.animation_data is not None
                and obj.animation_data.action is not None
            )
            mixamo_target_id = "mixamo-smoke-rig"
            mixamo_target[blockout.ID_PROPERTY] = mixamo_target_id
            mixamo_target.name = "Mixamo Smoke Rig"
            idle_action = mixamo_target.animation_data.action
            mixamo_target.animation_data.action = None
            for track in list(mixamo_target.animation_data.nla_tracks):
                mixamo_target.animation_data.nla_tracks.remove(track)
            if idle_action.users == 0:
                bpy.data.actions.remove(idle_action)
            bpy.context.view_layer.update()
            if native_session._manual_change_pending:
                flush_scheduled_snapshot()

            compatibility = execute({"op": "inspect_object", "id": mixamo_target_id})[
                "rig"
            ]["mixamoCompatibility"]
            assert compatibility["compatible"] is True
            assert compatibility["missingBoneRoles"] == []
            mixamo_bones = mixamo_actions._bone_index(mixamo_target)
            left_arm_name = mixamo_bones["leftarm"]
            preview_pose_token = '{"pose":"preview-regression"}'
            preview_pose_applied = submit(
                "apply-preview-regression-pose",
                [{
                    "op": "apply_pose_offsets",
                    "id": mixamo_target_id,
                    "stateToken": preview_pose_token,
                    "resetPose": True,
                    "bones": [{
                        "boneRef": left_arm_name,
                        "rotationOffsetQuaternion": [0.9914448614, 0.0, 0.0, 0.1305261922],
                    }],
                }],
            )
            assert preview_pose_applied["status"] == "succeeded"
            preview_pose_before = tuple(
                mixamo_target.pose.bones[left_arm_name].rotation_quaternion
            )
            preview_pose_revision = native_session._revision_value(bpy.context.scene)
            preview_pose_record = submit(
                "preview-preserves-director-character-pose",
                [{"op": "export_scene_preview"}],
            )
            assert preview_pose_record["status"] == "succeeded"
            assert preview_pose_record["revision"] == preview_pose_revision
            bpy.context.view_layer.update()
            if native_session._manual_change_pending:
                flush_scheduled_snapshot()
            assert native_session._revision_value(bpy.context.scene) == preview_pose_revision
            mixamo_target = blockout.find_object(mixamo_target_id)
            assert mixamo_target is not None
            assert mixamo_target.type == 'ARMATURE'
            preview_pose_after = tuple(
                mixamo_target.pose.bones[left_arm_name].rotation_quaternion
            )
            assert mixamo_target[rig_tools.DIRECTOR_CHARACTER_STATE_PROPERTY] == preview_pose_token
            assert all(
                abs(before - after) < 1e-6
                for before, after in zip(preview_pose_before, preview_pose_after)
            )
            armatures_before_mixamo = {
                obj.name for obj in bpy.data.objects if obj.type == 'ARMATURE'
            }
            mixamo_revision = native_session._revision_value(bpy.context.scene)
            mixamo_transaction = submit(
                "mixamo-import-and-nla-one-transaction",
                [
                    {
                        "op": "import_mixamo_action",
                        "id": mixamo_target_id,
                        "motionId": "walk",
                        "actionName": "Agent Walk",
                        "rootMotion": "IN_PLACE",
                    },
                    {
                        "op": "create_nla_track",
                        "id": mixamo_target_id,
                        "trackName": "Locomotion",
                    },
                    {
                        "op": "add_nla_strip",
                        "id": mixamo_target_id,
                        "trackName": "Locomotion",
                        "stripName": "Walk Base",
                        "actionName": "Agent Walk",
                        "startFrame": 10,
                        "blendMode": "REPLACE",
                        "influence": 0.75,
                        "repeat": 2,
                        "scale": 0.5,
                    },
                    {
                        "op": "update_nla_strip",
                        "id": mixamo_target_id,
                        "trackName": "Locomotion",
                        "stripName": "Walk Base",
                        "blendMode": "ADD",
                        "influence": 0.5,
                    },
                ],
            )
            assert mixamo_transaction["status"] == "succeeded", mixamo_transaction
            assert mixamo_transaction["revision"] == mixamo_revision + 1
            for result in mixamo_transaction["result"]["operations"]:
                assert result["affectedObjectIds"] == [mixamo_target_id]
                assert result["dirtyObjectIds"] == [mixamo_target_id]
            assert {
                obj.name for obj in bpy.data.objects if obj.type == 'ARMATURE'
            } == armatures_before_mixamo

            mixamo_inspection = execute({"op": "inspect_object", "id": mixamo_target_id})
            locomotion_track = next(
                track
                for track in mixamo_inspection["animation"]["nlaTracks"]
                if track["name"] == "Locomotion"
            )
            walk_strip = locomotion_track["strips"][0]
            assert walk_strip["name"] == "Walk Base"
            assert walk_strip["actionName"] == "Agent Walk"
            assert walk_strip["frameStart"] == 10.0
            assert walk_strip["blendMode"] == "ADD"
            assert walk_strip["influence"] == 0.5
            assert walk_strip["repeat"] == 2.0
            assert walk_strip["scale"] == 0.5

            walk_action = bpy.data.actions["Agent Walk"]
            hips_name = mixamo_actions._bone_index(mixamo_target)["hips"]
            vertical_axis = mixamo_actions._root_vertical_axis(mixamo_target, hips_name)
            root_location_curves = [
                curve
                for curve in mixamo_actions._fcurves(walk_action)
                if curve.data_path == f'pose.bones["{hips_name}"].location'
            ]
            assert len(root_location_curves) == 3
            for curve in root_location_curves:
                if curve.array_index == vertical_axis:
                    continue
                values = [round(float(point.co.y), 6) for point in curve.keyframe_points]
                assert len(set(values)) == 1

            mixamo_undo = submit("mixamo-import-and-nla-undo", [{"op": "undo_scene"}])
            assert mixamo_undo["status"] == "succeeded"
            assert bpy.data.actions.get("Agent Walk") is None
            assert execute({"op": "inspect_object", "id": mixamo_target_id})[
                "animation"
            ]["nlaTracks"] == []

            mixamo_redo = submit("mixamo-import-and-nla-redo", [{"op": "redo_scene"}])
            assert mixamo_redo["status"] == "succeeded"
            assert bpy.data.actions.get("Agent Walk") is not None
            assert execute({"op": "inspect_object", "id": mixamo_target_id})[
                "animation"
            ]["nlaTrackCount"] == 1

            nla_pose_token = '{"pose":"nla-preview-regression"}'
            nla_pose_applied = submit(
                "apply-nla-preview-regression-pose",
                [{
                    "op": "apply_pose_offsets",
                    "id": mixamo_target_id,
                    "stateToken": nla_pose_token,
                    "resetPose": False,
                    "bones": [{
                        "boneRef": left_arm_name,
                        "rotationOffsetQuaternion": [1.0, 0.0, 0.0, 0.0],
                    }],
                }],
            )
            assert nla_pose_applied["status"] == "succeeded"
            nla_pose_revision = native_session._revision_value(bpy.context.scene)
            bpy.context.view_layer.update()
            if native_session._manual_change_pending:
                flush_scheduled_snapshot()
            assert native_session._revision_value(bpy.context.scene) == nla_pose_revision
            assert blockout.find_object(mixamo_target_id)[
                rig_tools.DIRECTOR_CHARACTER_STATE_PROPERTY
            ] == nla_pose_token
            nla_preview = submit(
                "preview-preserves-nla-character-pose",
                [{"op": "export_scene_preview"}],
            )
            assert nla_preview["status"] == "succeeded"
            assert nla_preview["revision"] == nla_pose_revision
            assert blockout.find_object(mixamo_target_id)[
                rig_tools.DIRECTOR_CHARACTER_STATE_PROPERTY
            ] == nla_pose_token

            authored_revision = native_session._revision_value(bpy.context.scene)
            authored_motion = submit(
                "mixamo-authored-root-motion",
                [
                    {
                        "op": "import_mixamo_action",
                        "id": mixamo_target_id,
                        "motionId": "walk",
                        "actionName": "Agent Walk Authored",
                        "rootMotion": "AUTHORED",
                    }
                ],
            )
            assert authored_motion["status"] == "succeeded", authored_motion
            assert authored_motion["revision"] == authored_revision + 1
            authored_curves = [
                curve
                for curve in mixamo_actions._fcurves(bpy.data.actions["Agent Walk Authored"])
                if curve.data_path == f'pose.bones["{hips_name}"].location'
                and curve.array_index != vertical_axis
            ]
            assert any(
                len({round(float(point.co.y), 6) for point in curve.keyframe_points}) > 1
                for curve in authored_curves
            )
            authored_undo = submit("mixamo-authored-root-motion-undo", [{"op": "undo_scene"}])
            assert authored_undo["status"] == "succeeded"
            assert bpy.data.actions.get("Agent Walk Authored") is None

            unknown_motion_revision = native_session._revision_value(bpy.context.scene)
            unknown_motion = submit(
                "unknown-mixamo-motion-rolls-back",
                [
                    {
                        "op": "import_mixamo_action",
                        "id": mixamo_target_id,
                        "motionId": "missing-motion",
                        "actionName": "Missing Motion",
                    }
                ],
            )
            assert unknown_motion["status"] == "failed"
            assert unknown_motion["revision"] == unknown_motion_revision
            assert bpy.data.actions.get("Missing Motion") is None

        mixed_revision = native_session._revision_value(bpy.context.scene)
        mixed = submit(
            "undo-must-stand-alone",
            [
                {"op": "undo_scene"},
                {"op": "create_primitive", "id": "mixed-operation-leak", "primitive": "cube"},
            ],
        )
        assert mixed["status"] == "failed"
        assert "standalone batch" in mixed["error"]
        assert native_session._revision_value(bpy.context.scene) == mixed_revision
        assert blockout.find_object("mixed-operation-leak") is None

        submit(
            "restore-edit-selection",
            [
                {
                    "op": "select_mesh_elements",
                    "id": cube_id,
                    "domain": "EDGE",
                    "action": "SET",
                    "indices": [0],
                }
            ],
        )
        rollback_revision = native_session._revision_value(bpy.context.scene)
        failed = submit(
            "atomic-rollback",
            [
                {"op": "create_primitive", "id": "atomic-leak", "primitive": "cube"},
                {
                    "op": "update_transform",
                    "id": "missing-object",
                    "transform": {"position": [1, 2, 3]},
                },
            ],
        )
        assert failed["status"] == "failed"
        assert failed["revision"] == rollback_revision
        assert blockout.find_object("atomic-leak") is None
        restored_cube = blockout.find_object(cube_id)
        assert bpy.context.view_layer.objects.active == restored_cube
        assert restored_cube.mode == 'EDIT'
        restored_cube.update_from_editmode()
        assert [edge.index for edge in restored_cube.data.edges if edge.select] == [0]
        assert not any(
            item["id"] == "atomic-leak"
            for item in native_session.current_snapshot()["objects"]
        )

        failed_batch = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "atomic-rollback",
                    "expectedSceneEpoch": native_session.scene_epoch_value(),
                    "expectedRevision": rollback_revision,
                    "operations": [
                        {
                            "op": "create_primitive",
                            "id": "atomic-leak",
                            "primitive": "cube",
                        },
                        {
                            "op": "update_transform",
                            "id": "missing-object",
                            "transform": {"position": [1, 2, 3]},
                        },
                    ],
                }
            )
        )
        existing = native_session._queue_command(failed_batch)
        assert existing["status"] == "failed"
        assert native_session.drain_pending() == 0

        conflicting_batch = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "atomic-rollback",
                    "expectedSceneEpoch": native_session.scene_epoch_value(),
                    "expectedRevision": rollback_revision + 1,
                    "operations": failed_batch["operations"],
                }
            )
        )
        try:
            native_session._queue_command(conflicting_batch)
        except native_session.IntentConflictError as error:
            assert error.code == "intent_conflict"
            assert error.request_id == "atomic-rollback"
        else:
            raise AssertionError("same intent ID with different content must conflict")

        conflicting_operations = live_protocol.parse_live_batch(
            json.dumps(
                {
                    "contract": live_protocol.CONTRACT,
                    "requestId": "atomic-rollback",
                    "expectedSceneEpoch": native_session.scene_epoch_value(),
                    "expectedRevision": rollback_revision,
                    "operations": [
                        {
                            "op": "create_primitive",
                            "id": "must-not-run-twice",
                            "primitive": "cube",
                        }
                    ],
                }
            )
        )
        try:
            native_session._queue_command(conflicting_operations)
        except native_session.IntentConflictError:
            pass
        else:
            raise AssertionError("same intent ID with different operations must conflict")
        assert native_session.drain_pending() == 0
        assert blockout.find_object("must-not-run-twice") is None

        remembered_revision = native_session._revision_value(bpy.context.scene)
        native_session.stop()
        assert native_session.current_snapshot() is None
        assert native_session.command_record("atomic-rollback") is None
        native_session.start(0)
        assert native_session.current_snapshot()["revision"] == remembered_revision

        lifecycle_record = submit(
            "cleared-after-load",
            [{"op": "set_selection", "selectedIds": [], "mode": "OBJECT"}],
        )
        assert lifecycle_record["status"] == "succeeded"
        bpy.context.scene.worldengine_studio.scene_revision = 0
        native_session._on_load_post("")
        assert native_session.command_record("cleared-after-load") is None
        assert native_session._revision_value(bpy.context.scene) == 0
        assert native_session.current_snapshot()["revision"] == 0

        shared_action = bpy.data.actions.new("Agent Shared Slots")
        shared_rig = bpy.data.objects.new(
            "Agent Modeling Rig Slot Peer",
            blockout.find_object(rig_id).data.copy(),
        )
        shared_rig_id = "modeling-smoke-rig-slot-peer"
        shared_rig[blockout.ID_PROPERTY] = shared_rig_id
        bpy.context.scene.collection.objects.link(shared_rig)
        bpy.context.view_layer.update()
        for target, frame, x_position in (
            (blockout.find_object(rig_id), 7, 0.25),
            (shared_rig, 19, 0.75),
        ):
            target.animation_data_create().action = shared_action
            target.pose.bones["Agent Root"].location.x = x_position
            target.pose.bones["Agent Root"].keyframe_insert(
                data_path="location",
                frame=frame,
                group="Agent Root",
            )
        assert len(shared_action.slots) == 2

        first_slot_summary = execute({"op": "inspect_object", "id": rig_id})[
            "animation"
        ]["activeAction"]
        second_slot_summary = execute(
            {"op": "inspect_object", "id": shared_rig_id}
        )["animation"]["activeAction"]
        assert first_slot_summary["keyedFrames"] == [7.0]
        assert first_slot_summary["frameRange"] == [7.0, 7.0]
        assert first_slot_summary["fCurveCount"] == 3
        assert first_slot_summary["keyframeCount"] == 3
        assert second_slot_summary["keyedFrames"] == [19.0]
        assert second_slot_summary["frameRange"] == [19.0, 19.0]
        assert second_slot_summary["fCurveCount"] == 3
        assert second_slot_summary["keyframeCount"] == 3

        duplicate_action_name = "Director Shared Display Action"
        first_duplicate = execute({
            "op": "create_action",
            "id": rig_id,
            "actionName": duplicate_action_name,
        })
        second_duplicate = execute({
            "op": "create_action",
            "id": shared_rig_id,
            "actionName": duplicate_action_name,
        })
        first_action = rig_tools._action(duplicate_action_name, blockout.find_object(rig_id))
        second_action = rig_tools._action(duplicate_action_name, shared_rig)
        assert first_duplicate["action"]["actionName"] == duplicate_action_name
        assert second_duplicate["action"]["actionName"] == duplicate_action_name
        assert first_action is not second_action
        assert first_action.name != second_action.name

        print("WORLDENGINE_STUDIO_MODELING_SMOKE_OK")
    finally:
        bpy.utils.unregister_class(WORLDENGINE_OT_cancelled_smoke)
        worldengine_studio.unregister()


main()
