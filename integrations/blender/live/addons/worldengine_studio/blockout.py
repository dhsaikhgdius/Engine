# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

from __future__ import annotations

import difflib
import uuid
from typing import Any

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from .coordinates import blender_to_director_point, director_to_blender_point
from .material_names import nearby_material_names_from, unique_material_names


ID_PROPERTY = "worldengine_id"
DIRECTOR_ID_PROPERTY = "director_id"
DISPLAY_NAME_PROPERTY = "worldengine_display_name"
COLLECTION_ROLE_PROPERTY = "worldengine_collection_role"
BLOCKOUT_COLLECTION = "WorldEngine Blockout"
CONSTRUCTION_COLLECTION = "WorldEngine Construction"
LIGHT_COLLECTION = "WorldEngine Lights"
NEUTRAL_MATERIAL = "WorldEngine Neutral"
SCENE_MATERIAL_NAME_LIMIT = 64
_BASIS = Matrix(((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)))


def new_stable_id(prefix: str = "object") -> str:
    return f"we-{prefix}-{uuid.uuid4().hex}"


def ensure_stable_id(obj: bpy.types.Object, prefix: str | None = None) -> str:
    current = obj.get(ID_PROPERTY)
    if isinstance(current, str) and current.strip():
        return current
    identifier = new_stable_id(prefix or ("camera" if obj.type == 'CAMERA' else "object"))
    obj[ID_PROPERTY] = identifier
    return identifier


def find_director_id(obj: bpy.types.Object) -> str | None:
    current = obj
    while current is not None:
        identifier = current.get(DIRECTOR_ID_PROPERTY)
        if isinstance(identifier, str) and identifier.strip():
            return identifier
        current = current.parent
    return None


def object_display_name(obj: bpy.types.Object) -> str:
    value = obj.get(DISPLAY_NAME_PROPERTY)
    return value if isinstance(value, str) and value else obj.name


def set_object_display_name(obj: bpy.types.Object, name: str) -> None:
    obj.name = name
    obj[DISPLAY_NAME_PROPERTY] = name


# Maps identifier -> object NAME. Names, never Object references: Blender frees
# objects on delete/undo and stale references crash. Entries are verified against
# the live object on every hit, so renames, deletions, undo/redo, and name swaps
# fall back to the linear scan instead of returning a wrong object.
_FIND_OBJECT_CACHE_LIMIT = 4096
_find_object_name_cache: dict[str, str] = {}


def _matches_identifier(obj: bpy.types.Object, identifier: str) -> bool:
    return obj.get(ID_PROPERTY) == identifier or obj.get(DIRECTOR_ID_PROPERTY) == identifier


def _remember_object_name(identifier: str, name: str) -> None:
    if len(_find_object_name_cache) >= _FIND_OBJECT_CACHE_LIMIT:
        _find_object_name_cache.clear()
    _find_object_name_cache[identifier] = name


def find_object(identifier: str, scene: bpy.types.Scene | None = None) -> bpy.types.Object | None:
    scene = scene or bpy.context.scene
    if scene is None:
        return None
    cached_name = _find_object_name_cache.get(identifier)
    if cached_name is not None:
        cached = scene.objects.get(cached_name)
        if cached is not None and _matches_identifier(cached, identifier):
            _remember_object_name(identifier, cached.name)
            ensure_stable_id(cached)
            return cached
        _find_object_name_cache.pop(identifier, None)
    for obj in scene.objects:
        if _matches_identifier(obj, identifier):
            _remember_object_name(identifier, obj.name)
            ensure_stable_id(obj)
            return obj
    return None


def ensure_named_collection(scene: bpy.types.Scene, name: str) -> bpy.types.Collection:
    collection = next(
        (
            candidate
            for candidate in scene.collection.children
            if candidate.name == name or candidate.get(COLLECTION_ROLE_PROPERTY) == name
        ),
        None,
    )
    if collection is None:
        collection = bpy.data.collections.new(name)
        collection[COLLECTION_ROLE_PROPERTY] = name
        scene.collection.children.link(collection)
    return collection


def ensure_collection(scene: bpy.types.Scene) -> bpy.types.Collection:
    return ensure_named_collection(scene, BLOCKOUT_COLLECTION)


def move_objects_to_collection(
    scene: bpy.types.Scene,
    objects: list[bpy.types.Object],
    collection_name: str,
) -> bpy.types.Collection:
    collection = ensure_named_collection(scene, collection_name)
    for obj in objects:
        if collection.objects.get(obj.name) is None:
            collection.objects.link(obj)
        for current in list(obj.users_collection):
            if current != collection:
                current.objects.unlink(obj)
    return collection


CONSTRAINT_NAMES = {
    "track_to": "WorldEngine Track To",
    "copy_location": "WorldEngine Copy Location",
    "copy_rotation": "WorldEngine Copy Rotation",
    "copy_transforms": "WorldEngine Copy Transforms",
}


def set_parent(child: bpy.types.Object, parent: bpy.types.Object, *, keep_world_transform=True):
    if child == parent:
        raise ValueError("An object cannot be its own parent")
    world_matrix = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted_safe()
    if keep_world_transform:
        child.matrix_world = world_matrix
    ensure_stable_id(child)
    ensure_stable_id(parent)
    return child


def clear_parent(child: bpy.types.Object, *, keep_world_transform=True):
    world_matrix = child.matrix_world.copy()
    child.parent = None
    child.matrix_parent_inverse.identity()
    if keep_world_transform:
        child.matrix_world = world_matrix
    return child


def add_object_constraint(
    owner: bpy.types.Object,
    target: bpy.types.Object,
    kind: str,
    *,
    influence=1.0,
):
    constraint_types = {
        "track_to": 'TRACK_TO',
        "copy_location": 'COPY_LOCATION',
        "copy_rotation": 'COPY_ROTATION',
        "copy_transforms": 'COPY_TRANSFORMS',
    }
    constraint_type = constraint_types.get(kind)
    if constraint_type is None:
        raise ValueError(f"Unsupported WorldEngine constraint: {kind}")
    constraint = owner.constraints.new(type=constraint_type)
    constraint.name = CONSTRAINT_NAMES[kind]
    constraint.target = target
    constraint.influence = float(influence)
    if constraint.type == 'TRACK_TO':
        constraint.track_axis = 'TRACK_NEGATIVE_Z'
        constraint.up_axis = 'UP_Y'
    ensure_stable_id(owner)
    ensure_stable_id(target)
    return constraint


def remove_object_constraint(owner: bpy.types.Object, name: str):
    constraint = owner.constraints.get(name)
    if constraint is None:
        raise ValueError(f"Unknown constraint on {owner.name}: {name}")
    owner.constraints.remove(constraint)
    return name


def _normalize_material_key(name: str) -> str:
    return "".join(character for character in name.casefold() if character.isalnum())


def _used_material_names() -> list[str]:
    scene = bpy.context.scene
    if scene is None:
        return []
    used: list[str] = []
    for obj in scene.objects:
        data = getattr(obj, "data", None)
        materials = getattr(data, "materials", None) if data is not None else None
        if not materials:
            continue
        for material in materials:
            if material is not None:
                used.append(material.name)
    return used


def list_scene_material_names(limit: int = SCENE_MATERIAL_NAME_LIMIT) -> list[str]:
    return unique_material_names(
        [material.name for material in bpy.data.materials],
        used=_used_material_names(),
        limit=limit,
    )


def nearby_material_names(requested: str, limit: int = 8) -> list[str]:
    return nearby_material_names_from(
        requested,
        [material.name for material in bpy.data.materials],
        limit=limit,
    )


def unknown_material_message(name: str) -> str:
    nearby = nearby_material_names(name)
    if nearby:
        suffix = f" Nearby: {', '.join(nearby)}."
    elif bpy.data.materials:
        suffix = f" Existing: {', '.join(list_scene_material_names(8))}."
    else:
        suffix = " Scene has no materials."
    return (
        f"Unknown Blender material: {name}.{suffix} "
        "Retry assign_material with createIfMissing true to create it, or reuse one of those names."
    )


def resolve_material(name: str) -> tuple[bpy.types.Material | None, str | None]:
    exact = bpy.data.materials.get(name)
    if exact is not None:
        return exact, "exact"
    materials = list(bpy.data.materials)
    lowered = name.casefold()
    case_hits = [material for material in materials if material.name.casefold() == lowered]
    if len(case_hits) == 1:
        return case_hits[0], "case"
    requested_key = _normalize_material_key(name)
    if not requested_key:
        return None, None
    normalized_hits = [
        material
        for material in materials
        if _normalize_material_key(material.name) == requested_key
    ]
    if len(normalized_hits) == 1:
        return normalized_hits[0], "normalized"
    prefix_hits = [
        material
        for material in materials
        if (
            (key := _normalize_material_key(material.name))
            and min(len(key), len(requested_key)) >= 4
            and (key.startswith(requested_key) or requested_key.startswith(key))
        )
    ]
    if len(prefix_hits) == 1:
        return prefix_hits[0], "prefix"
    close_names = difflib.get_close_matches(
        name,
        [material.name for material in materials],
        n=2,
        cutoff=0.82,
    )
    if len(close_names) == 1:
        material = bpy.data.materials.get(close_names[0])
        if material is not None:
            return material, "close"
    return None, None


def ensure_neutral_material() -> bpy.types.Material:
    material = bpy.data.materials.get(NEUTRAL_MATERIAL)
    if material is None:
        material = bpy.data.materials.new(NEUTRAL_MATERIAL)
    material.diffuse_color = (0.72, 0.74, 0.77, 1.0)
    material.roughness = 0.82
    material.metallic = 0.0
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF") if material.node_tree else None
    if principled is not None:
        principled.inputs["Base Color"].default_value = material.diffuse_color
        principled.inputs["Roughness"].default_value = material.roughness
        principled.inputs["Metallic"].default_value = material.metallic
    return material


def assign_neutral_material(obj: bpy.types.Object) -> None:
    if obj.type != 'MESH' or obj.data is None:
        return
    material = ensure_neutral_material()
    obj.data.materials.clear()
    obj.data.materials.append(material)


def _unit_cube_mesh(name: str) -> bpy.types.Mesh:
    vertices = [
        (-0.5, -0.5, -0.5),
        (0.5, -0.5, -0.5),
        (0.5, 0.5, -0.5),
        (-0.5, 0.5, -0.5),
        (-0.5, -0.5, 0.5),
        (0.5, -0.5, 0.5),
        (0.5, 0.5, 0.5),
        (-0.5, 0.5, 0.5),
    ]
    faces = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (4, 0, 3, 7),
    ]
    mesh = bpy.data.meshes.new(f"{name} Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def _select_only(obj: bpy.types.Object) -> None:
    for candidate in bpy.context.selected_objects:
        candidate.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def create_box(
    scene: bpy.types.Scene,
    *,
    name: str,
    location=(0.0, 0.0, 0.5),
    dimensions=(1.0, 1.0, 1.0),
    rotation=(0.0, 0.0, 0.0),
    kind: str = "cube",
    select: bool = True,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, _unit_cube_mesh(name))
    set_object_display_name(obj, name)
    ensure_collection(scene).objects.link(obj)
    obj.location = location
    obj.rotation_mode = 'XYZ'
    obj.rotation_euler = rotation
    obj.scale = dimensions
    obj["worldengine_kind"] = kind
    ensure_stable_id(obj, kind)
    assign_neutral_material(obj)
    if select:
        _select_only(obj)
    return obj


# Default segment counts match the bpy.ops.mesh.primitive_*_add defaults that
# this module previously relied on (uv sphere 32x16, cylinder/cone 32 segments,
# ico sphere 2 subdivisions), verified against Blender 5.1.2.
_PRIMITIVE_SEGMENT_DEFAULTS = {
    "sphere": 32,
    "uv_sphere": 32,
    "ico_sphere": 2,
    "cylinder": 32,
    "cone": 32,
}
_UV_SPHERE_RING_DEFAULT = 16
_SEGMENTED_PRIMITIVES = frozenset(_PRIMITIVE_SEGMENT_DEFAULTS)
_RINGED_PRIMITIVES = frozenset({"sphere", "uv_sphere"})


def _primitive_mesh(name: str, primitive: str, segments: int, rings: int) -> bpy.types.Mesh:
    """Build a unit-sized primitive mesh directly through bmesh.ops.

    Unlike the bpy.ops.mesh.primitive_*_add operators this is context-free and
    parameterizable. Base meshes are unit-sized (radius 0.5 / depth 1.0), except
    the plane which stays a 2x2 grid so the historical scale=(dim/2) semantics
    keep producing the requested dimensions.
    """
    bm = bmesh.new()
    try:
        if primitive in {"sphere", "uv_sphere"}:
            bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=0.5)
        elif primitive == "ico_sphere":
            bmesh.ops.create_icosphere(bm, subdivisions=segments, radius=0.5)
        elif primitive == "cylinder":
            bmesh.ops.create_cone(
                bm, cap_ends=True, cap_tris=False,
                segments=segments, radius1=0.5, radius2=0.5, depth=1.0,
            )
        elif primitive == "cone":
            bmesh.ops.create_cone(
                bm, cap_ends=True, cap_tris=False,
                segments=segments, radius1=0.5, radius2=0.0, depth=1.0,
            )
        elif primitive == "plane":
            # size is the half extent: 1.0 rebuilds the same 2x2 base plane as
            # bpy.ops.mesh.primitive_plane_add did.
            bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
        else:
            raise ValueError(f"Unsupported bmesh primitive: {primitive}")
        mesh = bpy.data.meshes.new(f"{name} Mesh")
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    return mesh


def _mesh_bounds_size(mesh: bpy.types.Mesh) -> tuple[float, float, float]:
    coordinates = [vertex.co for vertex in mesh.vertices]
    return tuple(
        max(point[index] for point in coordinates) - min(point[index] for point in coordinates)
        for index in range(3)
    )


def _move_mesh_origin_to_floor(obj: bpy.types.Object) -> None:
    minimum_z = min(vertex.co.z for vertex in obj.data.vertices)
    for vertex in obj.data.vertices:
        vertex.co.z -= minimum_z
    obj.data.update()


def create_primitive(
    scene: bpy.types.Scene,
    primitive: str,
    *,
    name: str | None = None,
    location=None,
    dimensions: tuple[float, float, float] | None = None,
    rotation=(0.0, 0.0, 0.0),
    segments: int | None = None,
    rings: int | None = None,
    grounded: bool = False,
) -> bpy.types.Object:
    defaults = {
        "cube": ((1.0, 1.0, 1.0), 0.5),
        "floor": ((4.0, 4.0, 0.1), 0.05),
        "wall": ((4.0, 0.2, 2.8), 1.4),
        "sphere": ((1.0, 1.0, 1.0), 0.5),
        "uv_sphere": ((1.0, 1.0, 1.0), 0.5),
        "ico_sphere": ((1.0, 1.0, 1.0), 0.5),
        "cylinder": ((1.0, 1.0, 1.0), 0.5),
        "cone": ((1.0, 1.0, 1.0), 0.5),
        "plane": ((1.0, 1.0, 0.0), 0.0),
    }
    if primitive not in defaults:
        raise ValueError(f"Unsupported primitive: {primitive}")
    if segments is not None and primitive not in _SEGMENTED_PRIMITIVES:
        raise ValueError(f"segments is not supported for primitive: {primitive}")
    if rings is not None and primitive not in _RINGED_PRIMITIVES:
        raise ValueError(f"rings is only supported for sphere and uv_sphere, not: {primitive}")
    default_dimensions, z_offset = defaults[primitive]
    dimensions = dimensions or default_dimensions
    resolved_location = location or ((0.0, 0.0, 0.0) if grounded else (0.0, 0.0, z_offset))
    if primitive in {"cube", "floor", "wall"}:
        obj = create_box(
            scene,
            name=name or primitive.title(),
            location=tuple(float(value) for value in resolved_location),
            dimensions=dimensions,
            rotation=rotation,
            kind=primitive,
        )
        if grounded:
            _move_mesh_origin_to_floor(obj)
        return obj

    resolved_name = name or primitive.replace("_", " ").title()
    # The plane path ignores segment counts entirely (validated above).
    resolved_segments = (
        int(segments) if segments is not None else _PRIMITIVE_SEGMENT_DEFAULTS.get(primitive, 0)
    )
    resolved_rings = int(rings) if rings is not None else _UV_SPHERE_RING_DEFAULT
    obj = bpy.data.objects.new(
        resolved_name,
        _primitive_mesh(resolved_name, primitive, resolved_segments, resolved_rings),
    )
    set_object_display_name(obj, resolved_name)
    ensure_collection(scene).objects.link(obj)
    obj.location = tuple(float(value) for value in resolved_location)
    obj.rotation_mode = 'XYZ'
    obj.rotation_euler = rotation
    if primitive == "plane":
        obj.scale = (dimensions[0] / 2, dimensions[1] / 2, 1.0)
    else:
        # Same effect as the obj.dimensions setter, but computed from the fresh
        # mesh directly so it does not depend on a depsgraph-evaluated bound box.
        base = _mesh_bounds_size(obj.data)
        obj.scale = tuple(
            float(dimensions[index]) / base[index] if base[index] > 1e-9 else 1.0
            for index in range(3)
        )
    obj["worldengine_kind"] = primitive
    if grounded:
        _move_mesh_origin_to_floor(obj)
    ensure_stable_id(obj, primitive)
    assign_neutral_material(obj)
    _select_only(obj)
    return obj


def create_camera(
    scene: bpy.types.Scene,
    *,
    name: str = "WorldEngine Camera",
    location=(6.0, -6.0, 4.0),
    rotation=(1.109, 0.0, 0.785),
    focal_length_mm: float = 35.0,
    activate: bool = True,
) -> bpy.types.Object:
    camera_data = bpy.data.cameras.new(name)
    camera_data.lens = focal_length_mm
    obj = bpy.data.objects.new(name, camera_data)
    set_object_display_name(obj, name)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_mode = 'XYZ'
    obj.rotation_euler = rotation
    obj["worldengine_kind"] = "camera"
    ensure_stable_id(obj, "camera")
    if activate:
        scene.camera = obj
    _select_only(obj)
    return obj


def create_light(
    scene: bpy.types.Scene,
    *,
    kind: str = "AREA",
    name: str = "WorldEngine Key Light",
    location=(4.0, -4.0, 6.0),
    target=(0.0, 0.0, 1.5),
    energy: float = 1000.0,
    color=(1.0, 0.94, 0.86),
    size: float = 4.0,
) -> bpy.types.Object:
    light_kind = kind.upper()
    light_data = bpy.data.lights.new(name, type=light_kind)
    light_data.energy = float(energy)
    light_data.color = tuple(float(value) for value in color)
    if light_kind in {'POINT', 'SPOT'}:
        light_data.shadow_soft_size = float(size)
    if light_kind == 'AREA':
        light_data.shape = 'DISK'
        light_data.size = float(size)
    obj = bpy.data.objects.new(name, light_data)
    set_object_display_name(obj, name)
    ensure_named_collection(scene, LIGHT_COLLECTION).objects.link(obj)
    obj.location = location
    obj.rotation_mode = 'XYZ'
    direction = Vector(target) - obj.location
    if direction.length_squared > 0:
        obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    obj["worldengine_kind"] = "light"
    obj["worldengine_light_kind"] = light_kind.lower()
    ensure_stable_id(obj, "light")
    _select_only(obj)
    return obj


def set_world_environment(
    scene: bpy.types.Scene,
    *,
    color=(0.05, 0.05, 0.05),
    strength: float = 1.0,
) -> dict[str, object]:
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("Director World")
        scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = next((node for node in nodes if node.type == 'BACKGROUND'), None)
    if background is None:
        background = nodes.new("ShaderNodeBackground")
    output = next((node for node in nodes if node.type == 'OUTPUT_WORLD'), None)
    if output is None:
        output = nodes.new("ShaderNodeOutputWorld")
    color_input = background.inputs.get("Color")
    strength_input = background.inputs.get("Strength")
    surface_input = output.inputs.get("Surface")
    for link in list(color_input.links):
        links.remove(link)
    for link in list(surface_input.links):
        links.remove(link)
    links.new(background.outputs["Background"], surface_input)
    color_input.default_value = (*tuple(float(value) for value in color), 1.0)
    strength_input.default_value = float(strength)
    world.color = tuple(float(value) for value in color)
    return {"color": list(color), "strength": float(strength)}


def _object_local_dimensions(obj: bpy.types.Object) -> Vector:
    corners = [Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(corner[index] for corner in corners) for index in range(3)))
    maximum = Vector(tuple(max(corner[index] for corner in corners) for index in range(3)))
    local = maximum - minimum
    return Vector(tuple(abs(local[index] * obj.scale[index]) for index in range(3)))


def create_opening(
    scene: bpy.types.Scene,
    wall: bpy.types.Object,
    *,
    kind: str = "door",
    name: str | None = None,
    width: float = 0.9,
    height: float = 2.1,
    sill_height: float = 0.0,
    offset: float = 0.0,
) -> tuple[bpy.types.Object, bpy.types.Modifier]:
    """Create an editable native Boolean opening on a mesh wall."""
    if wall.type != 'MESH':
        raise ValueError("Openings require a mesh wall")

    opening_kind = kind.lower()
    bpy.context.view_layer.update()
    local_size = _object_local_dimensions(wall)
    horizontal_axis = 0 if local_size.x >= local_size.y else 1
    thickness_axis = 1 - horizontal_axis
    basis = wall.matrix_world.to_3x3().normalized()
    local_center = Vector((0.0, 0.0, -local_size.z / 2 + float(sill_height) + float(height) / 2))
    local_center[horizontal_axis] = float(offset)
    world_center = wall.matrix_world.translation + basis @ local_center

    cutter_name = name or f"{wall.name} {opening_kind.title()} Opening"
    cutter = bpy.data.objects.new(cutter_name, _unit_cube_mesh(cutter_name))
    set_object_display_name(cutter, cutter_name)
    ensure_named_collection(scene, CONSTRUCTION_COLLECTION).objects.link(cutter)
    cutter.location = world_center
    cutter.rotation_mode = 'XYZ'
    cutter.rotation_euler = wall.matrix_world.to_euler('XYZ')
    dimensions = [float(width), float(width), float(height)]
    dimensions[thickness_axis] = float(local_size[thickness_axis]) + 0.2
    cutter.dimensions = tuple(dimensions)
    cutter.display_type = 'WIRE'
    cutter.hide_render = True
    cutter["worldengine_kind"] = "opening"
    cutter["worldengine_opening_kind"] = opening_kind
    cutter["worldengine_target_id"] = ensure_stable_id(wall, "wall")
    ensure_stable_id(cutter, "opening")

    modifier = wall.modifiers.new(name=f"WorldEngine {opening_kind.title()} Opening", type='BOOLEAN')
    modifier.operation = 'DIFFERENCE'
    modifier.solver = 'EXACT'
    modifier.object = cutter
    cutter["worldengine_modifier"] = modifier.name
    _select_only(wall)
    return cutter, modifier


def create_room(scene: bpy.types.Scene, *, name="Room", location=(0.0, 0.0, 0.0), parameters=None):
    parameters = parameters or {}
    width = float(parameters.get("width", 6.0))
    depth = float(parameters.get("depth", 5.0))
    height = float(parameters.get("height", 2.8))
    thickness = float(parameters.get("thickness", parameters.get("wall_thickness", 0.15)))
    x, y, z = location
    objects = [create_box(scene, name=f"{name} Floor", location=(x, y, z + thickness / 2), dimensions=(width, depth, thickness), kind="floor", select=False)]
    for label, offset, dims in (
        ("North Wall", (0.0, depth / 2 - thickness / 2, height / 2), (width, thickness, height)),
        ("South Wall", (0.0, -depth / 2 + thickness / 2, height / 2), (width, thickness, height)),
        ("East Wall", (width / 2 - thickness / 2, 0.0, height / 2), (thickness, depth, height)),
        ("West Wall", (-width / 2 + thickness / 2, 0.0, height / 2), (thickness, depth, height)),
    ):
        objects.append(create_box(scene, name=f"{name} {label}", location=(x + offset[0], y + offset[1], z + offset[2]), dimensions=dims, kind="wall", select=False))
    _select_only(objects[0])
    return objects


def create_corridor(scene: bpy.types.Scene, *, name="Corridor", location=(0.0, 0.0, 0.0), parameters=None):
    parameters = parameters or {}
    length = float(parameters.get("length", 8.0))
    width = float(parameters.get("width", 2.4))
    height = float(parameters.get("height", 2.8))
    thickness = float(parameters.get("thickness", parameters.get("wall_thickness", 0.15)))
    x, y, z = location
    objects = [create_box(scene, name=f"{name} Floor", location=(x, y, z + thickness / 2), dimensions=(length, width, thickness), kind="floor", select=False)]
    for side, offset in (("Left", width / 2 - thickness / 2), ("Right", -width / 2 + thickness / 2)):
        objects.append(create_box(scene, name=f"{name} {side} Wall", location=(x, y + offset, z + height / 2), dimensions=(length, thickness, height), kind="wall", select=False))
    _select_only(objects[0])
    return objects


def create_stairs(scene: bpy.types.Scene, *, name="Stairs", location=(0.0, 0.0, 0.0), parameters=None):
    parameters = parameters or {}
    width = float(parameters.get("width", 2.0))
    run = float(parameters.get("run", 3.0))
    rise = float(parameters.get("rise", 1.8))
    steps = max(2, min(64, int(parameters.get("steps", 10))))
    step_depth = run / steps
    step_rise = rise / steps
    x, y, z = location
    objects = []
    for index in range(steps):
        height = step_rise * (index + 1)
        objects.append(create_box(
            scene,
            name=f"{name} {index + 1:02d}",
            location=(x, y + step_depth * (index + 0.5), z + height / 2),
            dimensions=(width, step_depth, height),
            kind="stair",
            select=False,
        ))
    _select_only(objects[0])
    return objects


def create_blockout(scene: bpy.types.Scene, preset: str, **kwargs):
    creators = {"room": create_room, "corridor": create_corridor, "stairs": create_stairs}
    creator = creators.get(preset)
    if creator is None:
        raise ValueError(f"Unsupported blockout preset: {preset}")
    return creator(scene, **kwargs)


def director_rotation_to_blender(rotation) -> Euler:
    source = Euler(tuple(float(value) for value in rotation), 'XYZ').to_matrix()
    return (_BASIS @ source @ _BASIS.inverted()).to_euler('XYZ')


def blender_rotation_to_director(rotation) -> list[float]:
    source = Euler(tuple(float(value) for value in rotation), 'XYZ').to_matrix()
    result = (_BASIS.inverted() @ source @ _BASIS).to_euler('XYZ')
    return [float(result.x), float(result.y), float(result.z)]


def object_world_transform(obj: bpy.types.Object) -> dict[str, list[float]]:
    location, rotation, scale = obj.matrix_world.decompose()
    return {
        "position": list(blender_to_director_point(tuple(float(value) for value in location))),
        "rotation": blender_rotation_to_director(rotation.to_euler('XYZ')),
        "scale": [float(scale.x), float(scale.z), float(scale.y)],
    }


def object_local_transform(obj: bpy.types.Object) -> dict[str, list[float]]:
    local_matrix = obj.parent.matrix_world.inverted_safe() @ obj.matrix_world if obj.parent else obj.matrix_world
    location, rotation, scale = local_matrix.decompose()
    return {
        "position": list(blender_to_director_point(tuple(float(value) for value in location))),
        "rotation": blender_rotation_to_director(rotation.to_euler('XYZ')),
        "scale": [float(scale.x), float(scale.z), float(scale.y)],
    }


def director_dimensions_to_blender(dimensions) -> tuple[float, float, float]:
    return (float(dimensions[0]), float(dimensions[2]), float(dimensions[1]))


def _hierarchy_local_bounds(
    root: bpy.types.Object,
    depsgraph: bpy.types.Depsgraph,
) -> dict[str, list[float]] | None:
    """Measure evaluated descendant geometry in the root object's local space."""
    root_inverse = root.matrix_world.inverted_safe()
    points: list[tuple[float, float, float]] = []
    pending = [root]
    while pending:
        source = pending.pop()
        pending.extend(source.children)
        if source.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META', 'VOLUME'}:
            continue
        evaluated = source.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            local_point = root_inverse @ (evaluated.matrix_world @ Vector(corner))
            points.append(
                blender_to_director_point(tuple(float(value) for value in local_point))
            )
    if not points:
        return None
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    if not any(maximum[axis] > minimum[axis] for axis in range(3)):
        return None
    return {"min": minimum, "max": maximum}


def snapshot_scene(scene: bpy.types.Scene) -> dict[str, Any]:
    objects = []
    for obj in scene.objects:
        identifier = ensure_stable_id(obj)
        record: dict[str, Any] = {
            "id": identifier,
            "director_id": obj.get(DIRECTOR_ID_PROPERTY),
            "name": object_display_name(obj),
            "kind": "camera" if obj.type == 'CAMERA' else str(obj.get("worldengine_kind", "object")),
            "position": list(blender_to_director_point(tuple(float(value) for value in obj.location))),
            "rotation": blender_rotation_to_director(obj.rotation_euler),
            "dimensions": [float(obj.dimensions.x), float(obj.dimensions.z), float(obj.dimensions.y)],
        }
        if obj.type == 'CAMERA':
            record["focal_length_mm"] = float(obj.data.lens)
            record["active"] = scene.camera == obj
        objects.append(record)
    return {"contract": "worldengine-blender-snapshot-v1", "scene": scene.name, "objects": objects}


def snapshot_live_scene(scene: bpy.types.Scene) -> dict[str, Any]:
    from .director_project import current_project_id

    objects = []
    cameras = []
    lights = []
    selected_object_ids = []
    active_object_id = None
    active_object = bpy.context.view_layer.objects.active
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in scene.objects:
        identifier = ensure_stable_id(obj)
        if obj.select_get():
            selected_object_ids.append(identifier)
        if obj == active_object:
            active_object_id = identifier
        world_transform = object_world_transform(obj)
        position = world_transform["position"]
        rotation = world_transform["rotation"]
        if obj.type == 'CAMERA':
            cameras.append({
                "id": identifier,
                "name": object_display_name(obj),
                "position": position,
                "rotation": rotation,
                "projectionType": (
                    "ORTHOGRAPHIC" if obj.data.type == 'ORTHO' else "PERSPECTIVE"
                ),
                "focalLengthMm": float(obj.data.lens),
                "sensorFit": str(obj.data.sensor_fit),
                "sensorWidthMm": float(obj.data.sensor_width),
                "sensorHeightMm": float(obj.data.sensor_height),
                "shiftX": float(obj.data.shift_x),
                "shiftY": float(obj.data.shift_y),
                "clipStart": float(obj.data.clip_start),
                "clipEnd": float(obj.data.clip_end),
                "orthographicScale": float(obj.data.ortho_scale),
                "active": scene.camera == obj,
            })
            continue
        if obj.type == 'LIGHT':
            light_size = (
                float(obj.data.size)
                if obj.data.type == 'AREA'
                else float(getattr(obj.data, "shadow_soft_size", 0.0))
            )
            lights.append({
                "id": identifier,
                "name": object_display_name(obj),
                "kind": str(obj.data.type).lower(),
                "position": position,
                "rotation": rotation,
                "color": [float(value) for value in obj.data.color],
                "energy": float(obj.data.energy),
                "size": light_size,
                "visible": not obj.hide_viewport and not obj.hide_get(),
            })
            continue
        record = {
            "id": identifier,
            "directorId": find_director_id(obj),
            "name": object_display_name(obj),
            "type": obj.type,
            "kind": str(obj.get("worldengine_kind", "object")),
            "position": position,
            "rotation": rotation,
            "scale": world_transform["scale"],
            "localTransform": object_local_transform(obj),
            "dimensions": [float(obj.dimensions.x), float(obj.dimensions.z), float(obj.dimensions.y)],
            "visible": not obj.hide_viewport and not obj.hide_get(),
            "collections": [collection.name for collection in obj.users_collection],
            "parentId": ensure_stable_id(obj.parent) if obj.parent is not None else None,
            "modifierCount": len(obj.modifiers),
            "constraints": [
                {
                    "name": constraint.name,
                    "kind": str(constraint.type).lower(),
                    "targetId": ensure_stable_id(constraint.target) if getattr(constraint, "target", None) else None,
                    "influence": float(constraint.influence),
                    "enabled": not constraint.mute,
                }
                for constraint in obj.constraints
            ],
        }
        if obj.parent is None:
            record["localBounds"] = _hierarchy_local_bounds(obj, depsgraph)
        objects.append(record)
    return {
        "contract": "worldengine-blender-live-v1",
        "projectId": current_project_id(scene),
        "revision": int(scene.worldengine_studio.scene_revision),
        "sceneName": scene.name,
        "frame": int(scene.frame_current),
        "unit": "meter",
        "coordinateSystem": "right-handed-y-up-negative-z-forward",
        "objects": objects,
        "cameras": cameras,
        "lights": lights,
        "selectedObjectIds": selected_object_ids,
        "activeObjectId": active_object_id,
    }
