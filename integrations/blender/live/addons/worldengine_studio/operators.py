# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

from __future__ import annotations

import json
from typing import Any

import bpy
from bpy.props import EnumProperty
from bpy.types import Menu, Operator
from mathutils import Matrix, Vector

from . import asset_import, asset_libraries, blockout, director_project, director_runtime, material_nodes, mixamo_actions, modeling, native_session, rig, semantic_geometry
from .preferences import get_preferences
from .coordinates import director_to_blender_point


def _mark_scene_changed(scene: bpy.types.Scene) -> None:
    state = scene.worldengine_studio
    state.scene_revision += 1


def _blockout_parameters(context, preset: str) -> dict[str, Any]:
    state = context.scene.worldengine_studio
    if preset == 'room':
        return {
            "width": state.blockout_width,
            "depth": state.blockout_depth,
            "height": state.blockout_height,
            "thickness": state.wall_thickness,
        }
    if preset == 'corridor':
        return {
            "length": state.blockout_depth,
            "width": state.blockout_width,
            "height": state.blockout_height,
            "thickness": state.wall_thickness,
        }
    return {
        "width": state.blockout_width,
        "run": state.blockout_depth,
        "rise": state.blockout_height,
        "steps": state.stair_steps,
    }


def _object_result(obj: bpy.types.Object) -> dict[str, Any]:
    return {
        "object_id": blockout.ensure_stable_id(obj),
        "name": blockout.object_display_name(obj),
        "kind": "camera" if obj.type == 'CAMERA' else str(obj.get("worldengine_kind", "object")),
    }


def _apply_live_transform(obj: bpy.types.Object, transform: dict[str, Any] | None) -> None:
    if not transform:
        return
    location, rotation, scale = obj.matrix_world.decompose()
    if "position" in transform:
        location = Vector(director_to_blender_point(transform["position"]))
    if "rotation" in transform:
        rotation = blockout.director_rotation_to_blender(transform["rotation"]).to_quaternion()
    if "scale" in transform:
        x, y, z = transform["scale"]
        scale = Vector((float(x), float(z), float(y)))
    obj.matrix_world = Matrix.LocRotScale(location, rotation, scale)


def _delete_live_objects(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    removal_by_pointer: dict[int, bpy.types.Object] = {}
    for operation in operations:
        obj = blockout.find_object(operation["id"])
        pointer = obj.as_pointer() if obj is not None else 0
        if obj is None or pointer in removal_by_pointer:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        results.append(_object_result(obj))
        targets = [obj]
        if obj.get(asset_import.ASSET_ROOT_PROPERTY):
            targets.extend(asset_import.asset_subtree(obj))
        for target in targets:
            removal_by_pointer.setdefault(target.as_pointer(), target)

    bpy.data.batch_remove(list(removal_by_pointer.values()))
    bpy.data.orphans_purge(do_recursive=True)
    return results


def execute_live_operation(operation: dict[str, Any]) -> dict[str, Any]:
    """Execute one operation from the shared live contract.

    Both the native UI and Director automation end here, in the same Blender
    data API and native undo stack.
    """
    op = operation["op"]
    scene = bpy.context.scene

    if op == "discover_operators":
        return modeling.discover_operators(
            query=operation.get("query", ""),
            category=operation.get("category"),
            scope=operation.get("scope", "modeling"),
            available_only=operation.get("availableOnly", False),
            limit=int(operation.get("limit", 80)),
        )

    if op == "describe_operator":
        return modeling.describe_operator(operation["operator"])

    if op == "inspect_object":
        return modeling.inspect_object(operation["id"])

    if op == "capture_render":
        return modeling.capture_render(operation)

    if op == "export_scene_preview":
        return modeling.export_scene_preview()

    if op == "bind_director_project":
        return director_project.bind_project(operation["projectId"])

    if op == "import_asset":
        return asset_import.import_asset(operation)

    if op == "set_selection":
        return modeling.set_selection(operation)

    if op == "select_mesh_elements":
        return modeling.select_mesh_elements(operation)

    if op == "assign_material":
        return modeling.assign_material(operation)

    if op == "project_uv":
        return modeling.project_uv(operation)

    if op == "create_material_node":
        return material_nodes.create_material_node(operation)

    if op == "delete_material_node":
        return material_nodes.delete_material_node(operation)

    if op == "set_material_node_input":
        return material_nodes.set_material_node_input(operation)

    if op == "connect_material_nodes":
        return material_nodes.connect_material_nodes(operation)

    if op == "disconnect_material_node_input":
        return material_nodes.disconnect_material_node_input(operation)

    if op == "ensure_geometry_nodes":
        return semantic_geometry.ensure_geometry_nodes(operation)

    if op == "create_geometry_node":
        return semantic_geometry.create_geometry_node(operation)

    if op == "delete_geometry_node":
        return semantic_geometry.delete_geometry_node(operation)

    if op == "set_geometry_node_input":
        return semantic_geometry.set_geometry_node_input(operation)

    if op == "connect_geometry_nodes":
        return semantic_geometry.connect_geometry_nodes(operation)

    if op == "disconnect_geometry_node_input":
        return semantic_geometry.disconnect_geometry_node_input(operation)

    if op == "select_pose_bones":
        return rig.select_pose_bones(operation)

    if op == "set_pose_bone_transform":
        return rig.set_pose_bone_transform(operation)

    if op == "apply_pose_offsets":
        return rig.apply_pose_offsets(operation)

    if op == "create_action":
        return rig.create_action(operation)

    if op == "set_active_action":
        return rig.set_active_action(operation)

    if op == "set_scene_frame":
        return rig.set_scene_frame(operation)

    if op == "insert_pose_keyframes":
        return rig.insert_pose_keyframes(operation)

    if op == "delete_pose_keyframes":
        return rig.delete_pose_keyframes(operation)

    if op == "import_mixamo_action":
        return mixamo_actions.import_mixamo_action(operation)

    if op == "create_nla_track":
        return mixamo_actions.create_nla_track(operation)

    if op == "add_nla_strip":
        return mixamo_actions.add_nla_strip(operation)

    if op == "update_nla_strip":
        return mixamo_actions.update_nla_strip(operation)

    if op == "remove_nla_strip":
        return mixamo_actions.remove_nla_strip(operation)

    if op == "invoke_operator":
        return modeling.invoke_operator(operation)

    if op == "set_rna_property":
        return modeling.set_rna_property(operation)

    if op == "execute_code":
        return modeling.execute_code(operation)

    if op == "polyhaven_search":
        return asset_libraries.polyhaven_search(operation)

    if op == "polyhaven_import":
        return asset_libraries.polyhaven_import(operation)

    if op == "sketchfab_search":
        return asset_libraries.sketchfab_search(operation)

    if op == "sketchfab_import":
        return asset_libraries.sketchfab_import(operation)

    if op == "undo_scene":
        return modeling.undo_scene()

    if op == "redo_scene":
        return modeling.redo_scene()

    if op == "create_curve":
        return semantic_geometry.create_curve(operation)

    if op == "set_curve_data":
        return semantic_geometry.set_curve_data(operation)

    if op == "create_text":
        return semantic_geometry.create_text(operation)

    if op == "set_text_data":
        return semantic_geometry.set_text_data(operation)

    if op == "create_primitive":
        primitive = operation["primitive"]
        dimensions = operation.get("dimensions")
        transform = operation.get("transform") or {}
        obj = blockout.create_primitive(
            scene,
            primitive,
            name=operation.get("name") or primitive.replace("_", " ").title(),
            location=(
                director_to_blender_point(transform["position"])
                if "position" in transform
                else None
            ),
            dimensions=(blockout.director_dimensions_to_blender(dimensions) if dimensions else None),
            rotation=(
                blockout.director_rotation_to_blender(transform["rotation"])
                if "rotation" in transform
                else (0.0, 0.0, 0.0)
            ),
            segments=operation.get("segments"),
            rings=operation.get("rings"),
            grounded=bool(operation.get("grounded", False)),
        )
        obj[blockout.ID_PROPERTY] = operation["id"]
        if operation.get("directorId"):
            obj[blockout.DIRECTOR_ID_PROPERTY] = operation["directorId"]
        obj.matrix_world = Matrix.LocRotScale(
            obj.location.copy(),
            obj.rotation_euler.to_quaternion(),
            obj.scale.copy(),
        )
        return _object_result(obj)

    if op == "update_transform":
        obj = blockout.find_object(operation["id"])
        if obj is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        _apply_live_transform(obj, operation["transform"])
        return _object_result(obj)

    if op == "set_object_name":
        obj = blockout.find_object(operation["id"])
        if obj is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        blockout.set_object_display_name(obj, operation["name"])
        return _object_result(obj)

    if op == "set_object_visibility":
        obj = blockout.find_object(operation["id"])
        if obj is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        visible = bool(operation["visible"])
        targets = [obj]
        if obj.get(asset_import.ASSET_ROOT_PROPERTY):
            targets.extend(asset_import.asset_subtree(obj))
        for target in targets:
            target.hide_viewport = not visible
            target.hide_render = not visible
            target.hide_set(not visible)
        return _object_result(obj)

    if op == "delete_object":
        return _delete_live_objects([operation])[0]

    if op == "duplicate_object":
        source = blockout.find_object(operation["id"])
        if source is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        if source.get(asset_import.ASSET_ROOT_PROPERTY):
            originals = [source, *asset_import.asset_subtree(source)]
            copies: dict[bpy.types.Object, bpy.types.Object] = {}
            for original in originals:
                duplicate = original.copy()
                if original.data is not None:
                    duplicate.data = original.data.copy()
                (original.users_collection[0] if original.users_collection else scene.collection).objects.link(duplicate)
                copies[original] = duplicate
            for original, duplicate in copies.items():
                if original.parent in copies:
                    duplicate.parent = copies[original.parent]
                    duplicate.matrix_parent_inverse = original.matrix_parent_inverse.copy()
                for modifier in duplicate.modifiers:
                    for prop in modifier.bl_rna.properties:
                        if prop.type != 'POINTER' or prop.is_readonly:
                            continue
                        value = getattr(modifier, prop.identifier)
                        if isinstance(value, bpy.types.Object) and value in copies:
                            setattr(modifier, prop.identifier, copies[value])
                for constraint in duplicate.constraints:
                    target = getattr(constraint, "target", None)
                    if isinstance(target, bpy.types.Object) and target in copies:
                        constraint.target = copies[target]
            obj = copies[source]
            obj[blockout.ID_PROPERTY] = operation["newId"]
            created_ids = [blockout.ensure_stable_id(obj)]
            for original in originals[1:]:
                descendant = copies[original]
                descendant[blockout.ID_PROPERTY] = blockout.new_stable_id("asset-object")
                if blockout.DIRECTOR_ID_PROPERTY in descendant:
                    del descendant[blockout.DIRECTOR_ID_PROPERTY]
                created_ids.append(blockout.ensure_stable_id(descendant))
            blockout.set_object_display_name(
                obj,
                operation.get("name") or f"{blockout.object_display_name(source)} Copy",
            )
            _apply_live_transform(obj, operation.get("transform"))
            blockout._select_only(obj)
            return {**_object_result(obj), "createdObjectIds": created_ids}
        obj = source.copy()
        if source.data is not None:
            obj.data = source.data.copy()
        (source.users_collection[0] if source.users_collection else scene.collection).objects.link(obj)
        obj[blockout.ID_PROPERTY] = operation["newId"]
        blockout.set_object_display_name(
            obj,
            operation.get("name") or f"{blockout.object_display_name(source)} Copy",
        )
        _apply_live_transform(obj, operation.get("transform"))
        blockout._select_only(obj)
        return {**_object_result(obj), "createdObjectIds": [blockout.ensure_stable_id(obj)]}

    if op == "create_camera":
        location = director_to_blender_point(operation["position"])
        target = Vector(director_to_blender_point(operation["target"]))
        obj = blockout.create_camera(
            scene,
            name=operation.get("name") or "Shot Camera",
            location=location,
            focal_length_mm=float(operation.get("focalLengthMm", 35.0)),
        )
        obj[blockout.ID_PROPERTY] = operation["id"]
        obj.data.sensor_width = float(operation.get("sensorWidthMm", 36.0))
        direction = target - obj.location
        if direction.length_squared > 0:
            obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        return _object_result(obj)

    if op == "set_camera_data":
        obj = blockout.find_object(operation["id"])
        if obj is None or obj.type != 'CAMERA':
            raise ValueError(f"Unknown WorldEngine camera: {operation['id']}")
        camera = obj.data
        camera.type = 'ORTHO' if operation["projectionType"] == "ORTHOGRAPHIC" else 'PERSP'
        camera.lens = float(operation["focalLengthMm"])
        camera.sensor_fit = operation["sensorFit"]
        camera.sensor_width = float(operation["sensorWidthMm"])
        camera.sensor_height = float(operation["sensorHeightMm"])
        camera.shift_x = float(operation["shiftX"])
        camera.shift_y = float(operation["shiftY"])
        camera.clip_start = float(operation["clipStart"])
        camera.clip_end = float(operation["clipEnd"])
        camera.ortho_scale = float(operation["orthographicScale"])
        return _object_result(obj)

    if op == "create_light":
        location = director_to_blender_point(operation["position"])
        target = director_to_blender_point(operation.get("target", [0.0, 1.5, 0.0]))
        obj = blockout.create_light(
            scene,
            kind=operation.get("kind", "area"),
            name=operation.get("name") or "Director Key Light",
            location=location,
            target=target,
            energy=float(operation.get("energy", 1000.0)),
            color=operation.get("color", [1.0, 0.94, 0.86]),
            size=float(operation.get("size", 4.0)),
        )
        obj[blockout.ID_PROPERTY] = operation["id"]
        return _object_result(obj)

    if op == "set_light_data":
        obj = blockout.find_object(operation["id"])
        if obj is None or obj.type != 'LIGHT':
            raise ValueError(f"Unknown WorldEngine light: {operation['id']}")
        light = obj.data
        light.type = operation["kind"].upper()
        light.color = tuple(float(value) for value in operation["color"])
        light.energy = float(operation["energy"])
        size = float(operation["size"])
        if light.type == 'AREA':
            light.size = size
        elif light.type in {'POINT', 'SPOT'}:
            light.shadow_soft_size = size
        obj["worldengine_light_kind"] = operation["kind"]
        return _object_result(obj)

    if op == "create_opening":
        wall = blockout.find_object(operation["targetId"])
        if wall is None:
            raise ValueError(f"Unknown WorldEngine wall: {operation['targetId']}")
        cutter, modifier = blockout.create_opening(
            scene,
            wall,
            kind=operation.get("kind", "door"),
            name=operation.get("name"),
            width=float(operation.get("width", 0.9)),
            height=float(operation.get("height", 2.1)),
            sill_height=float(operation.get("sillHeight", 0.0)),
            offset=float(operation.get("offset", 0.0)),
        )
        cutter[blockout.ID_PROPERTY] = operation["id"]
        return {
            "opening": _object_result(cutter),
            "target": _object_result(wall),
            "modifier": modifier.name,
        }

    if op == "move_to_collection":
        objects = []
        for identifier in operation["ids"]:
            obj = blockout.find_object(identifier)
            if obj is None:
                raise ValueError(f"Unknown WorldEngine object: {identifier}")
            objects.append(obj)
        collection = blockout.move_objects_to_collection(scene, objects, operation["collection"])
        return {
            "collection": collection.name,
            "objects": [_object_result(obj) for obj in objects],
        }

    if op == "set_parent":
        child = blockout.find_object(operation["id"])
        if child is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        parent_id = operation.get("parentId")
        if parent_id is None:
            blockout.clear_parent(child, keep_world_transform=operation.get("keepWorldTransform", True))
        else:
            parent = blockout.find_object(parent_id)
            if parent is None:
                raise ValueError(f"Unknown WorldEngine parent: {parent_id}")
            blockout.set_parent(
                child,
                parent,
                keep_world_transform=operation.get("keepWorldTransform", True),
            )
        return _object_result(child)

    if op == "add_constraint":
        owner = blockout.find_object(operation["id"])
        target = blockout.find_object(operation["targetId"])
        if owner is None or target is None:
            raise ValueError("WorldEngine constraint owner or target was not found")
        constraint = blockout.add_object_constraint(
            owner,
            target,
            operation["kind"],
            influence=operation.get("influence", 1.0),
        )
        return {"object": _object_result(owner), "constraintName": constraint.name}

    if op == "remove_constraint":
        owner = blockout.find_object(operation["id"])
        if owner is None:
            raise ValueError(f"Unknown WorldEngine object: {operation['id']}")
        name = blockout.remove_object_constraint(owner, operation["constraintName"])
        return {"object": _object_result(owner), "constraintName": name}

    if op == "set_active_camera":
        obj = blockout.find_object(operation["id"])
        if obj is None or obj.type != 'CAMERA':
            raise ValueError(f"Unknown WorldEngine camera: {operation['id']}")
        scene.camera = obj
        return _object_result(obj)

    if op == "set_world_environment":
        return {"world": blockout.set_world_environment(
            scene,
            color=operation.get("color", [0.05, 0.05, 0.05]),
            strength=float(operation.get("strength", 1.0)),
        )}

    if op == "create_blockout":
        preset = operation["preset"]
        origin = director_to_blender_point(operation.get("origin", [0.0, 0.0, 0.0]))
        width = float(operation.get("width", 8.0))
        depth = float(operation.get("depth", 6.0))
        height = float(operation.get("height", 3.0))
        thickness = float(operation.get("wallThickness", 0.18))
        if preset == "floor":
            objects = [blockout.create_box(
                scene,
                name="Blockout Floor",
                location=(origin[0], origin[1], origin[2] + thickness / 2),
                dimensions=(width, depth, thickness),
                kind="floor",
            )]
        elif preset == "wall":
            objects = [blockout.create_box(
                scene,
                name="Blockout Wall",
                location=(origin[0], origin[1], origin[2] + height / 2),
                dimensions=(width, thickness, height),
                kind="wall",
            )]
        else:
            parameters = {
                "width": width,
                "depth": depth,
                "length": depth,
                "height": height,
                "thickness": thickness,
                "run": depth,
                "rise": height,
                "steps": int(operation.get("stepCount", 12)),
            }
            objects = blockout.create_blockout(scene, preset, location=origin, parameters=parameters)
        for index, obj in enumerate(objects):
            obj[blockout.ID_PROPERTY] = f"{operation['idPrefix']}:{index + 1}"
        return {"objects": [_object_result(obj) for obj in objects]}

    if op in {"add_modifier", "set_modifier", "remove_modifier", "reorder_modifier", "apply_modifier"}:
        from . import modifier_stack

        return {
            "add_modifier": modifier_stack.add_modifier,
            "set_modifier": modifier_stack.set_modifier,
            "remove_modifier": modifier_stack.remove_modifier,
            "reorder_modifier": modifier_stack.reorder_modifier,
            "apply_modifier": modifier_stack.apply_modifier,
        }[op](operation)

    if op == "query_spatial":
        from . import spatial_query

        return spatial_query.query_spatial(operation)

    if op == "set_geometry_modifier_input":
        return semantic_geometry.set_geometry_modifier_input(operation)

    if op == "assign_geometry_node_group":
        return semantic_geometry.assign_geometry_node_group(operation)

    raise ValueError(f"Unsupported WorldEngine operation: {op}")


def execute_live_operations(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Execute one parsed batch, using Blender's bulk ID removal for delete-only batches."""
    if any(operation["op"] != "delete_object" for operation in operations):
        return [execute_live_operation(operation) for operation in operations]
    return _delete_live_objects(operations)


class WORLDENGINE_OT_open_director(Operator):
    bl_idname = "worldengine.open_director"
    bl_label = "Open Director"
    bl_description = "Open the WorldEngine Director stage in the default browser"

    def execute(self, context):
        preferences = get_preferences(context)
        url = preferences.director_url if preferences else "http://127.0.0.1:5175/?workspace=stage&host=blender"
        bpy.ops.wm.url_open(url=url)
        return {'FINISHED'}


class WORLDENGINE_OT_studio_start(Operator):
    bl_idname = "worldengine.studio_start"
    bl_label = "Start Blender Studio"
    bl_description = "Start the native Blender session and bundled Director services"

    def execute(self, context):
        preferences = get_preferences(context)
        session_port = preferences.session_port if preferences else 8791
        try:
            native_session.start(session_port)
            director_runtime.start(
                ui_port=preferences.director_ui_port if preferences else 5175,
                gateway_port=preferences.gateway_port if preferences else 8787,
                session_port=session_port,
            )
        except Exception as error:
            native_session.stop()
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}
        self.report({'INFO'}, "Blender Studio is running")
        return {'FINISHED'}


class WORLDENGINE_OT_studio_stop(Operator):
    bl_idname = "worldengine.studio_stop"
    bl_label = "Stop Blender Studio"

    def execute(self, _context):
        director_runtime.stop()
        native_session.stop()
        return {'FINISHED'}


class WORLDENGINE_OT_setup_workspace(Operator):
    bl_idname = "worldengine.setup_workspace"
    bl_label = "Set Up Director Workspace"
    bl_description = "Configure this Blender workspace for fast white-model staging"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        scene = context.scene
        scene.unit_settings.system = 'METRIC'
        scene.unit_settings.length_unit = 'METERS'
        scene.unit_settings.scale_length = 1.0
        scene.render.fps = 24
        scene.render.resolution_x = 1920
        scene.render.resolution_y = 1080
        scene.render.resolution_percentage = 50
        blockout.ensure_collection(scene)
        blockout.ensure_neutral_material()
        context.workspace["worldengine_workspace"] = True
        for area in context.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            space = area.spaces.active
            space.clip_start = 0.01
            space.clip_end = 10_000.0
            space.shading.type = 'SOLID'
            space.shading.light = 'STUDIO'
            space.shading.color_type = 'MATERIAL'
            space.shading.show_shadows = True
            space.overlay.show_floor = True
            space.overlay.show_axis_x = True
            space.overlay.show_axis_y = True
            space.overlay.grid_scale = 1.0
        self.report({'INFO'}, "WorldEngine Director workspace is ready")
        return {'FINISHED'}


class WORLDENGINE_OT_native_session_start(Operator):
    bl_idname = "worldengine.native_session_start"
    bl_label = "Start Native Session"

    def execute(self, context):
        preferences = get_preferences(context)
        port = preferences.session_port if preferences else 8791
        try:
            native_session.start(port)
        except Exception as error:
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}
        self.report({'INFO'}, f"Director session ready on 127.0.0.1:{port}")
        return {'FINISHED'}


class WORLDENGINE_OT_native_session_stop(Operator):
    bl_idname = "worldengine.native_session_stop"
    bl_label = "Stop Native Session"

    def execute(self, _context):
        native_session.stop()
        return {'FINISHED'}


class WORLDENGINE_OT_copy_session_url(Operator):
    bl_idname = "worldengine.copy_session_url"
    bl_label = "Copy Native Session URL"

    def execute(self, context):
        context.window_manager.clipboard = native_session.session_url()
        self.report({'INFO'}, "Native session URL copied")
        return {'FINISHED'}


class WORLDENGINE_OT_add_primitive(Operator):
    bl_idname = "worldengine.add_primitive"
    bl_label = "Add Blockout Primitive"
    bl_options = {'REGISTER', 'UNDO'}

    primitive: EnumProperty(
        name="Primitive",
        items=(
            ('cube', "Cube", "Add a neutral blockout cube"),
            ('floor', "Floor", "Add a neutral blockout floor"),
            ('wall', "Wall", "Add a neutral blockout wall"),
        ),
    )

    def execute(self, context):
        cursor = context.scene.cursor.location
        obj = blockout.create_primitive(context.scene, self.primitive)
        obj.location.x += cursor.x
        obj.location.y += cursor.y
        obj.location.z += cursor.z
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_add_blockout(Operator):
    bl_idname = "worldengine.add_blockout"
    bl_label = "Add Blockout Preset"
    bl_options = {'REGISTER', 'UNDO'}

    preset: EnumProperty(
        name="Preset",
        items=(
            ('room', "Room", "Create a floor and four walls"),
            ('corridor', "Corridor", "Create a floor and parallel walls"),
            ('stairs', "Stairs", "Create a stair flight"),
        ),
    )

    def execute(self, context):
        blockout.create_blockout(
            context.scene,
            self.preset,
            location=tuple(context.scene.cursor.location),
            parameters=_blockout_parameters(context, self.preset),
        )
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_add_camera(Operator):
    bl_idname = "worldengine.add_camera"
    bl_label = "Add Camera"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        blockout.create_camera(context.scene)
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_camera_from_view(Operator):
    bl_idname = "worldengine.camera_from_view"
    bl_label = "Camera from View"
    bl_description = "Create a physical camera matching the current 3D viewport"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.area is not None and context.area.type == 'VIEW_3D'

    def execute(self, context):
        obj = blockout.create_camera(context.scene, name="Shot Camera")
        obj.matrix_world = context.space_data.region_3d.view_matrix.inverted()
        context.scene.camera = obj
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_activate_camera(Operator):
    bl_idname = "worldengine.activate_camera"
    bl_label = "Activate Selected Camera"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.active_object is not None and context.active_object.type == 'CAMERA'

    def execute(self, context):
        blockout.ensure_stable_id(context.active_object, "camera")
        context.scene.camera = context.active_object
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_assign_neutral_material(Operator):
    bl_idname = "worldengine.assign_neutral_material"
    bl_label = "Apply Neutral Material"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return any(obj.type == 'MESH' for obj in context.selected_objects)

    def execute(self, context):
        for obj in context.selected_objects:
            blockout.ensure_stable_id(obj)
            blockout.assign_neutral_material(obj)
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_add_opening(Operator):
    bl_idname = "worldengine.add_opening"
    bl_label = "Add Native Opening"
    bl_description = "Add an editable Blender Boolean door or window to the selected wall"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.active_object is not None and context.active_object.type == 'MESH'

    def execute(self, context):
        state = context.scene.worldengine_studio
        sill_height = state.opening_sill_height if state.opening_kind == 'window' else 0.0
        blockout.create_opening(
            context.scene,
            context.active_object,
            kind=state.opening_kind,
            width=state.opening_width,
            height=state.opening_height,
            sill_height=sill_height,
            offset=state.opening_offset,
        )
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_add_light(Operator):
    bl_idname = "worldengine.add_light"
    bl_label = "Add Director Light"
    bl_description = "Create a real Blender light aimed at the 3D cursor"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        state = context.scene.worldengine_studio
        target = context.scene.cursor.location.copy()
        location = target + Vector((4.0, -4.0, 6.0))
        blockout.create_light(
            context.scene,
            kind=state.light_kind,
            location=location,
            target=target,
            energy=state.light_energy,
            size=state.light_size,
        )
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_move_to_collection(Operator):
    bl_idname = "worldengine.move_to_collection"
    bl_label = "Move Selection to Collection"
    bl_description = "Move selected objects into a native Blender collection"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return bool(context.selected_objects)

    def execute(self, context):
        state = context.scene.worldengine_studio
        blockout.move_objects_to_collection(context.scene, list(context.selected_objects), state.collection_name)
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_set_parent(Operator):
    bl_idname = "worldengine.set_parent"
    bl_label = "Set Native Parent"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        state = context.scene.worldengine_studio
        return context.active_object is not None and state.relation_target is not None

    def execute(self, context):
        state = context.scene.worldengine_studio
        blockout.set_parent(
            context.active_object,
            state.relation_target,
            keep_world_transform=state.keep_world_transform,
        )
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_clear_parent(Operator):
    bl_idname = "worldengine.clear_parent"
    bl_label = "Clear Native Parent"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.active_object is not None and context.active_object.parent is not None

    def execute(self, context):
        state = context.scene.worldengine_studio
        blockout.clear_parent(context.active_object, keep_world_transform=state.keep_world_transform)
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_add_constraint(Operator):
    bl_idname = "worldengine.add_constraint"
    bl_label = "Add Native Constraint"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        state = context.scene.worldengine_studio
        return context.active_object is not None and state.relation_target is not None

    def execute(self, context):
        state = context.scene.worldengine_studio
        blockout.add_object_constraint(
            context.active_object,
            state.relation_target,
            state.constraint_kind,
            influence=state.constraint_influence,
        )
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_remove_constraints(Operator):
    bl_idname = "worldengine.remove_constraints"
    bl_label = "Remove WorldEngine Constraints"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.active_object is not None and any(
            constraint.name.startswith("WorldEngine ") for constraint in context.active_object.constraints
        )

    def execute(self, context):
        owner = context.active_object
        for constraint in list(owner.constraints):
            if constraint.name.startswith("WorldEngine "):
                owner.constraints.remove(constraint)
        _mark_scene_changed(context.scene)
        return {'FINISHED'}


class WORLDENGINE_OT_save_scene(Operator):
    bl_idname = "worldengine.save_scene"
    bl_label = "Save Blender Scene"
    bl_description = "Save the authoritative native .blend scene"

    def execute(self, _context):
        if bpy.data.filepath:
            bpy.ops.wm.save_mainfile()
        else:
            bpy.ops.wm.save_as_mainfile('INVOKE_DEFAULT')
        return {'FINISHED'}


class WORLDENGINE_OT_snapshot_scene(Operator):
    bl_idname = "worldengine.snapshot_scene"
    bl_label = "Copy Scene Snapshot"

    def execute(self, context):
        snapshot = blockout.snapshot_scene(context.scene)
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        context.window_manager.clipboard = payload
        native_session.set_snapshot(snapshot)
        self.report({'INFO'}, f"Copied {len(snapshot['objects'])} objects")
        return {'FINISHED'}


class WORLDENGINE_MT_add(Menu):
    bl_idname = "WORLDENGINE_MT_add"
    bl_label = "WorldEngine Blockout"

    def draw(self, _context):
        layout = self.layout
        layout.operator("worldengine.add_primitive", text="Cube", icon='MESH_CUBE').primitive = 'cube'
        layout.operator("worldengine.add_primitive", text="Floor", icon='MESH_PLANE').primitive = 'floor'
        layout.operator("worldengine.add_primitive", text="Wall", icon='MOD_SOLIDIFY').primitive = 'wall'
        layout.separator()
        layout.operator("worldengine.add_blockout", text="Room", icon='HOME').preset = 'room'
        layout.operator("worldengine.add_blockout", text="Corridor", icon='MOD_ARRAY').preset = 'corridor'
        layout.operator("worldengine.add_blockout", text="Stairs", icon='MOD_BUILD').preset = 'stairs'
        layout.separator()
        layout.operator("worldengine.camera_from_view", icon='OUTLINER_DATA_CAMERA')
        layout.operator("worldengine.add_light", text="Director Light", icon='LIGHT_AREA')
        if bpy.context.active_object is not None and bpy.context.active_object.type == 'MESH':
            layout.operator("worldengine.add_opening", text="Door / Window Opening", icon='MOD_BOOLEAN')


def draw_add_menu(self, _context):
    self.layout.menu(WORLDENGINE_MT_add.bl_idname, icon='MESH_CUBE')


classes = (
    WORLDENGINE_MT_add,
    WORLDENGINE_OT_setup_workspace,
    WORLDENGINE_OT_studio_start,
    WORLDENGINE_OT_studio_stop,
    WORLDENGINE_OT_open_director,
    WORLDENGINE_OT_native_session_start,
    WORLDENGINE_OT_native_session_stop,
    WORLDENGINE_OT_copy_session_url,
    WORLDENGINE_OT_add_primitive,
    WORLDENGINE_OT_add_blockout,
    WORLDENGINE_OT_add_camera,
    WORLDENGINE_OT_camera_from_view,
    WORLDENGINE_OT_activate_camera,
    WORLDENGINE_OT_assign_neutral_material,
    WORLDENGINE_OT_add_opening,
    WORLDENGINE_OT_add_light,
    WORLDENGINE_OT_move_to_collection,
    WORLDENGINE_OT_set_parent,
    WORLDENGINE_OT_clear_parent,
    WORLDENGINE_OT_add_constraint,
    WORLDENGINE_OT_remove_constraints,
    WORLDENGINE_OT_save_scene,
    WORLDENGINE_OT_snapshot_scene,
)


def register(*, include_ui=True):
    for cls in classes:
        bpy.utils.register_class(cls)
    if include_ui:
        bpy.types.VIEW3D_MT_add.append(draw_add_menu)


def unregister(*, include_ui=True):
    if include_ui:
        bpy.types.VIEW3D_MT_add.remove(draw_add_menu)
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
