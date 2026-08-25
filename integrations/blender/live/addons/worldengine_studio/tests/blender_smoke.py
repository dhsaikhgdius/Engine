# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Run with: blender --background --factory-startup --python blender_smoke.py"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import bpy


ADDONS_CORE = Path(__file__).resolve().parents[2]
if str(ADDONS_CORE) not in sys.path:
    sys.path.insert(0, str(ADDONS_CORE))

import worldengine_studio  # noqa: E402
from worldengine_studio import asset_import, blockout, native_session, operators  # noqa: E402
from worldengine_studio.coordinates import blender_to_director_point, director_to_blender_point  # noqa: E402


def main():
    worldengine_studio.register()
    try:
        scene = bpy.context.scene
        assert bpy.ops.worldengine.setup_workspace() == {'FINISHED'}
        assert scene.unit_settings.system == 'METRIC'
        assert bpy.ops.worldengine.add_primitive(primitive='floor') == {'FINISHED'}
        assert scene.worldengine_studio.scene_revision == 1
        cube = blockout.create_primitive(scene, "cube", name="Smoke Cube")
        room = blockout.create_blockout(scene, "room", name="Smoke Room")
        camera = blockout.create_camera(scene, name="Smoke Camera")
        wall = next(obj for obj in room if obj.get("worldengine_kind") == "wall")
        opening, boolean = blockout.create_opening(scene, wall, kind="door")
        light = blockout.create_light(scene, name="Smoke Key Light")
        collection = blockout.move_objects_to_collection(scene, [cube], "Smoke Set")
        parent = blockout.create_primitive(scene, "cube", name="Smoke Parent", location=(2.0, 1.0, 1.0))
        child = blockout.create_primitive(scene, "sphere", name="Smoke Child", location=(3.0, 1.0, 1.0))
        child_world_before_parenting = child.matrix_world.copy()
        blockout.set_parent(child, parent, keep_world_transform=True)
        relation = blockout.add_object_constraint(child, parent, "copy_rotation", influence=0.75)
        assert cube.get(blockout.ID_PROPERTY)
        assert camera.get(blockout.ID_PROPERTY)
        assert scene.camera == camera
        assert boolean.type == 'BOOLEAN' and boolean.object == opening
        assert light.type == 'LIGHT' and light.data.type == 'AREA'
        assert collection.objects.get(cube.name) == cube
        assert child.parent == parent
        assert max(
            abs(child.matrix_world[row][column] - child_world_before_parenting[row][column])
            for row in range(4)
            for column in range(4)
        ) < 1e-5
        assert relation.target == parent and abs(relation.influence - 0.75) < 1e-6
        bpy.context.view_layer.update()
        evaluated_wall = wall.evaluated_get(bpy.context.evaluated_depsgraph_get())
        evaluated_mesh = evaluated_wall.to_mesh()
        try:
            assert len(evaluated_mesh.polygons) > len(wall.data.polygons)
        finally:
            evaluated_wall.to_mesh_clear()

        try:
            asset_import._download_asset("https://example.com/model.glb", "model.glb", Path("."))
        except ValueError as error:
            assert "loopback" in str(error)
        else:
            raise AssertionError("non-loopback asset URLs must be rejected")

        asset_root = bpy.data.objects.new("Smoke Asset", None)
        blockout.set_object_display_name(asset_root, "Smoke Asset")
        scene.collection.objects.link(asset_root)
        asset_root[blockout.ID_PROPERTY] = "smoke-asset-root"
        asset_root[blockout.DIRECTOR_ID_PROPERTY] = "smoke-asset-director"
        asset_root[asset_import.ASSET_ROOT_PROPERTY] = True
        asset_root[asset_import.ASSET_ID_PROPERTY] = "smoke-asset"
        asset_root["worldengine_kind"] = "prop"
        asset_root.location = (0.5, -0.25, 0.0)
        geometry = bpy.data.objects.new("Smoke Asset Geometry", None)
        scene.collection.objects.link(geometry)
        geometry.parent = asset_root
        blockout.ensure_stable_id(geometry, "asset-data")
        part_a = blockout.create_box(scene, name="Smoke Asset Part A", location=(0.0, 0.0, 0.5), select=False)
        part_b = blockout.create_box(scene, name="Smoke Asset Part B", location=(1.5, 0.0, 0.5), select=False)
        part_a[blockout.DIRECTOR_ID_PROPERTY] = "smoke-asset-part-director"
        bpy.context.view_layer.update()
        for part in (part_a, part_b):
            part_world = part.matrix_world.copy()
            part.parent = geometry
            part.matrix_parent_inverse = geometry.matrix_world.inverted_safe()
            part.matrix_world = part_world
        asset_boolean = part_a.modifiers.new(name="Smoke Asset Cut", type='BOOLEAN')
        asset_boolean.object = part_b
        blockout.add_object_constraint(part_b, part_a, "copy_rotation")
        blockout.add_object_constraint(part_a, cube, "copy_location")
        bpy.context.view_layer.update()
        part_b_world_before = part_b.matrix_world.copy()

        asset_duplicate = operators.execute_live_operation({
            "op": "duplicate_object",
            "id": "smoke-asset-root",
            "newId": "smoke-asset-root-copy",
            "name": "Smoke Asset Copy",
        })
        bpy.context.view_layer.update()
        assert asset_duplicate["object_id"] == "smoke-asset-root-copy"
        assert asset_duplicate["createdObjectIds"][0] == "smoke-asset-root-copy"
        assert len(asset_duplicate["createdObjectIds"]) == 4
        new_root = blockout.find_object("smoke-asset-root-copy")
        assert new_root is not None and new_root != asset_root
        assert new_root.get(asset_import.ASSET_ROOT_PROPERTY)
        assert new_root.get(asset_import.ASSET_ID_PROPERTY) == "smoke-asset"
        assert blockout.object_display_name(new_root) == "Smoke Asset Copy"
        new_subtree = asset_import.asset_subtree(new_root)
        assert len(new_subtree) == 3
        assert all(obj not in {geometry, part_a, part_b} for obj in new_subtree)
        new_ids = [new_root.get(blockout.ID_PROPERTY), *(obj.get(blockout.ID_PROPERTY) for obj in new_subtree)]
        assert sorted(asset_duplicate["createdObjectIds"]) == sorted(new_ids)
        original_ids = {
            asset_root.get(blockout.ID_PROPERTY),
            *(obj.get(blockout.ID_PROPERTY) for obj in asset_import.asset_subtree(asset_root)),
        }
        assert len(set(new_ids)) == 4 and not set(new_ids) & original_ids
        new_part_a = next(obj for obj in new_subtree if obj.type == 'MESH' and obj.modifiers)
        new_part_b = next(obj for obj in new_subtree if obj.type == 'MESH' and obj != new_part_a)
        assert new_part_a.modifiers["Smoke Asset Cut"].object == new_part_b
        assert new_part_b.constraints["WorldEngine Copy Rotation"].target == new_part_a
        assert new_part_a.constraints["WorldEngine Copy Location"].target == cube
        assert part_a.modifiers["Smoke Asset Cut"].object == part_b
        assert blockout.DIRECTOR_ID_PROPERTY not in new_part_a
        assert new_part_b.parent != geometry and new_part_b.parent.parent == new_root
        assert new_part_b.users_collection[0] == part_b.users_collection[0]
        assert max(
            abs(new_part_b.matrix_world[row][column] - part_b_world_before[row][column])
            for row in range(4)
            for column in range(4)
        ) < 1e-5

        plain_duplicate = operators.execute_live_operation({
            "op": "duplicate_object",
            "id": cube.get(blockout.ID_PROPERTY),
            "newId": "smoke-cube-copy",
        })
        assert plain_duplicate["object_id"] == "smoke-cube-copy"
        assert plain_duplicate["createdObjectIds"] == ["smoke-cube-copy"]
        plain_copy = blockout.find_object("smoke-cube-copy")
        assert plain_copy is not None and plain_copy.data != cube.data

        native_session.start(0)
        live_request_id = "63a521f0-7fe3-4fd7-8e06-8457e806c6b3"
        live_batch = {
            "contract": "worldengine-blender-live-v1",
            "requestId": live_request_id,
            "expectedSceneEpoch": native_session.scene_epoch_value(),
            "expectedRevision": scene.worldengine_studio.scene_revision,
            "operations": [
                {
                    "op": "create_blockout",
                    "preset": "corridor",
                    "idPrefix": "smoke-corridor",
                    "origin": [0, 0, 0],
                    "width": 2.4,
                    "depth": 8.0,
                    "height": 2.8,
                    "wallThickness": 0.15,
                    "stepCount": 12,
                },
                {
                    "op": "create_light",
                    "id": "smoke-light-live",
                    "kind": "area",
                    "position": [4, 6, 4],
                    "target": [0, 1.5, 0],
                    "energy": 900,
                    "size": 3,
                    "color": [1, 0.9, 0.8],
                },
                {
                    "op": "create_opening",
                    "id": "smoke-opening-live",
                    "targetId": wall.get(blockout.ID_PROPERTY),
                    "kind": "window",
                    "width": 1.4,
                    "height": 1.2,
                    "sillHeight": 0.9,
                    "offset": 0.5,
                },
                {
                    "op": "move_to_collection",
                    "ids": ["smoke-opening-live"],
                    "collection": "Director Openings",
                },
                {
                    "op": "create_primitive",
                    "id": "smoke-parent-live",
                    "primitive": "cube",
                    "dimensions": [1, 1, 1],
                    "transform": {"position": [3, 0.5, 0]},
                },
                {
                    "op": "create_primitive",
                    "id": "smoke-child-live",
                    "primitive": "sphere",
                    "dimensions": [0.5, 0.5, 0.5],
                    "transform": {"position": [4, 0.5, 0]},
                },
                {
                    "op": "set_parent",
                    "id": "smoke-child-live",
                    "parentId": "smoke-parent-live",
                    "keepWorldTransform": True,
                },
                {
                    "op": "add_constraint",
                    "id": "smoke-child-live",
                    "targetId": "smoke-parent-live",
                    "kind": "copy_rotation",
                    "influence": 0.6,
                },
            ],
        }
        live_request = Request(
            f"{native_session.session_url()}/v1/commands",
            data=json.dumps(live_batch).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(live_request, timeout=2.0) as response:
            accepted = json.loads(response.read())
            assert response.status == 202
            assert accepted["jobId"] == live_request_id
        assert native_session.wait_for_pending(timeout=0.0) is True
        assert native_session.drain_pending() == 1
        live_record = native_session.command_record(live_request_id)
        assert live_record and live_record["status"] == "succeeded"
        assert live_record["revision"] == scene.worldengine_studio.scene_revision
        assert "snapshotBefore" not in live_record["result"]
        assert "snapshotAfter" not in live_record["result"]
        assert native_session.current_snapshot()["revision"] == live_record["revision"]
        assert native_session.wait_for_pending(timeout=0.0) is False

        with urlopen(live_request, timeout=2.0) as response:
            replay = json.loads(response.read())
            assert response.status == 202
            assert replay["status"] == "succeeded"
        assert native_session.drain_pending() == 0

        conflicting_batch = json.loads(json.dumps(live_batch))
        conflicting_batch["expectedRevision"] = scene.worldengine_studio.scene_revision
        conflict_request = Request(
            f"{native_session.session_url()}/v1/commands",
            data=json.dumps(conflicting_batch).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urlopen(conflict_request, timeout=2.0)
        except HTTPError as error:
            conflict = json.loads(error.read())
            assert error.code == 409
            assert conflict["code"] == "intent_conflict"
            assert conflict["requestId"] == live_request_id
        else:
            raise AssertionError("same intent ID with a different revision must conflict")

        with urlopen(f"{native_session.session_url()}/health", timeout=2.0) as response:
            health = json.loads(response.read())
            assert health["ok"] is True
            assert health["revision"] == scene.worldengine_studio.scene_revision
        with urlopen(f"{native_session.session_url()}/v1/scene", timeout=2.0) as response:
            live_scene = json.loads(response.read())
            assert live_scene["contract"] == "worldengine-blender-live-v1"
            assert any(item["id"].startswith("smoke-corridor:") for item in live_scene["objects"])
            assert any(item["id"] == "smoke-opening-live" for item in live_scene["objects"])
            assert any(item["id"] == "smoke-light-live" for item in live_scene["lights"])
            assert live_scene["activeObjectId"] is not None
            live_child = next(item for item in live_scene["objects"] if item["id"] == "smoke-child-live")
            assert live_child["parentId"] == "smoke-parent-live"
            assert live_child["localTransform"] != {
                "position": live_child["position"],
                "rotation": live_child["rotation"],
                "scale": live_child["scale"],
            }
            assert any(
                constraint["targetId"] == "smoke-parent-live"
                and constraint["kind"] == "copy_rotation"
                and abs(constraint["influence"] - 0.6) < 1e-6
                for constraint in live_child["constraints"]
            )

        snapshot = native_session.current_snapshot()
        assert snapshot and snapshot["contract"] == "worldengine-blender-live-v1"
        assert any(item["name"] == "Smoke Cube" for item in snapshot["objects"])

        # query_spatial: read-only spatial reasoning in Director coordinates.
        # Prove the axis mapping first: Director Y is Blender Z (and Director
        # Z is Blender -Y), so every assertion below is written in Director Y-up.
        assert blender_to_director_point((1.0, 2.0, 3.0)) == (1.0, 3.0, -2.0)
        assert director_to_blender_point((1.0, 2.0, 3.0)) == (1.0, -3.0, 2.0)
        assert blender_to_director_point(director_to_blender_point((0.4, -1.0, 0.25))) == (0.4, -1.0, 0.25)

        # Isolated rig far from the rest of the smoke scene: an 8x8 m floor
        # slab whose top surface sits at Director Y=0.2, and a 1 m cube
        # floating with its bottom at Director Y=2.5. The primitives are moved
        # with a second update_transform after a view-layer update, because a
        # freshly created object's matrix_world is not evaluated yet and a
        # combined create+transform would drop the non-unit dimensions.
        operators.execute_live_operation({
            "op": "create_primitive",
            "id": "smoke-spatial-floor",
            "primitive": "floor",
            "dimensions": [8.0, 0.2, 8.0],
        })
        operators.execute_live_operation({
            "op": "create_primitive",
            "id": "smoke-spatial-cube",
            "primitive": "cube",
            "dimensions": [1.0, 1.0, 1.0],
        })
        bpy.context.view_layer.update()
        operators.execute_live_operation({
            "op": "update_transform",
            "id": "smoke-spatial-floor",
            "transform": {"position": [200.0, 0.1, 0.0]},
        })
        operators.execute_live_operation({
            "op": "update_transform",
            "id": "smoke-spatial-cube",
            "transform": {"position": [200.0, 3.0, 0.0]},
        })
        bpy.context.view_layer.update()

        spatial = operators.execute_live_operation({
            "op": "query_spatial",
            "queries": [
                {"kind": "RAYCAST", "origin": [200.0, 10.0, 0.0], "direction": [0.0, -1.0, 0.0]},
                {
                    "kind": "RAYCAST",
                    "origin": [200.0, 10.0, 0.0],
                    "direction": [0.0, -1.0, 0.0],
                    "excludeIds": ["smoke-spatial-cube"],
                },
                {"kind": "CLOSEST_POINT", "point": [200.0, 5.0, 0.0], "targetId": "smoke-spatial-cube"},
                {"kind": "OVERLAP", "idA": "smoke-spatial-cube", "idB": "smoke-spatial-floor"},
                {"kind": "GROUND", "id": "smoke-spatial-cube"},
            ],
        })["queries"]
        cube_hit, floor_hit, closest, separated, ground = spatial
        assert cube_hit["kind"] == "RAYCAST" and cube_hit["hit"] is True
        assert cube_hit["objectId"] == "smoke-spatial-cube"
        assert abs(cube_hit["distance"] - 6.5) < 1e-3
        assert max(abs(a - b) for a, b in zip(cube_hit["position"], [200.0, 3.5, 0.0])) < 1e-3
        # Blockout boxes are authored with inward-facing polygons, so the
        # geometric normal of the hit top face is Blender (0, 0, -1); the
        # query reports it unflipped as Director (0, -1, 0).
        assert max(abs(a - b) for a, b in zip(cube_hit["normal"], [0.0, -1.0, 0.0])) < 1e-3
        assert floor_hit["hit"] is True and floor_hit["objectId"] == "smoke-spatial-floor"
        assert abs(floor_hit["distance"] - 9.8) < 1e-3
        assert abs(floor_hit["position"][1] - 0.2) < 1e-3
        assert closest["kind"] == "CLOSEST_POINT" and closest["found"] is True
        assert closest["faceIndex"] >= 0
        assert abs(closest["distance"] - 1.5) < 1e-3
        assert max(abs(a - b) for a, b in zip(closest["position"], [200.0, 3.5, 0.0])) < 1e-3
        assert max(abs(a - b) for a, b in zip(closest["normal"], [0.0, -1.0, 0.0])) < 1e-3
        assert separated["kind"] == "OVERLAP" and separated["overlapping"] is False
        assert separated["contactPairCount"] == 0
        assert ground["kind"] == "GROUND" and ground["hit"] is True
        assert ground["groundObjectId"] == "smoke-spatial-floor"
        assert abs(ground["bottomY"] - 2.5) < 1e-3
        # Floor top is at Y=0.2 and the cube origin sits 0.5 above its bottom,
        # so resting the cube on the slab needs origin Y = 0.7.
        assert abs(ground["suggestedPositionY"] - 0.7) < 1e-3

        operators.execute_live_operation({
            "op": "update_transform",
            "id": "smoke-spatial-cube",
            "transform": {"position": [200.0, ground["suggestedPositionY"], 0.0]},
        })
        bpy.context.view_layer.update()
        grounded = operators.execute_live_operation({
            "op": "query_spatial",
            "queries": [{"kind": "GROUND", "id": "smoke-spatial-cube"}],
        })["queries"][0]
        assert grounded["hit"] is True and grounded["groundObjectId"] == "smoke-spatial-floor"
        assert abs(grounded["bottomY"] - 0.2) < 1e-3
        assert abs(grounded["suggestedPositionY"] - ground["suggestedPositionY"]) < 1e-3

        operators.execute_live_operation({
            "op": "update_transform",
            "id": "smoke-spatial-cube",
            "transform": {"position": [200.0, 0.0, 0.0]},
        })
        bpy.context.view_layer.update()
        intersecting = operators.execute_live_operation({
            "op": "query_spatial",
            "queries": [{"kind": "OVERLAP", "idA": "smoke-spatial-cube", "idB": "smoke-spatial-floor"}],
        })["queries"][0]
        assert intersecting["overlapping"] is True and intersecting["contactPairCount"] > 0

        named = operators.execute_live_operation({
            "op": "query_spatial",
            "queries": [{"kind": "NAME", "namePattern": "smoke-spatial-cube"}],
        })["queries"][0]
        assert named["kind"] == "NAME"
        assert any(item["id"] == "smoke-spatial-cube" for item in named["objects"])

        try:
            operators.execute_live_operation({
                "op": "query_spatial",
                "queries": [{"kind": "OVERLAP", "idA": "smoke-spatial-cube", "idB": "smoke-missing-object"}],
            })
        except ValueError as error:
            assert "smoke-missing-object" in str(error)
        else:
            raise AssertionError("query_spatial must reject unknown stable ids")

        # The live wire treats query_spatial as read-only: no expectedSceneEpoch
        # is required and the scene revision must not move.
        revision_before_query = scene.worldengine_studio.scene_revision
        query_request_id = "9d1f5f5e-3a89-4bd0-9a56-1af1c3c4f5aa"
        query_batch = {
            "contract": "worldengine-blender-live-v1",
            "requestId": query_request_id,
            "operations": [
                {
                    "op": "query_spatial",
                    "queries": [
                        {
                            "kind": "RAYCAST",
                            "origin": [200.0, 10.0, 0.0],
                            "direction": [0.0, -1.0, 0.0],
                            "maxDistance": 50.0,
                        },
                    ],
                },
            ],
        }
        query_request = Request(
            f"{native_session.session_url()}/v1/commands",
            data=json.dumps(query_batch).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(query_request, timeout=2.0) as response:
            assert response.status == 202
        assert native_session.wait_for_pending(timeout=0.0) is True
        assert native_session.drain_pending() == 1
        query_record = native_session.command_record(query_request_id)
        assert query_record and query_record["status"] == "succeeded"
        assert query_record["revision"] == revision_before_query
        assert scene.worldengine_studio.scene_revision == revision_before_query
        http_hit = query_record["result"]["operations"][0]["queries"][0]
        assert http_hit["hit"] is True and http_hit["objectId"] == "smoke-spatial-cube"
        assert abs(http_hit["distance"] - 9.5) < 1e-3

        print("WORLDENGINE_STUDIO_SMOKE_OK")
    finally:
        worldengine_studio.unregister()


main()
